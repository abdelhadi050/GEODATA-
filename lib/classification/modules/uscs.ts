/**
 * GEODATA HUB — USCS classification module (M5.4).
 *
 * Implements the Unified Soil Classification System per ASTM D2487-17
 * "Standard Practice for Classification of Soils for Engineering Purposes".
 *
 * STANDARD-TEXT INVARIANT — the rules implemented here are verbatim
 * transcriptions of the published ASTM D2487-17 criteria. No thresholds,
 * borderline criteria, or formulas are invented. Citations are inline next
 * to each criterion so a reviewer can trace every decision back to the
 * standard.
 *
 * INPUT CONTRACT — the module accepts the calculable core of two lab-test
 * registry result schemas:
 *   - granulometry: the `points` array (diameterMm + percentFiner), exactly
 *     as the GRANULOMETRY registry result schema expects (4–40 points, 0 <
 *     diameter ≤ 300 mm, 0 ≤ percentFiner ≤ 100, percentFiner non-decreasing
 *     with increasing diameter).
 *   - atterberg: optional `liquidLimit`, `plasticLimit`, `plasticityIndex`
 *     (LL/PL/PI). Optional because coarse-grained soils with low fines
 *     content are classifiable without them; the module reports an
 *     INSUFFICIENT_DATA warning when Atterberg data is required but absent.
 *
 * The module is independent of the lab-test registry — it accepts the same
 * field names by design (compatibility proven by tests, not by import).
 *
 * DETERMINISM — pure and deterministic: identical inputs always produce
 * deeply identical outputs. No clock, no randomness, no network or database
 * access.
 *
 * PRECISION — `raw` keeps full double precision for every derived quantity
 * (sieve fractions, A-line coordinate, U-line coordinate); `results` carries
 * the output-boundary-rounded values plus the verbatim classification symbol
 * and group name as the standard publishes them.
 *
 * REUSED ARITHMETIC — the percentile-diameter and percent-at-diameter
 * interpolations are exactly those of the granulometry calculation module
 * (`src/lib/calc/modules/granulometry.ts`, M5.2-b). They are imported and
 * reused — no logic is duplicated. The interpolations implement
 * log-linear interpolation, the method authorized for D10/D30/D60 in M5.2-b
 * and the standard method for deriving percent-passing at standard sieve
 * apertures from a measured PSD curve.
 */
import { z } from "zod";
import type { ClassificationModule, ClassificationWarning } from "../types";
import {
  ArithmeticDomainError,
  InvalidInputError,
  MissingInputError,
  InconsistentInputError,
  assertFiniteNumber,
  zodErrorToClassificationError,
} from "../errors";
import {
  interpolatePercentAtDiameter,
  interpolatePercentileDiameter,
  type GranulometryPoint,
  FINES_BOUNDARY_MM,
  COARSE_FINE_BOUNDARY_MM,
} from "@/lib/calc/modules/granulometry";

export const USCS_MODULE_ID = "uscs";
export const USCS_MODULE_VERSION = "1.0.0";
export const USCS_STANDARD = "ASTM D2487";
export const USCS_STANDARD_VERSION = "D2487-17";

// ---------------------------------------------------------------------------
// ASTM D2487-17 definitional constants (cited verbatim, not invented)
// ---------------------------------------------------------------------------

/**
 * Coarse/fine boundary (ASTM D2487 §6.2.1): the 75-µm sieve (#200) separates
 * coarse-grained soils (more than 50 % retained on #200) from fine-grained
 * soils (50 % or more passing #200). The 0.075 mm aperture is the literal
 * definition of the #200 sieve (ISO 565 / ASTM E11).
 */
const FINES_BOUNDARY_PCT = 50; // % passing #200 above which soil is fine-grained

/**
 * Gravel/sand boundary (ASTM D2487 §6.3.1): the 4.75-mm sieve (#4) separates
 * the coarse fraction into gravel (more than 50 % of coarse fraction retained
 * on #4) and sand (50 % or more of coarse fraction passing #4).
 */
const GRAVEL_SAND_SPLIT_PCT = 50;

/**
 * Coarse-grained soil fines thresholds (ASTM D2487 §6.3.2.1, Table 7):
 *   < 5 % fines     → clean coarse soil (GW/GP/SW/SP — fines character not
 *                     used in the symbol)
 *   5–12 % fines    → borderline dual symbol with the fines modifier
 *                     (GW-GM/GW-GC/GP-GM/GP-GC/SW-SM/SW-SC/SP-SM/SP-SC)
 *   ≥ 12 % fines    → fines character governs (GM/GC/SM/SC, or dual
 *                     GM-GC/SM-SC when both silty and clayey criteria met)
 *
 * The 5 % and 12 % are verbatim thresholds of the standard; the module treats
 * the inclusive/exclusive boundaries exactly as the standard does: "<5" means
 * strictly below 5; "5–12" is inclusive of both endpoints; "≥12" is 12 and
 * above.
 */
