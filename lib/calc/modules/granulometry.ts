/**
 * GEODATA HUB — Granulometry (particle size distribution) calculation module
 * (M5.2-b).
 *
 * Serves registry test type GRANULOMETRY (standard citations verified in
 * M5.1: ASTM D6913 / NF P94-056 / NF P94-057). The module implements ONLY the
 * definitional PSD indicator arithmetic explicitly authorized in M5.2-b:
 *
 *   - percentile diameters D10 / D30 / D60 by LOG-LINEAR interpolation
 *     between adjacent measured PSD points (authorization §3.1):
 *         log(Dx) = log(D1) + [(x − P1)/(P2 − P1)] × [log(D2) − log(D1)]
 *   - uniformity coefficient      Cu = D60 / D10
 *   - curvature coefficient       Cc = (D30 × D30) / (D10 × D60)
 *     (evaluated as (D30/D10) × (D30/D60) — the same algebraic value, but
 *     immune to the subnormal D30² underflow of the literal form)
 *   - percentage passing at 0.075 mm and the coarse/fine split at 4.75 mm,
 *     by the INVERSE log-linear relation, only where the measured diameter
 *     range supports them (never extrapolated, never invented).
 *
 * EXPLICITLY OUT OF SCOPE (authorization §6): hydrometer corrections,
 * retained-mass back-calculation, USCS/AASHTO classification, soil
 * descriptions, charts. The current data contract only carries PSD points.
 *
 * INPUT CONTRACT (M5.1 compatibility — same pattern as the water-content
 * module, docs/14 §5): the measured numbers live in the RESULT payload
 * (`LabTest.resultData`, registry `granulometryResult`). This module consumes
 * its calculable core — `points` (4–40 points, diameterMm 0 < d ≤ 300 mm,
 * percentFiner 0–100 %, bounds mirroring the registry schema exactly) — plus
 * the OPTIONAL laboratory-entered d10 / d30 / d60 / uniformityCoefficient /
 * coefficientOfCurvature, which are echoed unchanged and cross-checked, never
 * overwritten. `uscsClassification` and other unknown keys are stripped (Zod
 * default, same as the registry schemas).
 *
 * SEMANTIC RULES (mirrors of the M5.1 `granulometryResult` superRefine):
 *   - diameters must be unique (registry rule);
 *   - percentFiner must be non-decreasing with increasing diameter within the
 *     registry's 0.01 rounding-noise tolerance (registry rule);
 *   - entered uniformityCoefficient must equal entered d60/d10 within ±0.05
 *     when all are present (registry identity);
 *   - entered coefficientOfCurvature must equal entered d30²/(d60 × d10)
 *     within ±0.05 when all are present (registry identity).
 *
 * DOCUMENTED DIVERGENCE vs the M5.1 storage layer (the engine computes and
 * advises; the registry gates — docs/14 §5): the registry stores PSD points in
 * ANY order (its superRefine sorts a copy for the monotonicity check; the
 * seed data is stored coarse-to-fine). This module REQUIRES points ordered by
 * strictly increasing diameterMm and rejects unordered input with
 * INVALID_INPUT — it never silently sorts, per the M5.2-b authorization §4.
 * Callers presenting stored payloads must order the points explicitly first.
 *
 * ENTERED-VALUE COMPARISON: each computed quantity is compared with its
 * entered counterpart; a discrepancy beyond ±0.05 produces an
 * ENTERED_VALUE_DISCREPANCY WARNING (entered value echoed unchanged).
 * Provenance of the tolerance: the M5.1 registry identity checks for this
 * test type use ±0.05 (registry GRANULOMETRY validationNotes); M5.2-b reuses
 * the same magnitude for computed-vs-entered comparisons. It is a project
 * engineering tolerance, not a standard-verified constant (same class as the
 * water-content ±0.5, docs/14 §9 R1).
 *
 * PRECISION: `raw` keeps full double precision; rounding happens only at this
 * output boundary — diameters 4 dp, Cu/Cc 3 dp, percentages 2 dp. Computed
 * values are never clamped. All percentile targets and boundary diameters
 * (10/30/60 %, 0.075 mm, 4.75 mm) are definitional values named by the
 * authorization, not empirical constants; the module consumes ZERO governed
 * constants (D8-safe — pure interpolation arithmetic).
 */
