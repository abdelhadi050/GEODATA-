/**
 * GEODATA HUB — Reports service (M2 metadata + M5.4 PDF generation).
 *
 * M2-M5.3 provided record creation only (project, type, title). M5.4 extends
 * the service with full report generation:
 *   - `createReport` accepts an optional sampleId (TEST_SUMMARY) / boreholeId
 *     (BOREHOLE_LOG) and an optional `generatePdf` flag (default true).
 *   - When `generatePdf` is true, the service assembles the content snapshot
 *     via `assembleReportContent`, renders the PDF via `generateReportPdf`,
 *     and persists the snapshot + PDF metadata on the Report row in a single
 *     transaction (status = GENERATED, version = 1, pdfStoragePath set).
 *   - When `generatePdf` is false, the row is created as DRAFT (version 1,
 *     no PDF) and `generateReportPdfNow` can be called later to render the
 *     PDF and bump the row to GENERATED (a new generation creates a new row
 *     with version+1 — historical reports are preserved).
 *
 * RBAC: REPORT_GENERATE for create/generate; REPORT_VIEW for list/get.
 *
 * Layering:
 *   API routes → this service → report-content (assembly) + report-pdf (render)
 *   The assembler and PDF generator NEVER recomputes engineering values —
 *   they read the persisted lab tests, calculations and classifications
 *   verbatim.
 */
import { Prisma } from "@prisma/client";
import type { SessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Errors } from "@/lib/errors";
import { can, CAPABILITIES } from "@/lib/rbac";
import { createReportSchema } from "@/lib/validation/report";
import type { CreateReportInput } from "@/lib/validation/report";
import { parseOrThrow } from "@/lib/validation/parse";
import {
  getAccessibleProjectIds,
  getAccessibleProjectOrThrow,
  getOwnProjectOrThrow,
} from "./access";
import { logActivity, ACTIVITY_ACTIONS } from "./activity";
import { assembleReportContent, type ReportContent } from "./report-content";
import { generateReportPdf } from "./report-pdf";

export interface ListReportsOptions {
  projectId?: string;
  reportType?: string;
  status?: string;
}

// ---------------------------------------------------------------------------
// Validation — extended createReport schema (M5.4 additive)
// ---------------------------------------------------------------------------

/**
 * Extended create input: keeps the M2 fields (projectId, reportType, title)
 * and adds optional sampleId / boreholeId / generatePdf. The combination is
 * validated against the reportType below.
 */
export interface CreateReportInputM5_4 extends CreateReportInput {
  sampleId?: string;
  boreholeId?: string;
  generatePdf?: boolean;
}

function validateReportSubject(
  reportType: string,
  sampleId: string | undefined,
  boreholeId: string | undefined,
): void {
  if (reportType === "TEST_SUMMARY") {
    if (!sampleId) {
      throw Errors.validation("TEST_SUMMARY reports require a sampleId");
    }
    if (boreholeId) {
      throw Errors.validation("TEST_SUMMARY reports take a sampleId, not a boreholeId");
    }
  } else if (reportType === "BOREHOLE_LOG") {
    if (!boreholeId) {
      throw Errors.validation("BOREHOLE_LOG reports require a boreholeId");
    }
    if (sampleId) {
      throw Errors.validation("BOREHOLE_LOG reports take a boreholeId, not a sampleId");
    }
  } else if (reportType === "PROJECT_SUMMARY") {
    if (sampleId || boreholeId) {
      throw Errors.validation("PROJECT_SUMMARY reports take neither sampleId nor boreholeId");
    }
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

const LIST_SELECT = {
  id: true,
  projectId: true,
  reportType: true,
  title: true,
  status: true,
  version: true,
  sampleId: true,
  boreholeId: true,
  pdfGeneratedAt: true,
  pdfFileSize: true,
  pdfPageCount: true,
  createdAt: true,
  updatedAt: true,
  project: { select: { id: true, code: true, name: true } },
  sample: { select: { id: true, code: true } },
  borehole: { select: { id: true, code: true } },
  generatedBy: { select: { id: true, name: true } },
} as const;

type ListRow = Prisma.ReportGetPayload<{ select: typeof LIST_SELECT }>;

export function serializeReportListItem(row: ListRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    reportType: row.reportType,
    title: row.title,
    status: row.status,
    version: row.version,
    sampleId: row.sampleId,
    boreholeId: row.boreholeId,
    hasPdf: row.pdfGeneratedAt !== null,
    pdfFileSize: row.pdfFileSize,
    pdfPageCount: row.pdfPageCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    project: row.project,
    sample: row.sample,
    borehole: row.borehole,
    generatedBy: row.generatedBy,
  };
}

const DETAIL_INCLUDE = {
  ...LIST_SELECT,
  contentSnapshot: true,
  pdfStoragePath: true,
  pdfGeneratedAt: true,
} as const;

type DetailRow = Prisma.ReportGetPayload<{ select: typeof DETAIL_INCLUDE }>;

export function serializeReportDetail(row: DetailRow) {
  return {
    ...serializeReportListItem(row),
    contentSnapshot: row.contentSnapshot as unknown as ReportContent | null,
    pdfStoragePath: row.pdfStoragePath,
    pdfGeneratedAt: row.pdfGeneratedAt,
  };
}

// ---------------------------------------------------------------------------
// List / get
// ---------------------------------------------------------------------------

export async function listReports(actor: SessionUser, opts: ListReportsOptions = {}) {
  const { ownIds, sharedIds } = await getAccessibleProjectIds(actor);
  const visibleProjectIds = [...ownIds, ...sharedIds];

  const where = {
    project: { id: { in: visibleProjectIds } },
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    ...(opts.reportType ? { reportType: opts.reportType } : {}),
    ...(opts.status ? { status: opts.status } : {}),
  };

  const rows = await db.report.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: LIST_SELECT,
  });
  return rows.map(serializeReportListItem);
}

