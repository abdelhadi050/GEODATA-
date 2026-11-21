/**
 * GEODATA HUB — Calculation service (M5.2 Integration).
 *
 * The shared service that connects the calculation engine registry
 * (src/lib/calc/registry.ts — the source of truth for engines) with database
 * persistence (CalculationRecord). Every engine runs through the generic
 * `runCalculation` pipeline; NO calculation formula is duplicated here.
 *
 * Layering (docs/14 §3, preserved):
 *   API routes → this service → calc registry (pure modules) + Prisma
 *   The engines remain independent of HTTP and database infrastructure.
 *
 * RBAC (existing matrix, no new hierarchy):
 *   - Creating / recalculating: LAB_TEST_RESULT (ORG_ADMIN, PROJECT_MANAGER,
 *     ENGINEER) on an own-organization test — the same policy as recording
 *     lab results.
 *   - Reading (history, latest, detail, project listing): the tenancy access
 *     chain (own organization, or an approved project share) — the same guard
 *     as every other lab-test read. LAB_TEST_VIEW is universal in the matrix.
 *   - Authorization is enforced SERVER-SIDE only; foreign and shared-project
 *     resources surface as NOT_FOUND (no existence leak).
 *
 * Persistence semantics:
 *   - Records are IMMUTABLE SNAPSHOTS: one row per execution, final status
 *     written in a single atomic INSERT (no observable PENDING state, no
 *     status-update races; PENDING is reserved for future async execution).
 *   - Idempotency: a client-supplied idempotencyKey replays the original
 *     record on accidental retries (@@unique([labTestId, idempotencyKey])).
 *   - Duplicate suppression without a key: a RESULT_DATA-sourced calculation
 *     whose parsed input fingerprint, module and engine versions match the
 *     current valid record replays it (the engines are deterministic, so
 *     identical input ⇒ identical output — re-execution is safely avoidable).
 *   - Failed calculations are PERSISTED (status FAILED + engine error
 *     taxonomy), never silently discarded; they are distinguishable from
 *     infrastructure errors, which use the uniform error envelope.
 *
 * Invalidation (Phase E): see invalidateStaleCalculations — called from the
 * lab-tests service inside the same transaction that changes resultData.
 */
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { SessionUser } from "@/lib/auth";
import { AppError, Errors } from "@/lib/errors";
import { db } from "@/lib/db";
import { can, CAPABILITIES } from "@/lib/rbac";
import { CALCULATION_STATUSES, type CalculationStatus, type CalculationInputSource } from "@/lib/constants";
import { CALCULATION_ENGINE_VERSION, runCalculation } from "@/lib/calc/engine";
import {
  adaptResultDataForModule,
  describeCalculationMethod,
  getCalcModuleForTestType,
  type RegisteredCalculationModule,
} from "@/lib/calc/registry";
import { getLabTestDefinition } from "@/lib/lab-tests/registry";
import {
  getAccessibleLabTestOrThrow,
  getAccessibleProjectOrThrow,
  getOwnLabTestOrThrow,
} from "./access";
import { ACTIVITY_ACTIONS, logActivity } from "./activity";

/** Maximum accepted input payload size (canonical JSON characters). */
const MAX_INPUT_CHARS = 256 * 1024;

export type { CalculationStatus, CalculationInputSource };
export { CALCULATION_STATUSES };

// ---------------------------------------------------------------------------
// Per-lab-test serialization (in-process)
// ---------------------------------------------------------------------------

/**
 * Per-lab-test async mutex: at most one calculation / result-mutation
 * critical section runs per test at a time within this process.
 *
 * Rationale: SQLite is a single-writer database — concurrent interactive
 * transactions contend on the file-level writer lock (observed as socket
 * timeouts under concurrent Calculate requests). Serializing the short
 * critical sections at the application level matches the database's own
 * concurrency model and makes idempotency/dedup re-checks race-free
 * in-process. Cross-process (multi-instance production) correctness still
 * rests on the database guarantees: the idempotency unique index (P2002
 * replay) and the atomic single-statement writes; keyless concurrent
 * duplicates across processes are benign (identical deterministic outputs,
 * deterministic latest-valid selection) — documented limitation.
 */
