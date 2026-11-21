/**
 * GEODATA HUB — Oedometer (1-D consolidation) calculation module (M5.2-f).
 *
 * Serves registry test type OEDOMETER (standard citations verified in M5.1:
 * ASTM D2435 / NF P94-090 / ISO 17892-5). The module implements the
 * authorized M5.2-f scope:
 *
 *   - Stage void ratios: entered directly (registry `oedometerResult` shape)
 *     or derived from specimen-height (dial) readings through the
 *     DEFINITIONAL one-dimensional phase geometry (constant cross-section,
 *     constant solids volume):
 *         e(H) = (H / H_ref) × (1 + e_ref) − 1
 *     with the caller-supplied datum (referenceHeightMm, referenceVoidRatio).
 *   - e–log σ′ curve: loading branch (pressures strictly increasing) and an
 *     optional unloading branch (pressures strictly decreasing) — the actual
 *     loading and unloading stages are kept separate, never merged.
 *   - Initial / final void ratios: first loading stage and last stage
 *     overall (last unloading stage when a rebound branch exists).
 *   - Compression index Cc: least-squares slope of e on log10 σ′ over the
 *     TERMINAL LOADING WINDOW (the last 3 loading stages; the secant of the
 *     last 2 when only two exist) — the numerical realization of reading
 *     the virgin compression line from the final, normally consolidated
 *     portion of the curve (a documented module decision; the standard
 *     defines Cc graphically as the VCL slope). Cc = −slope (positive).
 *   - Swelling/recompression index Cs: least-squares slope of e on log10 σ′
 *     over ALL unloading stages (Cs = −slope). No unloading branch → Cs is
 *     null with an INSUFFICIENT_DATA warning (never invented).
 *   - Coefficient of volume compressibility mv per loading increment
 *     (documented definition, e_i = void ratio at the START of the
 *     increment):
 *         mv_i = (e_i − e_{i+1}) / ((1 + e_i) × (σ_{i+1} − σ_i))   [1/kPa]
 *   - Preconsolidation pressure σ′p — Casagrande graphical construction,
 *     deterministic numerical realization (the selected and documented
 *     interpretation method):
 *       1. VCL = the terminal-window fit above;
 *       2. point B = the point of MAXIMUM CURVATURE of the loading curve,
 *          realized as the middle point of the consecutive loading triple
 *          with the largest circumscribed-circle curvature (1/R);
 *       3. tangent at B = the central secant through B's neighbours
 *          (exact quadratic middle-derivative for the uniform log-spacing
 *          of a standard load-increment-ratio-1 schedule);
 *       4. the bisector of the angle between the horizontal through B and
 *          the tangent at B is intersected with the VCL; σ′p = 10^x at the
 *          intersection.
 *     The construction is reported ONLY when it closes strictly inside the
 *     tested range (x_B < x_int ≤ x_max); otherwise σ′p is null with an
 *     INSUFFICIENT_DATA warning (no distinct break / preconsolidation
 *     pressure beyond the maximum applied stress — never extrapolated).
 *   - Coefficient of consolidation Cv — Casagrande LOG-TIME fitting method
 *     (the selected method; the Taylor square-root-of-time method is NOT
 *     implemented), only when the caller supplies a time-settlement reading
 *     series for one loading increment plus its drainage path Hd:
 *       d0   = intercept of the least-squares dial-vs-√t line over the
 *              FIRST third of the readings (Terzaghi early-time U ∝ √T);
 *       d100 = dial at the intersection of the middle-third (primary) and
 *              last-third (secondary) least-squares lines on the semi-log
 *              (dial vs log10 t) plot — the classical two-asymptote
 *              construction with fixed windows (documented decision);
 *       d50  = (d0 + d100)/2;  t50 = the reading-curve crossing of d50,
 *              linearly interpolated in log10 t between bracketing
 *              readings (never extrapolated);
 *       Cv   = T50 × Hd² / t50   with the governed VERIFIED constant
 *              T50 = 0.197 (Terzaghi theory, D8) — output in mm²/min and
 *              cm²/s (exact SI conversions). The m²/year conversion is NOT
 *              applied: the year-length convention (365 d vs the Julian
 *              365.25 d) could not be verified against the adopted
 *              standards' text (D8) — the registry's m²/year field stays
 *              user-entered and the module emits an INSUFFICIENT_DATA
 *              advisory explaining the blocked conversion.
 *
 * INPUT CONTRACT: the registry `oedometerResult` payload carries the loading
 * `stages` (verticalPressureKpa 0–3200, voidRatio 0.15–4, 2–12, strictly
 * increasing) — consumed as `loadingStages` — plus the entered indicators
 * (compressionIndexCc, swellingIndexCs, preConsolidationPressureKpa,
 * coefficientOfConsolidationCvM2PerYear) which are ECHOED WITHOUT
 * COMPARISON: the M5.1 registry defines no tolerance identity for oedometer
 * indicators, and inventing a comparison tolerance is forbidden (D8-class
 * decision, documented). Engine-side extensions: `unloadingStages`,
 * height-based stages (`specimenHeightMm` + datum), `initialVoidRatio`,
 * `specimenDiameterMm` / `specimenHeightMm` (registry input fields, echoed)
 * and the `consolidationReading` block. Unknown keys are stripped.
 *
 * SEMANTIC RULES: loading pressures strictly increasing and unloading
 * pressures strictly decreasing (registry mirror for the loading branch; the
 * module never silently reorders); the terminal VCL slope must be negative
 * (e decreasing with log σ′ — a non-compressing loading curve is physically
 * invalid data); stage void ratios within the registry bound 0.15–4.
 *
 * PRECISION: `raw` keeps full double precision; rounding happens only at
 * this output boundary — pressures 2 dp, void ratios 4 dp, Cc/Cs 4 dp,
 * σ′p 1 dp, mv 6 dp, Cv 4 dp (mm²/min) / 6 dp (cm²/s). Computed values are
 * never clamped.
 */
