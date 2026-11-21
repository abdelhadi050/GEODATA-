/**
 * GEODATA HUB — Proctor compaction calculation module (M5.2-d).
 *
 * Serves registry test type PROCTOR (standard citations verified in M5.1:
 * ASTM D698 / ASTM D1557 / NF P94-093). The module implements the authorized
 * M5.2-d scope:
 *
 *   - Per-point water content w, from the entered percentage and/or from the
 *     point's tare-included masses (reusing the M5.1 F2 semantics and the
 *     M5.2-a phase-relation helpers):
 *         w = 100 × (wetMassG − dryMassG) / (dryMassG − containerMassG)
 *   - Per-point wet density, from the entered wet density or from the
 *     compaction-mold bookkeeping (a SEPARATE measurement from the water-
 *     content dish: the net mass of wet soil compacted into the mold):
 *         ρwet [Mg/m³] = wetSoilMassG [g] / moldVolumeCm3 [cm³]
 *     (1 g/cm³ ≡ 1 Mg/m³ — exact SI prefix arithmetic).
 *   - Per-point dry density (definitional three-phase relation):
 *         ρd = ρwet / (1 + w/100)
 *     (or the entered dry density directly when no wet measurement exists).
 *   - Compaction curve and its peak: the least-squares PARABOLA of dry
 *     density on water content, fitted to the CREST WINDOW — the measured
 *     peak point and its moisture neighbours (the classical laboratory
 *     reading of the crest from the points around the maximum; a global
 *     parabola is NOT used because a full-curve fit is dominated by the
 *     long dry branch and underestimates the peak, contradicting the M5.1
 *     registry's own consistency rule maxDryDensity ≥ highest point − 0.01).
 *     The fit uses the orthogonalized centered basis u = w − w̄,
 *     φ2 = u² − Suu/n (numerically stable, constant term = ȳ exactly):
 *         [ Suu   Suuu          ] [B]   [ Suy                    ]
 *         [ Suuu  Suuuu − Suu²/n] [C] = [ Suuy − (Suu/n)·Σy      ]
 *         c2 = C;  c1 = B − 2·C·w̄;  c0 = ȳ − B·w̄ + C·(w̄² − Suu/n)
 *         OMC = −c1/(2·c2),  MDD = c0 − c1²/(4·c2)      (vertex, c2 < 0)
 *     Window rule (documented module decision): points must arrive in
 *     non-decreasing water-content order (replicates allowed); the window is
 *     the 3 consecutive points containing the measured peak (first maximum
 *     in input order); when that window carries fewer than 3 distinct water
 *     contents (replicate determinations at the peak moisture), the fit
 *     extends to ALL points.
 *   - Zero Air Voids (ZAV) curve, only when a valid Gs is supplied:
 *         ρd,ZAV = Gs · ρw / (1 + w·Gs/100)          [ρw governed VERIFIED
 *                                                      constant, D8]
 *     (100 % saturation bound: a measured ρd above ZAV is physically
 *     impossible — reported as a PHYSICAL_CONSISTENCY warning, not an error,
 *     because the entered Gs may itself be the wrong input).
 *
 * NO MDD/OMC FABRICATION: the peak is reported ONLY when the fitted parabola
 * is concave (C < 0) AND its vertex lies strictly inside the tested moisture
 * range (min w < OMC < max w — the peak is bracketed by measurements,
 * mirroring the M5.2-b/c no-extrapolation policy). Otherwise MDD/OMC are
 * null with an INSUFFICIENT_DATA warning; the per-point results, the
 * regression coefficients and the optional ZAV curve are still reported.
 * A fit needs ≥ 3 DISTINCT water contents (the quadratic design matrix must
 * have full rank); fewer is ARITHMETIC_DOMAIN_ERROR.
 *
 * METHOD GATE — no mixing (authorization §4): `method` (STANDARD = ASTM
 * D698 / NF P94-093 "normal", MODIFIED = ASTM D1557) is honored strictly and
 * echoed. The compaction-curve arithmetic is identical for both efforts (the
 * curve is read off the measured points; no effort constant — blow count,
 * drop height, layer count — enters the calculation), so the method never
 * changes a number; it is recorded so results cannot be mislabeled.
 *
 * INPUT CONTRACT: the registry `proctorResult` payload carries the
 * laboratory-entered finals (points with moistureContent + dryDensity +
 * optional wetDensityMgM3, maxDryDensity, optimumMoisture). This module
 * consumes that shape and extends it engine-side (the granulometry pattern):
 * per-point masses (water content by oven drying), per-point wet mass +
 * test-level mold volume (wet density from mold bookkeeping), optional Gs
 * (ZAV), and the entered finals under their registry field names and bounds.
 * `mold` is the registry input enum (informational — the volume is NEVER
 * inferred from it: mold nominal volumes are standard-specific constants,
 * D8-blocked; callers supply moldVolumeCm3 explicitly). Unknown keys —
 * including the registry's `notes` — are stripped (Zod default).
 *
 * SEMANTIC RULES (mirrors of the M5.1 `proctorResult` superRefine, applied to
 * the computed per-point dry densities when the entered finals are present):
 *   - entered maxDryDensity ≥ (peak measured/computed ρd) − 0.01;
 *   - entered maxDryDensity ≤ (peak measured/computed ρd) + 0.2;
 *   - entered optimumMoisture within [min w − 1, max w + 1];
 *   - entered wetDensityMgM3 ≥ entered dryDensity per point
 *     (ρwet = ρd × (1 + w), w ≥ 0).
 *
 * ENTERED-VALUE COMPARISONS (warnings never overwrite): computed MDD vs
 * entered maxDryDensity beyond ±0.01 Mg/m³, computed OMC vs entered
 * optimumMoisture beyond ±1.0 percentage points, per-point w from masses vs
 * entered waterContentPercent beyond ±0.5, per-point ρd from wet
 * measurements vs entered dryDensity beyond ±0.01. Provenance: the M5.1
 * registry tolerances for this test type (±0.01 and ±1.0 in the proctor
 * superRefine) and the registry water-content identity (±0.5) — project
 * engineering tolerances, not standard-verified constants (same class as
 * docs/14 §9 R1).
 *
 * PRECISION: `raw` keeps full double precision; rounding happens only at
 * this output boundary — water contents 2 dp, densities 3 dp, ZAV 3 dp,
 * parabola coefficients (reported in original w space) 6 dp. Computed values
 * are never clamped: a computed MDD outside the registry storage bound is
 * reported as-is — the engine computes and advises, the registry gates at
 * write time (docs/14 §5).
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
import {
  drySoilMassFromTareMasses,
  waterContentPercent,
  waterMassFromTareMasses,
} from "../formulas/phase-relations";

export const PROCTOR_MODULE_ID = "proctor";
export const PROCTOR_MODULE_VERSION = "1.0.0";

/**
 * Entered-value comparison tolerances. Provenance: the M5.1 registry
 * `proctorResult` superRefine uses 0.01 Mg/m³ ("maxDryDensity cannot be lower
 * than the highest measured point") and 1 percentage point
 * ("optimumMoisture must lie within the tested moisture range (±1)"); the
 * water-content magnitude ±0.5 comes from the M5.1 water-content identity.
 * Project engineering tolerances, not standard-verified.
 */
