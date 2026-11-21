/**
 * GEODATA HUB — Laboratory tests service.
 * Result data is ALWAYS validated against the lab-test registry (Zod) before
 * storage — structured per test type, never arbitrary JSON. Since M5.1 the
 * same holds for test-definition inputs (`inputData`), which are validated
 * by the registry inputSchema and follow the approved editability rule:
 * inputs lock once a result exists; re-opening a test clears its result and
 * re-enables input editing.
 */
import type { SessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Errors } from "@/lib/errors";
import { can, CAPABILITIES } from "@/lib/rbac";
import {
  createLabTestSchema,
  updateLabTestSchema,
} from "@/lib/validation/lab-test";
import type { CreateLabTestInput, UpdateLabTestInput } from "@/lib/validation/lab-test";
import { parseOrThrow } from "@/lib/validation/parse";
import { Prisma } from "@prisma/client";
import { LAB_TEST_REGISTRY, isLabTestType } from "@/lib/lab-tests/registry";
import { parseLabTestResult, parseLabTestInput } from "@/lib/lab-tests/registry";
import {
  getAccessibleLabTestOrThrow,
  getAccessibleProjectIds,
  getOwnLabTestOrThrow,
  getOwnSampleOrThrow,
} from "./access";
import { logActivity, ACTIVITY_ACTIONS } from "./activity";
// M5.2 Integration — dependency-aware calculation invalidation. When a lab
// test's resultData changes (re-recorded or cleared by re-opening),
// calculations made from the previous data are marked stale IN THE SAME
// TRANSACTION (no partially invalidated state). No-op when no calculation
// records exist — existing behavior stays byte-identical.
import {
  invalidateStaleCalculations,
  logCalculationInvalidation,
  withLabTestLock,
} from "./calculations";
// M5.4 Classification & Reports — classification invalidation. When a
// GRANULOMETRY or ATTERBERG_LIMITS result changes, classifications for the
// sample are invalidated in the same transaction. Classifications consume
// both inputs (PSD + Atterberg), so a change to either invalidates all
// SAMPLE_DATA-sourced classifications of the sample.
import {
  invalidateStaleClassifications,
  logClassificationInvalidation,
} from "./classifications";

/** Lab test types whose resultData feeds classification engines. */
const CLASSIFICATION_INPUT_TEST_TYPES = new Set(["GRANULOMETRY", "ATTERBERG_LIMITS"]);

export interface ListLabTestsOptions {
  sampleId?: string;
  boreholeId?: string;
  projectId?: string;
  testType?: string;
  status?: string;
  search?: string;
  page?: number;
  pageSize?: number;
  /**
   * M5.1 (approved D3) — accepted opt-in projection flag. The list payload
   * has always included resultData (the original query used Prisma `include`,
   * which returns every scalar — verified empirically in M5.1), so keeping
   * the default response unchanged means resultData stays included whether
   * or not this flag is set. The flag is deliberately a no-op: no client can
   * observe a payload-shape change either way.
   */
  include?: "resultData";
}

export async function listLabTests(actor: SessionUser, opts: ListLabTestsOptions = {}) {
  const { ownIds, sharedIds } = await getAccessibleProjectIds(actor);
  const visibleProjectIds = [...ownIds, ...sharedIds];
  const page = Math.max(opts.page ?? 1, 1);
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);

  const where = {
    sample: { borehole: { project: { id: { in: visibleProjectIds } } } },
    ...(opts.sampleId ? { sampleId: opts.sampleId } : {}),
    ...(opts.boreholeId ? { sample: { boreholeId: opts.boreholeId } } : {}),
    ...(opts.projectId ? { sample: { borehole: { projectId: opts.projectId } } } : {}),
    ...(opts.testType ? { testType: opts.testType } : {}),
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.search
      ? { OR: [{ summary: { contains: opts.search } }, { performedBy: { contains: opts.search } }] }
      : {}),
  };

  const [items, total] = await Promise.all([
    db.labTest.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      // M5.1: explicit select (previously a bare `include` of `sample`).
      // `include` returns EVERY scalar, so after adding the inputData column
      // the default list payload would have silently gained a new key. This
      // select pins the list item shape to exactly the fields it has always
      // exposed (including resultData, which was always present) — the
      // default response therefore remains unchanged. inputData is exposed
      // on the lab-test DETAIL endpoint only.
      select: {
        id: true,
        sampleId: true,
        testType: true,
        status: true,
        performedBy: true,
        performedAt: true,
        resultData: true,
        summary: true,
        notes: true,
        createdAt: true,
        updatedAt: true,
        sample: {
          select: {
            id: true,
            code: true,
            type: true,
            borehole: {
              select: {
                id: true,
                code: true,
                project: { select: { id: true, code: true, name: true } },
              },
            },
          },
        },
      },
    }),
    db.labTest.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

