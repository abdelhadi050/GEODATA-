/**
 * GEODATA HUB — Atterberg limits calculation module (M5.2-c).
 *
 * Serves registry test type ATTERBERG_LIMITS (standard citations verified in
 * M5.1: ASTM D4318 / NF P94-051 — both Casagrande-cup based). The module
 * implements ONLY the authorized M5.2-c scope:
 *
 *   - Liquid limit (LL) from the Casagrande multipoint flow curve:
 *     the flow curve is the least-squares straight line of water content w
 *     against x = log10(N) over the measured (blows, w) points — the
 *     deterministic realization of the standards' "best straight line through
 *     the plotted points" (pure regression, no standard-specific constant);
 *         slope     = Sxy / Sxx,  intercept = mean(w) − slope · mean(x)
 *         LL        = intercept + slope · log10(25)
 *     25 blows/drops is DEFINITIONAL: both ASTM D4318 and NF P94-051 define
 *     the liquid limit as the water content at 25 blows (a definitional
 *     target value, same class as the M5.2-b percentile targets — NOT an
 *     empirical constant; the module consumes ZERO governed constants).
 *   - Plastic limit (PL): the representative value is the arithmetic mean of
 *     the trial water contents (definitional statistic, reusing
 *     calc/formulas/statistics). NO standard-specific trial-agreement
 *     tolerance is enforced (that would require verified standard text,
 *     D8); trial consistency is REPORTED (sample standard deviation and
 *     range), never gated.
 *   - Plasticity index: IP = LL − PL.
 *   - Explicit non-plastic handling: `nonPlastic: true` (thread-rolling test
 *     yielded no plastic limit) → PL and IP are null (reported as NP), LL is
 *     still computed when flow points exist. Contradictory input (trials or
 *     entered PL/IP alongside nonPlastic) is rejected, never reconciled.
 *
 * EXPLICITLY OUT OF SCOPE (M5.2-c authorization): cone penetrometer LL
 * computation (see below), the D4318 one-point method (its correlation factor
 * is a standard-specific constant — D8-blocked), liquidity index / consistency
 * index / activity (not in the authorized scope; their natural-water-content
 * and fines-fraction inputs are not part of this contract), shrinkage limit,
 * plasticity-chart classification, soil descriptions.
 *
 * METHOD GATE — no silent mixing (authorization §2): the input `method` is
 * honored strictly. The registry's adopted standards for this test type
 * (ASTM D4318 / NF P94-051) cover the Casagrande cup method only; the cone
 * penetrometer liquid-limit definition (e.g. NF P94-052) is NOT part of the
 * project's verified standards, so method = CONE_PENETROMETER is legal
 * REGISTRY STORAGE but NOT calculable here: the module rejects it with
 * INVALID_INPUT before interpreting any data — it never reinterprets
 * cone-style payloads as Casagrande flow points.
 *
 * INPUT CONTRACT: the registry `atterbergResult` payload carries only the
 * laboratory-entered finals (liquidLimit, plasticLimit, plasticityIndex,
 * shrinkageLimit?, liquidityIndex?, uscsSymbol?) — it has NO slot for the raw
 * flow-curve points or PL trials. This module therefore consumes an
 * ENGINE-SIDE contract (the granulometry pattern, extended): `method` (mirror
 * of the registry atterbergInput enum), `liquidLimitPoints` (3–10 points;
 * blows a positive integer ≤ 200; waterContentPercent 0–300 — the project's
 * water-content storage bound), `plasticLimitTrials` (1–6 values, 0–300,
 * required unless nonPlastic), `nonPlastic`, and the optional entered finals
 * under their registry field names with registry bounds (liquidLimit 10–150,
 * plasticLimit 5–100, plasticityIndex 0–100). Unknown keys — including the
 * registry's shrinkageLimit / liquidityIndex / uscsSymbol — are stripped
 * (Zod default, same as the registry schemas).
 *
 * SEMANTIC RULES (mirrors of the M5.1 `atterbergResult` superRefine, plus
 * the module's own physical-consistency rules):
 *   - entered plasticLimit must be lower than entered liquidLimit when both
 *     are present (registry rule);
 *   - entered plasticityIndex must equal entered liquidLimit − entered
 *     plasticLimit within ±1 when all three are present (registry identity,
 *     same expression and tolerance as the registry);
 *   - ≥ 2 DISTINCT blow counts are required (a flow line needs blow-count
 *     spread; all-identical blows make the regression undefined);
 *   - the flow-curve slope must be NEGATIVE: water content decreases as blow
 *     count increases (drier soil needs more blows) — a flat or rising fit is
 *     physically impossible data, not a rounding artifact;
 *   - 25 blows must lie within the measured blow-count range — extrapolation
 *     beyond the measured range is rejected (M5.2-b policy), never performed;
 *   - computed plasticLimit must be lower than computed liquidLimit
 *     (the registry's ordering rule applied to the computed values);
 *   - nonPlastic must not be combined with trials or entered PL/IP
 *     (contradictory input is rejected, never reconciled).
 *
 * FLOW CURVE vs INTERPOLATION (documented contrast with M5.2-b): the flow
 * curve is a global FIT through all points, not a point-to-point
 * interpolation — even a measured point at exactly 25 blows does not override
 * the fitted line (the standard reads LL off the flow curve). Duplicate blow
 * counts are therefore legitimate replicate determinations and are kept; the
 * fit handles the scatter. This differs from the granulometry exact-hit rule
 * because the physics differs: PSD percentile diameters are read between
 * adjacent sieve points, the LL is read off a fitted line.
 *
 * ENTERED-VALUE COMPARISON: computed LL / PL / IP are compared with the
 * optional laboratory-entered finals; a discrepancy beyond ±1.0 produces an
 * ENTERED_VALUE_DISCREPANCY WARNING (entered values echoed unchanged, never
 * overwritten). Provenance of the tolerance: the M5.1 registry identity
 * tolerance for this test type is ±1 ("plasticityIndex must equal
 * liquidLimit − plasticLimit (±1)", registry ATTERBERG_LIMITS
 * validationNotes); M5.2-c reuses the same magnitude for computed-vs-entered
 * comparisons. It is a project engineering tolerance, not a standard-verified
 * constant (same class as the water-content ±0.5 and granulometry ±0.05,
 * docs/14 §9 R1).
 *
 * PRECISION: `raw` keeps full double precision; rounding happens only at
 * this output boundary — percentages (LL, PL, IP, trial statistics) 2 dp,
 * flow-curve parameters (slope, intercept) 4 dp. Computed values are never
 * clamped: a computed PL below the registry storage minimum of 5 % (or an LL
 * above 150 %) is reported as-is — the engine computes and advises, the
 * registry gates at write time (docs/14 §5).
 */
