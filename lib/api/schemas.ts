/**
 * GEODATA HUB — route-level API schemas (M3).
 *
 * Two families:
 *   1. Body schemas — STRICT variants of the M2 validation schemas
 *      (`schema.strict()`): unknown body keys are rejected with
 *      VALIDATION_ERROR instead of being silently stripped, so clients
 *      (and the M4 UI) catch typos early. Notably, clients can never
 *      smuggle `organizationId` into a body — it is not a recognized key
 *      anywhere, and services only ever derive it from the session.
 *   2. Query schemas — coerce URL strings (numbers, enums) and reject
 *      unexpected parameters. Pagination is bounded per domain to
 *      prevent unbounded result retrieval (page ≤ 10 000; pageSize
 *      capped to the matching service limit).
 *
 * Business validation lives in the shared M2 schemas; nothing here
 * duplicates a rule — strictness and coercion only.
 */
import { z } from "zod";
import {
  createProjectSchema,
  updateProjectSchema,
  projectBoundarySchema,
} from "@/lib/validation/project";
import { createBoreholeSchema, updateBoreholeSchema } from "@/lib/validation/borehole";
import { createLayerSchema, updateLayerSchema } from "@/lib/validation/layer";
import { createSampleSchema, updateSampleSchema } from "@/lib/validation/sample";
import { createLabTestSchema, updateLabTestSchema } from "@/lib/validation/lab-test";
import { createSharingRequestSchema, shareDecisionSchema } from "@/lib/validation/sharing";
import { createReportSchema } from "@/lib/validation/report";
import { updateDocumentSchema } from "@/lib/validation/document";
import {
  BOREHOLE_TYPES,
  BOREHOLE_STATUSES,
  PROJECT_STATUSES,
  SAMPLE_TYPES,
  LAB_STATUSES,
  LAB_TEST_STATUSES,
  CALCULATION_STATUSES,
  DOC_TYPES,
  REPORT_TYPES,
} from "@/lib/constants";
import { LAB_TEST_TYPES } from "@/lib/lab-tests/registry";

const idQ = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "Invalid id");
const pageQ = z.coerce.number().int().min(1).max(10_000).optional();
const sortDirQ = z.enum(["asc", "desc"]).optional();
const searchQ = z.string().trim().min(1).max(200).optional();
const pageSizeOf = (max: number) =>
  z.coerce.number().int().min(1).max(max).optional();

// ---------- Bodies ----------

export const createProjectBody = createProjectSchema.strict();
export const updateProjectBody = updateProjectSchema.strict();
export const projectBoundaryBody = projectBoundarySchema.strict();

export const createBoreholeBody = createBoreholeSchema.strict();
export const updateBoreholeBody = updateBoreholeSchema.strict();

export const createLayerBody = createLayerSchema.strict();
export const updateLayerBody = updateLayerSchema.strict();

export const createSampleBody = createSampleSchema.strict();
export const updateSampleBody = updateSampleSchema.strict();

export const createLabTestBody = createLabTestSchema.strict();
export const updateLabTestBody = updateLabTestSchema.strict();
/** The result payload itself is validated by the lab-test registry (per type) inside the service. */
export const labTestResultBody = z.strictObject({
  result: z.unknown(),
  summary: z.string().trim().max(200).optional(),
});

export const createSharingRequestBody = createSharingRequestSchema.strict();
export const sharingDecisionBody = z.strictObject({
  decision: shareDecisionSchema,
});

export const createReportBody = createReportSchema.strict();
export const updateDocumentBody = updateDocumentSchema.strict();

/** Role value is validated by the organizations service (ALL_ROLES check). */
export const userRoleBody = z.strictObject({
  role: z.string().trim().min(2).max(30),
});
export const userStatusBody = z.strictObject({
  isActive: z.boolean(),
});

// ---------- M5.2 Integration: calculation bodies ----------

/**
 * POST /api/lab-tests/:id/calculate — submit a calculation.
 * All fields optional: an empty body means "run the registered engine for
 * this test's stored resultData". `input` (when supplied) is an explicit
 * analyst payload that OVERRIDES the stored data; its structure is validated
 * by the calculation module inside the engine — nothing is duplicated here
 * (strictness only, same philosophy as labTestResultBody).
 */
export const calculateLabTestBody = z.strictObject({
  input: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
  dryRun: z.boolean().optional(),
});

// ---------- Queries ----------

export const projectsQuery = z
  .strictObject({
    search: searchQ,
    status: z.enum(PROJECT_STATUSES).optional(),
    sortBy: z.enum(["name", "code", "createdAt", "status"]).optional(),
    sortOrder: sortDirQ,
    page: pageQ,
    pageSize: pageSizeOf(100),
  });

export const boreholesQuery = z
  .strictObject({
    projectId: idQ.optional(),
    search: searchQ,
    type: z.enum(BOREHOLE_TYPES).optional(),
    status: z.enum(BOREHOLE_STATUSES).optional(),
    sortBy: z.enum(["code", "depth", "createdAt"]).optional(),
    sortOrder: sortDirQ,
    page: pageQ,
    pageSize: pageSizeOf(200),
  });

