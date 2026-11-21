/**
 * GEODATA HUB — Explicit unit conversions and deterministic output rounding
 * (M5.2-a).
 *
 * Design rules (docs/14 §4.8 / §4.7):
 *
 * 1. NO HIDDEN CONVERSIONS. Calculation modules declare their working unit in
 *    their field names (e.g. `wetMassG`) and call these functions explicitly;
 *    nothing converts silently.
 * 2. Every conversion factor is an exact integer (SI prefix definition)
 *    obtained from the governed constants registry (D8) — nothing empirical,
 *    nothing standard-specific.
 * 3. `roundTo` is the ONLY rounding facility and is applied ONLY at output
 *    boundaries; `raw` values inside modules keep full double precision.
 */
import { requireVerifiedConstant } from "./constants/sources";
import { ArithmeticDomainError, UnitConversionError, assertFiniteNumber } from "./errors";

export type MassUnit = "mg" | "g" | "kg";
export type LengthUnit = "mm" | "cm" | "m";

export interface UnitDefinition {
  symbol: string;
  /** Exact integer number of base units (mg for mass, mm for length) per unit. */
  factorToBase: number;
  /** Provenance note for governance audits. */
  source: string;
}

const SI_PREFIX_SOURCE = "SI prefix definition (exact) — governed constant, see constants/sources.ts";

/** Mass table, base unit: milligram. Factors sourced from D8-verified constants. */
export const MASS_UNITS: Readonly<Record<MassUnit, UnitDefinition>> = Object.freeze({
  mg: { symbol: "mg", factorToBase: 1, source: "base unit of the mass table" },
  g: {
    symbol: "g",
    factorToBase: requireVerifiedConstant("si.mass.milligramsPerGram"),
    source: SI_PREFIX_SOURCE,
  },
  kg: {
    symbol: "kg",
    factorToBase:
      requireVerifiedConstant("si.mass.milligramsPerGram") *
      requireVerifiedConstant("si.mass.gramsPerKilogram"),
    source: SI_PREFIX_SOURCE,
  },
});

/** Length table, base unit: millimetre. Factors sourced from D8-verified constants. */
export const LENGTH_UNITS: Readonly<Record<LengthUnit, UnitDefinition>> = Object.freeze({
  mm: { symbol: "mm", factorToBase: 1, source: "base unit of the length table" },
  cm: {
    symbol: "cm",
    factorToBase: requireVerifiedConstant("si.length.millimetresPerCentimetre"),
    source: SI_PREFIX_SOURCE,
  },
  m: {
    symbol: "m",
    factorToBase: requireVerifiedConstant("si.length.millimetresPerMetre"),
    source: SI_PREFIX_SOURCE,
  },
});

function assertConvertible<TUnit extends string>(
  quantity: string,
  value: number,
  from: TUnit,
  to: TUnit,
  table: Readonly<Record<string, UnitDefinition>>,
): void {
  if (!Number.isFinite(value)) {
    throw new UnitConversionError(
      `Cannot convert ${quantity}: value must be a finite number (received ${String(value)}).`,
    );
  }
  if (!(from in table)) {
    throw new UnitConversionError(`Unknown ${quantity} unit '${String(from)}' (from).`);
  }
  if (!(to in table)) {
    throw new UnitConversionError(`Unknown ${quantity} unit '${String(to)}' (to).`);
  }
}

/** Convert a mass between mg / g / kg (exact integer factors, no rounding). */
export function convertMass(value: number, from: MassUnit, to: MassUnit): number {
  assertConvertible("mass", value, from, to, MASS_UNITS);
  return (value * MASS_UNITS[from].factorToBase) / MASS_UNITS[to].factorToBase;
}

/** Convert a length between mm / cm / m (exact integer factors, no rounding). */
export function convertLength(value: number, from: LengthUnit, to: LengthUnit): number {
  assertConvertible("length", value, from, to, LENGTH_UNITS);
  return (value * LENGTH_UNITS[from].factorToBase) / LENGTH_UNITS[to].factorToBase;
}

/**
 * Deterministic decimal rounding for OUTPUT BOUNDARIES ONLY.
 *
 * Convention: round half AWAY FROM ZERO at the requested decimal, using a
 * relative-epsilon correction first, so that values whose binary
 * representation sits marginally below a decimal .5 tie (2.675 → 267.49999…)
 * still round according to their human (decimal) value. Guards:
 * - value must be finite, decimals must be an integer in [0, 12];
 * - |value × 10^decimals| must stay inside the safe integer range.
 * Negative zero is normalized to 0. Fully specified and golden-tested in
 * scripts/m5.2-test-units.ts — any behavior change there is deliberate.
 */
export function roundTo(value: number, decimals: number): number {
  assertFiniteNumber("roundTo", value);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) {
    throw new ArithmeticDomainError(
      "roundTo",
      `decimals must be an integer between 0 and 12 (received ${String(decimals)}).`,
    );
  }
  const factor = 10 ** decimals;
  const scaled = value * factor;
  if (Math.abs(scaled) > Number.MAX_SAFE_INTEGER) {
    throw new ArithmeticDomainError(
      "roundTo",
      `Rounding ${String(value)} at ${decimals} decimals leaves the safe integer range.`,
    );
  }
  const correctedAbs = Math.abs(scaled) * (1 + Number.EPSILON);
  const rounded = Math.round(correctedAbs);
  const signed = scaled < 0 ? -rounded : rounded;
  const result = signed / factor;
  return result === 0 ? 0 : result;
}