import { z } from "zod";
import type { CalculationModule, CalculationWarning } from "../types";
import {
  ArithmeticDomainError,
  InvalidInputError,
  assertFiniteNumber,
  zodErrorToCalculationError,
} from "../errors";
import { roundTo } from "../units";

export const GRANULOMETRY_MODULE_ID = "granulometry";
export const GRANULOMETRY_MODULE_VERSION = "1.0.0";

/**
 * Entered-value comparison tolerance (absolute), for diameters [mm] and for
 * the dimensionless coefficients alike. Provenance: registry GRANULOMETRY
 * identity tolerance ±0.05 (M5.1); reused for computed-vs-entered checks in
 * M5.2-b — a project engineering tolerance, not standard-verified.
 */
export const GRANULOMETRY_ENTERED_TOLERANCE = 0.05;

/**
 * Definitional boundary diameters of the authorized additional indicators
 * (M5.2-b authorization §3.4): fines boundary 0.075 mm (#200 sieve) and
 * coarse/fine split 4.75 mm (#4 sieve). Definitions, not empirical constants.
 */
export const FINES_BOUNDARY_MM = 0.075;
export const COARSE_FINE_BOUNDARY_MM = 4.75;

/** Percentile targets of the required indicators (definitional: D10/D30/D60). */
const D10_TARGET_PERCENT = 10;
const D30_TARGET_PERCENT = 30;
const D60_TARGET_PERCENT = 60;

/** Output boundary: diameters 4 dp, coefficients 3 dp, percentages 2 dp. */
const DIAMETER_DECIMALS = 4;
const COEFFICIENT_DECIMALS = 3;
const PERCENT_DECIMALS = 2;
const WARNING_DETAIL_DECIMALS = 4;

/** One measured PSD point (registry `granulometryResult` point shape). */
export interface GranulometryPoint {
  /** sieve / hydrometer diameter, 0 < d ≤ 300 [mm] */
  diameterMm: number;
  /** percentage of sample mass finer than diameterMm, 0–100 [%] */
  percentFiner: number;
}

/**
 * Input schema — the calculable core of the registry `granulometryResult`
 * contract (bounds identical). Exported so compatibility tests can assert
 * behavioral parity against the registry schema. Unknown keys are stripped
 * (Zod default, same as the registry schemas).
 */
export const granulometryCalcInput = z.object({
  points: z
    .array(z.object({
      diameterMm: z.number().positive().max(300),
      percentFiner: z.number().min(0).max(100),
    }))
    .min(4)
    .max(40),
  d10: z.number().positive().optional(),
  d30: z.number().positive().optional(),
  d60: z.number().positive().optional(),
  uniformityCoefficient: z.number().positive().optional(),
  coefficientOfCurvature: z.number().positive().optional(),
});

export interface GranulometryInput {
  points: GranulometryPoint[];
  d10?: number | undefined;
  d30?: number | undefined;
  d60?: number | undefined;
  uniformityCoefficient?: number | undefined;
  coefficientOfCurvature?: number | undefined;
}

/** Full-precision internal values (never rounded, never clamped). */
export interface GranulometryRaw {
  /** diameter at 10 % finer [mm], log-linear interpolation */
  d10: number;
  /** diameter at 30 % finer [mm] */
  d30: number;
  /** diameter at 60 % finer [mm] */
  d60: number;
  /** Cu = D60 / D10 */
  uniformityCoefficient: number;
  /** Cc = (D30/D10) × (D30/D60) = D30²/(D10 × D60) */
  coefficientOfCurvature: number;
  /** % passing 0.075 mm; null when outside the measured diameter range */
  percentPassing0075Mm: number | null;
  /** % passing 4.75 mm; null when outside the measured diameter range */
  percentPassing475Mm: number | null;
  /** 100 − % passing 4.75 mm; null when the split is unsupported */
  percentCoarserThan475Mm: number | null;
}

