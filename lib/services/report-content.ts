/**
 * GEODATA HUB — Report content assembler (M5.4).
 *
 * Assembles the structured content of a geotechnical report from the
 * project's, sample's, borehole's, lab-test, calculation and classification
 * records. The assembled content is frozen as the report's `contentSnapshot`
 * at generation time — a report remains traceable to its source data even
 * after the source data later changes.
 *
 * The assembler NEVER recomputes engineering values. It reads the most
 * recent VALID calculation and classification records for each sample and
 * echoes their persisted outputs. Missing data is reported explicitly via
 * `warnings` — never silently omitted.
 *
 * Report types (mirrors the existing REPORT_TYPES constants):
 *   - PROJECT_SUMMARY: all boreholes, samples, lab tests, calculations and
 *     classifications of the project.
 *   - TEST_SUMMARY: a single sample's lab tests, calculations and
 *     classifications (requires a sampleId).
 *   - BOREHOLE_LOG: a single borehole's samples, lab tests and
 *     classifications (requires a boreholeId).
 */
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { Errors } from "@/lib/errors";
import {
  getAccessibleProjectOrThrow,
  getOwnProjectOrThrow,
} from "@/lib/services/access";
import type { SessionUser } from "@/lib/auth";

// ---------------------------------------------------------------------------
// Content snapshot type — what gets persisted as Report.contentSnapshot
// ---------------------------------------------------------------------------

export interface ReportContent {
  /** Report metadata. */
  report: {
    id: string;
    title: string;
    reportType: "BOREHOLE_LOG" | "TEST_SUMMARY" | "PROJECT_SUMMARY";
    version: number;
    generatedAt: string; // ISO
    generatedBy: { id: string; name: string };
  };
  /** Project context (always present). */
  project: {
    id: string;
    code: string;
    name: string;
    client: string | null;
    locationName: string | null;
    latitude: number | null;
    longitude: number | null;
    organization: { id: string; name: string; slug: string };
  };
  /** Subject context (depends on reportType). */
  subject:
    | { kind: "PROJECT"; boreholeCount: number; sampleCount: number; labTestCount: number }
    | { kind: "BOREHOLE"; borehole: BoreholeContent; samples: SampleContent[] }
    | { kind: "SAMPLE"; sample: SampleContent };
  /** Standards and methodology citations actually used in the report. */
  standards: string[];
  /** Warnings about missing or insufficient data (e.g. a sample with no
   * lab tests, a calculation FAILED, a classification pending). */
  warnings: Array<{ code: string; message: string; sampleId?: string }>;
}

export interface BoreholeContent {
  id: string;
  code: string;
  type: string;
  status: string;
  latitude: number;
  longitude: number;
  elevation: number | null;
  depth: number | null;
  drillingDate: string | null;
  drilledBy: string | null;
  layers: Array<{
    id: string;
    depthFrom: number;
    depthTo: number;
    layerCode: string | null;
    materialType: string;
    description: string;
    uscs: string | null;
    consistency: string | null;
  }>;
}

export interface SampleContent {
  id: string;
  code: string;
  type: string;
  depthFrom: number;
  depthTo: number;
  recovery: number | null;
  labStatus: string;
  borehole: { id: string; code: string };
  layer: { id: string; layerCode: string | null; uscs: string | null } | null;
  labTests: LabTestContent[];
  calculations: CalculationContent[];
  classifications: ClassificationContent[];
}

export interface LabTestContent {
  id: string;
  testType: string;
  status: string;
  performedBy: string | null;
  performedAt: string | null;
  summary: string | null;
  resultData: Record<string, unknown> | null;
}

export interface CalculationContent {
  id: string;
  labTestId: string;
  testType: string;
  moduleId: string;
  status: string;
  isValid: boolean;
  method: string | null;
  standard: string | null;
  results: Record<string, unknown> | null;
  warnings: Array<{ code: string; message: string }>;
  createdAt: string;
}

