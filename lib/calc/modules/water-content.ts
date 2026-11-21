/**
 * GEODATA HUB — Water content calculation module (M5.2-a, first module).
 *
 * Serves registry test type WATER_CONTENT (standard citations verified in
 * M5.1: ASTM D2216 / NF P94-050). The module implements ONLY the definitional
 * mass-ratio arithmetic of the three-phase model — no standard-specific
 * procedure and no standard-specific constant is involved (D8-safe).
 *
 * INPUT CONTRACT (M5.1 compatibility — docs/14 §5):
 * The measured numbers of the M5.1 water-content contract live in the RESULT
 * payload (`LabTest.resultData`, registry `waterContentResult`), not in
 * `inputData` (which holds only test parameters: containerId,
 * ovenTemperatureC, notes). This module consumes the MASS-COMPLETE subset of
 * that result payload:
 *
 *   waterContentPercent  laboratory-entered gravimetric water content, 0–300 %
 *   wetMassG             tare + wet soil (gross mass at removal), 0 < m ≤ 8000 g
 *   dryMassG             tare + dry soil (gross mass after oven drying), 0 < m ≤ 8000 g
 *   containerMassG       tare (empty container), 0 < m ≤ 2000 g
 *
 * Bounds mirror the registry schema exactly. Records without a complete mass
 * triple (e.g. seed `{ waterContentPercent: 22.4 }`) are valid M5.1 storage
 * but NOT calculable: the module rejects them with MISSING_INPUT and never
 * invents masses.
 *
 * FORMULA (definitional, phase diagram — M5.1 F2 tare semantics):
 *   w (%) = 100 × (wetMassG − dryMassG) / (dryMassG − containerMassG)
 *   water mass     m_w = wetMassG − dryMassG
 *   dry solids     m_s = dryMassG − containerMassG
 *
 * ENTERED-VALUE COMPARISON:
 * The computed w is compared with the entered waterContentPercent. A
 * discrepancy beyond ±0.5 percentage points — the M5.1 write-time consistency
 * tolerance (registry WATER_CONTENT validationNotes; docs/13 §4 and §9: an
 * engineering tolerance for 0.1 g mass bookkeeping) — produces an
 * ENTERED_VALUE_DISCREPANCY WARNING. The entered value is echoed unchanged
 * and NEVER overwritten. Note the intentional layer difference (docs/14 §5):
 * the M5.1 result schema REJECTS beyond-tolerance payloads at write time,
 * while this module ACCEPTS them and reports the discrepancy explicitly —
 * the engine computes and warns, the registry gates.
 *
 * PRECISION:
 * `raw` keeps full double precision; rounding is applied ONLY at this output
 * boundary: percentages 2 dp, masses 3 dp. Computed values are never clamped
 * (a computed w above 300 % is reported as-is; only the ENTERED value is
 * bounded by the M5.1 storage contract).
 */
import { z } from "zod";
import type { CalculationModule, CalculationWarning } from "../types";
import { InvalidInputError, zodErrorToCalculationError } from "../errors";
import { roundTo } from "../units";
import {
  drySoilMassFromTareMasses,
  waterContentPercent as waterContentPercentFromMasses,
  waterMassFromTareMasses,
} from "../formulas/phase-relations";

export const WATER_CONTENT_MODULE_ID = "water-content";
export const WATER_CONTENT_MODULE_VERSION = "1.0.0";

/**
 * Entered-value consistency tolerance in percentage points. Provenance: M5.1
 * decision F2 (registry WATER_CONTENT validationNotes; docs/13 §4/§9) — an
 * engineering tolerance for 0.1 g mass bookkeeping, not a standard-verified
 * constant (docs/14 §9 R1).
 */
export const WATER_CONTENT_ENTERED_TOLERANCE_PERCENT = 0.5;

/** Output boundary: percentages rounded to 2 dp, masses to 3 dp. */
const PERCENT_DECIMALS = 2;
const MASS_DECIMALS = 3;

/**
 * Input schema — the mass-complete subset of the registry `waterContentResult`
 * contract (bounds identical). Exported so the M5.1 compatibility tests can
 * assert parity against the registry schema behaviorally.
 * Unknown keys are stripped (Zod default, same as the registry schemas).
 */
export const waterContentCalcInput = z.object({
  waterContentPercent: z.number().min(0).max(300),
  wetMassG: z.number().positive().max(8000),
  dryMassG: z.number().positive().max(8000),
  containerMassG: z.number().positive().max(2000),
});

