/**
 * GEODATA HUB — PDF generator for geotechnical reports (M5.4).
 *
 * Renders a ReportContent snapshot (assembled by `report-content.ts`) into a
 * professional PDF document using pdfkit. The PDF is the primary deliverable
 * of the report generator: it carries project info, sample identification,
 * lab test results, calculation results, USCS/AASHTO classifications, tables
 * with units, warnings, applicable standards and methodology, and the report
 * generation date + version.
 *
 * Design rules (mirrors the project's engineering rules):
 *   - The generator NEVER recomputes engineering values. It reads the
 *     assembled content snapshot verbatim — the PDF is a faithful
 *     transcription of the persisted data.
 *   - Tables and cards use professional typography (Helvetica family).
 *   - Units are always shown next to numeric values.
 *   - Warnings and missing-data indicators are surfaced in a dedicated
 *     section, never silently omitted.
 *   - Standards and methodology citations are listed in a footer section.
 *
 * The PDF is written to a file under `storage/reports/<reportId>.pdf` and
 * the file path + size + page count are returned to the caller for
 * persistence on the Report row.
 */
import PDFDocument from "pdfkit";
import fs from "node:fs/promises";
import path from "node:path";
import type { ReportContent, SampleContent } from "./report-content";

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 612; // US Letter, 8.5" × 72 dpi
const PAGE_HEIGHT = 792;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * PAGE_MARGIN;

interface GeneratedPdf {
  storagePath: string;
  absolutePath: string;
  fileSize: number;
  pageCount: number;
}

/**
 * Render a ReportContent snapshot to a PDF file under storage/reports/.
 *
 * @param content the assembled content (from assembleReportContent)
 * @param reportId the Report row's id (used in the filename)
 * @returns the storage path, absolute path, file size, and page count
 */