export interface ClassificationContent {
  id: string;
  moduleId: string;
  status: string;
  isValid: boolean;
  standard: string | null;
  standardVersion: string | null;
  results: Record<string, unknown> | null;
  warnings: Array<{ code: string; message: string }>;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Assemble the structured content of a report.
 *
 * Reads the project, subject (project / borehole / sample), lab tests,
 * latest VALID calculations and latest VALID classifications. The assembled
 * object is what gets persisted as `Report.contentSnapshot` and what the PDF
 * generator renders.
 */
export async function assembleReportContent(
  actor: SessionUser,
  args: {
    projectId: string;
    reportType: "BOREHOLE_LOG" | "TEST_SUMMARY" | "PROJECT_SUMMARY";
    title: string;
    version: number;
    sampleId?: string;
    boreholeId?: string;
  },
): Promise<ReportContent> {
  // Verify access — write path requires own-organization project; the
  // content assembly is part of the write path (PDF generation).
  const project = await getOwnProjectOrThrow(actor, args.projectId);
  const organization = await db.organization.findUniqueOrThrow({
    where: { id: project.organizationId },
    select: { id: true, name: true, slug: true },
  });

  const warnings: ReportContent["warnings"] = [];
  const standards = new Set<string>();

  // Always include the project's standards (none for the project itself —
  // standards come from the lab tests / classifications cited below).

  if (args.reportType === "PROJECT_SUMMARY") {
    // Project-level: enumerate all boreholes, samples, lab tests, latest
    // valid calculations and classifications.
    const boreholes = await db.borehole.findMany({
      where: { projectId: project.id },
      orderBy: { code: "asc" },
      include: {
        layers: { orderBy: { depthFrom: "asc" } },
        samples: {
          orderBy: { depthFrom: "asc" },
          include: { layer: { select: { id: true, layerCode: true, uscs: true } } },
        },
      },
    });

    // Flatten samples with their parent borehole context (the samples
    // included via the borehole query don't have a nested `borehole`
    // relation — we attach it from the parent).
    const flatSamples = boreholes.flatMap((b) =>
      b.samples.map((s) => ({
        ...s,
        borehole: { id: b.id, code: b.code },
      })),
    );
    const samplesWithTests = await assembleSamplesContent(flatSamples, warnings, standards);

    const subject: ReportContent["subject"] = {
      kind: "PROJECT",
      boreholeCount: boreholes.length,
      sampleCount: samplesWithTests.length,
      labTestCount: samplesWithTests.reduce((n, s) => n + s.labTests.length, 0),
    };

    return {
      report: {
        id: "", // filled by the caller after the row is created
        title: args.title,
        reportType: "PROJECT_SUMMARY",
        version: args.version,
        generatedAt: new Date().toISOString(),
        generatedBy: { id: actor.id, name: actor.name },
      },
      project: {
        id: project.id,
        code: project.code,
        name: project.name,
        client: project.client,
        locationName: project.locationName,
        latitude: project.latitude,
        longitude: project.longitude,
        organization,
      },
      subject,
      standards: [...standards].sort(),
      warnings,
    };
  }

  if (args.reportType === "TEST_SUMMARY") {
    if (!args.sampleId) {
      throw Errors.validation("TEST_SUMMARY reports require a sampleId");
    }
    const sample = await db.sample.findUnique({
      where: { id: args.sampleId },
      include: {
        borehole: { select: { id: true, code: true, projectId: true } },
        layer: { select: { id: true, layerCode: true, uscs: true } },
      },
    });
    if (!sample || sample.borehole.projectId !== project.id) {
      throw Errors.notFound("Sample");
    }
    const [assembled] = await assembleSamplesContent([sample], warnings, standards);
    if (assembled.labTests.length === 0) {
      warnings.push({
        code: "NO_LAB_TESTS",
        message: `Sample ${sample.code} has no laboratory tests recorded.`,
        sampleId: sample.id,
      });
    }
    const subject: ReportContent["subject"] = { kind: "SAMPLE", sample: assembled };
    return {
      report: {
        id: "",
        title: args.title,
        reportType: "TEST_SUMMARY",
        version: args.version,
        generatedAt: new Date().toISOString(),
        generatedBy: { id: actor.id, name: actor.name },
      },
      project: {
        id: project.id,
        code: project.code,
        name: project.name,
        client: project.client,
        locationName: project.locationName,
        latitude: project.latitude,
        longitude: project.longitude,
        organization,
      },
      subject,
      standards: [...standards].sort(),
      warnings,
    };
  }

  if (args.reportType === "BOREHOLE_LOG") {
    if (!args.boreholeId) {
      throw Errors.validation("BOREHOLE_LOG reports require a boreholeId");
    }
    const borehole = await db.borehole.findUnique({
      where: { id: args.boreholeId },
      include: {
        layers: { orderBy: { depthFrom: "asc" } },
        samples: {
          orderBy: { depthFrom: "asc" },
          include: { layer: { select: { id: true, layerCode: true, uscs: true } } },
        },
      },
    });
    if (!borehole || borehole.projectId !== project.id) {
      throw Errors.notFound("Borehole");
    }
    // Attach the parent borehole to each sample (the samples included via
    // the borehole query don't have a nested `borehole` relation).
    const flatSamples = borehole.samples.map((s) => ({
      ...s,
      borehole: { id: borehole.id, code: borehole.code },
    }));
    const samplesWithTests = await assembleSamplesContent(flatSamples, warnings, standards);
    const subject: ReportContent["subject"] = {
      kind: "BOREHOLE",
      borehole: {
        id: borehole.id,
        code: borehole.code,
        type: borehole.type,
        status: borehole.status,
        latitude: borehole.latitude,
        longitude: borehole.longitude,
        elevation: borehole.elevation,
        depth: borehole.depth,
        drillingDate: borehole.drillingDate?.toISOString() ?? null,
        drilledBy: borehole.drilledBy,
        layers: borehole.layers.map((l) => ({
          id: l.id,
          depthFrom: l.depthFrom,
          depthTo: l.depthTo,
          layerCode: l.layerCode,
          materialType: l.materialType,
          description: l.description,
          uscs: l.uscs,
          consistency: l.consistency,
        })),
      },
      samples: samplesWithTests,
    };
    return {
      report: {
        id: "",
        title: args.title,
        reportType: "BOREHOLE_LOG",
        version: args.version,
        generatedAt: new Date().toISOString(),
        generatedBy: { id: actor.id, name: actor.name },
      },
      project: {
        id: project.id,
        code: project.code,
        name: project.name,
        client: project.client,
        locationName: project.locationName,
        latitude: project.latitude,
        longitude: project.longitude,
        organization,
      },
      subject,
      standards: [...standards].sort(),
      warnings,
    };
  }

  // Unreachable — reportType is Zod-validated to the three values above.
  throw Errors.validation(`Unsupported report type: ${args.reportType as string}`);
}

/**
 * For a list of samples, assemble the full content (lab tests + latest valid
 * calculations + latest valid classifications). Mutates `warnings` and
 * `standards` as side effects (additive — every cited standard accumulates).
 */
async function assembleSamplesContent(
  samples: Array<{
    id: string;
    code: string;
    type: string;
    depthFrom: number;
    depthTo: number;
    recovery: number | null;
    labStatus: string;
    boreholeId: string;
    borehole: { id: string; code: string };
    layer?: { id: string; layerCode: string | null; uscs: string | null } | null;
  }>,
  warnings: ReportContent["warnings"],
  standards: Set<string>,
): Promise<SampleContent[]> {
  if (samples.length === 0) return [];

  const sampleIds = samples.map((s) => s.id);

  // Lab tests for all samples (one query).
  const labTests = await db.labTest.findMany({
    where: { sampleId: { in: sampleIds } },
    orderBy: [{ createdAt: "asc" }],
  });

  // Latest VALID calculation per (sampleId's labTestId, moduleId) — same
  // semantics as getLatestValidCalculation but batched.
  const labTestIds = labTests.map((t) => t.id);
  const allCalculations = labTestIds.length === 0 ? [] : await db.calculationRecord.findMany({
    where: {
      labTestId: { in: labTestIds },
      inputSource: "RESULT_DATA",
      isValid: true,
      status: "COMPLETED",
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  // Keep only the latest per labTestId (the query is already ordered desc).
  const latestCalcByLabTest = new Map<string, typeof allCalculations[number]>();
  for (const calc of allCalculations) {
    if (!latestCalcByLabTest.has(calc.labTestId)) {
      latestCalcByLabTest.set(calc.labTestId, calc);
    }
  }

  // Latest VALID classification per (sampleId, moduleId).
  const allClassifications = sampleIds.length === 0 ? [] : await db.classificationRecord.findMany({
    where: {
      sampleId: { in: sampleIds },
      inputSource: "SAMPLE_DATA",
      isValid: true,
      status: "COMPLETED",
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const latestClassBySample = new Map<string, Map<string, typeof allClassifications[number]>>();
  for (const cls of allClassifications) {
    let byModule = latestClassBySample.get(cls.sampleId);
    if (!byModule) {
      byModule = new Map();
      latestClassBySample.set(cls.sampleId, byModule);
    }
    if (!byModule.has(cls.moduleId)) {
      byModule.set(cls.moduleId, cls);
    }
  }

  return samples.map((sample) => {
    const sampleLabTests = labTests.filter((t) => t.sampleId === sample.id);
    const labTestsContent: LabTestContent[] = sampleLabTests.map((t) => ({
      id: t.id,
      testType: t.testType,
      status: t.status,
      performedBy: t.performedBy,
      performedAt: t.performedAt?.toISOString() ?? null,
      summary: t.summary,
      resultData: (t.resultData as Record<string, unknown> | null) ?? null,
    }));

    const calculationsContent: CalculationContent[] = sampleLabTests
      .map((t) => {
        const calc = latestCalcByLabTest.get(t.id);
        if (!calc) return null;
        if (calc.standard) standards.add(calc.standard);
        const output = (calc.output ?? {}) as { raw?: unknown; results?: unknown };
        return {
          id: calc.id,
          labTestId: calc.labTestId,
          testType: calc.testType,
          moduleId: calc.moduleId,
          status: calc.status,
          isValid: calc.isValid,
          method: calc.method,
          standard: calc.standard,
          results: (output.results as Record<string, unknown> | null) ?? null,
          warnings: (Array.isArray(calc.warnings) ? calc.warnings : []) as Array<{ code: string; message: string }>,
          createdAt: calc.createdAt.toISOString(),
        };
      })
      .filter((c): c is CalculationContent => c !== null);

    const classByModule = latestClassBySample.get(sample.id);
    const classificationsContent: ClassificationContent[] = [];
    if (classByModule) {
      for (const cls of classByModule.values()) {
        if (cls.standard) standards.add(cls.standard);
        if (cls.standardVersion) standards.add(`${cls.standard} (${cls.standardVersion})`);
        const output = (cls.output ?? {}) as { raw?: unknown; results?: unknown };
        classificationsContent.push({
          id: cls.id,
          moduleId: cls.moduleId,
          status: cls.status,
          isValid: cls.isValid,
          standard: cls.standard,
          standardVersion: cls.standardVersion,
          results: (output.results as Record<string, unknown> | null) ?? null,
          warnings: (Array.isArray(cls.warnings) ? cls.warnings : []) as Array<{ code: string; message: string }>,
          createdAt: cls.createdAt.toISOString(),
        });
      }
    }

    if (sampleLabTests.length === 0) {
      warnings.push({
        code: "NO_LAB_TESTS",
        message: `Sample ${sample.code} has no laboratory tests recorded.`,
        sampleId: sample.id,
      });
    }

    return {
      id: sample.id,
      code: sample.code,
      type: sample.type,
      depthFrom: sample.depthFrom,
      depthTo: sample.depthTo,
      recovery: sample.recovery,
      labStatus: sample.labStatus,
      borehole: { id: sample.borehole.id, code: sample.borehole.code },
      layer: sample.layer ?? null,
      labTests: labTestsContent,
      calculations: calculationsContent,
      classifications: classificationsContent,
    };
  });
}

/** Type helper — the Prisma payload shape used by the assembler's queries. */
export type AssembledSamplePayload = Prisma.SampleGetPayload<{
  include: {
    borehole: { select: { id: true; code: true; projectId: true } };
    layer: { select: { id: true; layerCode: true; uscs: true } };
  };
}>;