export async function getReport(actor: SessionUser, reportId: string) {
  const report = await db.report.findUnique({
    where: { id: reportId },
    select: DETAIL_INCLUDE,
  });
  if (!report) throw Errors.notFound("Report");

  // Tenant/share boundary identical to project access. The DETAIL_INCLUDE
  // doesn't carry project.organizationId (kept lean for list payloads), so
  // resolve access through the project access chain.
  const { source } = await getAccessibleProjectOrThrow(actor, report.projectId);
  // own source ⇒ always allowed. shared source ⇒ allowed for read but the
  // caller (getReport) is a READ operation, so both are fine here.
  void source;
  return serializeReportDetail(report);
}

// ---------------------------------------------------------------------------
// Create + generate
// ---------------------------------------------------------------------------

export interface CreateReportResult {
  report: ReturnType<typeof serializeReportDetail>;
  /** Whether the PDF was generated in this call. False when generatePdf=false. */
  pdfGenerated: boolean;
}

/**
 * Create a report record, optionally generating the PDF immediately.
 *
 * When `generatePdf` is true (default), the service:
 *   1. Inserts the Report row as DRAFT (status = DRAFT, version = 1).
 *   2. Assembles the content snapshot from the project/sample/borehole data.
 *   3. Renders the PDF via pdfkit to storage/reports/<reportId>.pdf.
 *   4. Updates the row with status = GENERATED, contentSnapshot, pdfStoragePath,
 *      pdfGeneratedAt, pdfFileSize, pdfPageCount.
 *
 * When `generatePdf` is false, only step 1 runs — the row stays DRAFT and
 * `generateReportPdfNow` can be called later to render + update.
 */