export interface WaterContentInput {
  waterContentPercent: number;
  wetMassG: number;
  dryMassG: number;
  containerMassG: number;
}

/** Full-precision internal values (never rounded, never clamped). */
export interface WaterContentRaw {
  /** m_w = wetMassG − dryMassG [g] */
  waterMassG: number;
  /** m_s = dryMassG − containerMassG [g] */
  drySoilMassG: number;
  /** computed w = 100 × m_w / m_s [%] */
  waterContentPercent: number;
}

/** Output-boundary results (rounded; entered value echoed unchanged). */
export interface WaterContentResults {
  /** computed gravimetric water content, 2 dp [%] */
  waterContentPercent: number;
  /** mass of pore water, 3 dp [g] */
  waterMassG: number;
  /** mass of dry soil solids, 3 dp [g] */
  drySoilMassG: number;
  /** laboratory-entered value, echoed unchanged (never overwritten) [%] */
  enteredWaterContentPercent: number;
  /** computed − entered, 2 dp [percentage points] */
  discrepancyPercent: number;
}

export const waterContentModule: CalculationModule<
  WaterContentInput,
  WaterContentRaw,
  WaterContentResults
> = {
  id: WATER_CONTENT_MODULE_ID,
  testType: "WATER_CONTENT",
  version: WATER_CONTENT_MODULE_VERSION,
  label: "Water content (oven drying, mass bookkeeping)",
  description:
    "Computes gravimetric water content, water mass and dry-soil mass from tare-included gross masses (M5.1 F2 semantics), compares against the laboratory-entered percentage and warns on discrepancies beyond the ±0.5 pp tolerance.",

  validateInput(raw: unknown): WaterContentInput {
    const parsed = waterContentCalcInput.safeParse(raw);
    if (!parsed.success) {
      throw zodErrorToCalculationError(parsed.error, raw);
    }
    const input = parsed.data;
    // Physical ordering rules — mirror of the registry superRefine checks.
    if (input.wetMassG <= input.dryMassG) {
      throw new InvalidInputError(
        "wetMassG",
        `wetMassG (${input.wetMassG} g) must be greater than dryMassG (${input.dryMassG} g) — the water mass would be negative (M5.1 semantics: both masses include the tare).`,
      );
    }
    if (input.dryMassG <= input.containerMassG) {
      throw new InvalidInputError(
        "dryMassG",
        `dryMassG (${input.dryMassG} g) must exceed containerMassG (${input.containerMassG} g) — dryMassG is tare + dry solids (M5.1 semantics).`,
      );
    }
    return input;
  },

  compute(input: WaterContentInput) {
    const waterMassG = waterMassFromTareMasses(input.wetMassG, input.dryMassG);
    const drySoilMassG = drySoilMassFromTareMasses(input.dryMassG, input.containerMassG);
    const computedWaterContentPercent = waterContentPercentFromMasses(waterMassG, drySoilMassG);
    const discrepancyPercent = computedWaterContentPercent - input.waterContentPercent;

    const warnings: CalculationWarning[] = [];
    if (Math.abs(discrepancyPercent) > WATER_CONTENT_ENTERED_TOLERANCE_PERCENT) {
      warnings.push({
        code: "ENTERED_VALUE_DISCREPANCY",
        message:
          `Computed water content ${roundTo(computedWaterContentPercent, PERCENT_DECIMALS)} % deviates by ` +
          `${roundTo(discrepancyPercent, PERCENT_DECIMALS)} percentage points from the entered ` +
          `${input.waterContentPercent} % (tolerance ±${WATER_CONTENT_ENTERED_TOLERANCE_PERCENT}).`,
        details: {
          enteredWaterContentPercent: input.waterContentPercent,
          computedWaterContentPercent: roundTo(computedWaterContentPercent, 4),
          discrepancyPercent: roundTo(discrepancyPercent, 4),
          tolerancePercent: WATER_CONTENT_ENTERED_TOLERANCE_PERCENT,
        },
      });
    }

    return {
      raw: {
        waterMassG,
        drySoilMassG,
        waterContentPercent: computedWaterContentPercent,
      },
      results: {
        waterContentPercent: roundTo(computedWaterContentPercent, PERCENT_DECIMALS),
        waterMassG: roundTo(waterMassG, MASS_DECIMALS),
        drySoilMassG: roundTo(drySoilMassG, MASS_DECIMALS),
        enteredWaterContentPercent: input.waterContentPercent,
        discrepancyPercent: roundTo(discrepancyPercent, PERCENT_DECIMALS),
      },
      warnings,
    };
  },
};