export async function getLabTest(actor: SessionUser, labTestId: string) {
  const { labTest, source } = await getAccessibleLabTestOrThrow(actor, labTestId);
  const detail = await db.labTest.findUniqueOrThrow({
    where: { id: labTest.id },
    include: {
      sample: {
        select: {
          id: true,
          code: true,
          type: true,
          depthFrom: true,
          depthTo: true,
          labStatus: true,
          borehole: {
            select: {
              id: true,
              code: true,
              project: { select: { id: true, code: true, name: true } },
            },
          },
        },
      },
    },
  });
  const def = isLabTestType(detail.testType)
    ? LAB_TEST_REGISTRY[detail.testType]
    : null;
  return {
    ...detail,
    accessSource: source,
    registry: def
      ? {
          label: def.label,
          units: def.units,
          chart: def.chart,
          validationNotes: def.validationNotes,
        }
      : null,
  };
}

export async function createLabTest(actor: SessionUser, input: CreateLabTestInput) {
  if (!can(actor.role, CAPABILITIES.LAB_TEST_MANAGE)) {
    throw Errors.forbidden("Your role cannot create laboratory tests");
  }
  const data = parseOrThrow(createLabTestSchema, input);
  // Parent-child validation: the sample must resolve to the ACTOR's org.
  const sample = await getOwnSampleOrThrow(actor, data.sampleId);

  const clash = await db.labTest.findUnique({
    where: { sampleId_testType: { sampleId: data.sampleId, testType: data.testType } },
  });
  if (clash) {
    throw Errors.conflict(
      `A ${LAB_TEST_REGISTRY[data.testType].label} test already exists for this sample`,
    );
  }

  // M5.1: optional test-definition inputs — validated per type by the
  // registry inputSchema before anything is stored (never arbitrary JSON).
  let inputPayload: unknown;
  if (data.input !== undefined) {
    const parsedInput = parseLabTestInput(data.testType, data.input);
    if (!parsedInput.ok) {
      throw Errors.validation("Laboratory test input failed validation", parsedInput.error);
    }
    inputPayload = parsedInput.data;
  }

  const labTest = await db.labTest.create({
    data: {
      sampleId: data.sampleId,
      testType: data.testType,
      status: "PENDING",
      notes: data.notes,
      ...(inputPayload !== undefined ? { inputData: inputPayload as never } : {}),
    },
  });

  await logActivity({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: ACTIVITY_ACTIONS.LAB_TEST_CREATED,
    entityType: "LabTest",
    entityId: labTest.id,
    // M5.1 (approved D7): existing action reused; input recording noted in
    // the details (no vocabulary growth). Inputs themselves are never copied
    // into activity details.
    details: {
      testType: data.testType,
      sampleCode: sample.code,
      ...(inputPayload !== undefined ? { inputRecorded: true } : {}),
    },
  });

  return labTest;
}

/**
 * Record a structured lab result. The payload is validated against the
 * registry schema for the test type; storage happens only on success.
 * M5.2 Integration: calculations made from the previous resultData are
 * invalidated atomically with the result update (stale inputs ⇒ stale
 * results are never presented as current).
 */
export async function recordLabTestResult(
  actor: SessionUser,
  labTestId: string,
  result: unknown,
  opts: { summary?: string } = {},
) {
  if (!can(actor.role, CAPABILITIES.LAB_TEST_RESULT)) {
    throw Errors.forbidden("Your role cannot record laboratory results");
  }
  const existing = await getOwnLabTestOrThrow(actor, labTestId);

  const parsed = parseLabTestResult(existing.testType, result);
  if (!parsed.ok) {
    throw Errors.validation("Laboratory result failed validation", parsed.error);
  }

  let invalidatedCount = 0;
  let invalidatedClassifications = 0;
  // Serialized with calculations on the same test (withLabTestLock): the
  // result update + invalidation commit atomically, and no calculation can
  // read the old data and insert after the invalidation has run.
  const labTest = await withLabTestLock(labTestId, () =>
    db.$transaction(async (tx) => {
      const updated = await tx.labTest.update({
        where: { id: labTestId },
        data: {
          resultData: parsed.data as never,
          status: "COMPLETED",
          performedBy: actor.name,
          performedAt: new Date(),
          ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
        },
      });
      invalidatedCount = await invalidateStaleCalculations(tx, existing, parsed.data);
      // M5.4: when a GRANULOMETRY or ATTERBERG_LIMITS result changes,
      // invalidate classifications for the sample too.
      if (CLASSIFICATION_INPUT_TEST_TYPES.has(existing.testType)) {
        invalidatedClassifications = await invalidateStaleClassifications(tx, existing.sampleId);
      }
      return updated;
    }),
  );

  await logActivity({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: ACTIVITY_ACTIONS.LAB_TEST_RESULT_RECORDED,
    entityType: "LabTest",
    entityId: labTestId,
    details: { testType: existing.testType, sampleCode: existing.sample.code },
  });

  if (invalidatedCount > 0) {
    await logCalculationInvalidation({
      organizationId: actor.organizationId,
      userId: actor.id,
      labTestId,
      testType: existing.testType,
      count: invalidatedCount,
      reason: "LAB_TEST_RESULT_UPDATED",
    });
  }
  if (invalidatedClassifications > 0) {
    await logClassificationInvalidation({
      organizationId: actor.organizationId,
      userId: actor.id,
      sampleId: existing.sampleId,
      count: invalidatedClassifications,
      reason: "SAMPLE_INPUT_UPDATED",
    });
  }

  return labTest;
}

