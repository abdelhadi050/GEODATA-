/**
 * GEODATA HUB — AASHTO M 145 classification module (M5.4).
 *
 * Implements the AASHTO soil classification system per AASHTO M 145-91
 * (2004) "Classification of Soils and Soil-Aggregate Mixtures for Highway
 * Construction Purposes".
 *
 * STANDARD-TEXT INVARIANT — the rules and thresholds implemented here are
 * verbatim transcriptions of the published AASHTO M 145-91 table and the
 * Group Index formula. No thresholds, group limits, or formulas are invented.
 *
 * INPUT CONTRACT — the module accepts the calculable core of two lab-test
 * registry result schemas:
 *   - granulometry: the `points` array (diameterMm + percentFiner), exactly
 *     as the GRANULOMETRY registry result schema expects. The module derives
 *     % passing #10 (2.0 mm), #40 (0.425 mm), and #200 (0.075 mm) by
 *     log-linear interpolation from the measured PSD — the same method the
 *     M5.2 granulometry calculation module uses for D10/D30/D60.
 *   - atterberg: optional `liquidLimit`, `plasticLimit`, `plasticityIndex`.
 *     Required when the soil is plastic (PI ≥ 1); the standard treats a soil
 *     with non-determinable LL/PI as non-plastic (NP) and the GI as 0.
 *
 * DETERMINISM — pure and deterministic.
 *
 * PRECISION — `raw` keeps full double precision for every derived quantity
 * (sieve percentages, partial GI terms, final GI). `results` carries the
 * rounded values plus the verbatim AASHTO group symbol (e.g. "A-7-6", with
 * the GI appended in parentheses per the standard's notation, e.g.
 * "A-7-6 (20)") and group name.
 *
 * REUSED ARITHMETIC — the percent-at-diameter interpolation is the granulometry
 * calculation module's exported helper (`interpolatePercentAtDiameter`,
 * M5.2-b). No logic is duplicated.
 *
 * STANDARD-CITED TABLE (AASHTO M 145-91, verified against the AASHTO
 * refdoc and multiple authoritative references):
 *
 *   Granular materials (≤35 % passing #200):
 *     A-1-a: %pass#10 ≤50, %pass#40 ≤30, %pass#200 ≤15,        PI ≤6
 *     A-1-b: %pass#10 ≤50, %pass#40 ≤50, %pass#200 ≤25,        PI ≤6
 *     A-3:                       %pass#40 ≥51, %pass#200 ≤10,   NP (PI=0)
 *     A-2-4:                                  %pass#200 ≤35,   LL ≤40, PI ≤10
 *     A-2-5:                                  %pass#200 ≤35,   LL ≥41, PI ≤10
 *     A-2-6:                                  %pass#200 ≤35,   LL ≤40, PI ≥11
 *     A-2-7:                                  %pass#200 ≤35,   LL ≥41, PI ≥11
 *
 *   Silt-clay materials (>35 % passing #200):
 *     A-4:                                                     LL ≤40, PI ≤10
 *     A-5:                                                     LL ≥41, PI ≤10
 *     A-6:                                                     LL ≤40, PI ≥11
 *     A-7-5:                                                   LL ≥41, PI ≥11, PI ≤ LL−30
 *     A-7-6:                                                   LL ≥41, PI ≥11, PI > LL−30
 *
 * GROUP INDEX FORMULA (AASHTO M 145-91 §3):
 *   GI = (F−35)·[0.2 + 0.005·(LL−40)] + 0.01·(F−15)·(PI−10)
 *
 *   where F = % passing #200 (whole number)
 *         LL = liquid limit (whole number)
 *         PI = plasticity index (whole number)
 *
 *   Partial-term flooring rule (AASHTO M 145-91 §3):
 *     - Compute the LL-term partial first; if it is negative, set it to 0.
 *     - Then compute the PI-term partial; if it is negative, set it to 0.
 *     - GI = LL_partial + PI_partial; if the total is negative, GI = 0.
 *     - For groups A-1-a, A-1-b, A-3, A-2-4, A-2-5: GI is reported as 0
 *       by definition (the formula naturally yields 0 for these because
 *       either F ≤ 35 or the partial terms are non-positive).
 *     - For groups A-2-6 and A-2-7: only the PI-term partial is used
 *       (the LL-term partial is set to 0 per the standard).
 *     - For non-plastic soils (LL or PI cannot be determined): GI = 0.
 *     - The reported GI is rounded to the nearest whole number (the standard
 *       requires whole-number reporting).
 */