export const PROCTOR_DENSITY_TOLERANCE = 0.01;
export const PROCTOR_MOISTURE_TOLERANCE = 1.0;
export const PROCTOR_WATER_CONTENT_TOLERANCE = 0.5;

/** Registry contract bounds mirrored by this module (documented decisions). */
const MIN_POINTS = 3;
const MAX_POINTS = 8;
const MIN_DISTINCT_MOISTURES = 3;
const MAX_WATER_CONTENT = 60;

/** Output boundary: water contents 2 dp, densities 3 dp, coefficients 6 dp. */
const MOISTURE_DECIMALS = 2;
const DENSITY_DECIMALS = 3;
const COEFFICIENT_DECIMALS = 6;
const WARNING_DETAIL_DECIMALS = 4;

/**
 * One measured compaction point. At least one density source
 * (dryDensityMgM3 / wetDensityMgM3 / wetSoilMassG + test-level moldVolumeCm3)
 * and one water-content source (waterContentPercent / the three dish masses)
 * must be present; multiple sources are cross-checked with warnings.
 *
 * Mass semantics (two distinct laboratory measurements, both M5.1-aligned):
 *   - the density path uses wetSoilMassG = NET wet soil mass in the mold;
 *   - the water-content path uses the M5.1 F2 dish triple (wetMassG /
 *     dryMassG / containerMassG, all tare-included gross masses).
 */
export interface ProctorPointInput {
  /** molding water content of the point, 0–60 [%] (registry field name) */
  moistureContent?: number | undefined;
  /** tare-included wet gross dish mass, g (M5.1 F2 semantics), for w from masses */
  wetMassG?: number | undefined;
  /** tare-included dry gross dish mass, g */
  dryMassG?: number | undefined;
  /** tare (empty dish) mass, g */
  containerMassG?: number | undefined;
  /** NET wet soil mass compacted into the mold, g (density bookkeeping) */
  wetSoilMassG?: number | undefined;
  /** wet (bulk) density of the point, 1.0–3.0 [Mg/m³] (registry bound) */
  wetDensityMgM3?: number | undefined;
  /** dry density of the point, 1.0–2.7 [Mg/m³] (registry field name/bound) */
  dryDensity?: number | undefined;
}

/**
 * Input schema — engine-side extension of the registry `proctorResult`
 * calculable core (bounds identical where fields overlap). Exported so
 * compatibility tests can assert behavioral parity against the registry
 * schema. Unknown keys are stripped (Zod default, same as the registry).
 */
