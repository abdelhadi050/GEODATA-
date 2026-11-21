/**
 * GEODATA HUB — California Bearing Ratio calculation module (M5.2-e).
 *
 * Serves registry test type CBR (standard citations verified in M5.1:
 * ASTM D1883 / NF P94-078 — both adopt the same CBR reference scale). The
 * module implements the authorized M5.2-e scope:
 *
 *   - Load–penetration curve: the measured points (strictly increasing
 *     penetration — the module never silently reorders, M5.2-b policy), with
 *     the OPTIONAL concave-upward ORIGIN CORRECTION:
 *         when the analyst sets originCorrection: true, a straight line is
 *         projected through the steepest consecutive segment of the measured
 *         curve downward until it intersects the zero-load axis (the
 *         corrected origin — the deterministic realization of the standard's
 *         "project a straight line through the straight-line portion of the
 *         stress-penetration curve downward until it intersects the x-axis"
 *         construction for surface-irregularity seating);
 *         penetrations are then measured from the corrected origin and
 *         points falling before it are discarded. The applied correction is
 *         reported (CORRECTION_APPLIED warning) and the corrected curve is
 *         returned.
 *   - Loads at 2.5 mm and 5.0 mm penetration: exact measured hit, or LINEAR
 *     INTERPOLATION between the bracketing points (the granulometry
 *     pattern); NEVER extrapolated beyond the measured range (out-of-range
 *     targets yield null + INSUFFICIENT_DATA warning).
 *   - CBR values (the reference scale is fixed by the standard — governed
 *     VERIFIED constants, D8; custom reference loads are NOT accepted, no
 *     mixing):
 *         CBR(2.5 mm) = 100 × load(2.5 mm) / 13.24 kN
 *         CBR(5.0 mm) = 100 × load(5.0 mm) / 19.96 kN
 *   - Reported CBR: max(CBR 2.5, CBR 5.0) — the project-adopted reporting
 *     rule (registry identity "cbrValue = max(cbrAt2_5, cbrAt5_0)").
 *     When the 5.0 mm value governs, a REPORTING_RULE warning is emitted
 *     (the adopted standards expect the 2.5 mm value to govern and direct
 *     the test to be repeated when the 5.0 mm value is higher — verified
 *     during M5.2-e; the module reports, it does not hide the value).
 *   - Swelling: the laboratory-entered swellPercent is echoed and validated
 *     (registry bounds 0–15 %). Computing swell from height readings is
 *     NOT implemented — the swell reference-height convention could not be
 *     verified against the adopted standards' text (D8); nothing is
 *     invented (INSUFFICIENT_DATA is not raised for a merely absent
 *     optional echo, but the limitation is documented here).
 *
 * INPUT CONTRACT: the registry `cbrResult` payload shape — `condition`
 * (SOAKED/UNSOAKED, mirrored and echoed; soaked and unsoaked tests are
 * distinguished in every output), `points` (2–20, penetrationMm 0–15,
 * loadKn 0–60 — bounds identical to the registry), the entered finals
 * `cbrAt2_5` / `cbrAt5_0` / `cbrValue` (registry field names, bounds 0–100)
 * and `swellPercent` (0–15). `originCorrection` (engine-side) requests the
 * origin correction. Unknown keys — including the registry input's
 * `surchargeKg`, `soakingDays`, `notes` — are stripped (Zod default).
 *
 * SEMANTIC RULES (mirrors of the M5.1 `cbrResult` superRefine):
 *   - penetrationMm values must be unique (registry) and strictly increasing
 *     in input order (module ordering rule — documented divergence);
 *   - entered cbrValue must equal max(entered cbrAt2_5, entered cbrAt5_0)
 *     within ±0.01 (registry identity).
 *
 * ENTERED-VALUE COMPARISON: computed CBR 2.5 / 5.0 / reported value are
 * compared with the entered finals; a discrepancy beyond ±0.01 produces an
 * ENTERED_VALUE_DISCREPANCY warning (entered echoed unchanged). Provenance
 * of ±0.01: the M5.1 registry identity tolerance for this test type
 * ("cbrValue must equal max(cbrAt2_5, cbrAt5_0)" ± 0.01) — a project
 * engineering tolerance, not a standard-verified constant (same class as
 * the water-content ±0.5 and granulometry ±0.05, docs/14 §9 R1).
 *
 * PRECISION: `raw` keeps full double precision; rounding happens only at
 * this output boundary — loads 3 dp, penetrations 3 dp, CBR percentages
 * 2 dp. Computed values are never clamped: a computed CBR above 100 %
 * (a stiffer-than-standard material) is reported as-is — the registry
 * storage bound is 0–100 %, the engine computes and advises, the registry
 * gates at write time (docs/14 §5).
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

export const CBR_MODULE_ID = "cbr";
export const CBR_MODULE_VERSION = "1.0.0";

/**
 * Entered-value comparison tolerance (absolute, percentage points), for all
 * three CBR values alike. Provenance: registry CBR identity tolerance ±0.01
 * (M5.1); reused for computed-vs-entered checks in M5.2-e — a project
 * engineering tolerance, not standard-verified.
 */