export async function generateReportPdf(
  content: ReportContent,
  reportId: string,
): Promise<GeneratedPdf> {
  const filename = `${reportId}.pdf`;
  const storagePath = `reports/${filename}`;
  const absolutePath = path.resolve(process.cwd(), "storage", storagePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });

  // pdfkit writes to a stream — pipe the doc to a file write stream. The
  // stream emits 'finish' AFTER doc.end() is called and all content is
  // flushed. We add all content first, then call doc.end(), then await.
  const doc = new PDFDocument({
    size: [PAGE_WIDTH, PAGE_HEIGHT],
    margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN },
    info: {
      Title: content.report.title,
      Author: content.report.generatedBy.name,
      Subject: `Geotechnical ${content.report.reportType.replace("_", " ").toLowerCase()} report`,
      Keywords: content.standards.join(", "),
    },
  });

  // Page counter — incremented by the page-added event.
  let pageCount = 1;
  doc.on("pageAdded", () => { pageCount++; });

  const stream = doc.pipe(await fs.open(absolutePath, "w").then((fh) => fh.createWriteStream()));

  // Helper: ensure Y position with page-break.
  const ensureSpace = (needed: number) => {
    if (doc.y + needed > PAGE_HEIGHT - PAGE_MARGIN - 30) {
      doc.addPage();
    }
  };

  // ====================== Header ======================
  doc
    .font("Helvetica-Bold")
    .fontSize(16)
    .text(content.report.title, { align: "left" });
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#555")
    .text(
      `${content.report.reportType.replace("_", " ").toLowerCase()} report — version ${content.report.version}`,
      { align: "left" },
    )
    .text(
      `Generated ${content.report.generatedAt.substring(0, 10)} by ${content.report.generatedBy.name}`,
      { align: "left" },
    )
    .moveDown(0.5);
  // Horizontal rule
  drawHr(doc);
  doc.moveDown(0.3);

  // ====================== Project info ======================
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#000").text("Project");
  doc.font("Helvetica").fontSize(10);
  const p = content.project;
  doc.text(`Code: ${p.code}`);
  doc.text(`Name: ${p.name}`);
  if (p.client) doc.text(`Client: ${p.client}`);
  if (p.locationName) doc.text(`Location: ${p.locationName}`);
  if (p.latitude !== null && p.longitude !== null) {
    doc.text(`Coordinates: ${p.latitude.toFixed(6)}, ${p.longitude.toFixed(6)}`);
  }
  doc.text(`Organization: ${content.project.organization.name}`);
  doc.moveDown(0.5);
  drawHr(doc);
  doc.moveDown(0.3);

  // ====================== Subject ======================
  if (content.subject.kind === "PROJECT") {
    doc.font("Helvetica-Bold").fontSize(12).text("Project summary");
    doc.font("Helvetica").fontSize(10);
    doc.text(`Boreholes: ${content.subject.boreholeCount}`);
    doc.text(`Samples: ${content.subject.sampleCount}`);
    doc.text(`Laboratory tests: ${content.subject.labTestCount}`);
    doc.moveDown(0.5);
    drawHr(doc);
    doc.moveDown(0.3);
  } else if (content.subject.kind === "BOREHOLE") {
    const b = content.subject.borehole;
    doc.font("Helvetica-Bold").fontSize(12).text(`Borehole ${b.code}`);
    doc.font("Helvetica").fontSize(10);
    doc.text(`Type: ${b.type}`);
    doc.text(`Status: ${b.status}`);
    doc.text(`Coordinates: ${b.latitude.toFixed(6)}, ${b.longitude.toFixed(6)}`);
    if (b.elevation !== null) doc.text(`Elevation: ${b.elevation.toFixed(2)} m`);
    if (b.depth !== null) doc.text(`Depth: ${b.depth.toFixed(2)} m`);
    if (b.drillingDate) doc.text(`Drilling date: ${b.drillingDate.substring(0, 10)}`);
    if (b.drilledBy) doc.text(`Drilled by: ${b.drilledBy}`);
    doc.moveDown(0.3);

    // Layers table
    if (b.layers.length > 0) {
      doc.font("Helvetica-Bold").fontSize(11).text("Stratigraphy");
      doc.moveDown(0.2);
      const layerRows: string[][] = b.layers.map((l) => [
        `${l.depthFrom.toFixed(2)}–${l.depthTo.toFixed(2)}`,
        l.layerCode ?? "—",
        l.materialType,
        l.uscs ?? "—",
        l.description.length > 50 ? `${l.description.slice(0, 50)}…` : l.description,
      ]);
      drawTable(doc, layerRows, ["Depth (m)", "Code", "Material", "USCS", "Description"], ensureSpace);
      doc.moveDown(0.4);
    }

    // Samples within the borehole
    doc.font("Helvetica-Bold").fontSize(11).text(`Samples (${content.subject.samples.length})`);
    doc.moveDown(0.2);
    for (const sample of content.subject.samples) {
      renderSample(doc, sample, ensureSpace);
    }
  } else {
    // SAMPLE
    renderSample(doc, content.subject.sample, ensureSpace);
  }

  // ====================== Warnings ======================
  if (content.warnings.length > 0) {
    ensureSpace(80);
    doc.moveDown(0.5);
    drawHr(doc);
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#a30").text("Warnings");
    doc.font("Helvetica").fontSize(9).fillColor("#000");
    for (const w of content.warnings) {
      ensureSpace(20);
      doc.text(`• [${w.code}] ${w.message}`);
    }
    doc.moveDown(0.3);
  }

  // ====================== Standards & methodology ======================
  if (content.standards.length > 0) {
    ensureSpace(60);
    doc.moveDown(0.3);
    drawHr(doc);
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(11).text("Applicable standards and methodology");
    doc.font("Helvetica").fontSize(9);
    for (const s of content.standards) {
      ensureSpace(15);
      doc.text(`• ${s}`);
    }
    doc.moveDown(0.3);
  }

  // ====================== Footer (page numbers) ======================
  // pdfkit doesn't have a built-in footer-on-every-page, so we use the
  // pageAdded event counter to stamp the final page count via the buffered
  // range property. For simplicity we put the report id + version + date on
  // the bottom of the current (last) page only — full per-page footers
  // require a more elaborate post-processing pass.
  doc.font("Helvetica").fontSize(8).fillColor("#888");
  doc.text(
    `Report ${content.report.id || "(unsaved)"} — v${content.report.version} — page ${pageCount} of ${pageCount} — generated ${content.report.generatedAt.substring(0, 19).replace("T", " ")} UTC`,
    PAGE_MARGIN,
    PAGE_HEIGHT - 30,
    { align: "left", width: CONTENT_WIDTH },
  );

  doc.end();

  // Wait for the stream to finish.
  await new Promise<void>((resolve, reject) => {
    stream.on("finish", () => resolve());
    stream.on("error", (err) => reject(err));
  });

  const stat = await fs.stat(absolutePath);
  return {
    storagePath,
    absolutePath,
    fileSize: stat.size,
    pageCount,
  };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderSample(
  doc: InstanceType<typeof PDFDocument>,
  sample: SampleContent,
  ensureSpace: (n: number) => void,
) {
  ensureSpace(60);
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#000").text(`Sample ${sample.code}`);
  doc.font("Helvetica").fontSize(9);
  doc.text(`Type: ${sample.type}  Depth: ${sample.depthFrom.toFixed(2)}–${sample.depthTo.toFixed(2)} m  Lab status: ${sample.labStatus}`);
  if (sample.recovery !== null) doc.text(`Recovery: ${sample.recovery.toFixed(1)} %`);
  if (sample.layer) doc.text(`Layer: ${sample.layer.layerCode ?? "(no code)"} (USCS: ${sample.layer.uscs ?? "—"})`);
  doc.moveDown(0.2);

  // Lab tests table
  if (sample.labTests.length > 0) {
    doc.font("Helvetica-Bold").fontSize(10).text("Laboratory tests");
    doc.moveDown(0.1);
    const rows: string[][] = sample.labTests.map((t) => [
      t.testType.replace(/_/g, " ").toLowerCase(),
      t.status,
      t.performedAt ? t.performedAt.substring(0, 10) : "—",
      t.summary ?? "—",
    ]);
    drawTable(doc, rows, ["Test type", "Status", "Performed", "Summary"], ensureSpace);
    doc.moveDown(0.2);
  }

  // Calculations table
  if (sample.calculations.length > 0) {
    doc.font("Helvetica-Bold").fontSize(10).text("Calculations (latest valid)");
    doc.moveDown(0.1);
    const rows: string[][] = sample.calculations.map((c) => {
      const resultsSummary = summarizeResults(c.results);
      return [
        c.moduleId,
        c.testType.replace(/_/g, " ").toLowerCase(),
        c.method ?? "—",
        resultsSummary,
        c.warnings.length > 0 ? `${c.warnings.length} warning(s)` : "—",
      ];
    });
    drawTable(doc, rows, ["Module", "Test type", "Method", "Key results", "Warnings"], ensureSpace);
    doc.moveDown(0.2);
  }

  // Classifications table
  if (sample.classifications.length > 0) {
    doc.font("Helvetica-Bold").fontSize(10).text("Classifications (latest valid)");
    doc.moveDown(0.1);
    const rows: string[][] = sample.classifications.map((c) => {
      const symbol = (c.results as Record<string, unknown> | null)?.symbol
        ?? (c.results as Record<string, unknown> | null)?.group
        ?? (c.results as Record<string, unknown> | null)?.designation
        ?? "—";
      const groupName = (c.results as Record<string, unknown> | null)?.groupName as string | undefined;
      return [
        c.moduleId.toUpperCase(),
        String(symbol),
        groupName ?? "—",
        c.standardVersion ?? c.standard ?? "—",
        c.warnings.length > 0 ? `${c.warnings.length} warning(s)` : "—",
      ];
    });
    drawTable(doc, rows, ["Standard", "Symbol", "Group name", "Version", "Warnings"], ensureSpace);
    doc.moveDown(0.3);
  }
}