export const proctorCalcInput = z.object({
  method: z.enum(["STANDARD", "MODIFIED"]),
  mold: z.enum(["101.6MM", "152.4MM"]).optional(),
  /** internal volume of the compaction mold, cm³; required for mass-based points */
  moldVolumeCm3: z.number().positive().max(10000).optional(),
  /** specific gravity of solids Gs, 2.30–2.95 (registry SPECIFIC_GRAVITY bound); enables ZAV */
  specificGravity: z.number().min(2.3).max(2.95).optional(),
  points: z
    .array(
      z.object({
        moistureContent: z.number().min(0).max(MAX_WATER_CONTENT).optional(),
        wetMassG: z.number().positive().max(20000).optional(),
        dryMassG: z.number().positive().max(20000).optional(),
        containerMassG: z.number().positive().max(20000).optional(),
        wetSoilMassG: z.number().positive().max(30000).optional(),
        wetDensityMgM3: z.number().min(1.0).max(3.0).optional(),
        dryDensity: z.number().min(1.0).max(2.7).optional(),
      }),
    )
    .min(MIN_POINTS)
    .max(MAX_POINTS),
  maxDryDensity: z.number().min(1.0).max(2.7).optional(),
  optimumMoisture: z.number().min(0).max(MAX_WATER_CONTENT).optional(),
});

export interface ProctorInput {
  method: "STANDARD" | "MODIFIED";
  mold?: "101.6MM" | "152.4MM" | undefined;
  moldVolumeCm3?: number | undefined;
  specificGravity?: number | undefined;
  points: ProctorPointInput[];
  maxDryDensity?: number | undefined;
  optimumMoisture?: number | undefined;
}

/** One resolved compaction point at full precision. */
export interface ProctorPointRaw {
  /** resolved molding water content [%] */
  moistureContent: number;
  /** resolved wet density [Mg/m³]; null when no wet measurement exists */
  wetDensityMgM3: number | null;
  /** resolved dry density [Mg/m³] */
  dryDensity: number;
  /** ZAV dry density at this water content [Mg/m³]; null without Gs */
  zavDryDensityMgM3: number | null;
  /** entered dry density echoed [Mg/m³]; null when absent */
  enteredDryDensity: number | null;
}

/** Full-precision internal values (never rounded, never clamped). */
export interface ProctorRaw {
  points: ProctorPointRaw[];
  /** parabola coefficients in ORIGINAL w space: ρd = c0 + c1·w + c2·w² */
  curveCoefficientConstant: number;
  curveCoefficientLinear: number;
  curveCoefficientQuadratic: number;
  /** maximum dry density at the fitted vertex [Mg/m³]; null when not derivable */
  maxDryDensity: number | null;
  /** optimum moisture content at the fitted vertex [%]; null when not derivable */
  optimumMoisture: number | null;
  /** ZAV dry density at the OMC [Mg/m³]; null without Gs or OMC */
  zavAtOptimumMgM3: number | null;
}

/** Output-boundary results (rounded; entered values echoed unchanged). */
export interface ProctorResults {
  method: "STANDARD" | "MODIFIED";
  mold: "101.6MM" | "152.4MM" | null;
  /** number of compaction points */
  pointCount: number;
  /** per-point resolved values, input order (registry-compatible field names) */
  points: Array<{
    moistureContent: number;
    dryDensity: number;
    wetDensityMgM3: number | null;
    zavDryDensityMgM3: number | null;
  }>;
  /** compaction-curve parabola ρd = c0 + c1·w + c2·w², 6 dp */
  curveCoefficientConstant: number;
  curveCoefficientLinear: number;
  curveCoefficientQuadratic: number;
  /** maximum dry density [Mg/m³], 3 dp; null when the peak is not bracketed */
  maxDryDensity: number | null;
  /** optimum moisture content [%], 2 dp; null when the peak is not bracketed */
  optimumMoisture: number | null;
  /** zero-air-voids curve points (measured moistures + OMC when known), 3 dp */
  zavCurve: Array<{ moistureContent: number; zavMgM3: number }> | null;
  /** laboratory-entered finals, echoed unchanged (null when absent) */
  enteredMaxDryDensity: number | null;
  enteredOptimumMoisture: number | null;
}

// ---------------------------------------------------------------------------
// Compaction-curve helpers (exported for direct unit testing)
// ---------------------------------------------------------------------------

/**
 * Least-squares parabola of y on x in the orthogonalized centered basis
 * u = x − x̄, φ2 = u² − Suu/n (so the constant term is ȳ exactly and the
 * 2×2 system for (B, C) is well-conditioned). Returns the coefficients in
 * ORIGINAL x space: y = c0 + c1·x + c2·x².
 *
 * PRECONDITION: ≥ 3 DISTINCT x values (full-rank quadratic design); fewer is
 * ARITHMETIC_DOMAIN_ERROR. Sums accumulate in input order (deterministic).
 */