import { z } from "zod";
import type { CalculationModule, CalculationWarning } from "../types";
import {
  ArithmeticDomainError,
  InvalidInputError,
  MissingInputError,
  assertFiniteNumber,
  zodErrorToCalculationError,
} from "../errors";
import { roundTo } from "../units";
import { requireVerifiedConstant } from "../constants/sources";

export const OEDOMETER_MODULE_ID = "oedometer";
export const OEDOMETER_MODULE_VERSION = "1.0.0";

/** Registry contract bounds mirrored by this module. */
const MIN_STAGES = 2;
const MAX_STAGES = 12;
const MAX_PRESSURE = 3200;
const MIN_VOID_RATIO = 0.15;
const MAX_VOID_RATIO = 4;
const MIN_CV_READINGS = 6;
const MAX_CV_READINGS = 60;

/** Output boundary decimals. */
const PRESSURE_DECIMALS = 2;
const VOID_RATIO_DECIMALS = 4;
const INDEX_DECIMALS = 4;
const SIGMA_P_DECIMALS = 1;
const MV_DECIMALS = 6;
const CV_DECIMALS = 4;
const CV_CGS_DECIMALS = 6;
const WARNING_DETAIL_DECIMALS = 4;

/** Exact SI conversion mm²/min → cm²/s (1 cm² = 100 mm², 1 min = 60 s). */
const MM2_PER_MIN_TO_CM2_PER_S = 1 / 6000;

/**
 * One consolidation stage: either the void ratio directly (registry shape)
 * or the specimen height (dial-derived), never both (contradictory input is
 * rejected, never reconciled).
 */
export interface OedometerStageInput {
  /** applied vertical (effective) pressure at the end of the stage [kPa] */
  verticalPressureKpa: number;
  /** stage void ratio (registry bound 0.15–4) */
  voidRatio?: number | undefined;
  /** specimen height at the end of the stage [mm] (needs the test datum) */
  specimenHeightMm?: number | undefined;
}

/** Time-settlement reading of one loading increment (Casagrande method). */
export interface ConsolidationReading {
  /** elapsed time since the increment was applied, > 0 [min] */
  timeMin: number;
  /** dial (compression) reading [mm] */
  dialMm: number;
}

const stageSchema = z.object({
  verticalPressureKpa: z.number().min(0).max(MAX_PRESSURE),
  voidRatio: z.number().min(MIN_VOID_RATIO).max(MAX_VOID_RATIO).optional(),
  specimenHeightMm: z.number().positive().max(100).optional(),
});

/**
 * Input schema — the calculable core of the registry `oedometerResult`
 * contract plus engine-side extensions. Exported for compatibility tests.
 * Unknown keys are stripped (Zod default, same as the registry schemas).
 */
export const oedometerCalcInput = z.object({
  loadingStages: z.array(stageSchema).min(MIN_STAGES).max(MAX_STAGES),
  unloadingStages: z.array(stageSchema).min(MIN_STAGES).max(MAX_STAGES).optional(),
  referenceHeightMm: z.number().positive().max(100).optional(),
  referenceVoidRatio: z.number().min(MIN_VOID_RATIO).max(MAX_VOID_RATIO).optional(),
  initialVoidRatio: z.number().min(0.2).max(4).optional(),
  specimenDiameterMm: z.number().positive().min(50).max(120).optional(),
  specimenHeightMm: z.number().positive().min(15).max(60).optional(),
  consolidationReading: z
    .object({
      /** index (0-based, into loadingStages) of the increment's START stage */
      incrementFromIndex: z.number().int().min(0).max(10),
      readings: z
        .array(z.object({ timeMin: z.number().positive().max(10080), dialMm: z.number().min(0).max(100) }))
        .min(MIN_CV_READINGS)
        .max(MAX_CV_READINGS),
      /** drainage path Hd for the increment [mm] (H/2 double drainage, H single) */
      drainagePathMm: z.number().positive().max(100),
    })
    .optional(),
  compressionIndexCc: z.number().min(0).max(3).optional(),
  swellingIndexCs: z.number().min(0).max(1).optional(),
  preConsolidationPressureKpa: z.number().min(0).max(MAX_PRESSURE).optional(),
  coefficientOfConsolidationCvM2PerYear: z.number().min(0).max(50).optional(),
});