const labTestLocks = new Map<string, Promise<unknown>>();

export async function withLabTestLock<T>(labTestId: string, fn: () => Promise<T>): Promise<T> {
  const prev = labTestLocks.get(labTestId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  labTestLocks.set(labTestId, tail);
  void tail.then(() => {
    if (labTestLocks.get(labTestId) === tail) labTestLocks.delete(labTestId);
  });
  return run;
}

// ---------------------------------------------------------------------------
// Fingerprinting (input snapshots)
// ---------------------------------------------------------------------------

/**
 * Canonical JSON: object keys sorted recursively (arrays keep their order —
 * measurement order is semantically meaningful), then JSON.stringify.
 * Numbers serialize through JSON (finite by construction — payloads arrive
 * from req.json() or the registry-validated database Json columns).
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
 * Fingerprint the CALCULABLE input: the module-parsed payload when the module
 * accepts it (semantically meaningful changes only — unknown-key edits do not
 * invalidate), the raw payload otherwise (validation-failed records are
 * fingerprinted by what was submitted).
 */
function fingerprintCalculationInput(
  calcModule: RegisteredCalculationModule,
  rawPayload: unknown,
): string {
  try {
    return fingerprintInput(calcModule.validateInput(rawPayload));
  } catch {
    return fingerprintInput(rawPayload);
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Fields selected for LIST payloads (no output/input snapshots — lean). */
const LIST_SELECT = {
  id: true,
  labTestId: true,
  testType: true,
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
  method: true,
  standard: true,
  idempotencyKey: true,
  warnings: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { id: true, name: true } },
} as const;

type ListRow = Prisma.CalculationRecordGetPayload<{ select: typeof LIST_SELECT }>;

export function serializeCalculationListItem(row: ListRow) {
  const warnings = Array.isArray(row.warnings) ? row.warnings : [];
  return {
    id: row.id,
    labTestId: row.labTestId,
    testType: row.testType,
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
    method: row.method,
    standard: row.standard,
    idempotencyKey: row.idempotencyKey,
    warningCount: warnings.length,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy,
  };
}

/** Full detail payload: everything persisted, plus lab-test context. */
export function serializeCalculationDetail(
  record: Prisma.CalculationRecordGetPayload<{
    include: {
      createdBy: { select: { id: true; name: true } };
      labTest: {
        include: {
          sample: {
            include: {
              borehole: { include: { project: { select: { id: true; code: true; name: true } } } };
            };
          };
        };
      };
    };
  }>,
) {
  return {
    ...serializeCalculationListItem(record),
    inputSnapshot: record.inputSnapshot,
    output: record.output,
    warnings: record.warnings,
    errorMessage: record.errorMessage,
    errorDetails: record.errorDetails,
    units: record.units,
    labTest: {
      id: record.labTest.id,
      testType: record.labTest.testType,
      status: record.labTest.status,
      sample: {
        id: record.labTest.sample.id,
        code: record.labTest.sample.code,
        borehole: {
          id: record.labTest.sample.borehole.id,
          code: record.labTest.sample.borehole.code,
          project: record.labTest.sample.borehole.project,
        },
      },
    },
  };
}

const DETAIL_INCLUDE = {
  createdBy: { select: { id: true, name: true } },
  labTest: {
    include: {
      sample: {
        include: {
          borehole: {
            include: { project: { select: { id: true, code: true, name: true } } },
          },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Calculate (submit → validate → execute → persist)
// ---------------------------------------------------------------------------

export interface CalculateLabTestOptions {
  /** Explicit input payload; when absent the stored resultData is used. */
  input?: Record<string, unknown>;
  /** Client-supplied retry key — replays the original record on collisions. */
  idempotencyKey?: string;
  /** Validate + execute WITHOUT persisting (pre-flight check). */
  dryRun?: boolean;
}

export interface CalculateResult {
  /** The persisted record (full detail shape). Null for dry runs. */
  record: ReturnType<typeof serializeCalculationDetail> | null;
  /** The raw engine outcome envelope (both dry runs and persisted runs). */
  outcome: unknown;
  replayed: boolean;
  deduplicated: boolean;
  dryRun: boolean;
}

/**
 * Run the registered calculation engine for a lab test and persist the
 * snapshot. The engine NEVER throws for calculation failures — failures are
 * persisted as FAILED records and returned in the outcome envelope.
 */
export async function calculateLabTest(
  actor: SessionUser,
  labTestId: string,
  opts: CalculateLabTestOptions = {},
): Promise<CalculateResult> {
  // RBAC — server-side, existing capability (same policy as recording results).
  if (!can(actor.role, CAPABILITIES.LAB_TEST_RESULT)) {
    await logActivity({
      organizationId: actor.organizationId,
      userId: actor.id,
      action: ACTIVITY_ACTIONS.CALCULATION_ACCESS_DENIED,
      entityType: "CalculationRecord",
      entityId: null,
      details: { attempted: "calculate", labTestId, reason: "missing capability labtest:result" },
    });
    throw Errors.forbidden("Your role cannot run calculations");
  }

  // Write path: own-organization test only (shared projects are read-only).
  const labTest = await getOwnLabTestOrThrow(actor, labTestId);

  // Engine resolution — registry is the source of truth.
  const calcModule = getCalcModuleForTestType(labTest.testType);
  if (!calcModule) {
    throw new AppError(
      "UNSUPPORTED_CALCULATION_ENGINE",
      422,
      `No calculation engine is registered for test type ${labTest.testType}`,
      { testType: labTest.testType },
    );
  }

  const inputSource: CalculationInputSource =
    opts.input !== undefined ? "EXPLICIT" : "RESULT_DATA";
  // RESULT_DATA payloads speak the REGISTRY field names — adapt them to the
  // engine input contract (documented field-name mappings only, e.g. the
  // oedometer `stages` → `loadingStages` rename; see adaptResultDataForModule).
  // Explicit analyst payloads already speak the engine contract directly.
  const rawPayload: unknown =
    opts.input !== undefined
      ? opts.input
      : adaptResultDataForModule(
          calcModule.id,
          labTest.resultData ?? null,
        );

  // Payload size guard (registry-validated resultData is bounded by design;
  // explicit request payloads are bounded here).
  const encoded = JSON.stringify(rawPayload ?? null);
  if (encoded.length > MAX_INPUT_CHARS) {
    throw Errors.validation(
      `Calculation input exceeds the maximum accepted size (${MAX_INPUT_CHARS} characters)`,
    );
  }

  const fingerprint = fingerprintCalculationInput(calcModule, rawPayload);

  // Dry run: pure validation + execution — no replay, no dedup, no reads,
  // no writes (predictable "what would the engine produce" semantics).
  if (opts.dryRun === true) {
    const outcome = runCalculation(calcModule, rawPayload);
    return { record: null, outcome, replayed: false, deduplicated: false, dryRun: true };
  }

  // Execute — the generic engine pipeline (validate → compute → guard).
  // Pure and deterministic; running it before the critical section is safe.
  const outcome = runCalculation(calcModule, rawPayload);
  const ok = outcome.status === "ok";

  const def = getLabTestDefinition(labTest.testType);

  // Critical section — serialized per lab test (see withLabTestLock).
  const result = await withLabTestLock(labTest.id, async (): Promise<CalculateResult> => {
    // Idempotency replay: a retried request with the same key returns the
    // original record instead of creating a duplicate.
    if (opts.idempotencyKey !== undefined) {
      const existing = await db.calculationRecord.findFirst({
        where: { labTestId: labTest.id, idempotencyKey: opts.idempotencyKey },
        include: DETAIL_INCLUDE,
      });
      if (existing) {
        return {
          record: serializeCalculationDetail(existing),
          outcome: outcomeFromRecord(existing),
          replayed: true,
          deduplicated: false,
          dryRun: false,
        };
      }
    }

    // Duplicate suppression for stored-data calculations: identical parsed
    // input + identical engine versions ⇒ deterministic identical output, so
    // the current valid record is replayed instead of re-executed/re-stored.
    // (Explicit analyst payloads are deliberate submissions — always fresh;
    // failed attempts are individually recorded for audit.)
    if (inputSource === "RESULT_DATA" && ok) {
      const dedupHit = await db.calculationRecord.findFirst({
        where: {
          labTestId: labTest.id,
          moduleId: calcModule.id,
          moduleVersion: calcModule.version,
          engineVersion: CALCULATION_ENGINE_VERSION,
          inputSource: "RESULT_DATA",
          inputFingerprint: fingerprint,
          isValid: true,
          status: "COMPLETED",
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: DETAIL_INCLUDE,
      });
      if (dedupHit) {
        return {
          record: serializeCalculationDetail(dedupHit),
          outcome: outcomeFromRecord(dedupHit),
          replayed: false,
          deduplicated: true,
          dryRun: false,
        };
      }
    }

    const isRecalculation =
      (await db.calculationRecord.findFirst({
        where: { labTestId: labTest.id, moduleId: calcModule.id },
        select: { id: true },
      })) !== null;

    // The snapshot actually consumed: the module-parsed input on success,
    // the submitted payload on validation failure (JSON null when nothing
    // was supplied — Prisma.JsonNull, never SQL NULL: the column is NOT NULL).
    const snapshotValue = ok ? outcome.input : (rawPayload ?? null);

    // Persist — ONE atomic insert in the final state (a single-statement
    // transaction: no observable PENDING, no status-update races; the
    // idempotency unique index + P2002 catch below is the hard guarantee).
    let created: Prisma.CalculationRecordGetPayload<{ include: typeof DETAIL_INCLUDE }>;
    try {
      created = await db.calculationRecord.create({
        data: {
          organizationId: labTest.sample.borehole.project.organizationId,
          projectId: labTest.sample.borehole.project.id,
          labTestId: labTest.id,
          testType: labTest.testType,
          moduleId: calcModule.id,
          moduleVersion: calcModule.version,
          engineVersion: CALCULATION_ENGINE_VERSION,
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
                method: describeCalculationMethod(calcModule.id, outcome.results),
              }
            : {
                errorCode: outcome.error.code,
                errorMessage: outcome.error.message,
                ...(outcome.error.details !== undefined
                  ? { errorDetails: outcome.error.details as Prisma.InputJsonValue }
                  : {}),
              }),
          ...(def ? { standard: def.standard, units: def.units as Prisma.InputJsonValue } : {}),
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
        const existing = await db.calculationRecord.findFirst({
          where: { labTestId: labTest.id, idempotencyKey: opts.idempotencyKey },
          include: DETAIL_INCLUDE,
        });
        if (existing) {
          return {
            record: serializeCalculationDetail(existing),
            outcome: outcomeFromRecord(existing),
            replayed: true,
            deduplicated: false,
            dryRun: false,
          };
        }
      }
      throw e;
    }

    // Activity audit (best-effort, after commit — never blocks the response).
    await logActivity({
      organizationId: actor.organizationId,
      userId: actor.id,
      action: isRecalculation
        ? ACTIVITY_ACTIONS.CALCULATION_RECALCULATED
        : ACTIVITY_ACTIONS.CALCULATION_CREATED,
      entityType: "CalculationRecord",
      entityId: created.id,
      details: {
        testType: labTest.testType,
        moduleId: calcModule.id,
        moduleVersion: calcModule.version,
        inputSource,
        status: ok ? "COMPLETED" : "FAILED",
      },
    });
    await logActivity({
      organizationId: actor.organizationId,
      userId: actor.id,
      action: ok ? ACTIVITY_ACTIONS.CALCULATION_COMPLETED : ACTIVITY_ACTIONS.CALCULATION_FAILED,
      entityType: "CalculationRecord",
      entityId: created.id,
      details: ok
        ? {
            testType: labTest.testType,
            moduleId: calcModule.id,
            warningCount: outcome.warnings.length,
          }
        : {
            testType: labTest.testType,
            moduleId: calcModule.id,
            errorCode: outcome.error.code,
          },
    });

    return {
      record: serializeCalculationDetail(created),
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
  record: Prisma.CalculationRecordGetPayload<{ include: typeof DETAIL_INCLUDE }>,
): unknown {
  if (record.status === "COMPLETED") {
    const output = (record.output ?? {}) as { raw?: unknown; results?: unknown };
    return {
      status: "ok",
      engineVersion: record.engineVersion,
      moduleId: record.moduleId,
      moduleVersion: record.moduleVersion,
      testType: record.testType,
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
    testType: record.testType,
    error: {
      code: record.errorCode ?? "INTERNAL_ERROR",
      message: record.errorMessage ?? "Calculation failed",
      ...(record.errorDetails !== null && record.errorDetails !== undefined
        ? { details: record.errorDetails }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Retrieval (reads: own organization or approved project share)
// ---------------------------------------------------------------------------

export interface ListCalculationsOptions {
  status?: CalculationStatus;
  isValid?: boolean;
  moduleId?: string;
  testType?: string;
  page?: number;
  pageSize?: number;
}

export async function listLabTestCalculations(
  actor: SessionUser,
  labTestId: string,
  opts: ListCalculationsOptions = {},
) {
  await getAccessibleLabTestOrThrow(actor, labTestId);
  const page = Math.max(opts.page ?? 1, 1);
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 100);
  const where = {
    labTestId,
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.isValid !== undefined ? { isValid: opts.isValid } : {}),
    ...(opts.moduleId ? { moduleId: opts.moduleId } : {}),
  };
  const [rows, total] = await Promise.all([
    db.calculationRecord.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: LIST_SELECT,
    }),
    db.calculationRecord.count({ where }),
  ]);
  return {
    items: rows.map(serializeCalculationListItem),
    total,
    page,
    pageSize,
  };
}

/**
 * The latest VALID result: newest record computed from CURRENT data
 * (isValid = true) that completed successfully. 404 when none exists.
 *
 * Only RESULT_DATA-sourced records qualify: explicit analyst snapshots are
 * retrievable through history/detail but never presented as the test's
 * current result (they are what-if/persisted-analysis records, not results
 * of the stored lab data).
 */
export async function getLatestValidCalculation(actor: SessionUser, labTestId: string) {
  const { labTest, source } = await getAccessibleLabTestOrThrow(actor, labTestId);
  const record = await db.calculationRecord.findFirst({
    where: {
      labTestId: labTest.id,
      inputSource: "RESULT_DATA",
      isValid: true,
      status: "COMPLETED",
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: DETAIL_INCLUDE,
  });
  if (!record) {
    throw Errors.notFound("Valid calculation");
  }
  return { calculation: serializeCalculationDetail(record), accessSource: source };
}

/** Calculation detail by record id — tenancy via the lab-test access chain. */
export async function getCalculation(actor: SessionUser, calculationId: string) {
  const calculation = await db.calculationRecord.findUnique({
    where: { id: calculationId },
    include: DETAIL_INCLUDE,
  });
  if (!calculation) {
    throw Errors.notFound("Calculation");
  }
  const { source } = await getAccessibleLabTestOrThrow(actor, calculation.labTestId);
  return { calculation: serializeCalculationDetail(calculation), accessSource: source };
}

/** Project-scoped listing (own organization or actively shared project). */
export async function listProjectCalculations(
  actor: SessionUser,
  projectId: string,
  opts: ListCalculationsOptions = {},
) {
  await getAccessibleProjectOrThrow(actor, projectId);
  const page = Math.max(opts.page ?? 1, 1);
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 100);
  const where = {
    projectId,
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.isValid !== undefined ? { isValid: opts.isValid } : {}),
    ...(opts.moduleId ? { moduleId: opts.moduleId } : {}),
    ...(opts.testType ? { testType: opts.testType } : {}),
  };
  const [rows, total] = await Promise.all([
    db.calculationRecord.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: LIST_SELECT,
    }),
    db.calculationRecord.count({ where }),
  ]);
  return {
    items: rows.map(serializeCalculationListItem),
    total,
    page,
    pageSize,
  };
}

// ---------------------------------------------------------------------------
// Invalidation (Phase E) — called from the lab-tests service
// ---------------------------------------------------------------------------

/**
 * Invalidate RESULT_DATA-sourced calculations of a lab test whose inputs
 * changed. Runs INSIDE the caller's transaction (atomic with the data
 * change — no partially invalidated state).
 *
 * fingerprint semantics: the new resultData is fingerprinted through the
 * module's own parse (parsed when accepted, raw otherwise). Records whose
 * fingerprint differs — and ALL records when the new data is cleared or not
 * parseable — are marked stale (isValid = false) with a reason, PRESERVED as
 * history. EXPLICIT-sourced snapshots are deliberate analyst submissions and
 * are never auto-invalidated.
 *
 * Returns the number of invalidated records (0 ⇒ no-op, no activity row —
 * existing suites' behavior stays byte-identical when no calculations exist).
 */
export async function invalidateStaleCalculations(
  tx: Prisma.TransactionClient,
  labTest: { id: string; testType: string },
  newResultData: unknown,
): Promise<number> {
  const calcModule = getCalcModuleForTestType(labTest.testType);
  if (!calcModule) return 0; // no engine for this test type ⇒ no records possible

  const cleared =
    newResultData === null || newResultData === undefined;
  const reason = cleared ? "LAB_TEST_RESULT_CLEARED" : "LAB_TEST_RESULT_UPDATED";

  let fingerprint: string | null = null;
  if (!cleared) {
    try {
      // Same adaptation as the calculation path — fingerprints are computed
      // over the engine-contract payload on both sides.
      const adapted = adaptResultDataForModule(calcModule.id, newResultData);
      fingerprint = fingerprintInput(calcModule.validateInput(adapted));
    } catch {
      fingerprint = null; // new data not calculable ⇒ invalidate all
    }
  }

  const { count } = await tx.calculationRecord.updateMany({
    where: {
      labTestId: labTest.id,
      inputSource: "RESULT_DATA",
      isValid: true,
      ...(fingerprint !== null ? { inputFingerprint: { not: fingerprint } } : {}),
    },
    data: { isValid: false, invalidatedAt: new Date(), invalidatedReason: reason },
  });
  return count;
}

/** Audit row for an invalidation batch (best-effort, after commit). */
export async function logCalculationInvalidation(args: {
  organizationId: string;
  userId: string;
  labTestId: string;
  testType: string;
  count: number;
  reason: string;
}) {
  await logActivity({
    organizationId: args.organizationId,
    userId: args.userId,
    action: ACTIVITY_ACTIONS.CALCULATION_INVALIDATED,
    entityType: "CalculationRecord",
    entityId: args.labTestId,
    details: {
      labTestId: args.labTestId,
      testType: args.testType,
      count: args.count,
      reason: args.reason,
    },
  });
}