import { z } from "zod";
import type { ClassificationModule, ClassificationWarning } from "../types";
import {
  ArithmeticDomainError,
  InvalidInputError,
  InconsistentInputError,
  MissingInputError,
  assertFiniteNumber,
  zodErrorToClassificationError,
} from "../errors";
import {
  interpolatePercentAtDiameter,
  type GranulometryPoint,
} from "@/lib/calc/modules/granulometry";

export const AASHTO_MODULE_ID = "aashto";
export const AASHTO_MODULE_VERSION = "1.0.0";
export const AASHTO_STANDARD = "AASHTO M 145";
export const AASHTO_STANDARD_VERSION = "M 145-91 (2004)";

// ---------------------------------------------------------------------------
// AASHTO M 145-91 definitional constants (cited verbatim, not invented)
// ---------------------------------------------------------------------------

/**
 * Standard sieve apertures (ASTM E11 / ISO 565). The literal definitions of
 * the AASHTO M 145 reference sieves:
 *   #10  = 2.00 mm   (coarse sand / fine gravel boundary)
 *   #40  = 0.425 mm  (coarse / fine sand boundary; the Atterberg -40 fraction)
 *   #200 = 0.075 mm  (coarse / fine-grained boundary, the fines sieve)
 */
const SIEVE_NO_10_MM = 2.0;
const SIEVE_NO_40_MM = 0.425;
const SIEVE_NO_200_MM = 0.075;

/** Granular / silt-clay boundary: 35 % passing #200. */
const GRANULAR_FINESS_MAX = 35;
const SILT_CLAY_FINESS_MIN = 36;

/** A-7-5 vs A-7-6 distinction threshold (the LL−30 rule). */
const A76_THRESHOLD_OFFSET = 30;

/** LL low/high plasticity boundary: LL = 40 (A-2-4/6 vs A-2-5/7, A-4/6 vs A-5/7). */
const LL_LOW_MAX = 40;
const LL_HIGH_MIN = 41;

/** PI low/high plasticity boundary: PI = 10 vs PI = 11. */
const PI_LOW_MAX = 10;
const PI_HIGH_MIN = 11;

/**
 * Group Index formula coefficients — verbatim from AASHTO M 145-91 §3:
 *   GI = (F−35)·[0.2 + 0.005·(LL−40)] + 0.01·(F−15)·(PI−10)
 */
const GI_F_INTERCEPT_LL = 35;
const GI_LL_INTERCEPT = 40;
const GI_LL_SLOPE = 0.005;
const GI_LL_BASE = 0.2;
const GI_F_INTERCEPT_PI = 15;
const GI_PI_INTERCEPT = 10;
const GI_PI_COEFFICIENT = 0.01;

/** Output-boundary rounding: sieve percentages 2 dp, partial GI terms 4 dp, GI whole. */
const PERCENT_DECIMALS = 2;
const GI_PARTIAL_DECIMALS = 4;

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

export const aashtoCalcInput = z.object({
  /** Ordered by strictly increasing diameterMm (module contract). */
  points: z.array(granulometryPointSchema).min(2).max(40),
  /** Optional Atterberg limits — required when PI ≥ 1 (plastic soil). */
  atterberg: atterbergSchema.optional(),
});

export interface AashtoAtterberg {
  liquidLimit: number;
  plasticLimit: number;
  plasticityIndex: number;
}

export interface AashtoInput {
  points: GranulometryPoint[];
  atterberg?: AashtoAtterberg;
}

// ---------------------------------------------------------------------------
// Full-precision internal values (raw)
// ---------------------------------------------------------------------------