export const CBR_ENTERED_TOLERANCE = 0.01;

/** Registry contract bounds mirrored by this module. */
const MIN_POINTS = 2;
const MAX_POINTS = 20;
const MAX_PENETRATION = 15;
const MAX_LOAD = 60;

/** Definitional penetration targets of the CBR scale (2.5 / 5.0 mm). */
export const CBR_PENETRATION_TARGET_2_5_MM = 2.5;
export const CBR_PENETRATION_TARGET_5_0_MM = 5.0;

/** Output boundary: loads and penetrations 3 dp, CBR percentages 2 dp. */
const LOAD_DECIMALS = 3;
const PENETRATION_DECIMALS = 3;
const CBR_DECIMALS = 2;
const WARNING_DETAIL_DECIMALS = 4;

/** One measured load–penetration point (registry `cbrResult` point shape). */
export interface CbrPoint {
  /** penetration of the plunger, 0–15 [mm] */
  penetrationMm: number;
  /** applied load on the plunger, 0–60 [kN] */
  loadKn: number;
}

/**
 * Input schema — the calculable core of the registry `cbrResult` contract
 * (bounds identical) plus the engine-side `originCorrection` request.
 * Exported so compatibility tests can assert behavioral parity against the
 * registry schema. Unknown keys are stripped (Zod default).
 */
export const cbrCalcInput = z.object({
  condition: z.enum(["SOAKED", "UNSOAKED"]),
  originCorrection: z.boolean().optional(),
  points: z
    .array(
      z.object({
        penetrationMm: z.number().min(0).max(MAX_PENETRATION),
        loadKn: z.number().min(0).max(MAX_LOAD),
      }),
    )
    .min(MIN_POINTS)
    .max(MAX_POINTS),
  cbrAt2_5: z.number().min(0).max(100).optional(),
  cbrAt5_0: z.number().min(0).max(100).optional(),
  cbrValue: z.number().min(0).max(100).optional(),
  swellPercent: z.number().min(0).max(15).optional(),
});

export interface CbrInput {
  condition: "SOAKED" | "UNSOAKED";
  originCorrection?: boolean | undefined;
  points: CbrPoint[];
  cbrAt2_5?: number | undefined;
  cbrAt5_0?: number | undefined;
  cbrValue?: number | undefined;
  swellPercent?: number | undefined;
}

/** Full-precision internal values (never rounded, never clamped). */
export interface CbrRaw {
  /** the analysis curve (origin-corrected when requested); penetration [mm], load [kN] */
  curve: Array<{ penetrationMm: number; loadKn: number }>;
  /** origin shift applied by the correction [mm]; 0 when not requested/applicable */
  originShiftMm: number;
  /** measured (or interpolated) load at 2.5 mm [kN]; null when out of range */
  loadAt2_5Kn: number | null;
  /** measured (or interpolated) load at 5.0 mm [kN]; null when out of range */
  loadAt5_0Kn: number | null;
  /** CBR at 2.5 mm [%]; null when the load is not available */
  cbrAt2_5: number | null;
  /** CBR at 5.0 mm [%]; null when the load is not available */
  cbrAt5_0: number | null;
  /** reported CBR = max(cbrAt2_5, cbrAt5_0) [%]; null when neither exists */
  cbrValue: number | null;
}