export interface OedometerInput {
  loadingStages: OedometerStageInput[];
  unloadingStages?: OedometerStageInput[] | undefined;
  referenceHeightMm?: number | undefined;
  referenceVoidRatio?: number | undefined;
  initialVoidRatio?: number | undefined;
  specimenDiameterMm?: number | undefined;
  specimenHeightMm?: number | undefined;
  consolidationReading?: {
    incrementFromIndex: number;
    readings: ConsolidationReading[];
    drainagePathMm: number;
  } | undefined;
  compressionIndexCc?: number | undefined;
  swellingIndexCs?: number | undefined;
  preConsolidationPressureKpa?: number | undefined;
  coefficientOfConsolidationCvM2PerYear?: number | undefined;
}

/** One resolved stage at full precision. */
export interface OedometerStageRaw {
  verticalPressureKpa: number;
  /** resolved void ratio */
  voidRatio: number;
  /** log10 of the vertical pressure (the e–log σ′ abscissa) */
  log10Pressure: number;
}

/** Full-precision internal values (never rounded, never clamped). */
export interface OedometerRaw {
  loadingStages: OedometerStageRaw[];
  unloadingStages: OedometerStageRaw[];
  /** virgin compression line (terminal window fit): e = vclIntercept + vclSlope·log10 σ′ */
  vclSlope: number;
  vclIntercept: number;
  /** number of terminal loading stages used for the VCL window */
  vclWindowCount: number;
  /** compression index Cc = −vclSlope (positive) */
  compressionIndexCc: number;
  /** swelling index Cs; null without an unloading branch */
  swellingIndexCs: number | null;
  /** preconsolidation pressure [kPa]; null when the construction does not close */
  preConsolidationPressureKpa: number | null;
  /** abscissa of the maximum-curvature point B (log10 σ′); null without a break */
  casagrandeBLog10Pressure: number | null;
  /** circumscribed-circle curvature of the B triple (1/R) */
  casagrandeBCurvature: number | null;
  /** mv per loading increment [1/kPa] */
  mvPerIncrementKpaInverse: number[];
  initialVoidRatio: number;
  finalVoidRatio: number;
  /** Casagrande log-time fit (when a reading series is supplied) */
  cvFit: {
    /** d0 from the early √t-line intercept [mm] */
    d0Mm: number;
    /** d100 from the primary/secondary line intersection [mm] */
    d100Mm: number;
    /** t50 [min] */
    t50Min: number;
    /** Cv [mm²/min] */
    cvMm2PerMin: number;
    /** Cv [cm²/s] (exact SI conversion) */
    cvCm2PerS: number;
  } | null;
}

/** Output-boundary results (rounded; entered values echoed unchanged). */
export interface OedometerResults {
  /** the e–log σ′ curve: loading branch then unloading branch */
  curve: Array<{ verticalPressureKpa: number; voidRatio: number; branch: "LOADING" | "UNLOADING" }>;
  /** compression index Cc (terminal VCL window), 4 dp */
  compressionIndexCc: number;
  /** swelling index Cs, 4 dp; null without an unloading branch */
  swellingIndexCs: number | null;
  /** preconsolidation pressure (Casagrande construction), 1 dp [kPa]; null when not closable */
  preConsolidationPressureKpa: number | null;
  /** interpretation method of σ′p (documented) */
  preConsolidationMethod: "CASAGRANDE" | null;
  /** mv per loading increment [1/kPa], 6 dp */
  mvPerIncrementKpaInverse: number[];
  initialVoidRatio: number;
  finalVoidRatio: number;
  /** Cv (Casagrande log-time fit) in mm²/min (4 dp) and cm²/s (6 dp); null without readings */
  cvMm2PerMin: number | null;
  cvCm2PerS: number | null;
  /** always null: the m²/year conversion is D8-blocked (year-length convention unverified) */
  cvM2PerYear: null;
  /** laboratory-entered indicators, echoed WITHOUT comparison (no registry tolerance — documented) */
  enteredCompressionIndexCc: number | null;
  enteredSwellingIndexCs: number | null;
  enteredPreConsolidationPressureKpa: number | null;
  enteredCvM2PerYear: number | null;
}

// ---------------------------------------------------------------------------
// Curve helpers (exported for direct unit testing)
// ---------------------------------------------------------------------------

/**
 * Void ratio from specimen height through the 1-D phase datum:
 * e = (H / H_ref) × (1 + e_ref) − 1 (constant cross-section, constant
 * solids volume — definitional). Requires H > 0, H_ref > 0, e_ref ≥ 0.
 */