export async function updateLabTest(
  actor: SessionUser,
  labTestId: string,
  input: UpdateLabTestInput,
) {
  if (!can(actor.role, CAPABILITIES.LAB_TEST_MANAGE)) {
    throw Errors.forbidden("Your role cannot edit laboratory tests");
  }
  const existing = await getOwnLabTestOrThrow(actor, labTestId);
  const data = parseOrThrow(updateLabTestSchema, input);

  // Re-opening a completed test clears the recorded result to avoid stale
  // data — and (M5.1, approved D2) re-enables input editing in the same
  // request, because the lock is tied to the presence of a result.
  const reopening =
    data.status !== undefined &&
    existing.status === "COMPLETED" &&
    data.status !== "COMPLETED";

  // M5.1: input editability rule — inputs are locked once a result exists;
  // re-opening the test (which clears its result) re-enables editing.
  let inputPayload: unknown;
  if (data.input !== undefined) {
    if (existing.resultData != null && !reopening) {
      throw Errors.conflict(
        "Test inputs are locked once a result is recorded — re-open the test (which clears its result) to edit inputs",
      );
    }
    const parsedInput = parseLabTestInput(existing.testType, data.input);
    if (!parsedInput.ok) {
      throw Errors.validation("Laboratory test input failed validation", parsedInput.error);
    }
    inputPayload = parsedInput.data;
  }

  if (reopening) {
    // M5.2 Integration: clearing the result also invalidates calculations
    // made from it — atomically (same transaction), history preserved,
    // serialized with concurrent calculations via the per-test lock.
    let invalidatedCount = 0;
    let invalidatedClassifications = 0;
    await withLabTestLock(labTestId, () =>
      db.$transaction(async (tx) => {
        await tx.labTest.update({
          where: { id: labTestId },
          data: { resultData: Prisma.DbNull },
        });
        invalidatedCount = await invalidateStaleCalculations(tx, existing, null);
        // M5.4: clearing a GRANULOMETRY or ATTERBERG_LIMITS result also
        // invalidates classifications for the sample.
        if (CLASSIFICATION_INPUT_TEST_TYPES.has(existing.testType)) {
          invalidatedClassifications = await invalidateStaleClassifications(tx, existing.sampleId);
        }
      }),
    );
    if (invalidatedCount > 0) {
      await logCalculationInvalidation({
        organizationId: actor.organizationId,
        userId: actor.id,
        labTestId,
        testType: existing.testType,
        count: invalidatedCount,
        reason: "LAB_TEST_RESULT_CLEARED",
      });
    }
    if (invalidatedClassifications > 0) {
      await logClassificationInvalidation({
        organizationId: actor.organizationId,
        userId: actor.id,
        sampleId: existing.sampleId,
        count: invalidatedClassifications,
        reason: "SAMPLE_INPUT_CLEARED",
      });
    }
  }

  const labTest = await db.labTest.update({
    where: { id: labTestId },
    data: {
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(inputPayload !== undefined ? { inputData: inputPayload as never } : {}),
    },
  });

  await logActivity({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: ACTIVITY_ACTIONS.LAB_TEST_STATUS_UPDATED,
    entityType: "LabTest",
    entityId: labTestId,
    // M5.1 (approved D7): existing action reused; input updates noted in the
    // details (no vocabulary growth). Inputs themselves are never copied
    // into activity details.
    details: {
      testType: existing.testType,
      status: data.status ?? labTest.status,
      ...(inputPayload !== undefined ? { inputUpdated: true } : {}),
    },
  });

  return labTest;
}

export async function deleteLabTest(actor: SessionUser, labTestId: string) {
  if (!can(actor.role, CAPABILITIES.LAB_TEST_MANAGE)) {
    throw Errors.forbidden("Your role cannot delete laboratory tests");
  }
  const labTest = await getOwnLabTestOrThrow(actor, labTestId);
  await db.labTest.delete({ where: { id: labTestId } });

  await logActivity({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: ACTIVITY_ACTIONS.LAB_TEST_DELETED,
    entityType: "LabTest",
    entityId: null,
    details: { testType: labTest.testType, sampleCode: labTest.sample.code },
  });

  return { deleted: true };
}