/** Output-boundary results (rounded; entered values echoed unchanged). */
export interface CbrResults {
  condition: "SOAKED" | "UNSOAKED";
  /** whether the origin correction was applied */
  originCorrectionApplied: boolean;
  /** the analysis curve (corrected when applied), input order */
  curve: Array<{ penetrationMm: number; loadKn: number }>;
  /** measured/interpolated loads at the CBR targets [kN], 3 dp */
  loadAt2_5Kn: number | null;
  loadAt5_0Kn: number | null;
  /** CBR at 2.5 mm [%], 2 dp (unclamped) */
  cbrAt2_5: number | null;
  /** CBR at 5.0 mm [%], 2 dp (unclamped) */
  cbrAt5_0: number | null;
  /** reported CBR (max rule) [%], 2 dp */
  cbrValue: number | null;
  /** which penetration governs the reported value; null when none */
  reportedFrom: "2.5MM" | "5.0MM" | null;
  /** laboratory-entered swell percentage, echoed (not computed — D8 note) */
  swellPercent: number | null;
  /** laboratory-entered finals, echoed unchanged (null when absent) */
  enteredCbrAt2_5: number | null;
  enteredCbrAt5_0: number | null;
  enteredCbrValue: number | null;
}

// ---------------------------------------------------------------------------
// Curve helpers (exported for direct unit testing)
// ---------------------------------------------------------------------------

/**
 * Load at a target penetration on a strictly increasing penetration curve:
 * exact hit returns the measured load; otherwise LINEAR interpolation in
 * penetration between the bracketing points. Targets outside the measured
 * range return null (extrapolation is never performed — M5.2-b policy).
 * PRECONDITION: points have strictly increasing penetrationMm.
 */
export function loadAtPenetration(
  points: ReadonlyArray<CbrPoint>,
  targetPenetrationMm: number,
): number | null {
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.penetrationMm === targetPenetrationMm) return p.loadKn;
    if (p.penetrationMm > targetPenetrationMm) {
      if (i === 0) return null; // target below the measured range
      const prev = points[i - 1];
      const span = p.penetrationMm - prev.penetrationMm;
      const fraction = (targetPenetrationMm - prev.penetrationMm) / span;
      const interpolated = prev.loadKn + (p.loadKn - prev.loadKn) * fraction;
      assertFiniteNumber("loadAtPenetration", interpolated);
      return interpolated;
    }
  }
  return null; // target above the measured range
}

/**
 * Concave-upward origin correction: a straight line is projected through the
 * STEEPEST consecutive segment of the measured curve downward to the
 * zero-load axis; the corrected origin is that intercept. Returns the origin
 * shift [mm] (strictly positive when a correction exists) and the corrected
 * curve (points with corrected penetration < 0 discarded).
 *
 * PRECONDITION: points have strictly increasing penetration and ≥ 2 points.
 * When the steepest-segment line intercepts at penetration ≤ 0 the curve
 * carries no upward-concavity origin error — the shift is 0 and the curve
 * is returned unchanged.
 */