import { z } from "zod";
import type {
  CalculationIssueSummary,
  CalculationModule,
  CalculationWarning,
} from "../types";
import {
  ArithmeticDomainError,
  InvalidInputError,
  MissingInputError,
  assertFiniteNumber,
  zodErrorToCalculationError,
} from "../errors";
import { roundTo } from "../units";
import { mean, sampleStandardDeviation } from "../formulas/statistics";

export const ATTERBERG_LIMITS_MODULE_ID = "atterberg-limits";
export const ATTERBERG_LIMITS_MODULE_VERSION = "1.0.0";

/**
 * Entered-value comparison tolerance (absolute, percentage points), for LL,
 * PL and IP alike. Provenance: registry ATTERBERG_LIMITS identity tolerance
 * ±1 (M5.1); reused for computed-vs-entered checks in M5.2-c — a project
 * engineering tolerance, not standard-verified.
 */
export const ATTERBERG_ENTERED_TOLERANCE = 1.0;

/**
 * Blow count at which the Casagrande liquid limit is defined (ASTM D4318 /
 * NF P94-051: the water content at 25 blows/drops). Definitional target
 * value named by the M5.2-c authorization — not an empirical constant.
 */
export const LIQUID_LIMIT_BLOWS_TARGET = 25;

/** Output boundary: percentages 2 dp, flow-curve parameters 4 dp. */
const PERCENT_DECIMALS = 2;
const CURVE_DECIMALS = 4;
const WARNING_DETAIL_DECIMALS = 4;