export interface AashtoRaw {
  /** % passing the #10 sieve (2.00 mm). */
  percentPassingNo10: number;
  /** % passing the #40 sieve (0.425 mm). */
  percentPassingNo40: number;
  /** % passing the #200 sieve (0.075 mm). */
  percentPassingNo200: number;
  /** LL-term partial GI = (F−35)·[0.2 + 0.005·(LL−40)]; 0 if negative or NP. */
  giLlPartial: number;
  /** PI-term partial GI = 0.01·(F−15)·(PI−10); 0 if negative or NP. */
  giPiPartial: number;
  /** Final GI = giLlPartial + giPiPartial, floored at 0; null when NP. */
  groupIndex: number | null;
}

// ---------------------------------------------------------------------------
// Output-boundary results
// ---------------------------------------------------------------------------

export interface AashtoResults {
  /** Verbatim AASHTO group symbol (e.g. "A-7-6", "A-1-a", "A-4"). */
  group: string;
  /** Full AASHTO designation with GI appended (e.g. "A-7-6 (20)", "A-1-a (0)"). */
  designation: string;
  /** Verbatim AASHTO group description (e.g. "Clayey soils", "Stone fragments, gravel, and sand"). */
  groupName: string;
  /** Granular / silt-clay split as the standard defines it. */
  category: "GRANULAR" | "SILT_CLAY";
  /** % passing #10, #40, #200 (2 dp). */
  percentPassingNo10: number;
  percentPassingNo40: number;
  percentPassingNo200: number;
  /** Liquid limit and plasticity index (null when non-plastic). */
  liquidLimit: number | null;
  plasticityIndex: number | null;
  /** Group Index (whole number; 0 when NP or negative per the standard). */
  groupIndex: number;
  /** Partial GI terms (4 dp) — useful for engineering audit of the formula. */
  giLlPartial: number;
  giPiPartial: number;
  /** Reasoning steps — the standard clause invoked at each decision point. */
  reasoning: AashtoReasoningStep[];
}

export interface AashtoReasoningStep {
  /** Clause reference. */
  clause: string;
  /** What was decided at this step. */
  decision: string;
}

// ---------------------------------------------------------------------------
// Module implementation
// ---------------------------------------------------------------------------

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Compute the Group Index per AASHTO M 145-91 §3.
 *
 * The formula:
 *   GI = (F−35)·[0.2 + 0.005·(LL−40)] + 0.01·(F−15)·(PI−10)
 *
 * Partial-term flooring rule:
 *   - Compute the LL-term first; if negative, set to 0.
 *   - Compute the PI-term second; if negative, set to 0.
 *   - Sum and floor at 0; round to nearest whole number.
 *
 * For groups A-2-6 and A-2-7, the LL-term is forced to 0 (the standard
 * explicitly states "only the PI portion of the formula is used" for these
 * two subgroups). This is applied by the caller after the partials are
 * returned here; the helper computes the raw partials without that override.
 *
 * Non-plastic soils (no LL/PI): both partials are 0, GI = 0.
 */
export function computeGroupIndex(
  percentPassingNo200: number,
  liquidLimit: number | null,
  plasticityIndex: number | null,
): { giLlPartial: number; giPiPartial: number; groupIndex: number } {
  assertFiniteNumber("computeGroupIndex:F", percentPassingNo200);

  let giLlPartial = 0;
  let giPiPartial = 0;

  if (liquidLimit !== null) {
    const llTerm = (percentPassingNo200 - GI_F_INTERCEPT_LL) *
      (GI_LL_BASE + GI_LL_SLOPE * (liquidLimit - GI_LL_INTERCEPT));
    assertFiniteNumber("computeGroupIndex:llTerm", llTerm);
    giLlPartial = llTerm > 0 ? llTerm : 0;
  }

  if (plasticityIndex !== null) {
    const piTerm = GI_PI_COEFFICIENT *
      (percentPassingNo200 - GI_F_INTERCEPT_PI) *
      (plasticityIndex - GI_PI_INTERCEPT);
    assertFiniteNumber("computeGroupIndex:piTerm", piTerm);
    giPiPartial = piTerm > 0 ? piTerm : 0;
  }

  const sum = giLlPartial + giPiPartial;
  const groupIndex = sum > 0 ? Math.round(sum) : 0;
  return { giLlPartial, giPiPartial, groupIndex };
}

/**
 * AASHTO group description table (M 145-91 §2 — typical materials).
 *
 * Verbatim group descriptions from the standard's narrative.
 */