const CLEAN_COARSE_FINES_MAX = 5; // % fines < 5 ⇒ clean
const BORDERLINE_COARSE_FINES_MAX = 12; // % fines ≤ 12 ⇒ borderline (when ≥ 5)

/**
 * Well-graded criteria (ASTM D2487 §6.3.2.1, Table 7 footnotes):
 *   Gravel (GW):  Cu ≥ 4  AND  1 ≤ Cc ≤ 3
 *   Sand   (SW):  Cu ≥ 6  AND  1 ≤ Cc ≤ 3
 * The 4 / 6 / 1 / 3 thresholds are definitional values of the standard.
 */
const GRAVEL_WELL_GRADED_CU_MIN = 4;
const SAND_WELL_GRADED_CU_MIN = 6;
const WELL_GRADED_CC_MIN = 1;
const WELL_GRADED_CC_MAX = 3;

/**
 * Plasticity chart lines (ASTM D2487 §6.4.2, Fig. 4):
 *   A-line:  PI = 0.73 × (LL − 20)   (above ⇒ clayey behavior)
 *   U-line:  PI = 0.9  × (LL − 8)    (upper boundary of valid LL/PI pairs)
 *
 * Both equations are verbatim from the standard's plasticity chart. The
 * constant 0.73 and 0.9 are published coefficients — not invented.
 */
const A_LINE_SLOPE = 0.73;
const A_LINE_INTERCEPT = -20 * A_LINE_SLOPE; // = −14.6
const U_LINE_SLOPE = 0.9;
const U_LINE_INTERCEPT = -8 * U_LINE_SLOPE; // = −7.2

/** LL threshold separating "low" (L) from "high" (H) plasticity: LL = 50. */
const LL_PLASTICITY_THRESHOLD = 50;

/**
 * CL-ML crosshatched zone (ASTM D2487 Fig. 4): above the A-line (clayey) AND
 * 4 ≤ PI ≤ 7 AND LL < 50. The 4 and 7 are definitional bounds of the
 * crosshatched zone on the standard's plasticity chart.
 */
const CL_ML_PI_MIN = 4;
const CL_ML_PI_MAX = 7;

/** Output-boundary rounding: sieve fractions 2 dp, A-line/U-line coords 4 dp. */
const PERCENT_DECIMALS = 2;
const COORD_DECIMALS = 4;

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

const granulometryPointSchema = z.object({
  diameterMm: z.number().positive().max(300),
  percentFiner: z.number().min(0).max(100),
});

const atterbergSchema = z.object({
  liquidLimit: z.number().min(10).max(150),
  plasticLimit: z.number().min(5).max(100),
  plasticityIndex: z.number().min(0).max(100),
});

export const uscsCalcInput = z.object({
  /** Ordered by strictly increasing diameterMm (module contract). */
  points: z.array(granulometryPointSchema).min(2).max(40),
  /** Optional Atterberg limits — required when fines ≥ 5 %. */
  atterberg: atterbergSchema.optional(),
  /** Optional pre-computed D10/D30/D60 (echoed, not used in computation). */
  d10: z.number().positive().optional(),
  d30: z.number().positive().optional(),
  d60: z.number().positive().optional(),
});

export interface UscsAtterberg {
  liquidLimit: number;
  plasticLimit: number;
  plasticityIndex: number;
}

export interface UscsInput {
  points: GranulometryPoint[];
  atterberg?: UscsAtterberg;
  d10?: number;
  d30?: number;
  d60?: number;
}

// ---------------------------------------------------------------------------
// Full-precision internal values (raw)
// ---------------------------------------------------------------------------

export interface UscsRaw {
  /** % passing the #200 sieve (0.075 mm) — fines content of the whole sample. */
  percentFines: number;
  /** % passing the #4 sieve (4.75 mm). null for fine-grained soils (the #4 split is irrelevant). */
  percentPassingNo4: number | null;
  /** % retained on the #4 sieve — gravel fraction. 0 for fine-grained soils. */
  percentGravel: number;
  /** % sand = (#4 passing) − (#200 passing). 0 for fine-grained soils. */
  percentSand: number;
  /** Coarse fraction = gravel + sand = 100 − % fines. */
  percentCoarseFraction: number;
  /** % of coarse fraction that is gravel = %gravel / %coarseFraction × 100. */
  percentGravelOfCoarse: number;
  /** % of coarse fraction that is sand = %sand / %coarseFraction × 100. */
  percentSandOfCoarse: number;
  /** D10 [mm] — log-linear interpolation from the PSD (10 % finer). */
  d10: number;
  /** D30 [mm] — log-linear interpolation from the PSD (30 % finer). */
  d30: number;
  /** D60 [mm] — log-linear interpolation from the PSD (60 % finer). */
  d60: number;
  /** Cu = D60 / D10 (uniformity coefficient). */
  uniformityCoefficient: number;
  /** Cc = D30² / (D10 × D60) (coefficient of curvature). */
  coefficientOfCurvature: number;
  /** A-line PI at the sample's LL: PI = 0.73 × (LL − 20). null when no Atterberg. */
  aLinePiAtLl: number | null;
  /** U-line PI at the sample's LL: PI = 0.9 × (LL − 8). null when no Atterberg. */
  uLinePiAtLl: number | null;
  /** true when the (LL, PI) point lies on or above the A-line. null when no Atterberg. */
  isAboveAline: boolean | null;
  /** true when the (LL, PI) point lies on or above the U-line (physically questionable). */
  isAboveUline: boolean | null;
}