export function applyOriginCorrection(
  points: ReadonlyArray<CbrPoint>,
): { shiftMm: number; curve: CbrPoint[]; steepestSegmentIndex: number } {
  if (points.length < 2) {
    throw new ArithmeticDomainError(
      "applyOriginCorrection",
      "At least 2 points are required to construct the correction line.",
    );
  }
  let steepestSegmentIndex = 0;
  let steepestSlope = -Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const slope =
      (points[i + 1].loadKn - points[i].loadKn) /
      (points[i + 1].penetrationMm - points[i].penetrationMm);
    if (slope > steepestSlope) {
      steepestSlope = slope;
      steepestSegmentIndex = i;
    }
  }
  // Zero-load intercept of the line through the steepest segment:
  //   x0 = x_i − L_i / slope
  const a = points[steepestSegmentIndex];
  const intercept = a.penetrationMm - a.loadKn / steepestSlope;
  if (!(intercept > 0) || !Number.isFinite(intercept)) {
    return { shiftMm: 0, curve: points.map((p) => ({ ...p })), steepestSegmentIndex };
  }
  const corrected = points
    .map((p) => ({ penetrationMm: p.penetrationMm - intercept, loadKn: p.loadKn }))
    .filter((p) => p.penetrationMm >= 0);
  return { shiftMm: intercept, curve: corrected, steepestSegmentIndex };
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export const cbrModule: CalculationModule<CbrInput, CbrRaw, CbrResults> = {
  id: CBR_MODULE_ID,
  testType: "CBR",
  version: CBR_MODULE_VERSION,
  label: "California Bearing Ratio (2.5/5.0 mm, max reporting rule, origin correction)",
  description:
    "Reads the plunger load at 2.5 mm and 5.0 mm penetration from the measured load-penetration curve (exact hit or linear interpolation, never extrapolated), optionally applies the standard's concave-upward origin correction (steepest-segment line projected to the zero-load axis), computes CBR = 100 × measured load / standard load against the governed VERIFIED reference scale (13.24 kN at 2.5 mm, 19.96 kN at 5.0 mm), reports the governing value per the project-adopted max rule with an advisory when the 5.0 mm value governs, distinguishes soaked and unsoaked conditions, and cross-checks laboratory-entered finals — warning on discrepancies without overwriting them. Swelling is echoed, not computed (convention unverified, D8).",

  validateInput(raw: unknown): CbrInput {
    // Absent required-field pre-aggregation (Zod v4 enum interplay — the
    // documented M5.2-c pattern: absent enum fields report invalid_value).
    if (raw !== null && typeof raw === "object") {
      const record = raw as Record<string, unknown>;
      const missing: Array<{ path: string; code: string; message: string }> = [];
      if (record.condition === undefined) {
        missing.push({
          path: "condition",
          code: "missing",
          message: "condition is required (SOAKED or UNSOAKED).",
        });
      }
      if (record.points === undefined) {
        missing.push({
          path: "points",
          code: "missing",
          message: "points is required (the load-penetration measurements).",
        });
      }
      if (missing.length > 0) {
        throw new MissingInputError(
          `Missing required input field(s): ${missing.map((issue) => issue.path).join(", ")}`,
          missing,
        );
      }
    }
    const parsed = cbrCalcInput.safeParse(raw);
    if (!parsed.success) {
      throw zodErrorToCalculationError(parsed.error, raw);
    }
    const input = parsed.data;

    // Strictly increasing penetration (registry uniqueness + module ordering
    // rule — the curve is read in penetration order, never silently sorted).
    for (let i = 1; i < input.points.length; i++) {
      if (input.points[i].penetrationMm <= input.points[i - 1].penetrationMm) {
        throw new InvalidInputError(
          `points.${i}.penetrationMm`,
          `penetrationMm values must be unique and strictly increasing (point ${i}: ` +
            `${input.points[i].penetrationMm} mm follows ${input.points[i - 1].penetrationMm} mm) — ` +
            `registry uniqueness rule + module ordering rule (M5.2-b policy, never silently reordered).`,
        );
      }
    }

    // Registry identity mirror — entered cbrValue = max(entered cbrAt2_5,
    // entered cbrAt5_0) within ±0.01 (same expression as the superRefine).
    if (input.cbrAt2_5 !== undefined && input.cbrAt5_0 !== undefined && input.cbrValue !== undefined) {
      const expected = Math.max(input.cbrAt2_5, input.cbrAt5_0);
      if (Math.abs(input.cbrValue - expected) > CBR_ENTERED_TOLERANCE) {
        throw new InvalidInputError(
          "cbrValue",
          `cbrValue must equal max(cbrAt2_5, cbrAt5_0) (entered ${input.cbrValue} vs ` +
            `max(${input.cbrAt2_5}, ${input.cbrAt5_0}) = ${expected}; tolerance ±${CBR_ENTERED_TOLERANCE}, M5.1 contract).`,
        );
      }
    }
    return input;
  },

  compute(input: CbrInput) {
    const warnings: CalculationWarning[] = [];

    // 1. Analysis curve — optional origin correction (analyst-requested).
    let curve: CbrPoint[] = input.points.map((p) => ({ ...p }));
    let originShiftMm = 0;
    let correctionApplied = false;
    if (input.originCorrection === true) {
      const correction = applyOriginCorrection(input.points);
      if (correction.shiftMm > 0) {
        originShiftMm = correction.shiftMm;
        curve = correction.curve;
        correctionApplied = true;
        warnings.push({
          code: "CORRECTION_APPLIED",
          message:
            `Concave-upward origin correction applied: the steepest-segment line ` +
              `(segment ${correction.steepestSegmentIndex} → ${correction.steepestSegmentIndex + 1}) intersects the ` +
              `zero-load axis at ${roundTo(correction.shiftMm, PENETRATION_DECIMALS)} mm; penetrations are measured ` +
              `from the corrected origin and earlier points are discarded.`,
          details: {
            originShiftMm: roundTo(correction.shiftMm, WARNING_DETAIL_DECIMALS),
            steepestSegmentIndex: correction.steepestSegmentIndex,
          },
        });
      } else {
        warnings.push({
          code: "INSUFFICIENT_DATA",
          message:
            `Origin correction requested, but the steepest-segment line intersects the zero-load axis at ` +
              `penetration ≤ 0 — the curve carries no upward-concavity origin error; no correction applied.`,
          details: { originShiftMm: 0 },
        });
      }
    }

    // 2. Loads at the CBR targets (exact hit or interpolation, no extrapolation).
    const loadAt2_5 = loadAtPenetration(curve, CBR_PENETRATION_TARGET_2_5_MM);
    const loadAt5_0 = loadAtPenetration(curve, CBR_PENETRATION_TARGET_5_0_MM);
    const curveMinP = curve.length > 0 ? curve[0].penetrationMm : 0;
    const curveMaxP = curve.length > 0 ? curve[curve.length - 1].penetrationMm : 0;
    for (const [target, load] of [
      [CBR_PENETRATION_TARGET_2_5_MM, loadAt2_5] as const,
      [CBR_PENETRATION_TARGET_5_0_MM, loadAt5_0] as const,
    ]) {
      if (load === null) {
        warnings.push({
          code: "INSUFFICIENT_DATA",
          message:
            `The load at ${target} mm penetration is not available — the target lies outside the analysis curve ` +
              `range [${roundTo(curveMinP, PENETRATION_DECIMALS)}, ${roundTo(curveMaxP, PENETRATION_DECIMALS)}] mm ` +
              `${originShiftMm > 0 ? "(after the origin correction) " : ""}and extrapolation is not performed; ` +
              `the corresponding CBR is not reported.`,
          details: {
            targetPenetrationMm: target,
            curveRangeMin: roundTo(curveMinP, WARNING_DETAIL_DECIMALS),
            curveRangeMax: roundTo(curveMaxP, WARNING_DETAIL_DECIMALS),
            originShiftMm: roundTo(originShiftMm, WARNING_DETAIL_DECIMALS),
          },
        });
      }
    }

    // 3. CBR values against the governed VERIFIED standard loads (D8).
    const standardLoad2_5 = requireVerifiedConstant("cbr.standardLoadKnAt2_5mm");
    const standardLoad5_0 = requireVerifiedConstant("cbr.standardLoadKnAt5_0mm");
    const cbrAt2_5 = loadAt2_5 === null ? null : (100 * loadAt2_5) / standardLoad2_5;
    const cbrAt5_0 = loadAt5_0 === null ? null : (100 * loadAt5_0) / standardLoad5_0;

    // 4. Reported value — the project-adopted max rule (registry identity),
    //    with an advisory when the 5.0 mm value governs.
    let cbrValue: number | null = null;
    let reportedFrom: "2.5MM" | "5.0MM" | null = null;
    if (cbrAt2_5 !== null && cbrAt5_0 !== null) {
      if (cbrAt5_0 > cbrAt2_5) {
        cbrValue = cbrAt5_0;
        reportedFrom = "5.0MM";
        warnings.push({
          code: "REPORTING_RULE",
          message:
            `The CBR at 5.0 mm (${roundTo(cbrAt5_0, CBR_DECIMALS)} %) exceeds the CBR at 2.5 mm ` +
              `(${roundTo(cbrAt2_5, CBR_DECIMALS)} %) — per the project-adopted reporting rule ` +
              `(cbrValue = max(cbrAt2_5, cbrAt5_0), M5.1 registry contract) the 5.0 mm value is reported; ` +
              `the adopted standards expect the 2.5 mm value to govern and direct the test to be repeated ` +
              `when the 5.0 mm value is higher (verified during M5.2-e).`,
          details: {
            cbrAt2_5: roundTo(cbrAt2_5, WARNING_DETAIL_DECIMALS),
            cbrAt5_0: roundTo(cbrAt5_0, WARNING_DETAIL_DECIMALS),
            reportedFrom: "5.0MM",
          },
        });
      } else {
        cbrValue = cbrAt2_5;
        reportedFrom = "2.5MM";
      }
    } else if (cbrAt2_5 !== null) {
      cbrValue = cbrAt2_5;
      reportedFrom = "2.5MM";
    } else if (cbrAt5_0 !== null) {
      cbrValue = cbrAt5_0;
      reportedFrom = "5.0MM";
    }

    const raw: CbrRaw = {
      curve,
      originShiftMm,
      loadAt2_5Kn: loadAt2_5,
      loadAt5_0Kn: loadAt5_0,
      cbrAt2_5,
      cbrAt5_0,
      cbrValue,
    };

    // 5. Entered-value comparisons — fixed order, warnings never overwrite.
    const comparisons: ReadonlyArray<{ field: string; computed: number | null; entered: number | undefined }> = [
      { field: "cbrAt2_5", computed: cbrAt2_5, entered: input.cbrAt2_5 },
      { field: "cbrAt5_0", computed: cbrAt5_0, entered: input.cbrAt5_0 },
      { field: "cbrValue", computed: cbrValue, entered: input.cbrValue },
    ];
    for (const { field, computed, entered } of comparisons) {
      if (entered === undefined || computed === null) continue;
      if (Math.abs(computed - entered) > CBR_ENTERED_TOLERANCE) {
        warnings.push({
          code: "ENTERED_VALUE_DISCREPANCY",
          message:
            `Computed ${field} ${roundTo(computed, CBR_DECIMALS)} % deviates by ` +
              `${roundTo(computed - entered, CBR_DECIMALS)} percentage points from the entered ` +
              `${entered} % (tolerance ±${CBR_ENTERED_TOLERANCE}).`,
          details: {
            field,
            computedValue: roundTo(computed, WARNING_DETAIL_DECIMALS),
            enteredValue: entered,
            discrepancy: roundTo(computed - entered, WARNING_DETAIL_DECIMALS),
            tolerance: CBR_ENTERED_TOLERANCE,
          },
        });
      }
    }

    // 6. Output boundary.
    const results: CbrResults = {
      condition: input.condition,
      originCorrectionApplied: correctionApplied,
      curve: curve.map((p) => ({
        penetrationMm: roundTo(p.penetrationMm, PENETRATION_DECIMALS),
        loadKn: roundTo(p.loadKn, LOAD_DECIMALS),
      })),
      loadAt2_5Kn: loadAt2_5 === null ? null : roundTo(loadAt2_5, LOAD_DECIMALS),
      loadAt5_0Kn: loadAt5_0 === null ? null : roundTo(loadAt5_0, LOAD_DECIMALS),
      cbrAt2_5: cbrAt2_5 === null ? null : roundTo(cbrAt2_5, CBR_DECIMALS),
      cbrAt5_0: cbrAt5_0 === null ? null : roundTo(cbrAt5_0, CBR_DECIMALS),
      cbrValue: cbrValue === null ? null : roundTo(cbrValue, CBR_DECIMALS),
      reportedFrom,
      swellPercent: input.swellPercent ?? null,
      enteredCbrAt2_5: input.cbrAt2_5 ?? null,
      enteredCbrAt5_0: input.cbrAt5_0 ?? null,
      enteredCbrValue: input.cbrValue ?? null,
    };

    return { raw, results, warnings };
  },
};