/**
 * Contract bounds (module decisions, documented): flow points 3–10 (a
 * multipoint flow curve; the D4318 one-point method is D8-blocked), blow
 * counts integer 1–200, water contents 0–300 % (the project's water-content
 * storage bound), PL trials 1–6.
 */
const MIN_FLOW_POINTS = 3;
const MAX_FLOW_POINTS = 10;
const MAX_BLOWS = 200;
const MIN_TRIALS = 1;
const MAX_TRIALS = 6;

/** One measured Casagrande flow-curve point. */
export interface AtterbergFlowPoint {
  /** number of blows/drops to groove closure, positive integer ≤ 200 */
  blows: number;
  /** measured water content of that trial, 0–300 [%] */
  waterContentPercent: number;
}

/**
 * Input schema — engine-side contract (the registry result payload has no
 * slot for raw flow points or PL trials; entered finals carry their registry
 * field names and bounds). Exported so compatibility tests can assert
 * behavioral parity against the registry schemas. Unknown keys are stripped
 * (Zod default, same as the registry schemas).
 */
export const atterbergLimitsCalcInput = z.object({
  method: z.enum(["CASAGRANDE_CUP", "CONE_PENETROMETER"]),
  liquidLimitPoints: z
    .array(
      z.object({
        blows: z.number().int().min(1).max(MAX_BLOWS),
        waterContentPercent: z.number().min(0).max(300),
      }),
    )
    .min(MIN_FLOW_POINTS)
    .max(MAX_FLOW_POINTS),
  plasticLimitTrials: z.array(z.number().min(0).max(300)).min(MIN_TRIALS).max(MAX_TRIALS).optional(),
  nonPlastic: z.boolean().optional(),
  liquidLimit: z.number().min(10).max(150).optional(),
  plasticLimit: z.number().min(5).max(100).optional(),
  plasticityIndex: z.number().min(0).max(100).optional(),
});

export interface AtterbergLimitsInput {
  method: "CASAGRANDE_CUP" | "CONE_PENETROMETER";
  liquidLimitPoints: AtterbergFlowPoint[];
  plasticLimitTrials?: number[] | undefined;
  nonPlastic?: boolean | undefined;
  liquidLimit?: number | undefined;
  plasticLimit?: number | undefined;
  plasticityIndex?: number | undefined;
}

/** Full-precision internal values (never rounded, never clamped). */
export interface AtterbergLimitsRaw {
  /** flow-curve slope dw/dlog10(N) — negative (physical rule enforced) */
  flowCurveSlope: number;
  /** flow-curve intercept: w at log10(N) = 0 (N = 1 blow) */
  flowCurveIntercept: number;
  /** LL = intercept + slope × log10(25) [%] */
  liquidLimit: number;
  /** PL = mean of trial water contents; null when non-plastic (NP) */
  plasticLimit: number | null;
  /** IP = LL − PL; null when non-plastic (NP) */
  plasticityIndex: number | null;
  /** sample standard deviation of the trials; null when n < 2 or NP */
  plasticLimitTrialStdDev: number | null;
  /** max − min of the trials (0 for a single trial); null when NP */
  plasticLimitTrialRange: number | null;
}

