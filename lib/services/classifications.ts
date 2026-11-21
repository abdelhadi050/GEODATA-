/**
 * GEODATA HUB — Classification service (M5.4).
 *
 * The shared service that connects the classification engine registry
 * (src/lib/classification/registry.ts — the source of truth for engines)
 * with database persistence (ClassificationRecord). Every engine runs
 * through the generic `runClassification` pipeline; NO classification logic
 * is duplicated here.
 *
 * Mirrors `src/lib/services/calculations.ts` (M5.2 Integration) in design
 * because the same engineering rules apply:
 *   - Layering: API routes → this service → classification registry (pure
 *     modules) + Prisma. The engines remain independent of HTTP and DB.
 *   - RBAC: writes require LAB_TEST_RESULT (same policy as recording lab
 *     results and running calculations — classifications are derived lab
 *     work). Reads use the sample-access chain (own org or active share).
 *   - Persistence: immutable snapshots, idempotency, duplicate suppression,
 *     invalidation on input change — every pattern mirrors CalculationRecord.
 *
 * Classification input source: a SAMPLE's lab tests. The service reads the
 * granulometry (GRANULOMETRY) and Atterberg (ATTERBERG_LIMITS) lab tests
 * attached to the sample, sorts their PSD points by strictly increasing
 * diameter (the engine contract — see the M5.2-b granulometry module), and
 * assembles the classification input payload:
 *
 *   {
 *     points: [{ diameterMm, percentFiner }, ...] (sorted increasing),
 *     atterberg: { liquidLimit, plasticLimit, plasticityIndex } | undefined
 *   }
 *
 * The Atterberg lab test is optional — coarse-grained soils with <5 % fines
 * classify without it. Fine-grained soils require it (the engine throws
 * MISSING_INPUT otherwise, which is persisted as a FAILED record).
 *
 * Invalidation: when a GRANULOMETRY or ATTERBERG_LIMITS lab-test resultData
 * changes, classifications made from the previous data are marked stale in
 * the same transaction (see invalidateStaleClassifications). The fingerprint
 * is computed over the FULL sample-derived input payload (granulometry +
 * Atterberg), so a change to either input invalidates the record.
 */
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { SessionUser } from "@/lib/auth";
import { AppError, Errors } from "@/lib/errors";
import { db } from "@/lib/db";
import { can, CAPABILITIES } from "@/lib/rbac";
import { CLASSIFICATION_ENGINE_VERSION, runClassification } from "@/lib/classification/engine";
import {
  getClassModuleById,
  type RegisteredClassificationModule,
} from "@/lib/classification/registry";
import {
  getAccessibleSampleOrThrow,
  getOwnSampleOrThrow,
} from "./access";
import { ACTIVITY_ACTIONS, logActivity } from "./activity";

/** Maximum accepted explicit input payload size (canonical JSON characters). */
const MAX_INPUT_CHARS = 256 * 1024;

// ---------------------------------------------------------------------------
// Per-sample serialization (in-process)
// ---------------------------------------------------------------------------

/**
 * Per-sample async mutex: at most one classification critical section runs per
 * sample at a time within this process. Mirrors `withLabTestLock` from the
 * calculation service (M5.2 Integration) — same rationale (SQLite single-
 * writer serialization + race-free idempotency re-checks in-process).
 */
const sampleLocks = new Map<string, Promise<unknown>>();

export async function withSampleLock<T>(sampleId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sampleLocks.get(sampleId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  sampleLocks.set(sampleId, tail);
  void tail.then(() => {
    if (sampleLocks.get(sampleId) === tail) sampleLocks.delete(sampleId);
  });
  return run;
}

// ---------------------------------------------------------------------------
// Fingerprinting (input snapshots)
// ---------------------------------------------------------------------------

/**
 * Canonical JSON: object keys sorted recursively (arrays keep their order —
 * measurement order is semantically meaningful), then JSON.stringify.
 * Identical implementation to the calculation service's `canonicalJson`.
 */
export function canonicalJson(value: unknown): string {
  const sortValue = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortValue);
    if (v !== null && typeof v === "object") {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[key] = sortValue((v as Record<string, unknown>)[key]);
      }
      return sorted;
    }
    return v;
  };
  return JSON.stringify(sortValue(value));
}