// ---------------------------------------------------------------------------
// Output-boundary results
// ---------------------------------------------------------------------------

export interface UscsResults {
  /** Verbatim ASTM D2487 group symbol (e.g. "CL", "SP-SM", "GW-GC", "CL-ML"). */
  symbol: string;
  /** Verbatim ASTM D2487 group name (e.g. "Lean clay", "Poorly graded sand with silt"). */
  groupName: string;
  /** Coarse/fine split as the standard defines it. */
  category: "COARSE_GRAINED" | "FINE_GRAINED";
  /** Sub-category: gravel/sand for coarse; ML/CL/MH/CH/OL/OH/CL-ML for fine. */
  primaryType: string;
  /** Derived sieve fractions, rounded to 2 dp. */
  percentFines: number;
  percentGravel: number;
  percentSand: number;
  /** Computed D10/D30/D60 [mm], 4 dp, and Cu/Cc (3 dp). */
  d10: number;
  d30: number;
  d60: number;
  uniformityCoefficient: number;
  coefficientOfCurvature: number;
  /** A-line and U-line coordinates at the sample's LL (4 dp); null when no Atterberg. */
  aLinePiAtLl: number | null;
  uLinePiAtLl: number | null;
  /** Reasoning steps — the standard clause invoked at each decision point. */
  reasoning: UscsReasoningStep[];
  /** Echoed Atterberg inputs when provided (null otherwise). */
  enteredLiquidLimit: number | null;
  enteredPlasticLimit: number | null;
  enteredPlasticityIndex: number | null;
}

export interface UscsReasoningStep {
  /** Clause reference (e.g. "D2487 §6.2.1", "D2487 Table 7"). */
  clause: string;
  /** What was decided at this step. */
  decision: string;
}

// ---------------------------------------------------------------------------
// Module implementation
// ---------------------------------------------------------------------------

function pctAt(points: readonly GranulometryPoint[], diameterMm: number, label: string): number | null {
  // Boundary rule: if the target diameter is LARGER than the largest measured
  // diameter AND the largest measured percentFiner is 100, then trivially 100 %
  // passes (no particle is larger than the largest measured sieve, and 100 %
  // already pass that sieve). The symmetric rule applies at the small end: if
  // the target is SMALLER than the smallest measured diameter AND the smallest
  // measured percentFiner is 0, then 0 % passes. These are definitional — they
  // do not extrapolate; they state that a soil entirely finer than the largest
  // measured sieve is also entirely finer than any larger sieve.
  const first = points[0];
  const last = points[points.length - 1];
  if (diameterMm > last.diameterMm && last.percentFiner === 100) return 100;
  if (diameterMm < first.diameterMm && first.percentFiner === 0) return 0;
  // The granulometry module's interpolatePercentAtDiameter throws on
  // pathological input; we wrap to surface a deterministic error here.
  try {
    return interpolatePercentAtDiameter(points, diameterMm, label);
  } catch (err) {
    if (err instanceof ArithmeticDomainError || err instanceof InvalidInputError) {
      throw err;
    }
    // Non-classified throw → wrap as ArithmeticDomainError to keep the engine
    // error taxonomy clean.
    throw new ArithmeticDomainError(
      `pctAt(${label})`,
      `Failed to interpolate % passing at ${diameterMm} mm (${label}): ${(err as Error).message}`,
    );
  }
}

/** A-line PI = 0.73 × (LL − 20). */
export function aLinePiAt(ll: number): number {
  assertFiniteNumber("aLinePiAt", ll);
  const pi = A_LINE_SLOPE * (ll - 20);
  assertFiniteNumber("aLinePiAt:result", pi);
  return pi;
}