/** Output-boundary results (rounded; entered values echoed unchanged). */
export interface AtterbergLimitsResults {
  /** computed liquid limit at 25 blows, 2 dp [%] (registry result field name) */
  liquidLimit: number;
  /** flow-curve slope dw/dlog10(N), 4 dp (negative) */
  flowCurveSlope: number;
  /** flow-curve intercept, 4 dp */
  flowCurveIntercept: number;
  /** computed plastic limit, 2 dp [%]; null when non-plastic (NP) */
  plasticLimit: number | null;
  /** computed plasticity index, 2 dp; null when non-plastic (NP) */
  plasticityIndex: number | null;
  /** explicit non-plastic flag from the input */
  nonPlastic: boolean;
  /** number of PL trials (0 when non-plastic) */
  plasticLimitTrialCount: number;
  /** sample std dev of the trials, 2 dp; null when n < 2 or NP */
  plasticLimitTrialStdDev: number | null;
  /** range of the trials, 2 dp; null when NP */
  plasticLimitTrialRange: number | null;
  /** laboratory-entered finals, echoed unchanged (null when absent) */
  enteredLiquidLimit: number | null;
  enteredPlasticLimit: number | null;
  enteredPlasticityIndex: number | null;
}

// ---------------------------------------------------------------------------
// Flow-curve helpers (exported for direct unit testing)
// ---------------------------------------------------------------------------

/**
 * Least-squares flow curve: water content against x = log10(blows).
 *
 * PRECONDITION: `points` validated by the module contract (≥ 3 points, blows
 * positive integers). Requires ≥ 2 DISTINCT blow counts — with all blows
 * identical the regression is undefined (zero spread in x) and is rejected
 * with ARITHMETIC_DOMAIN_ERROR. (Distinct integers in [1, 200] always have
 * distinct, well-separated log10 doubles — minimum gap log10(200/199) ≈
 * 2.2e-3 — so Sxx > 0 is guaranteed once the distinct-count check passes;
 * sums of non-negative squared deviations cannot cancel to zero.)
 */
export function fitFlowCurve(
  points: ReadonlyArray<AtterbergFlowPoint>,
): { slope: number; intercept: number } {
  const distinctBlows = new Set(points.map((p) => p.blows));
  if (distinctBlows.size < 2) {
    throw new ArithmeticDomainError(
      "fitFlowCurve",
      `At least 2 distinct blow counts are required to fit the flow curve ` +
        `(all ${points.length} points share blows = ${points[0]?.blows}) — the regression is undefined.`,
    );
  }
  const xs = points.map((p) => Math.log10(p.blows));
  const ys = points.map((p) => p.waterContentPercent);
  const xMean = mean(xs);
  const yMean = mean(ys);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - xMean;
    const dy = ys[i] - yMean;
    sxy += dx * dy;
    sxx += dx * dx;
  }
  const slope = sxy / sxx;
  const intercept = yMean - slope * xMean;
  assertFiniteNumber("fitFlowCurve.slope", slope);
  assertFiniteNumber("fitFlowCurve.intercept", intercept);
  return { slope, intercept };
}

/**
 * Water content predicted by the flow curve at a given blow count:
 * w(N) = intercept + slope × log10(N). PRECONDITION: slope/intercept from
 * fitFlowCurve; blows a positive integer.
 */