export function fitCompactionParabola(
  points: ReadonlyArray<{ x: number; y: number }>,
): { c0: number; c1: number; c2: number; centeredLinear: number; centeredQuadratic: number } {
  const distinctX = new Set(points.map((p) => p.x));
  if (distinctX.size < 2) {
    throw new ArithmeticDomainError(
      "fitCompactionParabola",
      `At least 2 distinct water contents are required to fit any curve (all ${points.length} points share w = ${points[0]?.x}).`,
    );
  }
  if (distinctX.size < MIN_DISTINCT_MOISTURES) {
    throw new ArithmeticDomainError(
      "fitCompactionParabola",
      `At least ${MIN_DISTINCT_MOISTURES} distinct water contents are required to fit the compaction parabola (found ${distinctX.size} among ${points.length} points) — the quadratic regression is undefined.`,
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
  // Centered sums (u = x − x̄): Su, Suu, Suuu, Suuuu, Suy = Σu·y,
  // SuuyRaw = Σu²·y (y uncentered — the orthogonalized basis absorbs it).
  let suu = 0;
  let suuu = 0;
  let suuuu = 0;
  let suy = 0;
  let suuyRaw = 0;
  for (const p of points) {
    const u = p.x - xMean;
    suu += u * u;
    suuu += u * u * u;
    suuuu += u * u * u * u;
    suy += u * p.y;
    suuyRaw += u * u * p.y;
  }
  // Normal equations in the orthogonalized basis (constant term = ȳ exact):
  //   [ Suu   Suuu           ] [B]   [ Suy              ]
  //   [ Suuu  Suuuu − Suu²/n ] [C] = [ SuuyRaw − (Suu/n)·Σy ]
  const m22 = suuuu - (suu * suu) / n;
  const det = suu * m22 - suuu * suuu;
  if (det === 0 || !Number.isFinite(det)) {
    throw new ArithmeticDomainError(
      "fitCompactionParabola",
      `The compaction parabola normal equations are singular (determinant ${det}) — the measured water contents do not support a quadratic fit.`,
    );
  }
  const rhs2 = suuyRaw - (suu / n) * sy;
  const centeredLinear = (suy * m22 - suuu * rhs2) / det;
  const centeredQuadratic = (suu * rhs2 - suuu * suy) / det;
  assertFiniteNumber("fitCompactionParabola.centeredLinear", centeredLinear);
  assertFiniteNumber("fitCompactionParabola.centeredQuadratic", centeredQuadratic);
  const c2 = centeredQuadratic;
  const c1 = centeredLinear - 2 * centeredQuadratic * xMean;
  const c0 = yMean - centeredLinear * xMean + centeredQuadratic * (xMean * xMean - suu / n);
  assertFiniteNumber("fitCompactionParabola.c0", c0);
  assertFiniteNumber("fitCompactionParabola.c1", c1);
  assertFiniteNumber("fitCompactionParabola.c2", c2);
  return { c0, c1, c2, centeredLinear, centeredQuadratic };
}

/**
 * Dry density from wet density and water content (definitional):
 * ρd = ρwet / (1 + w/100), w in percent. Requires ρwet > 0 and w > −100.
 */
export function dryDensityFromWet(
  wetDensityMgM3: number,
  waterContentPercent: number,
): number {
  assertFiniteNumber("dryDensityFromWet", wetDensityMgM3);
  assertFiniteNumber("dryDensityFromWet", waterContentPercent);
  if (wetDensityMgM3 <= 0) {
    throw new ArithmeticDomainError(
      "dryDensityFromWet",
      `Wet density must be strictly positive (received ${wetDensityMgM3} Mg/m³).`,
    );
  }
  if (waterContentPercent <= -100) {
    throw new ArithmeticDomainError(
      "dryDensityFromWet",
      `Water content must exceed −100 % (received ${waterContentPercent} %).`,
    );
  }
  const rhoD = wetDensityMgM3 / (1 + waterContentPercent / 100);
  assertFiniteNumber("dryDensityFromWet.result", rhoD);
  return rhoD;
}

/**
 * Zero-air-voids dry density (100 % saturation bound):
 * ρd,ZAV = Gs·ρw / (1 + w·Gs/100), w in percent, ρw the governed VERIFIED
 * conventional water density [Mg/m³] (D8). Requires Gs > 0 and a positive
 * denominator (w > −100/Gs).
 */
export function zeroAirVoidsDensity(
  specificGravity: number,
  waterContentPercent: number,
): number {
  assertFiniteNumber("zeroAirVoidsDensity", specificGravity);
  assertFiniteNumber("zeroAirVoidsDensity", waterContentPercent);
  if (specificGravity <= 0) {
    throw new ArithmeticDomainError(
      "zeroAirVoidsDensity",
      `Specific gravity must be strictly positive (received ${specificGravity}).`,
    );
  }
  const denominator = 1 + (waterContentPercent * specificGravity) / 100;
  if (denominator <= 0) {
    throw new ArithmeticDomainError(
      "zeroAirVoidsDensity",
      `The ZAV denominator (1 + w·Gs/100) must be positive (received w = ${waterContentPercent} %, Gs = ${specificGravity}).`,
    );
  }
  const rhoW = requireVerifiedConstant("water.massDensityMgPerM3");
  const zav = (specificGravity * rhoW) / denominator;
  assertFiniteNumber("zeroAirVoidsDensity.result", zav);
  return zav;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

/**
 * Water content from a point's mass triple (M5.1 F2 semantics, reusing the
 * phase-relation helpers); for ordering checks only — the full resolution
 * happens in compute(). PRECONDITION: the mass triple is complete.
 */
function massWaterContent(p: ProctorPointInput): number {
  return waterContentPercent(
    waterMassFromTareMasses(p.wetMassG!, p.dryMassG!),
    drySoilMassFromTareMasses(p.dryMassG!, p.containerMassG!),
  );
}

export const proctorModule: CalculationModule<ProctorInput, ProctorRaw, ProctorResults> = {
  id: PROCTOR_MODULE_ID,
  testType: "PROCTOR",
  version: PROCTOR_MODULE_VERSION,
  label: "Proctor compaction (moisture–density curve, MDD/OMC, ZAV)",
  description:
    "Resolves each compaction point's water content (entered or oven-dry masses), wet density (entered or mold mass/volume) and dry density (ρd = ρ/(1 + w/100)), fits the least-squares compaction parabola and reads its vertex as the maximum dry density and optimum moisture content — reported only when the fitted peak is concave and bracketed by the tested moisture range, never fabricated — and computes the zero-air-voids (100 % saturation) curve when a valid Gs is supplied, warning on physically impossible densities above ZAV and on discrepancies with laboratory-entered finals without overwriting them.",

  validateInput(raw: unknown): ProctorInput {
    // Absent required-field aggregation. Zod v4 reports an ABSENT enum field
    // (method) with issue code "invalid_value" (not "invalid_type"), which
    // the shared zodErrorToCalculationError helper does not classify as
    // missing — the documented M5.2-c interplay. Pre-aggregate the absent
    // required fields locally so {} reports both method and points at once.
    if (raw !== null && typeof raw === "object") {
      const record = raw as Record<string, unknown>;
      const missing: Array<{ path: string; code: string; message: string }> = [];
      if (record.method === undefined) {
        missing.push({
          path: "method",
          code: "missing",
          message: "method is required (STANDARD or MODIFIED).",
        });
      }
      if (record.points === undefined) {
        missing.push({
          path: "points",
          code: "missing",
          message: "points is required (the compaction test points).",
        });
      }
      if (missing.length > 0) {
        throw new MissingInputError(
          `Missing required input field(s): ${missing.map((issue) => issue.path).join(", ")}`,
          missing,
        );
      }
    }
    const parsed = proctorCalcInput.safeParse(raw);
    if (!parsed.success) {
      throw zodErrorToCalculationError(parsed.error, raw);
    }
    const input = parsed.data;

    // Per-point resolution requirements (measured numbers must exist).
    for (let i = 0; i < input.points.length; i++) {
      const p = input.points[i];
      const path = `points.${i}`;
      const hasMasses = p.wetMassG !== undefined && p.dryMassG !== undefined && p.containerMassG !== undefined;
      const hasW = p.moistureContent !== undefined || hasMasses;
      if (!hasW) {
        throw new InvalidInputError(
          `${path}.moistureContent`,
          `Point ${i} has no water-content measurement — supply moistureContent, or wetMassG + dryMassG + containerMassG for oven-dry determination.`,
        );
      }
      // Partial mass triples are rejected (never silently completed) — checked
      // before the density-source requirement so point completeness is
      // reported first.
      const massFields = [p.wetMassG, p.dryMassG, p.containerMassG].filter((v) => v !== undefined).length;
      if (massFields > 0 && massFields < 3) {
        throw new InvalidInputError(
          `${path}.wetMassG`,
          `Point ${i} supplies ${massFields} of the 3 mass fields — water content from masses needs wetMassG, dryMassG AND containerMassG (M5.1 F2 semantics).`,
        );
      }
      const hasWetDensity = p.wetDensityMgM3 !== undefined || p.wetSoilMassG !== undefined;
      const hasDryDensity = p.dryDensity !== undefined;
      if (!hasWetDensity && !hasDryDensity) {
        throw new InvalidInputError(
          `${path}.dryDensity`,
          `Point ${i} has no density measurement — supply dryDensity, or wetDensityMgM3, or wetSoilMassG (with test-level moldVolumeCm3).`,
        );
      }
      if (p.wetSoilMassG !== undefined && input.moldVolumeCm3 === undefined && p.wetDensityMgM3 === undefined) {
        throw new InvalidInputError(
          `${path}.wetSoilMassG`,
          `Point ${i} supplies wetSoilMassG but the test carries no moldVolumeCm3 — the mold volume is never inferred from the mold designation (nominal volumes are standard-specific constants, D8); supply moldVolumeCm3 or wetDensityMgM3.`,
        );
      }
      // Registry mirror — entered wet density must be ≥ entered dry density.
      if (p.wetDensityMgM3 !== undefined && p.dryDensity !== undefined && p.wetDensityMgM3 < p.dryDensity - 0.001) {
        throw new InvalidInputError(
          `${path}.wetDensityMgM3`,
          `wetDensityMgM3 (${p.wetDensityMgM3}) must be greater than or equal to dryDensity (${p.dryDensity}) (ρwet = ρd × (1 + w), w ≥ 0) — M5.1 contract.`,
        );
      }
    }
    // Moisture ordering (documented divergence, M5.2-b pattern): points must
    // arrive in NON-DECREASING water-content order (replicates at equal w are
    // legitimate) so the crest window is read from true moisture neighbours;
    // the module never silently reorders measured data.
    for (let i = 1; i < input.points.length; i++) {
      const wPrev = input.points[i - 1].moistureContent;
      const wCurr = input.points[i].moistureContent;
      // Compare on the declared percentage when present; on the mass-derived
      // value otherwise (both resolved below in compute — for ordering, use
      // the declared value if present, else the mass ratio).
      const prev = wPrev !== undefined ? wPrev : massWaterContent(input.points[i - 1]);
      const curr = wCurr !== undefined ? wCurr : massWaterContent(input.points[i]);
      if (curr < prev) {
        throw new InvalidInputError(
          `points.${i}.moistureContent`,
          `Points must be supplied in non-decreasing water-content order (point ${i} w = ${curr} % follows point ${i - 1} w = ${prev} %) — the module never silently reorders measured data (M5.2-b policy).`,
        );
      }
    }
    return input;
  },

  compute(input: ProctorInput) {
    const warnings: CalculationWarning[] = [];

    // 1. Resolve every point: w, ρwet, ρd (full precision).
    const resolved: ProctorPointRaw[] = input.points.map((p, i) => {
      let w: number;
      if (p.moistureContent !== undefined) {
        w = p.moistureContent;
        if (p.wetMassG !== undefined && p.dryMassG !== undefined && p.containerMassG !== undefined) {
          // Cross-check the entered percentage against the masses
          // (water-content module precedent: warning, never overwrite).
          const wFromMasses = waterContentPercent(
            waterMassFromTareMasses(p.wetMassG, p.dryMassG),
            drySoilMassFromTareMasses(p.dryMassG, p.containerMassG),
          );
          if (Math.abs(wFromMasses - w) > PROCTOR_WATER_CONTENT_TOLERANCE) {
            warnings.push({
              code: "ENTERED_VALUE_DISCREPANCY",
              message:
                `Point ${i}: moistureContent from masses is ${roundTo(wFromMasses, MOISTURE_DECIMALS)} %, ` +
                  `deviating by ${roundTo(wFromMasses - w, MOISTURE_DECIMALS)} percentage points from the entered ` +
                  `${w} % (tolerance ±${PROCTOR_WATER_CONTENT_TOLERANCE}).`,
              details: {
                pointIndex: i,
                field: "moistureContent",
                computedValue: roundTo(wFromMasses, WARNING_DETAIL_DECIMALS),
                enteredValue: w,
                discrepancy: roundTo(wFromMasses - w, WARNING_DETAIL_DECIMALS),
                tolerance: PROCTOR_WATER_CONTENT_TOLERANCE,
              },
            });
          }
        }
      } else {
        // Masses are present (validated above).
        w = waterContentPercent(
          waterMassFromTareMasses(p.wetMassG!, p.dryMassG!),
          drySoilMassFromTareMasses(p.dryMassG!, p.containerMassG!),
        );
      }

      let rhoWet: number | null = null;
      if (p.wetDensityMgM3 !== undefined) {
        rhoWet = p.wetDensityMgM3;
      } else if (p.wetSoilMassG !== undefined && input.moldVolumeCm3 !== undefined) {
        // ρwet [Mg/m³] = m [g] / V [cm³]  (1 g/cm³ ≡ 1 Mg/m³, exact SI prefixes)
        rhoWet = p.wetSoilMassG / input.moldVolumeCm3;
        assertFiniteNumber("proctor.wetDensity", rhoWet);
      }

      let rhoD: number;
      if (rhoWet !== null) {
        rhoD = dryDensityFromWet(rhoWet, w);
        if (p.dryDensity !== undefined && Math.abs(rhoD - p.dryDensity) > PROCTOR_DENSITY_TOLERANCE) {
          warnings.push({
            code: "ENTERED_VALUE_DISCREPANCY",
            message:
              `Point ${i}: dry density derived from the wet measurement is ${roundTo(rhoD, DENSITY_DECIMALS)} Mg/m³, ` +
                `deviating by ${roundTo(rhoD - p.dryDensity, DENSITY_DECIMALS)} from the entered ` +
                `${p.dryDensity} Mg/m³ (tolerance ±${PROCTOR_DENSITY_TOLERANCE}).`,
            details: {
              pointIndex: i,
              field: "dryDensity",
              computedValue: roundTo(rhoD, WARNING_DETAIL_DECIMALS),
              enteredValue: p.dryDensity,
              discrepancy: roundTo(rhoD - p.dryDensity, WARNING_DETAIL_DECIMALS),
              tolerance: PROCTOR_DENSITY_TOLERANCE,
            },
          });
        }
      } else {
        rhoD = p.dryDensity!;
      }

      const zav =
        input.specificGravity !== undefined ? zeroAirVoidsDensity(input.specificGravity, w) : null;

      return {
        moistureContent: w,
        wetDensityMgM3: rhoWet,
        dryDensity: rhoD,
        zavDryDensityMgM3: zav,
        enteredDryDensity: p.dryDensity ?? null,
      };
    });

    // 2. Registry mirrors on the entered finals (applied to the resolved
    //    per-point dry densities — same expressions as the M5.1 superRefine).
    let peakRhoD = resolved[0].dryDensity;
    let minW = resolved[0].moistureContent;
    let maxW = resolved[0].moistureContent;
    for (const r of resolved) {
      if (r.dryDensity > peakRhoD) peakRhoD = r.dryDensity;
      if (r.moistureContent < minW) minW = r.moistureContent;
      if (r.moistureContent > maxW) maxW = r.moistureContent;
    }
    if (input.maxDryDensity !== undefined) {
      if (input.maxDryDensity < peakRhoD - PROCTOR_DENSITY_TOLERANCE) {
        throw new InvalidInputError(
          "maxDryDensity",
          `maxDryDensity (${input.maxDryDensity}) cannot be lower than the highest measured point ` +
            `(${roundTo(peakRhoD, DENSITY_DECIMALS)} Mg/m³) — M5.1 contract (±${PROCTOR_DENSITY_TOLERANCE}).`,
        );
      }
      if (input.maxDryDensity > peakRhoD + 0.2) {
        throw new InvalidInputError(
          "maxDryDensity",
          `maxDryDensity (${input.maxDryDensity}) is inconsistent with the measured curve ` +
            `(highest point ${roundTo(peakRhoD, DENSITY_DECIMALS)} Mg/m³) — M5.1 contract.`,
        );
      }
    }
    if (
      input.optimumMoisture !== undefined &&
      (input.optimumMoisture < minW - PROCTOR_MOISTURE_TOLERANCE ||
        input.optimumMoisture > maxW + PROCTOR_MOISTURE_TOLERANCE)
    ) {
      throw new InvalidInputError(
        "optimumMoisture",
        `optimumMoisture (${input.optimumMoisture}) must lie within the tested moisture range ` +
          `[${roundTo(minW, MOISTURE_DECIMALS)}, ${roundTo(maxW, MOISTURE_DECIMALS)}] (±${PROCTOR_MOISTURE_TOLERANCE}) — M5.1 contract.`,
      );
    }

    // 3. Compaction parabola (CREST WINDOW) and its vertex (MDD / OMC) — only
    //    when the fitted peak is concave AND bracketed by the tested range.
    //    Window: the 3 consecutive points containing the measured peak (first
    //    maximum in moisture order); extends to ALL points when the window
    //    carries fewer than 3 distinct water contents (replicates at the peak).
    let peakIndex = 0;
    for (let i = 1; i < resolved.length; i++) {
      if (resolved[i].dryDensity > resolved[peakIndex].dryDensity) peakIndex = i;
    }
    const n = resolved.length;
    let windowFrom = peakIndex === 0 ? 0 : peakIndex - 1;
    let windowTo = peakIndex === n - 1 ? n - 1 : peakIndex + 1; // inclusive
    const windowDistinct = new Set(
      resolved.slice(windowFrom, windowTo + 1).map((r) => r.moistureContent),
    ).size;
    if (windowDistinct < MIN_DISTINCT_MOISTURES && n > windowTo - windowFrom + 1) {
      windowFrom = 0;
      windowTo = n - 1;
    }
    const windowPoints = resolved
      .slice(windowFrom, windowTo + 1)
      .map((r) => ({ x: r.moistureContent, y: r.dryDensity }));
    const fit = fitCompactionParabola(windowPoints);
    let maxDryDensity: number | null = null;
    let optimumMoisture: number | null = null;
    if (fit.c2 >= 0) {
      warnings.push({
        code: "INSUFFICIENT_DATA",
        message:
          `The fitted compaction curve is not concave (quadratic coefficient ${roundTo(fit.c2, 6)} ≥ 0) — ` +
            `the points do not define a compaction maximum; MDD and OMC are not reported.`,
        details: { quadraticCoefficient: roundTo(fit.c2, 6) },
      });
    } else {
      const omc = -fit.c1 / (2 * fit.c2);
      const mdd = fit.c0 - (fit.c1 * fit.c1) / (4 * fit.c2);
      if (!(omc > minW && omc < maxW)) {
        warnings.push({
          code: "INSUFFICIENT_DATA",
          message:
            `The fitted compaction peak (OMC ${roundTo(omc, MOISTURE_DECIMALS)} %) lies outside the tested moisture ` +
              `range [${roundTo(minW, MOISTURE_DECIMALS)}, ${roundTo(maxW, MOISTURE_DECIMALS)}] % — the maximum is not ` +
              `bracketed by measurements and extrapolation is not performed; MDD and OMC are not reported.`,
          details: {
            fittedOmc: roundTo(omc, WARNING_DETAIL_DECIMALS),
            testedRangeMin: roundTo(minW, WARNING_DETAIL_DECIMALS),
            testedRangeMax: roundTo(maxW, WARNING_DETAIL_DECIMALS),
          },
        });
      } else {
        optimumMoisture = omc;
        maxDryDensity = mdd;
      }
    }

    // 4. Physical consistency — a measured dry density above the ZAV curve
    //    is impossible (Sr would exceed 100 %); reported, never clamped
    //    (the entered Gs may itself be the wrong input).
    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i];
      if (r.zavDryDensityMgM3 !== null && r.dryDensity > r.zavDryDensityMgM3) {
        warnings.push({
          code: "PHYSICAL_CONSISTENCY",
          message:
            `Point ${i}: dry density ${roundTo(r.dryDensity, DENSITY_DECIMALS)} Mg/m³ exceeds the ` +
              `zero-air-voids density ${roundTo(r.zavDryDensityMgM3, DENSITY_DECIMALS)} Mg/m³ at w = ` +
              `${roundTo(r.moistureContent, MOISTURE_DECIMALS)} % (Gs = ${input.specificGravity}) — ` +
              `the degree of saturation would exceed 100 %; check the point measurement or the entered Gs.`,
          details: {
            pointIndex: i,
            dryDensity: roundTo(r.dryDensity, WARNING_DETAIL_DECIMALS),
            zav: roundTo(r.zavDryDensityMgM3, WARNING_DETAIL_DECIMALS),
            moistureContent: roundTo(r.moistureContent, WARNING_DETAIL_DECIMALS),
            specificGravity: input.specificGravity ?? null,
          },
        });
      }
    }

    const zavAtOptimum =
      input.specificGravity !== undefined && optimumMoisture !== null
        ? zeroAirVoidsDensity(input.specificGravity, optimumMoisture)
        : null;

    const raw: ProctorRaw = {
      points: resolved,
      curveCoefficientConstant: fit.c0,
      curveCoefficientLinear: fit.c1,
      curveCoefficientQuadratic: fit.c2,
      maxDryDensity,
      optimumMoisture,
      zavAtOptimumMgM3: zavAtOptimum,
    };

    // 5. Entered-final comparisons — fixed order, warnings never overwrite.
    if (
      input.maxDryDensity !== undefined && maxDryDensity !== null &&
      Math.abs(maxDryDensity - input.maxDryDensity) > PROCTOR_DENSITY_TOLERANCE
    ) {
      warnings.push({
        code: "ENTERED_VALUE_DISCREPANCY",
        message:
          `Computed maximum dry density ${roundTo(maxDryDensity, DENSITY_DECIMALS)} Mg/m³ deviates by ` +
            `${roundTo(maxDryDensity - input.maxDryDensity, DENSITY_DECIMALS)} from the entered ` +
            `${input.maxDryDensity} Mg/m³ (tolerance ±${PROCTOR_DENSITY_TOLERANCE}).`,
        details: {
          field: "maxDryDensity",
          computedValue: roundTo(maxDryDensity, WARNING_DETAIL_DECIMALS),
          enteredValue: input.maxDryDensity,
          discrepancy: roundTo(maxDryDensity - input.maxDryDensity, WARNING_DETAIL_DECIMALS),
          tolerance: PROCTOR_DENSITY_TOLERANCE,
        },
      });
    }
    if (
      input.optimumMoisture !== undefined && optimumMoisture !== null &&
      Math.abs(optimumMoisture - input.optimumMoisture) > PROCTOR_MOISTURE_TOLERANCE
    ) {
      warnings.push({
        code: "ENTERED_VALUE_DISCREPANCY",
        message:
          `Computed optimum moisture content ${roundTo(optimumMoisture, MOISTURE_DECIMALS)} % deviates by ` +
            `${roundTo(optimumMoisture - input.optimumMoisture, MOISTURE_DECIMALS)} percentage points from the ` +
            `entered ${input.optimumMoisture} % (tolerance ±${PROCTOR_MOISTURE_TOLERANCE}).`,
        details: {
          field: "optimumMoisture",
          computedValue: roundTo(optimumMoisture, WARNING_DETAIL_DECIMALS),
          enteredValue: input.optimumMoisture,
          discrepancy: roundTo(optimumMoisture - input.optimumMoisture, WARNING_DETAIL_DECIMALS),
          tolerance: PROCTOR_MOISTURE_TOLERANCE,
        },
      });
    }

    // 6. Output boundary.
    const zavCurve =
      input.specificGravity !== undefined
        ? [
            ...resolved.map((r) => ({
              moistureContent: roundTo(r.moistureContent, MOISTURE_DECIMALS),
              zavMgM3: roundTo(r.zavDryDensityMgM3!, DENSITY_DECIMALS),
            })),
            ...(optimumMoisture !== null
              ? [
                  {
                    moistureContent: roundTo(optimumMoisture, MOISTURE_DECIMALS),
                    zavMgM3: roundTo(zavAtOptimum!, DENSITY_DECIMALS),
                  },
                ]
              : []),
          ]
        : null;

    const results: ProctorResults = {
      method: input.method,
      mold: input.mold ?? null,
      pointCount: resolved.length,
      points: resolved.map((r) => ({
        moistureContent: roundTo(r.moistureContent, MOISTURE_DECIMALS),
        dryDensity: roundTo(r.dryDensity, DENSITY_DECIMALS),
        wetDensityMgM3: r.wetDensityMgM3 === null ? null : roundTo(r.wetDensityMgM3, DENSITY_DECIMALS),
        zavDryDensityMgM3: r.zavDryDensityMgM3 === null ? null : roundTo(r.zavDryDensityMgM3, DENSITY_DECIMALS),
      })),
      curveCoefficientConstant: roundTo(fit.c0, COEFFICIENT_DECIMALS),
      curveCoefficientLinear: roundTo(fit.c1, COEFFICIENT_DECIMALS),
      curveCoefficientQuadratic: roundTo(fit.c2, COEFFICIENT_DECIMALS),
      maxDryDensity: maxDryDensity === null ? null : roundTo(maxDryDensity, DENSITY_DECIMALS),
      optimumMoisture: optimumMoisture === null ? null : roundTo(optimumMoisture, MOISTURE_DECIMALS),
      zavCurve,
      enteredMaxDryDensity: input.maxDryDensity ?? null,
      enteredOptimumMoisture: input.optimumMoisture ?? null,
    };

    return { raw, results, warnings };
  },
};