/** Output-boundary results (rounded; entered values echoed unchanged). */
export interface GranulometryResults {
  /** computed D10, 4 dp [mm] (registry result field name) */
  d10: number;
  /** computed D30, 4 dp [mm] */
  d30: number;
  /** computed D60, 4 dp [mm] */
  d60: number;
  /** computed Cu = D60/D10, 3 dp */
  uniformityCoefficient: number;
  /** computed Cc = D30²/(D10 × D60), 3 dp */
  coefficientOfCurvature: number;
  /** % passing 0.075 mm, 2 dp; null = not supported by measured points */
  percentPassing0075Mm: number | null;
  /** % passing 4.75 mm, 2 dp; null = not supported by measured points */
  percentPassing475Mm: number | null;
  /** % coarser than 4.75 mm, 2 dp; null = not supported by measured points */
  percentCoarserThan475Mm: number | null;
  /** laboratory-entered values, echoed unchanged (null when absent) */
  enteredD10: number | null;
  enteredD30: number | null;
  enteredD60: number | null;
  enteredUniformityCoefficient: number | null;
  enteredCoefficientOfCurvature: number | null;
}

// ---------------------------------------------------------------------------
// Interpolation helpers (exported for direct unit testing)
// ---------------------------------------------------------------------------

/**
 * Log-linear percentile-diameter interpolation (authorization §3.1):
 *   log(Dx) = log(D1) + [(x − P1)/(P2 − P1)] × [log(D2) − log(D1)]
 *
 * PRECONDITION: `points` validated by the module contract (≥ 2 points,
 * strictly increasing diameterMm, percentFiner non-decreasing within the
 * 0.01 registry noise tolerance). Deterministic resolution order:
 *   1. exactly one measured point at percentFiner === x → its diameter;
 *   2. more than one point at x, or more than one bracketing interval →
 *      INVALID_INPUT (the percentile is ambiguous — never guessed);
 *   3. exactly one bracketing interval → log-linear interpolation;
 *   4. no interval and x outside [min P, max P] → ARITHMETIC_DOMAIN_ERROR
 *      (extrapolation is rejected, missing values are never invented);
 *   5. no interval although x is inside the measured range (a noise gap in
 *      a non-monotonic-within-tolerance curve) → ARITHMETIC_DOMAIN_ERROR.
 */
export function interpolatePercentileDiameter(
  points: readonly GranulometryPoint[],
  targetPercent: number,
  quantityName: string,
): number {
  assertFiniteNumber(`interpolatePercentileDiameter(${quantityName})`, targetPercent);
  if (points.length < 2) {
    throw new InvalidInputError(
      "points",
      `At least 2 measured points are required to interpolate ${quantityName} (received ${points.length}).`,
    );
  }

  // 1–2. exact measured hits (a measured point beats any interpolation)
  const exactHits = points.filter((p) => p.percentFiner === targetPercent);
  if (exactHits.length > 1) {
    const diameters = exactHits.map((p) => p.diameterMm).join(" mm, ");
    throw new InvalidInputError(
      "points",
      `Ambiguous ${quantityName}: ${exactHits.length} measured points share percentFiner = ${targetPercent} % ` +
        `(diameters ${diameters} mm) — the percentile diameter is not uniquely defined.`,
    );
  }
  if (exactHits.length === 1) {
    return exactHits[0].diameterMm;
  }

  // bracketing intervals: adjacent pairs with P_i ≤ x ≤ P_(i+1)
  const brackets: Array<[GranulometryPoint, GranulometryPoint]> = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a.percentFiner <= targetPercent && targetPercent <= b.percentFiner) {
      brackets.push([a, b]);
    }
  }

  if (brackets.length > 1) {
    throw new InvalidInputError(
      "points",
      `Ambiguous ${quantityName}: ${brackets.length} interpolation intervals contain percentFiner = ${targetPercent} % ` +
        `— the percentile diameter is not uniquely defined.`,
    );
  }

  if (brackets.length === 0) {
    let minP = points[0].percentFiner;
    let maxP = points[0].percentFiner;
    for (const p of points) {
      if (p.percentFiner < minP) minP = p.percentFiner;
      if (p.percentFiner > maxP) maxP = p.percentFiner;
    }
    if (targetPercent < minP || targetPercent > maxP) {
      throw new ArithmeticDomainError(
        `interpolatePercentileDiameter(${quantityName})`,
        `${quantityName} requires percentFiner = ${targetPercent} %, but the measured percentFiner range is ` +
          `[${minP}, ${maxP}] % — the target lies outside the measured range and extrapolation is not performed.`,
      );
    }
    throw new ArithmeticDomainError(
      `interpolatePercentileDiameter(${quantityName})`,
      `${quantityName} target ${targetPercent} % lies within the measured percentFiner range [${minP}, ${maxP}] % ` +
        `but no valid interpolation interval covers it (the curve is non-monotonic around the target within the ` +
        `tolerated noise) — the percentile diameter cannot be determined.`,
    );
  }

  // 3. unique bracket → log-linear interpolation (P2 − P1 > 0 guaranteed:
  //    no point equals the target, so P1 < x < P2 strictly)
  const [lo, hi] = brackets[0];
  const t = (targetPercent - lo.percentFiner) / (hi.percentFiner - lo.percentFiner);
  const logDx = Math.log(lo.diameterMm) + t * (Math.log(hi.diameterMm) - Math.log(lo.diameterMm));
  const diameter = Math.exp(logDx);
  assertFiniteNumber(`interpolatePercentileDiameter(${quantityName})`, diameter);
  if (diameter <= 0) {
    throw new ArithmeticDomainError(
      `interpolatePercentileDiameter(${quantityName})`,
      `Interpolated ${quantityName} underflowed to zero — the bracketing diameters are too small for double precision.`,
    );
  }
  return diameter;
}