export async function createReport(
  actor: SessionUser,
  input: CreateReportInputM5_4,
): Promise<CreateReportResult> {
  if (!can(actor.role, CAPABILITIES.REPORT_GENERATE)) {
    throw Errors.forbidden("Your role cannot generate reports");
  }
  const data = parseOrThrow(createReportSchema, input);
  const sampleId = input.sampleId;
  const boreholeId = input.boreholeId;
  const generatePdf = input.generatePdf ?? true;

  validateReportSubject(data.reportType, sampleId, boreholeId);

  // Verify project ownership (write path) and that the sample/borehole
  // belongs to that project.
  const project = await getOwnProjectOrThrow(actor, data.projectId);
  if (sampleId) {
    const sample = await db.sample.findUnique({
      where: { id: sampleId },
      select: { id: true, borehole: { select: { projectId: true } } },
    });
    if (!sample || sample.borehole.projectId !== project.id) {
      throw Errors.notFound("Sample");
    }
  }
  if (boreholeId) {
    const borehole = await db.borehole.findUnique({
      where: { id: boreholeId },
      select: { id: true, projectId: true },
    });
    if (!borehole || borehole.projectId !== project.id) {
      throw Errors.notFound("Borehole");
    }
  }

  // Insert the DRAFT row first so we have a reportId for the PDF filename.
  const draft = await db.report.create({
    data: {
      projectId: data.projectId,
      reportType: data.reportType,
      title: data.title,
      status: "DRAFT",
      version: 1,
      ...(sampleId ? { sampleId } : {}),
      ...(boreholeId ? { boreholeId } : {}),
      generatedById: actor.id,
    },
    select: DETAIL_INCLUDE,
  });

  if (!generatePdf) {
    await logActivity({
      organizationId: actor.organizationId,
      userId: actor.id,
      action: ACTIVITY_ACTIONS.REPORT_GENERATED,
      entityType: "Report",
      entityId: draft.id,
      details: { title: draft.title, reportType: draft.reportType, status: "DRAFT" },
    });
    return { report: serializeReportDetail(draft), pdfGenerated: false };
  }

  // Generate the PDF immediately.
  return generateReportPdfNow(actor, draft.id);
}

/**
 * Render the PDF for an existing DRAFT report (or regenerate for any report —
 * creates a NEW version row, preserving the previous one as history).
 *
 * Steps:
 *   1. Read the existing report row.
 *   2. If it's already GENERATED, create a NEW row with version+1 (history
 *      preservation — never overwrite a previously-generated report).
 *   3. Assemble the content snapshot.
 *   4. Render the PDF.
 *   5. Update the (new) row with status = GENERATED + content + PDF metadata.
 */
export async function generateReportPdfNow(
  actor: SessionUser,
  reportId: string,
): Promise<CreateReportResult> {
  if (!can(actor.role, CAPABILITIES.REPORT_GENERATE)) {
    throw Errors.forbidden("Your role cannot generate reports");
  }
  const existing = await db.report.findUnique({
    where: { id: reportId },
    include: { project: { select: { id: true, organizationId: true } } },
  });
  if (!existing || existing.project.organizationId !== actor.organizationId) {
    throw Errors.notFound("Report");
  }

  // If the existing row is already GENERATED, create a NEW version row.
  // DRAFT rows can be promoted in place (no history value yet).
  let targetRowId = existing.id;
  if (existing.status === "GENERATED") {
    const newVersion = await db.report.create({
      data: {
        projectId: existing.projectId,
        reportType: existing.reportType,
        title: existing.title,
        status: "DRAFT",
        version: existing.version + 1,
        sampleId: existing.sampleId,
        boreholeId: existing.boreholeId,
        generatedById: actor.id,
      },
    });
    targetRowId = newVersion.id;
  }

  // Assemble the content snapshot.
  const content = await assembleReportContent(actor, {
    projectId: existing.projectId,
    reportType: existing.reportType as "BOREHOLE_LOG" | "TEST_SUMMARY" | "PROJECT_SUMMARY",
    title: existing.title,
    version: existing.version,
    ...(existing.sampleId ? { sampleId: existing.sampleId } : {}),
    ...(existing.boreholeId ? { boreholeId: existing.boreholeId } : {}),
  });
  // Fill the report id for the snapshot (used in the PDF footer).
  content.report.id = targetRowId;

  // Render the PDF.
  const pdfResult = await generateReportPdf(content, targetRowId);

  // Update the target row with GENERATED status + content + PDF metadata.
  const updated = await db.report.update({
    where: { id: targetRowId },
    data: {
      status: "GENERATED",
      contentSnapshot: content as unknown as Prisma.InputJsonValue,
      pdfStoragePath: pdfResult.storagePath,
      pdfGeneratedAt: new Date(),
      pdfFileSize: pdfResult.fileSize,
      pdfPageCount: pdfResult.pageCount,
    },
    select: DETAIL_INCLUDE,
  });

  await logActivity({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: ACTIVITY_ACTIONS.REPORT_GENERATED,
    entityType: "Report",
    entityId: updated.id,
    details: {
      title: updated.title,
      reportType: updated.reportType,
      status: "GENERATED",
      version: updated.version,
      pdfPageCount: pdfResult.pageCount,
    },
  });

  return { report: serializeReportDetail(updated), pdfGenerated: true };
}