function groupNameFor(group: string): string {
  switch (group) {
    case "A-1-a": return "Stone fragments, gravel, and sand";
    case "A-1-b": return "Gravel and sand";
    case "A-3": return "Fine sand";
    case "A-2-4": return "Silty or clayey gravel and sand";
    case "A-2-5": return "Silty or clayey gravel and sand";
    case "A-2-6": return "Clayey gravel and sand";
    case "A-2-7": return "Clayey gravel and sand";
    case "A-4": return "Silty soils";
    case "A-5": return "Silty soils";
    case "A-6": return "Clayey soils";
    case "A-7-5": return "Clayey soils";
    case "A-7-6": return "Clayey soils";
    default: return "AASHTO soil";
  }
}

/**
 * Sequential group selection per AASHTO M 145-91 §4 (the standard's
 * "the soil is classified by trial of the groups in their order" rule).
 *
 * The order is: A-1-a → A-1-b → A-3 → A-2-4 → A-2-5 → A-2-6 → A-2-7 →
 *               A-4   → A-5   → A-6 → A-7-5 → A-7-6.
 *
 * Each group's criteria must be ALL satisfied for the soil to be assigned
 * to that group. The first matching group wins. The silt-clay groups
 * (A-4..A-7-6) require >35 % passing #200; the granular groups require ≤35 %.
 */