export function voidRatioFromHeight(
  heightMm: number,
  referenceHeightMm: number,
  referenceVoidRatio: number,
): number {
  assertFiniteNumber("voidRatioFromHeight", heightMm);
  assertFiniteNumber("voidRatioFromHeight", referenceHeightMm);
  assertFiniteNumber("voidRatioFromHeight", referenceVoidRatio);
  if (heightMm <= 0 || referenceHeightMm <= 0) {
    throw new ArithmeticDomainError(
      "voidRatioFromHeight",
      `Heights must be strictly positive (received H = ${heightMm} mm, H_ref = ${referenceHeightMm} mm).`,
    );
  }
  if (referenceVoidRatio < 0) {
    throw new ArithmeticDomainError(
      "voidRatioFromHeight",
      `Reference void ratio must be non-negative (received ${referenceVoidRatio}).`,
    );
  }
  const e = (heightMm / referenceHeightMm) * (1 + referenceVoidRatio) - 1;
  assertFiniteNumber("voidRatioFromHeight.result", e);
  return e;
}

/**
 * Least-squares straight line of y on x (the atterberg fitFlowCurve pattern).
 * Requires ≥ 2 DISTINCT x values; returns { slope, intercept }.
 */
export function fitLine(
  points: ReadonlyArray<{ x: number; y: number }>,
): { slope: number; intercept: number } {
  const distinct = new Set(points.map((p) => p.x));
  if (distinct.size < 2) {
    throw new ArithmeticDomainError(
      "fitLine",
      `At least 2 distinct x values are required (all ${points.length} points share x = ${points[0]?.x}).`,
    );
  }
  const n = points.length;
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const xMean = sx / n;
  const yMean = sy / n;
  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    const dx = p.x - xMean;
    const dy = p.y - yMean;
    sxy += dx * dy;
    sxx += dx * dx;
  }
  const slope = sxy / sxx;
  const intercept = yMean - slope * xMean;
  assertFiniteNumber("fitLine.slope", slope);
  assertFiniteNumber("fitLine.intercept", intercept);
  return { slope, intercept };
}

/**
 * Curvature (1/R of the circumscribed circle) of three consecutive points;
 * exactly collinear triples return 0. Used by the Casagrande construction
 * to locate the point of maximum curvature.
 */
export function tripleCurvature(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
): number {
  const a = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const b = Math.hypot(p3.x - p2.x, p3.y - p2.y);
  const c = Math.hypot(p3.x - p1.x, p3.y - p1.y);
  const twiceArea = Math.abs(
    (p2.x - p1.x) * (p3.y - p1.y) - (p3.x - p1.x) * (p2.y - p1.y),
  );
  if (twiceArea === 0) return 0;
  const radius = (a * b * c) / (2 * twiceArea);
  if (!Number.isFinite(radius) || radius <= 0) return 0;
  return 1 / radius;
}

/**
 * Casagrande preconsolidation construction on the loading curve
 * (e vs x = log10 σ′). PRECONDITION: stages resolved, ≥ 3 loading stages,
 * vcl = { slope, intercept } of the virgin line with slope < 0.
 * Returns the intersection pressure and internals, or null with a reason
 * when the construction does not close strictly inside the tested range.
 */
export function casagrandePreconsolidation(
  stages: ReadonlyArray<OedometerStageRaw>,
  vcl: { slope: number; intercept: number },
): {
  preConsolidationPressureKpa: number | null;
  bLog10Pressure: number | null;
  bCurvature: number | null;
} {
  let bestI = -1;
  let bestCurvature = 0;
  for (let i = 1; i < stages.length - 1; i++) {
    const curvature = tripleCurvature(
      { x: stages[i - 1].log10Pressure, y: stages[i - 1].voidRatio },
      { x: stages[i].log10Pressure, y: stages[i].voidRatio },
      { x: stages[i + 1].log10Pressure, y: stages[i + 1].voidRatio },
    );
    if (curvature > bestCurvature) {
      bestCurvature = curvature;
      bestI = i;
    }
  }
  if (bestI < 0 || bestCurvature === 0) {
    return { preConsolidationPressureKpa: null, bLog10Pressure: null, bCurvature: null };
  }
  const b = stages[bestI];
  const prev = stages[bestI - 1];
  const next = stages[bestI + 1];
  // Tangent at B: central secant through the neighbours (exact quadratic
  // middle-derivative under the uniform log-spacing of a doubling schedule).
  const tangentSlope = (next.voidRatio - prev.voidRatio) / (next.log10Pressure - prev.log10Pressure);
  // Internal bisector of the horizontal (1, 0) and the tangent direction.
  const tangentNorm = Math.sqrt(1 + tangentSlope * tangentSlope);
  const dx = 1 + 1 / tangentNorm;
  const dy = tangentSlope / tangentNorm;
  // Intersect the bisector (from B, direction (dx, dy)) with the VCL
  //   e_B + t·dy = intercept + slope·(x_B + t·dx)
  const denominator = dy - vcl.slope * dx;
  if (denominator === 0 || !Number.isFinite(denominator)) {
    return { preConsolidationPressureKpa: null, bLog10Pressure: b.log10Pressure, bCurvature: bestCurvature };
  }
  const t = (vcl.intercept + vcl.slope * b.log10Pressure - b.voidRatio) / denominator;
  const xIntersection = b.log10Pressure + t * dx;
  const xMax = stages[stages.length - 1].log10Pressure;
  if (!(t > 0) || !(xIntersection > b.log10Pressure) || !(xIntersection <= xMax)) {
    return { preConsolidationPressureKpa: null, bLog10Pressure: b.log10Pressure, bCurvature: bestCurvature };
  }
  const sigmaP = 10 ** xIntersection;
  assertFiniteNumber("casagrandePreconsolidation", sigmaP);
  return { preConsolidationPressureKpa: sigmaP, bLog10Pressure: b.log10Pressure, bCurvature: bestCurvature };
}