/** sha256 fingerprint (hex) of the canonical JSON of an input value. */
export function fingerprintInput(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * Fingerprint the CLASSIFIABLE input: the module-parsed payload when the
 * module accepts it (semantically meaningful changes only — unknown-key edits
 * do not invalidate), the raw payload otherwise (validation-failed records
 * are fingerprinted by what was submitted).
 */
function fingerprintClassificationInput(
  module: RegisteredClassificationModule,
  rawPayload: unknown,
): string {
  try {
    return fingerprintInput(module.validateInput(rawPayload));
  } catch {
    return fingerprintInput(rawPayload);
  }
}

// ---------------------------------------------------------------------------
// Sample → classification input assembly
// ---------------------------------------------------------------------------

/**
 * The granulometry lab-test result shape (registry `granulometryResult`):
 *   { points: [{ diameterMm, percentFiner }], d10?, d30?, d60?, ... }
 * Only `points` is used by the classification modules.
 */
interface GranulometryResult {
  points?: Array<{ diameterMm: number; percentFiner: number }>;
}

interface AtterbergResult {
  liquidLimit: number;
  plasticLimit: number;
  plasticityIndex: number;
}

/**
 * Assemble the classification input payload from a sample's lab tests.
 *
 * Reads the GRANULOMETRY and ATTERBERG_LIMITS lab tests attached to the
 * sample. The granulometry `points` array is sorted by strictly increasing
 * diameterMm (the engine contract — coarse-to-fine storage order is
 * rejected). The Atterberg lab test is optional — its absence is preserved
 * (the engine will throw MISSING_INPUT for fine-grained soils, which is
 * persisted as a FAILED record).
 *
 * Returns the assembled payload plus the source lab-test ids (for tracing).
 * Throws AppError VALIDATION_ERROR when the granulometry lab test is missing
 * (classifications cannot proceed without a PSD).
 */
export async function assembleSampleClassificationInput(
  sampleId: string,
): Promise<{
  payload: { points: Array<{ diameterMm: number; percentFiner: number }>; atterberg?: AtterbergResult };
  source: { granulometryLabTestId: string | null; atterbergLabTestId: string | null };
}> {
  const labTests = await db.labTest.findMany({
    where: { sampleId },
    select: { id: true, testType: true, resultData: true, status: true },
  });

  const granulometry = labTests.find((t) => t.testType === "GRANULOMETRY");
  const atterberg = labTests.find((t) => t.testType === "ATTERBERG_LIMITS");

  if (!granulometry || !granulometry.resultData) {
    throw new AppError(
      "VALIDATION_ERROR",
      400,
      "Sample has no granulometry lab-test result — classification requires a particle-size distribution.",
      { sampleId, hasGranulometry: Boolean(granulometry) },
    );
  }

  const granData = granulometry.resultData as GranulometryResult;
  if (!Array.isArray(granData.points) || granData.points.length < 2) {
    throw new AppError(
      "VALIDATION_ERROR",
      400,
      "Sample's granulometry result has fewer than 2 PSD points — classification cannot proceed.",
      { sampleId, pointCount: Array.isArray(granData.points) ? granData.points.length : 0 },
    );
  }

  // Sort by strictly increasing diameterMm (the engine contract — coarse-to-
  // fine storage order is rejected; sorting is the documented caller
  // responsibility per the M5.2-b granulometry module).
  const sortedPoints = [...granData.points]
    .map((p) => ({ diameterMm: Number(p.diameterMm), percentFiner: Number(p.percentFiner) }))
    .sort((a, b) => a.diameterMm - b.diameterMm);

  // Verify strict ordering (duplicates would cause the engine to throw
  // INVALID_INPUT — surface as a clearer error here).
  for (let i = 1; i < sortedPoints.length; i++) {
    if (sortedPoints[i].diameterMm === sortedPoints[i - 1].diameterMm) {
      throw new AppError(
        "VALIDATION_ERROR",
        400,
        `Sample's granulometry has duplicate diameterMm ${sortedPoints[i].diameterMm} — PSD diameters must be unique.`,
        { sampleId, duplicateDiameterMm: sortedPoints[i].diameterMm },
      );
    }
  }

  let atterbergValue: AtterbergResult | undefined;
  if (atterberg && atterberg.resultData) {
    const att = atterberg.resultData as Partial<AtterbergResult>;
    if (
      typeof att.liquidLimit === "number" &&
      typeof att.plasticLimit === "number" &&
      typeof att.plasticityIndex === "number"
    ) {
      atterbergValue = {
        liquidLimit: att.liquidLimit,
        plasticLimit: att.plasticLimit,
        plasticityIndex: att.plasticityIndex,
      };
    }
  }

  return {
    payload: { points: sortedPoints, ...(atterbergValue ? { atterberg: atterbergValue } : {}) },
    source: {
      granulometryLabTestId: granulometry.id,
      atterbergLabTestId: atterberg?.id ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Fields selected for LIST payloads (no output/input snapshots — lean). */
const LIST_SELECT = {
  id: true,
  sampleId: true,
  moduleId: true,
  moduleVersion: true,
  engineVersion: true,
  status: true,
  inputSource: true,
  inputFingerprint: true,
  isValid: true,
  invalidatedAt: true,
  invalidatedReason: true,
  errorCode: true,
  standard: true,
  standardVersion: true,
  idempotencyKey: true,
  warnings: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { id: true, name: true } },
} as const;

type ListRow = Prisma.ClassificationRecordGetPayload<{ select: typeof LIST_SELECT }>;

export function serializeClassificationListItem(row: ListRow) {
  const warnings = Array.isArray(row.warnings) ? row.warnings : [];
  return {
    id: row.id,
    sampleId: row.sampleId,
    moduleId: row.moduleId,
    moduleVersion: row.moduleVersion,
    engineVersion: row.engineVersion,
    status: row.status,
    inputSource: row.inputSource,
    inputFingerprint: row.inputFingerprint,
    isValid: row.isValid,
    invalidatedAt: row.invalidatedAt,
    invalidatedReason: row.invalidatedReason,
    errorCode: row.errorCode,
    standard: row.standard,
    standardVersion: row.standardVersion,
    idempotencyKey: row.idempotencyKey,
    warningCount: warnings.length,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy,
  };
}

/** Full detail payload: everything persisted, plus sample context. */
export function serializeClassificationDetail(
  record: Prisma.ClassificationRecordGetPayload<{
    include: {
      createdBy: { select: { id: true; name: true } };
      sample: {
        include: {
          borehole: { include: { project: { select: { id: true; code: true; name: true } } } };
        };
      };
    };
  }>,
) {
  return {
    ...serializeClassificationListItem(record),
    inputSnapshot: record.inputSnapshot,
    output: record.output,
    warnings: record.warnings,
    errorMessage: record.errorMessage,
    errorDetails: record.errorDetails,
    sample: {
      id: record.sample.id,
      code: record.sample.code,
      borehole: {
        id: record.sample.borehole.id,
        code: record.sample.borehole.code,
        project: record.sample.borehole.project,
      },
    },
  };
}

const DETAIL_INCLUDE = {
  createdBy: { select: { id: true, name: true } },
  sample: {
    include: {
      borehole: {
        include: { project: { select: { id: true, code: true, name: true } } },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Classify (submit → validate → execute → persist)
// ---------------------------------------------------------------------------

export interface ClassifySampleOptions {
  /** Explicit input payload; when absent the sample's lab-test data is used. */
  input?: Record<string, unknown>;
  /** Client-supplied retry key — replays the original record on collisions. */
  idempotencyKey?: string;
  /** Validate + execute WITHOUT persisting (pre-flight check). */
  dryRun?: boolean;
}

export interface ClassifyResult {
  /** The persisted record (full detail shape). Null for dry runs. */
  record: ReturnType<typeof serializeClassificationDetail> | null;
  /** The raw engine outcome envelope (both dry runs and persisted runs). */
  outcome: unknown;
  replayed: boolean;
  deduplicated: boolean;
  dryRun: boolean;
}

/**
 * Run a classification module over a sample's lab-test data and persist the
 * snapshot. The engine NEVER throws for classification failures — failures
 * are persisted as FAILED records and returned in the outcome envelope.
 */
export async function classifySample(
  actor: SessionUser,
  sampleId: string,
  moduleId: string,
  opts: ClassifySampleOptions = {},
): Promise<ClassifyResult> {
  // RBAC — same policy as running calculations (LAB_TEST_RESULT).
  if (!can(actor.role, CAPABILITIES.LAB_TEST_RESULT)) {
    await logActivity({
      organizationId: actor.organizationId,
      userId: actor.id,
      action: ACTIVITY_ACTIONS.CALCULATION_ACCESS_DENIED, // reuse — audit-relevant denial
      entityType: "ClassificationRecord",
      entityId: null,
      details: { attempted: "classify", sampleId, moduleId, reason: "missing capability labtest:result" },
    });
    throw Errors.forbidden("Your role cannot run classifications");
  }

  // Write path: own-organization sample only (shared projects are read-only).
  const sample = await getOwnSampleOrThrow(actor, sampleId);

  // Engine resolution — registry is the source of truth.
  const classModule = getClassModuleById(moduleId);
  if (!classModule) {
    throw new AppError(
      "UNSUPPORTED_CLASSIFICATION_ENGINE",
      422,
      `No classification engine is registered for module id ${moduleId}`,
      { moduleId },
    );
  }

  // Assemble the input payload — either from the sample's lab tests
  // (SAMPLE_DATA source, auto-invalidated on data change) or from an
  // explicit analyst payload (EXPLICIT source, deliberate snapshot).
  const inputSource = opts.input !== undefined ? "EXPLICIT" : "SAMPLE_DATA";
  let rawPayload: unknown;
  if (opts.input !== undefined) {
    rawPayload = opts.input;
  } else {
    const assembled = await assembleSampleClassificationInput(sample.id);
    rawPayload = assembled.payload;
  }

  // Payload size guard.
  const encoded = JSON.stringify(rawPayload ?? null);
  if (encoded.length > MAX_INPUT_CHARS) {
    throw Errors.validation(
      `Classification input exceeds the maximum accepted size (${MAX_INPUT_CHARS} characters)`,
    );
  }

  const fingerprint = fingerprintClassificationInput(classModule, rawPayload);

  // Dry run: pure validation + execution — no replay, no dedup, no writes.
  if (opts.dryRun === true) {
    const outcome = runClassification(classModule, rawPayload);
    return { record: null, outcome, replayed: false, deduplicated: false, dryRun: true };
  }

  // Execute — the generic engine pipeline (validate → compute → guard).
  const outcome = runClassification(classModule, rawPayload);
  const ok = outcome.status === "ok";

  // Critical section — serialized per sample.
  const result = await withSampleLock(sample.id, async (): Promise<ClassifyResult> => {
    // Idempotency replay.
    if (opts.idempotencyKey !== undefined) {
      const existing = await db.classificationRecord.findFirst({
        where: { sampleId: sample.id, idempotencyKey: opts.idempotencyKey },
        include: DETAIL_INCLUDE,
      });
      if (existing) {
        return {
          record: serializeClassificationDetail(existing),
          outcome: outcomeFromRecord(existing),
          replayed: true,
          deduplicated: false,
          dryRun: false,
        };
      }
    }

    // Duplicate suppression for sample-data classifications.
    if (inputSource === "SAMPLE_DATA" && ok) {
      const dedupHit = await db.classificationRecord.findFirst({
        where: {
          sampleId: sample.id,
          moduleId: classModule.id,
          moduleVersion: classModule.version,
          engineVersion: CLASSIFICATION_ENGINE_VERSION,
          inputSource: "SAMPLE_DATA",
          inputFingerprint: fingerprint,
          isValid: true,
          status: "COMPLETED",
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: DETAIL_INCLUDE,
      });
      if (dedupHit) {
        return {
          record: serializeClassificationDetail(dedupHit),
          outcome: outcomeFromRecord(dedupHit),
          replayed: false,
          deduplicated: true,
          dryRun: false,
        };
      }
    }

    const isRecalculation =
      (await db.classificationRecord.findFirst({
        where: { sampleId: sample.id, moduleId: classModule.id },
        select: { id: true },
      })) !== null;

    const snapshotValue = ok ? outcome.input : (rawPayload ?? null);

    let created: Prisma.ClassificationRecordGetPayload<{ include: typeof DETAIL_INCLUDE }>;
    try {
      created = await db.classificationRecord.create({
        data: {
          organizationId: sample.borehole.project.organizationId,
          projectId: sample.borehole.project.id,
          sampleId: sample.id,
          moduleId: classModule.id,
          moduleVersion: classModule.version,
          engineVersion: CLASSIFICATION_ENGINE_VERSION,
          status: ok ? "COMPLETED" : "FAILED",
          inputSource,
          inputSnapshot:
            snapshotValue === null || snapshotValue === undefined
              ? Prisma.JsonNull
              : (snapshotValue as Prisma.InputJsonValue),
          inputFingerprint: fingerprint,
          ...(ok
            ? {
                output: { raw: outcome.raw, results: outcome.results } as Prisma.InputJsonValue,
                warnings: outcome.warnings as unknown as Prisma.InputJsonValue,
              }
            : {
                errorCode: outcome.error.code,
                errorMessage: outcome.error.message,
                ...(outcome.error.details !== undefined
                  ? { errorDetails: outcome.error.details as Prisma.InputJsonValue }
                  : {}),
              }),
          standard: classModule.standard,
          standardVersion: classModule.standardVersion,
          ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
          createdById: actor.id,
        },
        include: DETAIL_INCLUDE,
      });
    } catch (e) {
      // Cross-process race on the same idempotency key — replay the winner.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002" &&
        opts.idempotencyKey !== undefined
      ) {
        const existing = await db.classificationRecord.findFirst({
          where: { sampleId: sample.id, idempotencyKey: opts.idempotencyKey },
          include: DETAIL_INCLUDE,
        });
        if (existing) {
          return {
            record: serializeClassificationDetail(existing),
            outcome: outcomeFromRecord(existing),
            replayed: true,
            deduplicated: false,
            dryRun: false,
          };
        }
      }
      throw e;
    }

    // Activity audit (best-effort, after commit).
    await logActivity({
      organizationId: actor.organizationId,
      userId: actor.id,
      action: isRecalculation
        ? ACTIVITY_ACTIONS.CALCULATION_RECALCULATED
        : ACTIVITY_ACTIONS.CALCULATION_CREATED,
      entityType: "ClassificationRecord",
      entityId: created.id,
      details: {
        moduleId: classModule.id,
        moduleVersion: classModule.version,
        inputSource,
        status: ok ? "COMPLETED" : "FAILED",
      },
    });
    await logActivity({
      organizationId: actor.organizationId,
      userId: actor.id,
      action: ok ? ACTIVITY_ACTIONS.CALCULATION_COMPLETED : ACTIVITY_ACTIONS.CALCULATION_FAILED,
      entityType: "ClassificationRecord",
      entityId: created.id,
      details: ok
        ? {
            moduleId: classModule.id,
            warningCount: outcome.warnings.length,
          }
        : {
            moduleId: classModule.id,
            errorCode: outcome.error.code,
          },
    });

    return {
      record: serializeClassificationDetail(created),
      outcome,
      replayed: false,
      deduplicated: false,
      dryRun: false,
    };
  });

  return result;
}

/** Rebuild a compact outcome envelope from a persisted record. */
function outcomeFromRecord(
  record: Prisma.ClassificationRecordGetPayload<{ include: typeof DETAIL_INCLUDE }>,
): unknown {
  if (record.status === "COMPLETED") {
    const output = (record.output ?? {}) as { raw?: unknown; results?: unknown };
    return {
      status: "ok",
      engineVersion: record.engineVersion,
      moduleId: record.moduleId,
      moduleVersion: record.moduleVersion,
      sourceType: "SAMPLE",
      standard: record.standard,
      standardVersion: record.standardVersion,
      raw: output.raw ?? null,
      results: output.results ?? null,
      warnings: record.warnings ?? [],
    };
  }
  return {
    status: "error",
    engineVersion: record.engineVersion,
    moduleId: record.moduleId,
    moduleVersion: record.moduleVersion,
    sourceType: "SAMPLE",
    standard: record.standard,
    standardVersion: record.standardVersion,
    error: {
      code: record.errorCode ?? "INTERNAL_ERROR",
      message: record.errorMessage ?? "Classification failed",
      ...(record.errorDetails !== null && record.errorDetails !== undefined
        ? { details: record.errorDetails }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Retrieval (reads: own organization or approved project share)
// ---------------------------------------------------------------------------

export interface ListClassificationsOptions {
  status?: string;
  isValid?: boolean;
  moduleId?: string;
  page?: number;
  pageSize?: number;
}

export async function listSampleClassifications(
  actor: SessionUser,
  sampleId: string,
  opts: ListClassificationsOptions = {},
) {
  await getAccessibleSampleOrThrow(actor, sampleId);
  const page = Math.max(opts.page ?? 1, 1);
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 100);
  const where = {
    sampleId,
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.isValid !== undefined ? { isValid: opts.isValid } : {}),
    ...(opts.moduleId ? { moduleId: opts.moduleId } : {}),
  };
  const [rows, total] = await Promise.all([
    db.classificationRecord.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: LIST_SELECT,
    }),
    db.classificationRecord.count({ where }),
  ]);
  return {
    items: rows.map(serializeClassificationListItem),
    total,
    page,
    pageSize,
  };
}

/**
 * The latest VALID classification for a sample + module: newest record
 * computed from CURRENT data (isValid = true) that completed successfully.
 * 404 when none exists.
 */
export async function getLatestValidClassification(
  actor: SessionUser,
  sampleId: string,
  moduleId: string,
) {
  const { sample, source } = await getAccessibleSampleOrThrow(actor, sampleId);
  const record = await db.classificationRecord.findFirst({
    where: {
      sampleId: sample.id,
      moduleId,
      inputSource: "SAMPLE_DATA",
      isValid: true,
      status: "COMPLETED",
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: DETAIL_INCLUDE,
  });
  if (!record) {
    throw Errors.notFound("Valid classification");
  }
  return { classification: serializeClassificationDetail(record), accessSource: source };
}

/** Classification detail by record id — tenancy via the sample access chain. */
export async function getClassification(actor: SessionUser, classificationId: string) {
  const classification = await db.classificationRecord.findUnique({
    where: { id: classificationId },
    include: DETAIL_INCLUDE,
  });
  if (!classification) {
    throw Errors.notFound("Classification");
  }
  const { source } = await getAccessibleSampleOrThrow(actor, classification.sampleId);
  return { classification: serializeClassificationDetail(classification), accessSource: source };
}

// ---------------------------------------------------------------------------
// Invalidation — called from the lab-tests service
// ---------------------------------------------------------------------------

/**
 * Invalidate SAMPLE_DATA-sourced classifications of a sample whose inputs
 * changed. Runs INSIDE the caller's transaction (atomic with the lab-test
 * data change — no partially invalidated state).
 *
 * Triggered when EITHER the granulometry OR the Atterberg lab test of the
 * sample has its resultData changed (re-recorded or cleared). The
 * fingerprint is recomputed over the full sample-derived payload (granulometry
 * + Atterberg) — any change to either input invalidates records whose
 * fingerprint differs.
 *
 * Returns the number of invalidated records (0 ⇒ no-op, no activity row —
 * existing suites' behavior stays byte-identical when no classifications
 * exist).
 */
export async function invalidateStaleClassifications(
  tx: Prisma.TransactionClient,
  sampleId: string,
): Promise<number> {
  // Re-assemble the current sample-derived payload (best-effort — if assembly
  // fails because the granulometry is gone, invalidate all SAMPLE_DATA
  // classifications of the sample).
  let fingerprint: string | null = null;
  try {
    // Read the sample's lab tests INSIDE the caller's transaction — the new
    // data is already visible (this runs after the lab-test update commit
    // inside the same tx).
    const labTests = await tx.labTest.findMany({
      where: { sampleId },
      select: { testType: true, resultData: true },
    });
    const granulometry = labTests.find((t) => t.testType === "GRANULOMETRY");
    const atterberg = labTests.find((t) => t.testType === "ATTERBERG_LIMITS");
    if (!granulometry || !granulometry.resultData) {
      fingerprint = null; // granulometry gone → invalidate all
    } else {
      const granData = granulometry.resultData as GranulometryResult;
      if (!Array.isArray(granData.points)) {
        fingerprint = null;
      } else {
        const sortedPoints = [...granData.points]
          .map((p) => ({ diameterMm: Number(p.diameterMm), percentFiner: Number(p.percentFiner) }))
          .sort((a, b) => a.diameterMm - b.diameterMm);
        let atterbergValue: AtterbergResult | undefined;
        if (atterberg && atterberg.resultData) {
          const att = atterberg.resultData as Partial<AtterbergResult>;
          if (
            typeof att.liquidLimit === "number" &&
            typeof att.plasticLimit === "number" &&
            typeof att.plasticityIndex === "number"
          ) {
            atterbergValue = {
              liquidLimit: att.liquidLimit,
              plasticLimit: att.plasticLimit,
              plasticityIndex: att.plasticityIndex,
            };
          }
        }
        const payload = {
          points: sortedPoints,
          ...(atterbergValue ? { atterberg: atterbergValue } : {}),
        };
        // Fingerprint the canonical JSON directly (no module parse — the
        // module may not be loadable here, and we want invalidation to fire
        // on ANY change to the payload, even ones the module would strip).
        fingerprint = fingerprintInput(payload);
      }
    }
  } catch {
    fingerprint = null; // assembly failed → invalidate all
  }

  const reason = fingerprint === null ? "SAMPLE_INPUT_CLEARED" : "SAMPLE_INPUT_UPDATED";

  const { count } = await tx.classificationRecord.updateMany({
    where: {
      sampleId,
      inputSource: "SAMPLE_DATA",
      isValid: true,
      ...(fingerprint !== null ? { inputFingerprint: { not: fingerprint } } : {}),
    },
    data: { isValid: false, invalidatedAt: new Date(), invalidatedReason: reason },
  });
  return count;
}

/** Audit row for an invalidation batch (best-effort, after commit). */
export async function logClassificationInvalidation(args: {
  organizationId: string;
  userId: string;
  sampleId: string;
  count: number;
  reason: string;
}) {
  await logActivity({
    organizationId: args.organizationId,
    userId: args.userId,
    action: ACTIVITY_ACTIONS.CALCULATION_INVALIDATED, // reuse — same audit semantic
    entityType: "ClassificationRecord",
    entityId: args.sampleId,
    details: {
      sampleId: args.sampleId,
      count: args.count,
      reason: args.reason,
    },
  });
}