function selectAashtoGroup(
  pct10: number,
  pct40: number,
  pct200: number,
  ll: number | null,
  pi: number | null,
  reasoning: AashtoReasoningStep[],
): { group: string; category: "GRANULAR" | "SILT_CLAY" } {
  const isGranular = pct200 <= GRANULAR_FINESS_MAX;

  // The standard treats non-plastic (NP) soils specially for A-3:
  // A-3 requires PI = 0 (NP). If LL is undeterminable the soil is NP.
  const isNonPlastic = pi === null || ll === null;

  reasoning.push({
    clause: "M 145-91 §2 (granular/silt-clay split)",
    decision: `% passing #200 = ${roundTo(pct200, PERCENT_DECIMALS)} % ${isGranular ? "≤ 35 → granular material" : "> 35 → silt-clay material"}.`,
  });

  if (isGranular) {
    // A-1-a: %pass#10 ≤ 50, %pass#40 ≤ 30, %pass#200 ≤ 15, PI ≤ 6.
    if (pct10 <= 50 && pct40 <= 30 && pct200 <= 15 && (pi === null || pi <= 6)) {
      reasoning.push({
        clause: "M 145-91 §4 (A-1-a criteria)",
        decision: `%pass#10=${roundTo(pct10, PERCENT_DECIMALS)} ≤ 50; %pass#40=${roundTo(pct40, PERCENT_DECIMALS)} ≤ 30; %pass#200=${roundTo(pct200, PERCENT_DECIMALS)} ≤ 15; PI=${pi ?? "NP"} ≤ 6 → A-1-a.`,
      });
      return { group: "A-1-a", category: "GRANULAR" };
    }
    // A-1-b: %pass#10 ≤ 50, %pass#40 ≤ 50, %pass#200 ≤ 25, PI ≤ 6.
    if (pct10 <= 50 && pct40 <= 50 && pct200 <= 25 && (pi === null || pi <= 6)) {
      reasoning.push({
        clause: "M 145-91 §4 (A-1-b criteria)",
        decision: `%pass#10=${roundTo(pct10, PERCENT_DECIMALS)} ≤ 50; %pass#40=${roundTo(pct40, PERCENT_DECIMALS)} ≤ 50; %pass#200=${roundTo(pct200, PERCENT_DECIMALS)} ≤ 25; PI=${pi ?? "NP"} ≤ 6 → A-1-b.`,
      });
      return { group: "A-1-b", category: "GRANULAR" };
    }
    // A-3: %pass#40 ≥ 51, %pass#200 ≤ 10, NP (PI = 0).
    if (pct40 >= 51 && pct200 <= 10 && isNonPlastic) {
      reasoning.push({
        clause: "M 145-91 §4 (A-3 criteria)",
        decision: `%pass#40=${roundTo(pct40, PERCENT_DECIMALS)} ≥ 51; %pass#200=${roundTo(pct200, PERCENT_DECIMALS)} ≤ 10; PI=${pi ?? "NP"} (NP required) → A-3.`,
      });
      return { group: "A-3", category: "GRANULAR" };
    }
    // A-2-4: %pass#200 ≤ 35, LL ≤ 40, PI ≤ 10.
    if (ll !== null && pi !== null && ll <= LL_LOW_MAX && pi <= PI_LOW_MAX) {
      reasoning.push({
        clause: "M 145-91 §4 (A-2-4 criteria)",
        decision: `%pass#200=${roundTo(pct200, PERCENT_DECIMALS)} ≤ 35; LL=${ll} ≤ 40; PI=${pi} ≤ 10 → A-2-4.`,
      });
      return { group: "A-2-4", category: "GRANULAR" };
    }
    // A-2-5: %pass#200 ≤ 35, LL ≥ 41, PI ≤ 10.
    if (ll !== null && pi !== null && ll >= LL_HIGH_MIN && pi <= PI_LOW_MAX) {
      reasoning.push({
        clause: "M 145-91 §4 (A-2-5 criteria)",
        decision: `%pass#200=${roundTo(pct200, PERCENT_DECIMALS)} ≤ 35; LL=${ll} ≥ 41; PI=${pi} ≤ 10 → A-2-5.`,
      });
      return { group: "A-2-5", category: "GRANULAR" };
    }
    // A-2-6: %pass#200 ≤ 35, LL ≤ 40, PI ≥ 11.
    if (ll !== null && pi !== null && ll <= LL_LOW_MAX && pi >= PI_HIGH_MIN) {
      reasoning.push({
        clause: "M 145-91 §4 (A-2-6 criteria)",
        decision: `%pass#200=${roundTo(pct200, PERCENT_DECIMALS)} ≤ 35; LL=${ll} ≤ 40; PI=${pi} ≥ 11 → A-2-6.`,
      });
      return { group: "A-2-6", category: "GRANULAR" };
    }
    // A-2-7: %pass#200 ≤ 35, LL ≥ 41, PI ≥ 11.
    if (ll !== null && pi !== null && ll >= LL_HIGH_MIN && pi >= PI_HIGH_MIN) {
      reasoning.push({
        clause: "M 145-91 §4 (A-2-7 criteria)",
        decision: `%pass#200=${roundTo(pct200, PERCENT_DECIMALS)} ≤ 35; LL=${ll} ≥ 41; PI=${pi} ≥ 11 → A-2-7.`,
      });
      return { group: "A-2-7", category: "GRANULAR" };
    }
    // Fallback within granular: the soil satisfies none of A-1/A-3/A-2-* — this
    // is unreachable when the inputs are well-formed (a granular soil with PI
    // in any range and any LL matches one of A-2-4..A-2-7). Surface it as an
    // internal error rather than fabricating a group.
    throw new ArithmeticDomainError(
      "selectAashtoGroup",
      `Granular soil (%pass#200=${roundTo(pct200, PERCENT_DECIMALS)}, LL=${ll}, PI=${pi}) matched none of A-1-a/A-1-b/A-3/A-2-4..A-2-7 — the inputs are inconsistent or incomplete.`,
    );
  }

  // Silt-clay (>35 % passing #200)
  // A-4: LL ≤ 40, PI ≤ 10.
  if (ll !== null && pi !== null && ll <= LL_LOW_MAX && pi <= PI_LOW_MAX) {
    reasoning.push({
      clause: "M 145-91 §4 (A-4 criteria)",
      decision: `%pass#200=${roundTo(pct200, PERCENT_DECIMALS)} > 35; LL=${ll} ≤ 40; PI=${pi} ≤ 10 → A-4.`,
    });
    return { group: "A-4", category: "SILT_CLAY" };
  }
  // A-5: LL ≥ 41, PI ≤ 10.
  if (ll !== null && pi !== null && ll >= LL_HIGH_MIN && pi <= PI_LOW_MAX) {
    reasoning.push({
      clause: "M 145-91 §4 (A-5 criteria)",
      decision: `%pass#200=${roundTo(pct200, PERCENT_DECIMALS)} > 35; LL=${ll} ≥ 41; PI=${pi} ≤ 10 → A-5.`,
    });
    return { group: "A-5", category: "SILT_CLAY" };
  }
  // A-6: LL ≤ 40, PI ≥ 11.
  if (ll !== null && pi !== null && ll <= LL_LOW_MAX && pi >= PI_HIGH_MIN) {
    reasoning.push({
      clause: "M 145-91 §4 (A-6 criteria)",
      decision: `%pass#200=${roundTo(pct200, PERCENT_DECIMALS)} > 35; LL=${ll} ≤ 40; PI=${pi} ≥ 11 → A-6.`,
    });
    return { group: "A-6", category: "SILT_CLAY" };
  }
  // A-7-5 / A-7-6: LL ≥ 41, PI ≥ 11; distinguished by PI vs (LL−30).
  if (ll !== null && pi !== null && ll >= LL_HIGH_MIN && pi >= PI_HIGH_MIN) {
    const threshold = ll - A76_THRESHOLD_OFFSET;
    if (pi <= threshold) {
      reasoning.push({
        clause: "M 145-91 §4 (A-7-5 criteria)",
        decision: `%pass#200=${roundTo(pct200, PERCENT_DECIMALS)} > 35; LL=${ll} ≥ 41; PI=${pi} ≥ 11; PI=${pi} ≤ LL−30=${threshold} → A-7-5.`,
      });
      return { group: "A-7-5", category: "SILT_CLAY" };
    }
    reasoning.push({
      clause: "M 145-91 §4 (A-7-6 criteria)",
      decision: `%pass#200=${roundTo(pct200, PERCENT_DECIMALS)} > 35; LL=${ll} ≥ 41; PI=${pi} ≥ 11; PI=${pi} > LL−30=${threshold} → A-7-6.`,
    });
    return { group: "A-7-6", category: "SILT_CLAY" };
  }

  // Silt-clay soil that doesn't match A-4..A-7-6 — only reachable when LL or
  // PI is missing for a silt-clay soil. The standard requires Atterberg data
  // for silt-clay classification.
  throw new MissingInputError(
    "atterberg",
    `Silt-clay soil (%pass#200=${roundTo(pct200, PERCENT_DECIMALS)} > 35) requires Atterberg limits (LL and PI) for AASHTO M 145 classification. Received LL=${ll}, PI=${pi}.`,
  );
}