/** Compact one-line summary of a calculation results object. */
function summarizeResults(results: Record<string, unknown> | null): string {
  if (!results) return "—";
  // Pick up to 3 numeric/short values that fit in a table cell.
  const keys = Object.keys(results).filter((k) => {
    const v = results[k];
    return typeof v === "number" || typeof v === "string";
  }).slice(0, 3);
  if (keys.length === 0) return "—";
  return keys.map((k) => `${k}=${String(results[k]).slice(0, 12)}`).join(", ");
}

/** Draw a simple borderless table with a header row. */
function drawTable(
  doc: InstanceType<typeof PDFDocument>,
  rows: string[][],
  headers: string[],
  ensureSpace: (n: number) => void,
) {
  const colCount = headers.length;
  const colWidth = Math.floor(CONTENT_WIDTH / colCount);
  const rowHeight = 16;
  const headerHeight = 18;

  // Header
  ensureSpace(headerHeight + rowHeight);
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#000");
  for (let i = 0; i < colCount; i++) {
    doc.text(headers[i], PAGE_MARGIN + i * colWidth, doc.y, {
      width: colWidth - 4,
      height: headerHeight,
      ellipsis: true,
    });
  }
  doc.y += headerHeight;
  // Header underline
  doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN + CONTENT_WIDTH, doc.y).lineWidth(0.5).strokeColor("#888").stroke();
  doc.y += 2;

  // Body rows
  doc.font("Helvetica").fontSize(8);
  for (const row of rows) {
    ensureSpace(rowHeight);
    const rowStartY = doc.y;
    for (let i = 0; i < colCount; i++) {
      const cellText = row[i] ?? "—";
      doc.text(cellText, PAGE_MARGIN + i * colWidth, rowStartY, {
        width: colWidth - 4,
        height: rowHeight,
        ellipsis: true,
      });
    }
    doc.y = rowStartY + rowHeight;
  }
}

function drawHr(doc: InstanceType<typeof PDFDocument>) {
  doc
    .moveTo(PAGE_MARGIN, doc.y)
    .lineTo(PAGE_MARGIN + CONTENT_WIDTH, doc.y)
    .lineWidth(0.5)
    .strokeColor("#ccc")
    .stroke();
}