/**
 * Casagrande log-time fit of one increment's reading series.
 * PRECONDITION: readings sorted by strictly increasing time, ≥ 6 readings.
 * Fixed windows (documented): first ⌊n/3⌋ readings for the early √t line,
 * middle ⌊n/3⌋ for the primary semi-log line, last ⌊n/3⌋ for the secondary
 * line (minimum 2 per window). Returns null when d50 is not bracketed by
 * the readings (never extrapolated).
 */
export function casagrandeLogTimeFit(
  readings: ReadonlyArray<ConsolidationReading>,
): { d0Mm: number; d100Mm: number; t50Min: number | null } {
  const n = readings.length;
  const window = Math.max(2, Math.floor(n / 3));
  // d0: intercept of the early dial-vs-√t line (first window).
  const early = readings.slice(0, window);
  const earlyFit = fitLine(
    early.map((r) => ({ x: Math.sqrt(r.timeMin), y: r.dialMm })),
  );
  const d0 = earlyFit.intercept;
  // Primary (middle third) and secondary (last third) lines on the semi-log plot.
  const primary = readings.slice(window, n - window);
  const secondary = readings.slice(n - window);
  if (primary.length < 2) {
    throw new ArithmeticDomainError(
      "casagrandeLogTimeFit",
      `The reading series leaves fewer than 2 readings for the primary window (n = ${n}).`,
    );
  }
  const primaryFit = fitLine(primary.map((r) => ({ x: Math.log10(r.timeMin), y: r.dialMm })));
  const secondaryFit = fitLine(secondary.map((r) => ({ x: Math.log10(r.timeMin), y: r.dialMm })));
  // d100: intersection of the primary and secondary lines.
  const denominator = primaryFit.slope - secondaryFit.slope;
  if (denominator === 0 || !Number.isFinite(denominator)) {
    throw new ArithmeticDomainError(
      "casagrandeLogTimeFit",
      "The primary and secondary semi-log lines are parallel — d100 is undefined.",
    );
  }
  const x100 = (secondaryFit.intercept - primaryFit.intercept) / denominator;
  const d100 = primaryFit.intercept + primaryFit.slope * x100;
  assertFiniteNumber("casagrandeLogTimeFit.d100", d100);
  // d50 and its crossing time, interpolated linearly in log10 t.
  const d50 = (d0 + d100) / 2;
  for (let i = 1; i < n; i++) {
    const y1 = readings[i - 1].dialMm;
    const y2 = readings[i].dialMm;
    if ((y1 <= d50 && d50 <= y2) || (y2 <= d50 && d50 <= y1)) {
      if (y2 === y1) continue;
      const x1 = Math.log10(readings[i - 1].timeMin);
      const x2 = Math.log10(readings[i].timeMin);
      const fraction = (d50 - y1) / (y2 - y1);
      const t50 = 10 ** (x1 + fraction * (x2 - x1));
      assertFiniteNumber("casagrandeLogTimeFit.t50", t50);
      return { d0Mm: d0, d100Mm: d100, t50Min: t50 };
    }
  }
  return { d0Mm: d0, d100Mm: d100, t50Min: null };
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

/** Resolve one stage's void ratio (direct or height-derived). */
function resolveStages(
  stages: OedometerStageInput[],
  referenceHeightMm: number | undefined,
  referenceVoidRatio: number | undefined,
  branch: "loadingStages" | "unloadingStages",
): OedometerStageRaw[] {
  return stages.map((s, i) => {
    let voidRatio: number;
    if (s.voidRatio !== undefined) {
      voidRatio = s.voidRatio;
      if (s.specimenHeightMm !== undefined) {
        throw new InvalidInputError(
          `${branch}.${i}.voidRatio`,
          `Stage ${i} supplies BOTH voidRatio and specimenHeightMm — contradictory input is rejected, never reconciled.`,
        );
      }
    } else if (s.specimenHeightMm !== undefined) {
      if (referenceHeightMm === undefined || referenceVoidRatio === undefined) {
        throw new MissingInputError(
          `Missing required input field(s): referenceHeightMm, referenceVoidRatio (needed by ${branch}.${i}.specimenHeightMm to derive the void ratio)`,
          [
            { path: "referenceHeightMm", code: "missing", message: "the height datum is required for height-based stages" },
            { path: "referenceVoidRatio", code: "missing", message: "the height datum is required for height-based stages" },
          ],
        );
      }
      voidRatio = voidRatioFromHeight(s.specimenHeightMm, referenceHeightMm, referenceVoidRatio);
    } else {
      throw new InvalidInputError(
        `${branch}.${i}.voidRatio`,
        `Stage ${i} carries neither voidRatio nor specimenHeightMm — a measurement is required.`,
      );
    }
    if (voidRatio < MIN_VOID_RATIO || voidRatio > MAX_VOID_RATIO) {
      throw new InvalidInputError(
        `${branch}.${i}.voidRatio`,
        `Resolved void ratio ${voidRatio} is outside the registry bound [${MIN_VOID_RATIO}, ${MAX_VOID_RATIO}] (computed values are validated against the storage contract; no clamping).`,
      );
    }
    return {
      verticalPressureKpa: s.verticalPressureKpa,
      voidRatio,
      log10Pressure: Math.log10(s.verticalPressureKpa),
    };
  });
}

export const oedometerModule: CalculationModule<OedometerInput, OedometerRaw, OedometerResults> = {
  id: OEDOMETER_MODULE_ID,
  testType: "OEDOMETER",
  version: OEDOMETER_MODULE_VERSION,
  label: "Oedometer consolidation (e–log σ′, Cc/Cs, mv, Casagrande σ′p, Cv log-time)",
  description:
    "Builds the e–log σ′ curve from the loading and unloading stages (void ratios entered or derived from specimen-height readings through the 1-D phase datum), reads the compression index from the terminal virgin-line window, the swelling index from the unloading branch, the coefficient of volume compressibility per increment, the preconsolidation pressure by a documented deterministic Casagrande construction (maximum-curvature point, bisector, virgin-line intersection — reported only when it closes inside the tested range) and — when a time-settlement series with drainage path is supplied — the coefficient of consolidation by the Casagrande log-time method with the governed T50 = 0.197 (mm²/min and cm²/s; the m²/year conversion is D8-blocked). Entered indicators are echoed without comparison (no registry tolerance exists).",

  validateInput(raw: unknown): OedometerInput {
    if (raw !== null && typeof raw === "object") {
      const record = raw as Record<string, unknown>;
      if (record.loadingStages === undefined) {
        throw new MissingInputError(
          "Missing required input field(s): loadingStages",
          [{ path: "loadingStages", code: "missing", message: "loadingStages is required (the consolidation loading branch)." }],
        );
      }
    }
    const parsed = oedometerCalcInput.safeParse(raw);
    if (!parsed.success) {
      throw zodErrorToCalculationError(parsed.error, raw);
    }
    const input = parsed.data;

    // Loading pressures strictly increasing (registry mirror).
    for (let i = 1; i < input.loadingStages.length; i++) {
      if (input.loadingStages[i].verticalPressureKpa <= input.loadingStages[i - 1].verticalPressureKpa) {
        throw new InvalidInputError(
          `loadingStages.${i}.verticalPressureKpa`,
          `Loading pressures must be strictly increasing (stage ${i}: ${input.loadingStages[i].verticalPressureKpa} kPa follows ${input.loadingStages[i - 1].verticalPressureKpa} kPa) — M5.1 contract.`,
        );
      }
    }
    // Unloading pressures strictly decreasing (module rule, same policy).
    if (input.unloadingStages !== undefined) {
      for (let i = 1; i < input.unloadingStages.length; i++) {
        if (input.unloadingStages[i].verticalPressureKpa >= input.unloadingStages[i - 1].verticalPressureKpa) {
          throw new InvalidInputError(
            `unloadingStages.${i}.verticalPressureKpa`,
            `Unloading pressures must be strictly decreasing (stage ${i}: ${input.unloadingStages[i].verticalPressureKpa} kPa follows ${input.unloadingStages[i - 1].verticalPressureKpa} kPa) — the rebound branch is never reordered.`,
          );
        }
      }
    }
    // Consolidation readings: strictly increasing time, valid increment index.
    if (input.consolidationReading !== undefined) {
      const cr = input.consolidationReading;
      if (cr.incrementFromIndex >= input.loadingStages.length - 1) {
        throw new InvalidInputError(
          "consolidationReading.incrementFromIndex",
          `incrementFromIndex ${cr.incrementFromIndex} does not identify a loading increment (loadingStages has ${input.loadingStages.length} stages; the index must be 0–${input.loadingStages.length - 2}).`,
        );
      }
      for (let i = 1; i < cr.readings.length; i++) {
        if (cr.readings[i].timeMin <= cr.readings[i - 1].timeMin) {
          throw new InvalidInputError(
            `consolidationReading.readings.${i}.timeMin`,
            `Reading times must be strictly increasing (reading ${i}: ${cr.readings[i].timeMin} min follows ${cr.readings[i - 1].timeMin} min) — never silently reordered.`,
          );
        }
      }
    }
    return input;
  },

  compute(input: OedometerInput) {
    const warnings: CalculationWarning[] = [];

    // 1. Resolve the stage void ratios.
    const loading = resolveStages(
      input.loadingStages, input.referenceHeightMm, input.referenceVoidRatio, "loadingStages",
    );
    const unloading =
      input.unloadingStages === undefined
        ? []
        : resolveStages(
            input.unloadingStages, input.referenceHeightMm, input.referenceVoidRatio, "unloadingStages",
          );

    // 2. Virgin compression line — terminal loading window (last 3 stages,
    //    or all stages when fewer), least-squares of e on log10 σ′.
    const vclWindowCount = Math.min(3, loading.length);
    const vclWindow = loading.slice(loading.length - vclWindowCount);
    const vcl = fitLine(vclWindow.map((s) => ({ x: s.log10Pressure, y: s.voidRatio })));
    if (vcl.slope >= 0) {
      throw new InvalidInputError(
        "loadingStages",
        `The terminal loading window (last ${vclWindowCount} stages, ${roundTo(vclWindow[0].verticalPressureKpa, PRESSURE_DECIMALS)}–${roundTo(vclWindow[vclWindow.length - 1].verticalPressureKpa, PRESSURE_DECIMALS)} kPa) has a non-negative e–log σ′ slope (${vcl.slope}) — void ratio must decrease with pressure; the stages are physically inconsistent.`,
      );
    }
    const compressionIndexCc = -vcl.slope;

    // 3. Swelling index from the unloading branch (null when absent).
    let swellingIndexCs: number | null = null;
    if (unloading.length >= 2) {
      const unloadFit = fitLine(unloading.map((s) => ({ x: s.log10Pressure, y: s.voidRatio })));
      swellingIndexCs = -unloadFit.slope;
      if (swellingIndexCs < 0) {
        warnings.push({
          code: "PHYSICAL_CONSISTENCY",
          message:
            `The fitted unloading slope is negative (Cs = ${roundTo(swellingIndexCs, INDEX_DECIMALS)}) — the rebound branch shows compression; the data are reported as computed, check the unloading stages.`,
          details: { swellingIndexCs: roundTo(swellingIndexCs, WARNING_DETAIL_DECIMALS) },
        });
      }
    } else {
      warnings.push({
        code: "INSUFFICIENT_DATA",
        message:
          `No unloading stages supplied — the swelling/recompression index Cs is not computable and is not reported (never invented).`,
        details: { unloadingStageCount: 0 },
      });
    }

    // 4. Preconsolidation pressure — Casagrande construction (documented).
    let sigmaP: number | null = null;
    let bLog10: number | null = null;
    let bCurvature: number | null = null;
    if (loading.length >= 3) {
      const construction = casagrandePreconsolidation(loading, vcl);
      sigmaP = construction.preConsolidationPressureKpa;
      bLog10 = construction.bLog10Pressure;
      bCurvature = construction.bCurvature;
      if (sigmaP === null) {
        warnings.push({
          code: "INSUFFICIENT_DATA",
          message:
            `The Casagrande construction does not close strictly inside the tested pressure range ` +
              `(maximum curvature at σ′ = ${roundTo(10 ** (bLog10 ?? 0), PRESSURE_DECIMALS)} kPa, tested up to ` +
              `${roundTo(loading[loading.length - 1].verticalPressureKpa, PRESSURE_DECIMALS)} kPa) — either the curve shows ` +
              `no distinct preconsolidation break (normally consolidated within the tested range) or σ′p lies beyond the ` +
              `maximum applied stress; extrapolation is not performed and σ′p is not reported.`,
          details: {
            maxCurvaturePressureKpa: bLog10 === null ? null : roundTo(10 ** bLog10, WARNING_DETAIL_DECIMALS),
            maxTestedPressureKpa: roundTo(loading[loading.length - 1].verticalPressureKpa, WARNING_DETAIL_DECIMALS),
          },
        });
      }
    } else {
      warnings.push({
        code: "INSUFFICIENT_DATA",
        message:
          `Fewer than 3 loading stages — the Casagrande maximum-curvature construction is undefined; σ′p is not reported.`,
        details: { loadingStageCount: loading.length },
      });
    }

    // 5. mv per loading increment (e_i = void ratio at the increment start).
    const mvPerIncrementKpaInverse: number[] = [];
    for (let i = 0; i < loading.length - 1; i++) {
      const e1 = loading[i].voidRatio;
      const e2 = loading[i + 1].voidRatio;
      const dSigma = loading[i + 1].verticalPressureKpa - loading[i].verticalPressureKpa;
      const mv = (e1 - e2) / ((1 + e1) * dSigma);
      assertFiniteNumber("mvPerIncrement", mv);
      mvPerIncrementKpaInverse.push(mv);
    }

    const initialVoidRatio = loading[0].voidRatio;
    const finalVoidRatio =
      unloading.length > 0 ? unloading[unloading.length - 1].voidRatio : loading[loading.length - 1].voidRatio;

    // 6. Cv — Casagrande log-time fit (when the reading series is supplied).
    let cvFit: OedometerRaw["cvFit"] = null;
    if (input.consolidationReading !== undefined) {
      const fit = casagrandeLogTimeFit(input.consolidationReading.readings);
      if (fit.t50Min === null) {
        warnings.push({
          code: "INSUFFICIENT_DATA",
          message:
            `The 50 % consolidation dial (d50 = ${roundTo((fit.d0Mm + fit.d100Mm) / 2, 2)} mm) is not bracketed by ` +
              `the reading series — t50 is undefined and Cv is not reported (never extrapolated).`,
          details: {
            d0Mm: roundTo(fit.d0Mm, WARNING_DETAIL_DECIMALS),
            d100Mm: roundTo(fit.d100Mm, WARNING_DETAIL_DECIMALS),
          },
        });
      } else {
        const t50 = requireVerifiedConstant("consolidation.timeFactorT50");
        const hd = input.consolidationReading.drainagePathMm;
        const cvMm2PerMin = (t50 * hd * hd) / fit.t50Min;
        assertFiniteNumber("cvMm2PerMin", cvMm2PerMin);
        cvFit = {
          d0Mm: fit.d0Mm,
          d100Mm: fit.d100Mm,
          t50Min: fit.t50Min,
          cvMm2PerMin,
          cvCm2PerS: cvMm2PerMin * MM2_PER_MIN_TO_CM2_PER_S,
        };
        warnings.push({
          code: "INSUFFICIENT_DATA",
          message:
            `The m²/year Cv conversion is not applied — the year-length convention (365 d vs the Julian 365.25 d) ` +
              `could not be verified against the adopted standards' text (D8); Cv is reported in mm²/min and cm²/s ` +
              `(exact SI conversions) and the registry's m²/year field stays user-entered.`,
          details: { cvMm2PerMin: roundTo(cvMm2PerMin, WARNING_DETAIL_DECIMALS) },
        });
      }
    }

    const raw: OedometerRaw = {
      loadingStages: loading,
      unloadingStages: unloading,
      vclSlope: vcl.slope,
      vclIntercept: vcl.intercept,
      vclWindowCount,
      compressionIndexCc,
      swellingIndexCs,
      preConsolidationPressureKpa: sigmaP,
      casagrandeBLog10Pressure: bLog10,
      casagrandeBCurvature: bCurvature,
      mvPerIncrementKpaInverse,
      initialVoidRatio,
      finalVoidRatio,
      cvFit,
    };

    // 7. Output boundary. Entered indicators are echoed WITHOUT comparison
    //    (the M5.1 registry defines no tolerance identity for oedometer
    //    indicators — none is invented).
    const results: OedometerResults = {
      curve: [
        ...loading.map((s) => ({
          verticalPressureKpa: roundTo(s.verticalPressureKpa, PRESSURE_DECIMALS),
          voidRatio: roundTo(s.voidRatio, VOID_RATIO_DECIMALS),
          branch: "LOADING" as const,
        })),
        ...unloading.map((s) => ({
          verticalPressureKpa: roundTo(s.verticalPressureKpa, PRESSURE_DECIMALS),
          voidRatio: roundTo(s.voidRatio, VOID_RATIO_DECIMALS),
          branch: "UNLOADING" as const,
        })),
      ],
      compressionIndexCc: roundTo(compressionIndexCc, INDEX_DECIMALS),
      swellingIndexCs: swellingIndexCs === null ? null : roundTo(swellingIndexCs, INDEX_DECIMALS),
      preConsolidationPressureKpa: sigmaP === null ? null : roundTo(sigmaP, SIGMA_P_DECIMALS),
      preConsolidationMethod: sigmaP === null ? null : "CASAGRANDE",
      mvPerIncrementKpaInverse: mvPerIncrementKpaInverse.map((mv) => roundTo(mv, MV_DECIMALS)),
      initialVoidRatio: roundTo(initialVoidRatio, VOID_RATIO_DECIMALS),
      finalVoidRatio: roundTo(finalVoidRatio, VOID_RATIO_DECIMALS),
      cvMm2PerMin: cvFit === null ? null : roundTo(cvFit.cvMm2PerMin, CV_DECIMALS),
      cvCm2PerS: cvFit === null ? null : roundTo(cvFit.cvCm2PerS, CV_CGS_DECIMALS),
      cvM2PerYear: null,
      enteredCompressionIndexCc: input.compressionIndexCc ?? null,
      enteredSwellingIndexCs: input.swellingIndexCs ?? null,
      enteredPreConsolidationPressureKpa: input.preConsolidationPressureKpa ?? null,
      enteredCvM2PerYear: input.coefficientOfConsolidationCvM2PerYear ?? null,
    };

    return { raw, results, warnings };
  },
};