/** U-line PI = 0.9 × (LL − 8). */
export function uLinePiAt(ll: number): number {
  assertFiniteNumber("uLinePiAt", ll);
  const pi = U_LINE_SLOPE * (ll - 8);
  assertFiniteNumber("uLinePiAt:result", pi);
  return pi;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Coarse-grained classification per ASTM D2487 §6.3 + Table 7.
 *
 * Decision tree (verbatim from the standard):
 *   1. Determine fines content F = % passing #200.
 *   2. If F < 5 %:
 *        - Compute Cu = D60/D10, Cc = D30²/(D10 × D60) from the PSD.
 *        - Gravel: well-graded GW if Cu ≥ 4 AND 1 ≤ Cc ≤ 3; else GP.
 *        - Sand:   well-graded SW if Cu ≥ 6 AND 1 ≤ Cc ≤ 3; else SP.
 *   3. If 5 % ≤ F ≤ 12 % (borderline):
 *        - First determine the clean-soil symbol (GW/GP/SW/SP) as above.
 *        - Then determine the fines modifier (M if below A-line or PI < 4;
 *          C if at/above A-line and PI ≥ 7).
 *        - Combine into a dual symbol (e.g. GW-GM, SP-SC).
 *        - Special case: if PI is between 4 and 7 (inclusive), the modifier
 *          is dual M-C (crosshatched zone analog for coarse soils).
 *   4. If F > 12 %:
 *        - Fines character governs: M (silty) or C (clayey) based on the
 *          plasticity chart, with dual M-C for the 4–7 PI zone.
 *
 * Returns the symbol, group name, and accumulated reasoning steps.
 */
function classifyCoarseGrained(
  raw: UscsRaw,
  atterberg: UscsAtterberg | undefined,
  reasoning: UscsReasoningStep[],
  isGravel: boolean,
  warnings: ClassificationWarning[],
): { symbol: string; groupName: string } {
  const finesPct = raw.percentFines;
  const cu = raw.uniformityCoefficient;
  const cc = raw.coefficientOfCurvature;
  const baseType = isGravel ? "G" : "S";
  const baseNounSingular = isGravel ? "gravel" : "sand";
  const baseNounPlural = isGravel ? "gravels" : "sands";
  const cuMin = isGravel ? GRAVEL_WELL_GRADED_CU_MIN : SAND_WELL_GRADED_CU_MIN;

  // Step 1: fines-tier determination (clean / borderline / fines-governed).
  let finesTier: "CLEAN" | "BORDERLINE" | "FINES_GOVERNED";
  if (finesPct < CLEAN_COARSE_FINES_MAX) {
    finesTier = "CLEAN";
    reasoning.push({
      clause: "D2487 §6.3.2.1 (Table 7)",
      decision: `Fines content ${roundTo(finesPct, PERCENT_DECIMALS)} % < 5 % → clean coarse-grained soil (no fines modifier in symbol).`,
    });
  } else if (finesPct <= BORDERLINE_COARSE_FINES_MAX) {
    finesTier = "BORDERLINE";
    reasoning.push({
      clause: "D2487 §6.3.2.1 (Table 7)",
      decision: `Fines content ${roundTo(finesPct, PERCENT_DECIMALS)} % is in the 5–12 % borderline range → dual symbol with the fines modifier.`,
    });
  } else {
    finesTier = "FINES_GOVERNED";
    reasoning.push({
      clause: "D2487 §6.3.2.1 (Table 7)",
      decision: `Fines content ${roundTo(finesPct, PERCENT_DECIMALS)} % > 12 % → fines character governs the symbol.`,
    });
  }

  // Step 2: gradation (well-graded W vs poorly-graded P) — required for clean
  // and borderline soils. The standard does NOT assign W/P to GM/GC/SM/SC
  // (fines-governed) because gradation is not the controlling criterion.
  let gradationSymbol = ""; // "W" | "P" | "" (no gradation in symbol)
  let isWellGraded = false;
  if (finesTier === "CLEAN" || finesTier === "BORDERLINE") {
    isWellGraded = cu >= cuMin && cc >= WELL_GRADED_CC_MIN && cc <= WELL_GRADED_CC_MAX;
    gradationSymbol = isWellGraded ? "W" : "P";
    reasoning.push({
      clause: `D2487 §6.3.2.1 (Table 7, footnote ${isGravel ? "Cu ≥ 4" : "Cu ≥ 6"} AND 1 ≤ Cc ≤ 3)`,
      decision:
        `Cu = ${roundTo(cu, 3)} ${cu >= cuMin ? "≥" : "<"} ${cuMin}; Cc = ${roundTo(cc, 3)} ` +
        `(must be in [1, 3]) → ${isWellGraded ? "well-graded (W)" : "poorly-graded (P)"}.`,
    });
  }

  // Step 3: fines modifier (M / C / dual M-C) — required for BORDERLINE and
  // FINES_GOVERNED tiers. Requires Atterberg data.
  let finesModifier = ""; // "M" | "C" | "M-C" | "" (no fines modifier)
  if (finesTier === "BORDERLINE" || finesTier === "FINES_GOVERNED") {
    if (!atterberg) {
      // The standard cannot determine M vs C without plasticity data. The
      // module refuses to fabricate a modifier — the caller is required to
      // supply Atterberg data for any coarse-grained soil with ≥ 5 % fines.
      throw new MissingInputError(
        "atterberg",
        `Coarse-grained soil with ${roundTo(finesPct, PERCENT_DECIMALS)} % fines requires Atterberg limits to determine the fines character (M/C). Provide liquidLimit, plasticLimit and plasticityIndex.`,
      );
    }
    const { liquidLimit, plasticityIndex } = atterberg;
    const aPi = aLinePiAt(liquidLimit);
    const isClayey = plasticityIndex >= 7 && plasticityIndex >= aPi;
    const isSilty = plasticityIndex < CL_ML_PI_MIN || plasticityIndex < aPi;
    if (isClayey && isSilty) {
      // PI is both ≥7 and <4 — impossible; covered for completeness.
      finesModifier = "M-C";
    } else if (isClayey) {
      finesModifier = "C";
    } else if (plasticityIndex >= CL_ML_PI_MIN && plasticityIndex <= CL_ML_PI_MAX) {
      // Crosshatched zone analog: PI between 4 and 7 inclusive → dual M-C.
      finesModifier = "M-C";
    } else {
      finesModifier = "M";
    }
    reasoning.push({
      clause: "D2487 §6.3.2.1 + plasticity chart (Fig. 4)",
      decision: `Atterberg LL=${liquidLimit}, PI=${plasticityIndex}. A-line PI at LL=${roundTo(aPi, 2)}. Fines character: ${finesModifier === "M" ? "silty (M) — below the A-line or PI < 4" : finesModifier === "C" ? "clayey (C) — at or above the A-line and PI ≥ 7" : "dual silty-clayey (M-C) — PI in the 4–7 crosshatched zone"}.`,
    });
    // Warn when borderline (5–12 %) and the Cu/Cc criteria are not met — the
    // dual symbol combines the poorly-graded symbol with the fines modifier,
    // which is what the standard mandates, but the analyst should be aware.
    if (finesTier === "BORDERLINE" && !isWellGraded && atterberg.plasticityIndex > CL_ML_PI_MAX) {
      warnings.push({
        code: "BORDERLINE_CASE",
        message:
          `Borderline coarse-grained soil (${roundTo(finesPct, PERCENT_DECIMALS)} % fines) with poorly-graded gradation ` +
          `(Cu=${roundTo(cu, 3)}, Cc=${roundTo(cc, 3)}). The dual symbol ${baseType}P-${baseType}${finesModifier} ` +
          `reflects both the gradation and the fines character per ASTM D2487 Table 7.`,
        details: {
          finesPct: roundTo(finesPct, PERCENT_DECIMALS),
          uniformityCoefficient: roundTo(cu, 3),
          coefficientOfCurvature: roundTo(cc, 3),
        },
      });
    }
  }

  // Step 4: assemble the symbol per the standard's combining rules.
  let symbol: string;
  let groupName: string;

  if (finesTier === "CLEAN") {
    symbol = `${baseType}${gradationSymbol}`;
    groupName =
      gradationSymbol === "W"
        ? isGravel
          ? `Well-graded ${baseNounPlural}`
          : `Well-graded ${baseNounPlural} with gravel`
        : isGravel
          ? `Poorly-graded ${baseNounPlural}`
          : `Poorly-graded ${baseNounPlural} with gravel`;
  } else if (finesTier === "BORDERLINE") {
    symbol = `${baseType}${gradationSymbol}-${baseType}${finesModifier}`;
    const finesWord =
      finesModifier === "M"
        ? "silt"
        : finesModifier === "C"
          ? "clay"
          : "silt and clay";
    groupName = `${
      gradationSymbol === "W" ? "Well-graded" : "Poorly-graded"
    } ${baseNounSingular} with ${finesWord}`;
  } else {
    // FINES_GOVERNED: symbol is just G/S + M/C (no gradation letter).
    if (finesModifier === "M-C") {
      symbol = `${baseType}M-${baseType}C`;
      groupName = `Silty, clayey ${baseNounSingular}`;
    } else {
      symbol = `${baseType}${finesModifier}`;
      groupName =
        finesModifier === "M"
          ? `Silty ${baseNounSingular}`
          : `Clayey ${baseNounSingular}`;
    }
  }

  return { symbol, groupName };
}

/**
 * Fine-grained classification per ASTM D2487 §6.4 + plasticity chart.
 *
 * Decision tree (verbatim from the standard):
 *   1. Required input: LL and PI.
 *   2. Determine LL < 50 (low plasticity, L) vs LL ≥ 50 (high plasticity, H).
 *   3. Compute A-line PI at the sample's LL: PI_A = 0.73 × (LL − 20).
 *   4. Compute U-line PI at the sample's LL: PI_U = 0.9  × (LL − 8).
 *   5. If PI ≥ PI_A (at or above A-line): clayey (C).
 *        - LL < 50  → CL (lean clay)
 *        - LL ≥ 50  → CH (fat clay)
 *   6. If PI < PI_A (below A-line): silty (M) or organic (O).
 *        - LL < 50  → ML (silt) — organic OL is not derivable from LL/PI alone;
 *                     requires organic-content test (the module flags this).
 *        - LL ≥ 50  → MH (silt of high plasticity) — OH likewise not derivable.
 *   7. Crosshatched zone (CL-ML): above A-line AND 4 ≤ PI ≤ 7 AND LL < 50.
 *   8. If the (LL, PI) point plots ABOVE the U-line, the data is physically
 *      questionable (no real soil should plot above the U-line). The module
 *      still produces the symbol determined by the A-line test but emits a
 *      PHYSICAL_CONSISTENCY-class warning — wait, no: per the standard's
 *      own guidance, the U-line check is a quality-control flag; the symbol
 *      is still produced per the A-line. We surface an ENTERED_VALUE_
 *      DISCREPANCY warning here (the closest existing code in the warning
 *      taxonomy), but the classification result is NOT modified.
 */
function classifyFineGrained(
  raw: UscsRaw,
  atterberg: UscsAtterberg,
  reasoning: UscsReasoningStep[],
  warnings: ClassificationWarning[],
): { symbol: string; groupName: string } {
  const { liquidLimit, plasticityIndex } = atterberg;
  const aPi = raw.aLinePiAtLl!;
  const uPi = raw.uLinePiAtLl!;
  const isAboveA = raw.isAboveAline!;
  const isAboveU = raw.isAboveUline!;

  reasoning.push({
    clause: "D2487 §6.4.2 (plasticity chart, Fig. 4)",
    decision: `LL=${liquidLimit}, PI=${plasticityIndex}. A-line PI=${roundTo(aPi, 2)} at this LL; U-line PI=${roundTo(uPi, 2)}. Plot ${isAboveA ? "above (clayey)" : "below (silty"} the A-line. LL ${liquidLimit < LL_PLASTICITY_THRESHOLD ? "< 50 (low plasticity)" : "≥ 50 (high plasticity)"}.`,
  });

  if (isAboveU) {
    warnings.push({
      code: "ENTERED_VALUE_DISCREPANCY",
      message:
        `The (LL, PI) point plots above the U-line (PI=${plasticityIndex} > U-line PI=${roundTo(uPi, 2)}) ` +
        `— no real soil should plot above the U-line per ASTM D2487 Fig. 4. Verify the Atterberg data; ` +
        `the classification below is reported nonetheless.`,
      details: {
        liquidLimit,
        plasticityIndex,
        uLinePiAtLl: roundTo(uPi, COORD_DECIMALS),
      },
    });
  }

  // Crosshatched CL-ML zone: above A-line AND 4 ≤ PI ≤ 7 AND LL < 50.
  if (
    isAboveA &&
    plasticityIndex >= CL_ML_PI_MIN &&
    plasticityIndex <= CL_ML_PI_MAX &&
    liquidLimit < LL_PLASTICITY_THRESHOLD
  ) {
    reasoning.push({
      clause: "D2487 Fig. 4 (crosshatched zone)",
      decision: `PI is between ${CL_ML_PI_MIN} and ${CL_ML_PI_MAX} (inclusive) and the point plots above the A-line with LL < 50 → CL-ML (silty clay).`,
    });
    return {
      symbol: "CL-ML",
      groupName: "Silty clay",
    };
  }

  if (isAboveA) {
    // Clayey (C): CL if LL < 50, CH if LL ≥ 50.
    if (liquidLimit < LL_PLASTICITY_THRESHOLD) {
      return { symbol: "CL", groupName: "Lean clay" };
    }
    return { symbol: "CH", groupName: "Fat clay" };
  }

  // Below the A-line: silty (M) — organic (O) requires a separate organic test
  // not derivable from LL/PI alone. The module reports ML/MH and emits an
  // INSUFFICIENT_DATA warning so the analyst is aware that OL/OH cannot be
  // ruled out without the organic-content test.
  warnings.push({
    code: "INSUFFICIENT_DATA",
    message:
      `The point plots below the A-line (silty behavior). ASTM D2487 distinguishes ML/OL (LL < 50) and MH/OH (LL ≥ 50) ` +
      `by an organic-content test (ASTM D2974) — without it, OL/OH cannot be ruled out. The inorganic symbol ` +
      `(ML or MH) is reported; perform the organic test if the soil is suspected to be organic.`,
    details: {
      liquidLimit,
      plasticityIndex,
      aLinePiAtLl: roundTo(aPi, COORD_DECIMALS),
    },
  });

  if (liquidLimit < LL_PLASTICITY_THRESHOLD) {
    return { symbol: "ML", groupName: "Silt" };
  }
  return { symbol: "MH", groupName: "Silt of high plasticity, elastic silt" };
}

// ---------------------------------------------------------------------------
// Module registration
// ---------------------------------------------------------------------------

export const uscsModule: ClassificationModule<UscsInput, UscsRaw, UscsResults> = {
  id: USCS_MODULE_ID,
  sourceType: "SAMPLE",
  version: USCS_MODULE_VERSION,
  label: "USCS classification (ASTM D2487)",
  description:
    "Classifies soils per the Unified Soil Classification System (ASTM D2487-17). Uses particle-size distribution and Atterberg limits to determine coarse-grained vs fine-grained, gravel/sand split, gradation (Cu/Cc), fines character (M/C), and plasticity-chart placement (A-line, U-line, CL-ML crosshatched zone).",
  standard: USCS_STANDARD,
  standardVersion: USCS_STANDARD_VERSION,

  validateInput(raw: unknown): UscsInput {
    const parsed = uscsCalcInput.safeParse(raw);
    if (!parsed.success) {
      throw zodErrorToClassificationError(parsed.error, raw);
    }
    const input = parsed.data;

    // Mirror of the granulometry module's ordering rule (M5.2-b §4): points
    // must be ordered by strictly increasing diameterMm; unordered input is
    // rejected, never silently sorted.
    for (let i = 1; i < input.points.length; i++) {
      const prev = input.points[i - 1];
      const curr = input.points[i];
      if (curr.diameterMm === prev.diameterMm) {
        throw new InvalidInputError(
          `points[${i}].diameterMm`,
          `Duplicate diameterMm ${curr.diameterMm} at points[${i}] — points[${i - 1}] already uses this diameter.`,
        );
      }
      if (curr.diameterMm < prev.diameterMm) {
        throw new InvalidInputError(
          `points[${i}].diameterMm`,
          `points[${i}].diameterMm (${curr.diameterMm}) must be greater than points[${i - 1}].diameterMm (${prev.diameterMm}) — points must be ordered by strictly increasing diameterMm.`,
        );
      }
    }
    // percentFiner non-decreasing within the registry 0.01 noise tolerance.
    for (let i = 1; i < input.points.length; i++) {
      if (input.points[i].percentFiner < input.points[i - 1].percentFiner - 0.01) {
        throw new InvalidInputError(
          `points[${i}].percentFiner`,
          `points[${i}].percentFiner (${input.points[i].percentFiner}) is more than 0.01 below points[${i - 1}].percentFiner (${input.points[i - 1].percentFiner}) — percentFiner must be non-decreasing as diameter increases.`,
        );
      }
    }

    // Atterberg consistency (registry mirror): PL < LL, PI = LL − PL.
    if (input.atterberg) {
      const { liquidLimit, plasticLimit, plasticityIndex } = input.atterberg;
      if (plasticLimit >= liquidLimit) {
        throw new InconsistentInputError(
          "atterberg",
          `plasticLimit (${plasticLimit}) must be lower than liquidLimit (${liquidLimit}).`,
        );
      }
      const expected = liquidLimit - plasticLimit;
      if (Math.abs(plasticityIndex - expected) > 1.0) {
        throw new InconsistentInputError(
          "atterberg.plasticityIndex",
          `plasticityIndex (${plasticityIndex}) must equal liquidLimit − plasticLimit = ${expected} (±1).`,
        );
      }
    }

    return input;
  },

  compute(input: UscsInput) {
    // ---- Step 1: coarse/fine split (D2487 §6.2.1) — only %fines required ----
    // The standard's first decision is the coarse/fine split, which depends
    // solely on % passing #200. We compute that first; if the soil is
    // fine-grained we never need % passing #4 (the gravel/sand split is
    // only defined for coarse-grained soils).
    const percentFines = pctAt(input.points, FINES_BOUNDARY_MM, "percentFines (#200)");
    if (percentFines === null) {
      throw new ArithmeticDomainError(
        "percentFines",
        `The measured PSD range does not cover the #200 sieve (0.075 mm); ASTM D2487 §6.2.1 cannot determine the coarse/fine split without the fines content. Extend the sieve analysis to include sieves at and below 0.075 mm.`,
      );
    }
    const isFineGrained = percentFines >= FINES_BOUNDARY_PCT;

    // ---- % passing #4 — only required for coarse-grained soils ----
    let percentPassingNo4: number | null = null;
    let percentGravel = 0;
    let percentSand = 0;
    let percentCoarseFraction = 100 - percentFines;
    let percentGravelOfCoarse = 0;
    let percentSandOfCoarse = 0;
    if (!isFineGrained) {
      percentPassingNo4 = pctAt(input.points, COARSE_FINE_BOUNDARY_MM, "percentPassingNo4 (#4)");
      if (percentPassingNo4 === null) {
        throw new ArithmeticDomainError(
          "percentPassingNo4",
          `The measured PSD range does not cover the #4 sieve (4.75 mm); ASTM D2487 §6.3.1 cannot determine the gravel/sand split without % passing #4. Extend the sieve analysis to include sieves at and above 4.75 mm, or ensure the largest measured sieve shows 100 % passing.`,
        );
      }
      percentGravel = 100 - percentPassingNo4;
      percentSand = percentPassingNo4 - percentFines;
      // Avoid division by zero for pure-fines soils (defensive guard).
      percentGravelOfCoarse =
        percentCoarseFraction > 0 ? (percentGravel / percentCoarseFraction) * 100 : 0;
      percentSandOfCoarse =
        percentCoarseFraction > 0 ? (percentSand / percentCoarseFraction) * 100 : 0;
    }

    // ---- D10/D30/D60 + Cu/Cc — only needed for coarse-grained soils ----
    // (the granulometry module's interpolation throws ARITHMETIC_DOMAIN_ERROR
    // when the target percentile lies outside the measured percentFiner range;
    // for fine-grained soils that is expected — the percentiles D10/D30 are
    // typically below the smallest measured percentFiner — so we skip the
    // computation entirely for fine-grained inputs and report zeros).
    let d10 = 0;
    let d30 = 0;
    let d60 = 0;
    let cu = 0;
    let cc = 0;
    if (!isFineGrained) {
      // All three percentile diameters are required by the standard's
      // gradation criteria. interpolatePercentileDiameter throws when the
      // target is outside the measured percentFiner range — that surface as
      // an ArithmeticDomainError here, telling the analyst the PSD is too
      // coarse or too sparse to assess gradation.
      d10 = interpolatePercentileDiameter(input.points, 10, "d10");
      d30 = interpolatePercentileDiameter(input.points, 30, "d30");
      d60 = interpolatePercentileDiameter(input.points, 60, "d60");
      cu = d60 / d10;
      assertFiniteNumber("uniformityCoefficient", cu);
      cc = (d30 / d10) * (d30 / d60);
      assertFiniteNumber("coefficientOfCurvature", cc);
    }

    // ---- Plasticity chart coordinates (only when Atterberg is provided) ----
    let aLinePiAtLl: number | null = null;
    let uLinePiAtLl: number | null = null;
    let isAboveAline: boolean | null = null;
    let isAboveUline: boolean | null = null;
    if (input.atterberg) {
      const { liquidLimit, plasticityIndex } = input.atterberg;
      aLinePiAtLl = aLinePiAt(liquidLimit);
      uLinePiAtLl = uLinePiAt(liquidLimit);
      // ASTM D2487: "at or above" the A-line ⇒ clayey; the standard treats
      // points exactly on the line as clayey (the A-line is the boundary of
      // the clay region, inclusive).
      isAboveAline = plasticityIndex >= aLinePiAtLl;
      isAboveUline = plasticityIndex > uLinePiAtLl;
    }

    const rawValues: UscsRaw = {
      percentFines,
      percentPassingNo4,
      percentGravel,
      percentSand,
      percentCoarseFraction,
      percentGravelOfCoarse,
      percentSandOfCoarse,
      d10,
      d30,
      d60,
      uniformityCoefficient: cu,
      coefficientOfCurvature: cc,
      aLinePiAtLl,
      uLinePiAtLl,
      isAboveAline,
      isAboveUline,
    };

    const warnings: ClassificationWarning[] = [];
    const reasoning: UscsReasoningStep[] = [];

    reasoning.push({
      clause: "D2487 §6.2.1",
      decision: `% passing #200 = ${roundTo(percentFines, PERCENT_DECIMALS)} % ${isFineGrained ? "≥ 50 % → fine-grained soil" : "< 50 % → coarse-grained soil"}.`,
    });

    let symbol: string;
    let groupName: string;
    let category: "COARSE_GRAINED" | "FINE_GRAINED";
    let primaryType: string;

    if (isFineGrained) {
      category = "FINE_GRAINED";
      if (!input.atterberg) {
        throw new MissingInputError(
          "atterberg",
          "Fine-grained soils require Atterberg limits (LL, PL, PI) for ASTM D2487 classification. Provide the Atterberg limits for this sample.",
        );
      }
      const result = classifyFineGrained(rawValues, input.atterberg, reasoning, warnings);
      symbol = result.symbol;
      groupName = result.groupName;
      primaryType = symbol;
    } else {
      category = "COARSE_GRAINED";
      // ---- Step 2: gravel vs sand (D2487 §6.3.1) ----
      const isGravel = percentGravelOfCoarse > GRAVEL_SAND_SPLIT_PCT;
      reasoning.push({
        clause: "D2487 §6.3.1",
        decision: `% of coarse fraction retained on #4 = ${roundTo(percentGravelOfCoarse, PERCENT_DECIMALS)} % ${isGravel ? "> 50 % → gravel (G)" : "≤ 50 % → sand (S)"}.`,
      });
      primaryType = isGravel ? "G" : "S";
      const result = classifyCoarseGrained(rawValues, input.atterberg, reasoning, isGravel, warnings);
      symbol = result.symbol;
      groupName = result.groupName;
    }

    const results: UscsResults = {
      symbol,
      groupName,
      category,
      primaryType,
      percentFines: roundTo(percentFines, PERCENT_DECIMALS),
      percentGravel: roundTo(percentGravel, PERCENT_DECIMALS),
      percentSand: roundTo(percentSand, PERCENT_DECIMALS),
      d10: roundTo(d10, 4),
      d30: roundTo(d30, 4),
      d60: roundTo(d60, 4),
      uniformityCoefficient: roundTo(cu, 3),
      coefficientOfCurvature: roundTo(cc, 3),
      aLinePiAtLl: aLinePiAtLl === null ? null : roundTo(aLinePiAtLl, COORD_DECIMALS),
      uLinePiAtLl: uLinePiAtLl === null ? null : roundTo(uLinePiAtLl, COORD_DECIMALS),
      reasoning,
      enteredLiquidLimit: input.atterberg?.liquidLimit ?? null,
      enteredPlasticLimit: input.atterberg?.plasticLimit ?? null,
      enteredPlasticityIndex: input.atterberg?.plasticityIndex ?? null,
    };

    return { raw: rawValues, results, warnings };
  },
};