export function waterContentAtBlows(slope: number, intercept: number, blows: number): number {
  const w = intercept + slope * Math.log10(blows);
  assertFiniteNumber("waterContentAtBlows", w);
  return w;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

/** Entered-comparison descriptors: fixed iteration order (determinism). */
const ENTERED_COMPARISONS: ReadonlyArray<{ field: string }> = [
  { field: "liquidLimit" },
  { field: "plasticLimit" },
  { field: "plasticityIndex" },
] as const;

function enteredValue(input: AtterbergLimitsInput, field: string): number | undefined {
  switch (field) {
    case "liquidLimit": return input.liquidLimit;
    case "plasticLimit": return input.plasticLimit;
    case "plasticityIndex": return input.plasticityIndex;
    default: return undefined;
  }
}

function computedValue(raw: AtterbergLimitsRaw, field: string): number | null {
  switch (field) {
    case "liquidLimit": return raw.liquidLimit;
    case "plasticLimit": return raw.plasticLimit;
    case "plasticityIndex": return raw.plasticityIndex;
    default:
      throw new ArithmeticDomainError("computedValue", `Unknown computed field '${field}'.`);
  }
}

export const atterbergLimitsModule: CalculationModule<
  AtterbergLimitsInput,
  AtterbergLimitsRaw,
  AtterbergLimitsResults
> = {
  id: ATTERBERG_LIMITS_MODULE_ID,
  testType: "ATTERBERG_LIMITS",
  version: ATTERBERG_LIMITS_MODULE_VERSION,
  label: "Atterberg limits (Casagrande flow curve: LL, PL, IP)",
  description:
    "Computes the liquid limit at 25 blows from the least-squares Casagrande flow curve (water content vs log10 blow count), the representative plastic limit as the mean of the thread-rolling trial water contents (with sample spread statistics, no invented tolerance), and the plasticity index IP = LL − PL; handles non-plastic soils explicitly and cross-checks laboratory-entered finals, warning on discrepancies beyond ±1 without overwriting them. Cone penetrometer data is rejected (unsupported method), never reinterpreted.",

  validateInput(raw: unknown): AtterbergLimitsInput {
    // Method gate — BEFORE any schema interpretation (authorization §2: no
    // silent mixing of Casagrande and cone penetrometer methods). The gate
    // fires on the payload's declared method alone, whatever the rest of the
    // payload looks like.
    if (
      raw !== null && typeof raw === "object" &&
      (raw as { method?: unknown }).method === "CONE_PENETROMETER"
    ) {
      throw new InvalidInputError(
        "method",
        `method CONE_PENETROMETER is not calculable by this module: the project's adopted standards ` +
          `for ATTERBERG_LIMITS (ASTM D4318 / NF P94-051, registry citation) define the Casagrande cup ` +
          `method only; the cone penetrometer liquid-limit definition is not a verified standard here ` +
          `(D8) and the payload is never reinterpreted as Casagrande flow data.`,
      );
    }

    // Absent required-field aggregation. Zod v4 reports an ABSENT enum field
    // with issue code "invalid_value" (not "invalid_type"), so the shared
    // zodErrorToCalculationError helper would list only liquidLimitPoints as
    // missing for a payload like {} (this is the first module schema with an
    // enum field). Mirror the helper's missing-field classification here so
    // every absent required field is reported at once.
    if (raw !== null && typeof raw === "object") {
      const record = raw as Record<string, unknown>;
      const missing: CalculationIssueSummary[] = [];
      if (record.method === undefined) {
        missing.push({
          path: "method",
          code: "missing",
          message: "method is required (CASAGRANDE_CUP or CONE_PENETROMETER).",
        });
      }
      if (record.liquidLimitPoints === undefined) {
        missing.push({
          path: "liquidLimitPoints",
          code: "missing",
          message: "liquidLimitPoints is required (the Casagrande flow-curve measurements).",
        });
      }
      if (missing.length > 0) {
        throw new MissingInputError(
          `Missing required input field(s): ${missing.map((issue) => issue.path).join(", ")}`,
          missing,
        );
      }
    }

    const parsed = atterbergLimitsCalcInput.safeParse(raw);
    if (!parsed.success) {
      throw zodErrorToCalculationError(parsed.error, raw);
    }
    const input = parsed.data;

    // Non-plastic consistency — a non-plastic soil cannot carry PL trials or
    // entered PL/IP (contradictory input is rejected, never reconciled).
    if (input.nonPlastic === true) {
      if (input.plasticLimitTrials !== undefined) {
        throw new InvalidInputError(
          "plasticLimitTrials",
          `plasticLimitTrials (${input.plasticLimitTrials.length} values) cannot be combined with ` +
            `nonPlastic: true — a non-plastic soil has no thread-rolling results.`,
        );
      }
      if (input.plasticLimit !== undefined) {
        throw new InvalidInputError(
          "plasticLimit",
          `plasticLimit (${input.plasticLimit}) cannot be combined with nonPlastic: true — ` +
            `a non-plastic soil has no plastic limit.`,
        );
      }
      if (input.plasticityIndex !== undefined) {
        throw new InvalidInputError(
          "plasticityIndex",
          `plasticityIndex (${input.plasticityIndex}) cannot be combined with nonPlastic: true — ` +
            `a non-plastic soil has no plasticity index.`,
        );
      }
    } else if (input.plasticLimitTrials === undefined) {
      // Plastic soil (the default): the representative PL needs at least one
      // trial measurement — the module never invents one.
      throw new MissingInputError(
        `Missing required input field(s): plasticLimitTrials`,
        [
          {
            path: "plasticLimitTrials",
            code: "missing",
            message:
              `plasticLimitTrials is required for a plastic soil (set nonPlastic: true when the ` +
              `thread-rolling test yields no plastic limit).`,
          },
        ],
      );
    }

    // Semantic rule — entered PL must be lower than entered LL (registry
    // mirror: "plasticLimit must be lower than liquidLimit").
    if (input.liquidLimit !== undefined && input.plasticLimit !== undefined && input.plasticLimit >= input.liquidLimit) {
      throw new InvalidInputError(
        "plasticLimit",
        `plasticLimit (${input.plasticLimit}) must be lower than liquidLimit (${input.liquidLimit}) ` +
          `(M5.1 contract: plasticLimit must be lower than liquidLimit).`,
      );
    }

    // Semantic rule — entered PI identity (registry mirror, ±1, same
    // expression as the registry superRefine).
    if (
      input.liquidLimit !== undefined && input.plasticLimit !== undefined &&
      input.plasticityIndex !== undefined
    ) {
      const expected = input.liquidLimit - input.plasticLimit;
      if (Math.abs(input.plasticityIndex - expected) > 1.0) {
        throw new InvalidInputError(
          "plasticityIndex",
          `plasticityIndex must equal liquidLimit - plasticLimit (entered ${input.plasticityIndex} vs ` +
            `${input.liquidLimit} - ${input.plasticLimit} = ${expected}; tolerance ±1, M5.1 contract).`,
        );
      }
    }

    return input;
  },

  compute(input: AtterbergLimitsInput) {
    // 1. Flow curve (least-squares fit of w on log10(N)).
    const { slope, intercept } = fitFlowCurve(input.liquidLimitPoints);

    // 2. Physical rule — the flow curve must fall: water content decreases as
    //    blow count increases (drier soil requires more blows). A flat or
    //    rising fit is physically impossible measured data.
    if (slope >= 0) {
      throw new InvalidInputError(
        "liquidLimitPoints",
        `The fitted flow curve is not falling (slope ${slope} ≥ 0 per log10 blow cycle) — water content ` +
          `must decrease as blow count increases; the measured points are physically inconsistent.`,
      );
    }

    // 3. No extrapolation — 25 blows must lie within the measured blow range
    //    (M5.2-b policy: never extrapolate beyond the measured range).
    let minBlows = input.liquidLimitPoints[0].blows;
    let maxBlows = input.liquidLimitPoints[0].blows;
    for (const p of input.liquidLimitPoints) {
      if (p.blows < minBlows) minBlows = p.blows;
      if (p.blows > maxBlows) maxBlows = p.blows;
    }
    if (LIQUID_LIMIT_BLOWS_TARGET < minBlows || LIQUID_LIMIT_BLOWS_TARGET > maxBlows) {
      throw new ArithmeticDomainError(
        "liquidLimitAt25Blows",
        `The liquid limit requires ${LIQUID_LIMIT_BLOWS_TARGET} blows, but the measured blow-count range is ` +
          `[${minBlows}, ${maxBlows}] — the target lies outside the measured range and extrapolation ` +
          `is not performed.`,
      );
    }

    // 4. Liquid limit — read off the fitted flow curve (NOT off any single
    //    measured point, even one at exactly 25 blows).
    const liquidLimit = waterContentAtBlows(slope, intercept, LIQUID_LIMIT_BLOWS_TARGET);

    // 5. Plastic limit — representative value = arithmetic mean of the trials
    //    (definitional statistic; consistency is reported, never gated — a
    //    standard trial-agreement tolerance would be D8-blocked).
    const nonPlastic = input.nonPlastic === true;
    const trials = nonPlastic ? [] : (input.plasticLimitTrials ?? []);
    const plasticLimit = nonPlastic ? null : mean(trials);
    const plasticLimitTrialStdDev =
      !nonPlastic && trials.length >= 2 ? sampleStandardDeviation(trials) : null;
    const plasticLimitTrialRange = nonPlastic
      ? null
      : Math.max(...trials) - Math.min(...trials);

    // 6. Physical rule on the computed values — the registry's ordering rule
    //    applied to computed PL vs computed LL (a measured PL at or above the
    //    LL is physically impossible for a plastic soil).
    if (plasticLimit !== null && plasticLimit >= liquidLimit) {
      throw new InvalidInputError(
        "plasticLimitTrials",
        `Computed plastic limit (${plasticLimit}) is not lower than computed liquid limit ` +
          `(${liquidLimit}) — the trial water contents are inconsistent with the flow curve ` +
          `(M5.1 contract: plasticLimit must be lower than liquidLimit).`,
      );
    }

    // 7. Plasticity index — a single subtraction at full precision.
    const plasticityIndex = plasticLimit === null ? null : liquidLimit - plasticLimit;

    const raw: AtterbergLimitsRaw = {
      flowCurveSlope: slope,
      flowCurveIntercept: intercept,
      liquidLimit,
      plasticLimit,
      plasticityIndex,
      plasticLimitTrialStdDev,
      plasticLimitTrialRange,
    };

    // 8. Entered-value comparisons — fixed order, warnings never overwrite.
    const warnings: CalculationWarning[] = [];
    for (const { field } of ENTERED_COMPARISONS) {
      const entered = enteredValue(input, field);
      if (entered === undefined) continue;
      const computed = computedValue(raw, field);
      if (computed === null) continue; // NP: no PL/IP to compare
      const discrepancy = computed - entered;
      if (Math.abs(discrepancy) > ATTERBERG_ENTERED_TOLERANCE) {
        warnings.push({
          code: "ENTERED_VALUE_DISCREPANCY",
          message:
            `Computed ${field} ${roundTo(computed, PERCENT_DECIMALS)} % deviates by ` +
            `${roundTo(discrepancy, PERCENT_DECIMALS)} percentage points from the entered ` +
            `${entered} % (tolerance ±${ATTERBERG_ENTERED_TOLERANCE}).`,
          details: {
            field,
            enteredValue: entered,
            computedValue: roundTo(computed, WARNING_DETAIL_DECIMALS),
            discrepancy: roundTo(discrepancy, WARNING_DETAIL_DECIMALS),
            tolerance: ATTERBERG_ENTERED_TOLERANCE,
          },
        });
      }
    }

    const results: AtterbergLimitsResults = {
      liquidLimit: roundTo(liquidLimit, PERCENT_DECIMALS),
      flowCurveSlope: roundTo(slope, CURVE_DECIMALS),
      flowCurveIntercept: roundTo(intercept, CURVE_DECIMALS),
      plasticLimit: plasticLimit === null ? null : roundTo(plasticLimit, PERCENT_DECIMALS),
      plasticityIndex: plasticityIndex === null ? null : roundTo(plasticityIndex, PERCENT_DECIMALS),
      nonPlastic,
      plasticLimitTrialCount: trials.length,
      plasticLimitTrialStdDev:
        plasticLimitTrialStdDev === null ? null : roundTo(plasticLimitTrialStdDev, PERCENT_DECIMALS),
      plasticLimitTrialRange:
        plasticLimitTrialRange === null ? null : roundTo(plasticLimitTrialRange, PERCENT_DECIMALS),
      enteredLiquidLimit: input.liquidLimit ?? null,
      enteredPlasticLimit: input.plasticLimit ?? null,
      enteredPlasticityIndex: input.plasticityIndex ?? null,
    };

    return { raw, results, warnings };
  },
};