// ---------------------------------------------------------------------------
// Module registration
// ---------------------------------------------------------------------------

export const aashtoModule: ClassificationModule<AashtoInput, AashtoRaw, AashtoResults> = {
  id: AASHTO_MODULE_ID,
  sourceType: "SAMPLE",
  version: AASHTO_MODULE_VERSION,
  label: "AASHTO classification (M 145)",
  description:
    "Classifies soils and soil-aggregate mixtures per AASHTO M 145-91 (2004) for highway construction purposes. Derives % passing #10, #40, #200 from the PSD; applies the A-1 through A-7 group table; computes the Group Index per the standard's formula with the partial-term flooring rule.",
  standard: AASHTO_STANDARD,
  standardVersion: AASHTO_STANDARD_VERSION,

  validateInput(raw: unknown): AashtoInput {
    const parsed = aashtoCalcInput.safeParse(raw);
    if (!parsed.success) {
      throw zodErrorToClassificationError(parsed.error, raw);
    }
    const input = parsed.data;

    // Same ordering rule as the granulometry module (M5.2-b §4).
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
          `points[${i}].diameterMm (${curr.diameterMm}) must be greater than points[${i - 1}].diameterMm (${prev.diameterMm}).`,
        );
      }
    }
    for (let i = 1; i < input.points.length; i++) {
      if (input.points[i].percentFiner < input.points[i - 1].percentFiner - 0.01) {
        throw new InvalidInputError(
          `points[${i}].percentFiner`,
          `points[${i}].percentFiner (${input.points[i].percentFiner}) is more than 0.01 below points[${i - 1}].percentFiner (${input.points[i - 1].percentFiner}).`,
        );
      }
    }
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

  compute(input: AashtoInput) {
    // ---- Derive % passing #10, #40, #200 by log-linear interpolation ----
    const pct10 = interpolatePercentAtDiameter(input.points, SIEVE_NO_10_MM, "percentPassingNo10");
    const pct40 = interpolatePercentAtDiameter(input.points, SIEVE_NO_40_MM, "percentPassingNo40");
    const pct200 = interpolatePercentAtDiameter(input.points, SIEVE_NO_200_MM, "percentPassingNo200");

    if (pct10 === null || pct40 === null || pct200 === null) {
      const missing: string[] = [];
      if (pct10 === null) missing.push("#10 (2.00 mm)");
      if (pct40 === null) missing.push("#40 (0.425 mm)");
      if (pct200 === null) missing.push("#200 (0.075 mm)");
      throw new ArithmeticDomainError(
        "percentPassingSieves",
        `The measured PSD range does not cover the AASHTO reference sieves (${missing.join(", ")}); AASHTO M 145 cannot classify without them. Extend the sieve analysis to span 0.075 mm to 2.00 mm.`,
      );
    }

    // ---- Atterberg: extract LL and PI (null when non-plastic) ----
    const ll = input.atterberg?.liquidLimit ?? null;
    const pi = input.atterberg?.plasticityIndex ?? null;

    // ---- Group selection ----
    const reasoning: AashtoReasoningStep[] = [];
    const { group, category } = selectAashtoGroup(pct10, pct40, pct200, ll, pi, reasoning);

    // ---- Group Index ----
    // Compute partials (with the partial-term flooring rule applied inside
    // computeGroupIndex). For groups A-2-6 and A-2-7, only the PI-term is
    // used (the standard's explicit override).
    const baseGi = computeGroupIndex(pct200, ll, pi);
    let giLlPartial = baseGi.giLlPartial;
    let giPiPartial = baseGi.giPiPartial;
    if (group === "A-2-6" || group === "A-2-7") {
      giLlPartial = 0;
    }
    const giSum = giLlPartial + giPiPartial;
    const groupIndex = giSum > 0 ? Math.round(giSum) : 0;

    reasoning.push({
      clause: "M 145-91 §3 (Group Index)",
      decision:
        `LL-partial = (F−35)·[0.2 + 0.005·(LL−40)] = ${roundTo(giLlPartial, GI_PARTIAL_DECIMALS)}${group === "A-2-6" || group === "A-2-7" ? " (forced to 0 — A-2-6/A-2-7 use only the PI-term per M 145-91 §3)" : ""}; ` +
        `PI-partial = 0.01·(F−15)·(PI−10) = ${roundTo(giPiPartial, GI_PARTIAL_DECIMALS)}; ` +
        `GI = ${groupIndex}.`,
    });

    const designation = `${group} (${groupIndex})`;
    const groupName = groupNameFor(group);

    const rawValues: AashtoRaw = {
      percentPassingNo10: pct10,
      percentPassingNo40: pct40,
      percentPassingNo200: pct200,
      giLlPartial,
      giPiPartial,
      groupIndex: groupIndex === 0 ? null : groupIndex,
    };

    const results: AashtoResults = {
      group,
      designation,
      groupName,
      category,
      percentPassingNo10: roundTo(pct10, PERCENT_DECIMALS),
      percentPassingNo40: roundTo(pct40, PERCENT_DECIMALS),
      percentPassingNo200: roundTo(pct200, PERCENT_DECIMALS),
      liquidLimit: ll,
      plasticityIndex: pi,
      groupIndex,
      giLlPartial: roundTo(giLlPartial, GI_PARTIAL_DECIMALS),
      giPiPartial: roundTo(giPiPartial, GI_PARTIAL_DECIMALS),
      reasoning,
    };

    const warnings: ClassificationWarning[] = [];
    if (ll === null || pi === null) {
      warnings.push({
        code: "INSUFFICIENT_DATA",
        message:
          `Atterberg limits were not provided (NP soil). AASHTO M 145 treats such soils as non-plastic ` +
          `(GI = 0). Classification as A-3 is permitted for NP granular soils; silt-clay classification ` +
          `requires LL and PI. Provide Atterberg data if the soil is suspected to be plastic.`,
        details: {
          liquidLimit: ll,
          plasticityIndex: pi,
        },
      });
    }

    return { raw: rawValues, results, warnings };
  },
};