export const samplesQuery = z
  .strictObject({
    boreholeId: idQ.optional(),
    projectId: idQ.optional(),
    type: z.enum(SAMPLE_TYPES).optional(),
    labStatus: z.enum(LAB_STATUSES).optional(),
    search: searchQ,
    page: pageQ,
    pageSize: pageSizeOf(200),
  });

export const labTestsQuery = z
  .strictObject({
    sampleId: idQ.optional(),
    boreholeId: idQ.optional(),
    projectId: idQ.optional(),
    testType: z.enum(LAB_TEST_TYPES).optional(),
    status: z.enum(LAB_TEST_STATUSES).optional(),
    search: searchQ,
    page: pageQ,
    pageSize: pageSizeOf(200),
    // M5.1 (approved D3): opt-in projection flag for cross-test analytics.
    // NOTE: list items have always carried resultData in this API (verified
    // empirically in M5.1 — the service query used `include`, which returns
    // every scalar). To keep the default response unchanged the parameter is
    // accepted and resultData remains included exactly as before; it is
    // deliberately a no-op so no client payload can change shape.
    include: z.enum(["resultData"]).optional(),
  });

export const documentsQuery = z
  .strictObject({
    projectId: idQ.optional(),
    boreholeId: idQ.optional(),
    docType: z.enum(DOC_TYPES).optional(),
    search: searchQ,
    page: pageQ,
    pageSize: pageSizeOf(200),
  });

export const reportsQuery = z
  .strictObject({
    projectId: idQ.optional(),
    reportType: z.enum(REPORT_TYPES).optional(),
  });

export const usersQuery = z
  .strictObject({
    search: searchQ,
  });

export const activityQuery = z
  .strictObject({
    limit: z.coerce.number().int().min(1).max(100).optional(),
  });

// ---------- M5.4 Classification & Reports: bodies ----------

/**
 * POST /api/samples/:id/classify — submit a classification for a sample.
 * Body:
 *   { moduleId: "uscs" | "aashto", input?: object, idempotencyKey?: string, dryRun?: boolean }
 *
 * `moduleId` is required — the caller selects which classification standard
 * to apply. `input` (when supplied) is an explicit analyst payload that
 * OVERRIDES the sample's lab-test data; its structure is validated by the
 * classification module inside the engine — nothing is duplicated here
 * (strictness only, same philosophy as calculateLabTestBody).
 */
export const classifySampleBody = z.strictObject({
  moduleId: z.enum(["uscs", "aashto"]),
  input: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
  dryRun: z.boolean().optional(),
});

/**
 * POST /api/reports (extended for M5.4) — create a report record.
 * M2-M5.3 body: { projectId, reportType, title }
 * M5.4 extends additively: optional sampleId (TEST_SUMMARY) / boreholeId
 * (BOREHOLE_LOG). The combination is validated by the service:
 *   - PROJECT_SUMMARY: no sampleId, no boreholeId.
 *   - TEST_SUMMARY: sampleId required (project derived from sample).
 *   - BOREHOLE_LOG: boreholeId required (project derived from borehole).
 * `generatePdf` (default true) triggers immediate PDF generation in the
 * same request; when false, the report record is created as DRAFT and the
 * PDF can be generated later via POST /api/reports/:id/generate.
 */
export const createReportBodyM5_4 = z.strictObject({
  projectId: z.string().min(1),
  reportType: z.enum(REPORT_TYPES),
  title: z.string().trim().min(3).max(160),
  sampleId: z.string().min(1).optional(),
  boreholeId: z.string().min(1).optional(),
  generatePdf: z.boolean().optional(),
});

// ---------- M5.4 Classification queries ----------

const classificationFilterQ = {
  status: z.enum(["PENDING", "COMPLETED", "FAILED"]).optional(),
  isValid: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  moduleId: z.enum(["uscs", "aashto"]).optional(),
  page: pageQ,
  pageSize: pageSizeOf(100),
};

/** GET /api/samples/:id/classifications — per-sample classification history. */
export const sampleClassificationsQuery = z.strictObject(classificationFilterQ);

/** GET /api/samples/:id/classifications/latest?moduleId=uscs — latest valid. */
export const latestClassificationQuery = z.strictObject({
  moduleId: z.enum(["uscs", "aashto"]),
});

/** Shared calculation-history filters (query strings arrive as strings). */
const calculationFilterQ = {
  status: z.enum(CALCULATION_STATUSES).optional(),
  // "true"/"false" strings — NOT z.coerce.boolean (which coerces "false"→true).
  isValid: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  moduleId: z.string().trim().min(2).max(64).optional(),
  page: pageQ,
  pageSize: pageSizeOf(100),
};

/** GET /api/lab-tests/:id/calculations — per-test history. */
export const labTestCalculationsQuery = z.strictObject(calculationFilterQ);

/** GET /api/projects/:id/calculations — project-scoped listing. */
export const projectCalculationsQuery = z.strictObject({
  ...calculationFilterQ,
  testType: z.enum(LAB_TEST_TYPES).optional(),
});

/** Upload form field validation (the file itself is handled separately). */
export const uploadMeta = z.strictObject({
  projectId: idQ,
  boreholeId: idQ.optional(),
  title: z.string().trim().min(3).max(160),
  docType: z.enum(DOC_TYPES),
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((name) => !name.includes(".."), {
      message: "Filename must not contain path sequences",
    }),
});