/**
 * Inverse log-linear interpolation: percentage finer at a given diameter.
 *   P(d) = P1 + [(log(d) − log(D1))/(log(D2) − log(D1))] × (P2 − P1)
 *
 * Returns `null` when `diameterMm` lies outside the measured diameter range
 * (the indicator is unsupported — never extrapolated). PRECONDITION: points
 * validated by the module contract. The bracketing interval is unique because
 * diameters are strictly increasing; a zero logarithmic interval width
 * (diameters indistinguishable at double precision) is rejected explicitly
 * instead of producing NaN.
 */
export function interpolatePercentAtDiameter(
  points: readonly GranulometryPoint[],
  diameterMm: number,
  quantityName: string,
): number | null {
  assertFiniteNumber(`interpolatePercentAtDiameter(${quantityName})`, diameterMm);
  if (points.length < 2) {
    throw new InvalidInputError(
      "points",
      `At least 2 measured points are required to interpolate ${quantityName} (received ${points.length}).`,
    );
  }

  if (diameterMm < points[0].diameterMm || diameterMm > points[points.length - 1].diameterMm) {
    return null; // outside the measured diameter range — unsupported, not extrapolated
  }

  // exact measured diameter → its measured percentage
  for (const p of points) {
    if (p.diameterMm === diameterMm) return p.percentFiner;
  }

  // unique bracketing interval (strictly increasing unique diameters)
  let lo = points[0];
  let hi = points[1];
  for (let i = 0; i + 1 < points.length; i++) {
    if (points[i].diameterMm < diameterMm && diameterMm < points[i + 1].diameterMm) {
      lo = points[i];
      hi = points[i + 1];
      break;
    }
  }

  const logWidth = Math.log(hi.diameterMm) - Math.log(lo.diameterMm);
  if (logWidth === 0) {
    throw new ArithmeticDomainError(
      `interpolatePercentAtDiameter(${quantityName})`,
      `Interpolation interval around ${diameterMm} mm has zero logarithmic width ` +
        `(diameters ${lo.diameterMm} mm and ${hi.diameterMm} mm are indistinguishable at double precision) ` +
        `— ${quantityName} cannot be interpolated.`,
    );
  }
  const t = (Math.log(diameterMm) - Math.log(lo.diameterMm)) / logWidth;
  const percent = lo.percentFiner + t * (hi.percentFiner - lo.percentFiner);
  assertFiniteNumber(`interpolatePercentAtDiameter(${quantityName})`, percent);
  return percent;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

/** Entered-comparison descriptors: fixed iteration order (determinism). */
const ENTERED_COMPARISONS: ReadonlyArray<{
  field: string;
  unit: string;
}> = [
  { field: "d10", unit: "mm" },
  { field: "d30", unit: "mm" },
  { field: "d60", unit: "mm" },
  { field: "uniformityCoefficient", unit: "" },
  { field: "coefficientOfCurvature", unit: "" },
] as const;

function enteredValue(input: GranulometryInput, field: string): number | undefined {
  switch (field) {
    case "d10": return input.d10;
    case "d30": return input.d30;
    case "d60": return input.d60;
    case "uniformityCoefficient": return input.uniformityCoefficient;
    case "coefficientOfCurvature": return input.coefficientOfCurvature;
    default: return undefined;
  }
}

function computedValue(raw: GranulometryRaw, field: string): number {
  switch (field) {
    case "d10": return raw.d10;
    case "d30": return raw.d30;
    case "d60": return raw.d60;
    case "uniformityCoefficient": return raw.uniformityCoefficient;
    case "coefficientOfCurvature": return raw.coefficientOfCurvature;
    default: throw new ArithmeticDomainError("computedValue", `Unknown computed field '${field}'.`);
  }
}

export const granulometryModule: CalculationModule<
  GranulometryInput,
  GranulometryRaw,
  GranulometryResults
> = {
  id: GRANULOMETRY_MODULE_ID,
  testType: "GRANULOMETRY",
  version: GRANULOMETRY_MODULE_VERSION,
  label: "Granulometry (PSD indicators: D10/D30/D60, Cu, Cc)",
  description:
    "Computes D10, D30 and D60 by log-linear interpolation between measured PSD points, the uniformity and curvature coefficients, and the percentages passing 0.075 mm and 4.75 mm where the measured range supports them; cross-checks laboratory-entered values and warns on discrepancies beyond ±0.05 without overwriting them. No hydrometer corrections, no classification.",

  validateInput(raw: unknown): GranulometryInput {
    const parsed = granulometryCalcInput.safeParse(raw);
    if (!parsed.success) {
      throw zodErrorToCalculationError(parsed.error, raw);
    }
    const input = parsed.data;

    // Semantic rule 1 — strictly increasing diameters (module contract: the
    // input must be ordered; unordered or duplicated input is rejected, never
    // silently sorted). Duplicates additionally violate the M5.1 registry rule.
    for (let i = 1; i < input.points.length; i++) {
      const prev = input.points[i - 1];
      const curr = input.points[i];
      if (curr.diameterMm === prev.diameterMm) {
        throw new InvalidInputError(
          `points[${i}].diameterMm`,
          `Duplicate diameterMm ${curr.diameterMm} at points[${i}] — points[${i - 1}] already uses this diameter; ` +
            `diameters must be unique (M5.1 contract).`,
        );
      }
      if (curr.diameterMm < prev.diameterMm) {
        throw new InvalidInputError(
          `points[${i}].diameterMm`,
          `points[${i}].diameterMm (${curr.diameterMm}) is not greater than points[${i - 1}].diameterMm ` +
            `(${prev.diameterMm}) — points must be ordered by strictly increasing diameterMm ` +
            `(unordered input is rejected, never silently sorted).`,
        );
      }
    }

    // Semantic rule 2 — percentFiner non-decreasing within the registry's
    // 0.01 rounding-noise tolerance (mirror of the M5.1 superRefine).
    for (let i = 1; i < input.points.length; i++) {
      const prev = input.points[i - 1];
      const curr = input.points[i];
      if (curr.percentFiner < prev.percentFiner - 0.01) {
        throw new InvalidInputError(
          `points[${i}].percentFiner`,
          `points[${i}].percentFiner (${curr.percentFiner}) is more than 0.01 below points[${i - 1}].percentFiner ` +
            `(${prev.percentFiner}) — percentFiner must be non-decreasing as particle diameter increases ` +
            `(more material is finer than a larger threshold).`,
        );
      }
    }

    // Semantic rule 3 — entered Cu identity (registry mirror, ±0.05).
    if (input.d10 && input.d60 && input.uniformityCoefficient) {
      const cu = input.d60 / input.d10;
      if (Math.abs(input.uniformityCoefficient - cu) > 0.05) {
        throw new InvalidInputError(
          "uniformityCoefficient",
          `uniformityCoefficient must equal d60 / d10 (entered ${input.uniformityCoefficient} vs ` +
            `${input.d60} / ${input.d10} = ${cu}; tolerance ±0.05, M5.1 contract).`,
        );
      }
    }

    // Semantic rule 4 — entered Cc identity (registry mirror, ±0.05).
    if (input.d10 && input.d30 && input.d60 && input.coefficientOfCurvature) {
      const cc = (input.d30 * input.d30) / (input.d60 * input.d10);
      if (Math.abs(input.coefficientOfCurvature - cc) > 0.05) {
        throw new InvalidInputError(
          "coefficientOfCurvature",
          `coefficientOfCurvature must equal d30² / (d60 × d10) (entered ${input.coefficientOfCurvature} vs ` +
            `${input.d30}² / (${input.d60} × ${input.d10}) = ${cc}; tolerance ±0.05, M5.1 contract).`,
        );
      }
    }

    return input;
  },

  compute(input: GranulometryInput) {
    // Required indicators — any uncomputable percentile fails the calculation
    // (authorization §3.1: extrapolation is rejected, not silently omitted).
    const d10 = interpolatePercentileDiameter(input.points, D10_TARGET_PERCENT, "d10");
    const d30 = interpolatePercentileDiameter(input.points, D30_TARGET_PERCENT, "d30");
    const d60 = interpolatePercentileDiameter(input.points, D60_TARGET_PERCENT, "d60");

    // Cu = D60 / D10 and Cc = D30²/(D10 × D60) — non-finite results (overflow)
    // are rejected explicitly; values are never clamped.
    const uniformityCoefficient = d60 / d10;
    assertFiniteNumber("uniformityCoefficient", uniformityCoefficient);
    const coefficientOfCurvature = (d30 / d10) * (d30 / d60);
    assertFiniteNumber("coefficientOfCurvature", coefficientOfCurvature);

    // Additional indicators — only where the measured diameter range supports
    // them; null means "not derivable from the measured points".
    const percentPassing0075Mm = interpolatePercentAtDiameter(input.points, FINES_BOUNDARY_MM, "percentPassing0075Mm");
    const percentPassing475Mm = interpolatePercentAtDiameter(input.points, COARSE_FINE_BOUNDARY_MM, "percentPassing475Mm");
    const percentCoarserThan475Mm = percentPassing475Mm === null ? null : 100 - percentPassing475Mm;

    const raw: GranulometryRaw = {
      d10,
      d30,
      d60,
      uniformityCoefficient,
      coefficientOfCurvature,
      percentPassing0075Mm,
      percentPassing475Mm,
      percentCoarserThan475Mm,
    };

    // Entered-value comparisons — fixed order, warnings never overwrite.
    const warnings: CalculationWarning[] = [];
    for (const { field, unit } of ENTERED_COMPARISONS) {
      const entered = enteredValue(input, field);
      if (entered === undefined) continue;
      const computed = computedValue(raw, field);
      const discrepancy = computed - entered;
      if (Math.abs(discrepancy) > GRANULOMETRY_ENTERED_TOLERANCE) {
        const decimals = unit === "mm" ? DIAMETER_DECIMALS : COEFFICIENT_DECIMALS;
        const unitSuffix = unit === "" ? "" : ` ${unit}`;
        warnings.push({
          code: "ENTERED_VALUE_DISCREPANCY",
          message:
            `Computed ${field} ${roundTo(computed, decimals)}${unitSuffix} deviates by ` +
            `${roundTo(discrepancy, decimals)}${unitSuffix} from the entered ${entered}${unitSuffix} ` +
            `(tolerance ±${GRANULOMETRY_ENTERED_TOLERANCE}${unitSuffix}).`,
          details: {
            field,
            enteredValue: entered,
            computedValue: roundTo(computed, WARNING_DETAIL_DECIMALS),
            discrepancy: roundTo(discrepancy, WARNING_DETAIL_DECIMALS),
            tolerance: GRANULOMETRY_ENTERED_TOLERANCE,
          },
        });
      }
    }

    const results: GranulometryResults = {
      d10: roundTo(d10, DIAMETER_DECIMALS),
      d30: roundTo(d30, DIAMETER_DECIMALS),
      d60: roundTo(d60, DIAMETER_DECIMALS),
      uniformityCoefficient: roundTo(uniformityCoefficient, COEFFICIENT_DECIMALS),
      coefficientOfCurvature: roundTo(coefficientOfCurvature, COEFFICIENT_DECIMALS),
      percentPassing0075Mm: percentPassing0075Mm === null ? null : roundTo(percentPassing0075Mm, PERCENT_DECIMALS),
      percentPassing475Mm: percentPassing475Mm === null ? null : roundTo(percentPassing475Mm, PERCENT_DECIMALS),
      percentCoarserThan475Mm: percentCoarserThan475Mm === null ? null : roundTo(percentCoarserThan475Mm, PERCENT_DECIMALS),
      enteredD10: input.d10 ?? null,
      enteredD30: input.d30 ?? null,
      enteredD60: input.d60 ?? null,
      enteredUniformityCoefficient: input.uniformityCoefficient ?? null,
      enteredCoefficientOfCurvature: input.coefficientOfCurvature ?? null,
    };

    return { raw, results, warnings };
  },
};
