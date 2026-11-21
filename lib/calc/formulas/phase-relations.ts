/**
 * GEODATA HUB — Soil phase-relation formulas (M5.2-a).
 *
 * Every function here is a DEFINITIONAL relation of the three-phase soil model
 * (solids / water / voids), derivable from the phase diagram:
 *   w  = W_w / W_s,  e = V_v / V_s,  n = V_v / V,  Sr = V_w / V_v,
 * and the identity e·Sr = w·Gs (w as a fraction).
 *
 * No standard-specific constant or procedure is involved (D8-safe). Results
 * are NOT clamped to plausibility ranges: domain violations throw
 * ArithmeticDomainError, while computable-but-out-of-range values (e.g.
 * Sr > 100 %, w > 100 %) are returned as-is for the caller to interpret
 * (docs/14 §4.9).
 */
import { ArithmeticDomainError, assertFiniteNumber } from "../errors";

/**
 * Mass of pore water from tare-included gross masses (M5.1 F2 semantics):
 *   m_w = (tare + wet soil) − (tare + dry soil)
 * Requires both masses non-negative with wet ≥ dry (negative water mass is
 * physically impossible).
 */
export function waterMassFromTareMasses(wetTotalMassG: number, dryTotalMassG: number): number {
  assertFiniteNumber("waterMassFromTareMasses", wetTotalMassG);
  assertFiniteNumber("waterMassFromTareMasses", dryTotalMassG);
  if (wetTotalMassG < 0 || dryTotalMassG < 0) {
    throw new ArithmeticDomainError(
      "waterMassFromTareMasses",
      `Masses must be non-negative (received wet ${wetTotalMassG} g, dry ${dryTotalMassG} g).`,
    );
  }
  if (wetTotalMassG < dryTotalMassG) {
    throw new ArithmeticDomainError(
      "waterMassFromTareMasses",
      `Wet total mass (${wetTotalMassG} g) is below dry total mass (${dryTotalMassG} g) — the water mass would be negative.`,
    );
  }
  return wetTotalMassG - dryTotalMassG;
}

/**
 * Mass of dry soil solids from tare-included gross mass (M5.1 F2 semantics):
 *   m_s = (tare + dry soil) − tare
 * Requires dry total ≥ tare, both non-negative.
 */
export function drySoilMassFromTareMasses(dryTotalMassG: number, containerMassG: number): number {
  assertFiniteNumber("drySoilMassFromTareMasses", dryTotalMassG);
  assertFiniteNumber("drySoilMassFromTareMasses", containerMassG);
  if (dryTotalMassG < 0 || containerMassG < 0) {
    throw new ArithmeticDomainError(
      "drySoilMassFromTareMasses",
      `Masses must be non-negative (received dry ${dryTotalMassG} g, tare ${containerMassG} g).`,
    );
  }
  if (dryTotalMassG < containerMassG) {
    throw new ArithmeticDomainError(
      "drySoilMassFromTareMasses",
      `Dry total mass (${dryTotalMassG} g) is below the tare (${containerMassG} g) — the dry solids mass would be negative.`,
    );
  }
  return dryTotalMassG - containerMassG;
}

/**
 * Gravimetric water content in percent (definitional):
 *   w (%) = 100 × m_w / m_s
 * Requires m_w ≥ 0 and m_s > 0 (division by zero is an error, never a clamp).
 */
export function waterContentPercent(waterMassG: number, drySoilMassG: number): number {
  assertFiniteNumber("waterContentPercent", waterMassG);
  assertFiniteNumber("waterContentPercent", drySoilMassG);
  if (waterMassG < 0) {
    throw new ArithmeticDomainError(
      "waterContentPercent",
      `Water mass must be non-negative (received ${waterMassG} g).`,
    );
  }
  if (drySoilMassG <= 0) {
    throw new ArithmeticDomainError(
      "waterContentPercent",
      `Dry soil mass must be strictly positive (received ${drySoilMassG} g).`,
    );
  }
  return (100 * waterMassG) / drySoilMassG;
}

/** Porosity from void ratio: n = e / (1 + e). Requires e ≥ 0. */
export function porosityFromVoidRatio(voidRatio: number): number {
  assertFiniteNumber("porosityFromVoidRatio", voidRatio);
  if (voidRatio < 0) {
    throw new ArithmeticDomainError(
      "porosityFromVoidRatio",
      `Void ratio must be non-negative (received ${voidRatio}).`,
    );
  }
  return voidRatio / (1 + voidRatio);
}

/** Void ratio from porosity: e = n / (1 − n). Requires 0 ≤ n < 1. */
export function voidRatioFromPorosity(porosity: number): number {
  assertFiniteNumber("voidRatioFromPorosity", porosity);
  if (porosity < 0 || porosity >= 1) {
    throw new ArithmeticDomainError(
      "voidRatioFromPorosity",
      `Porosity must lie in [0, 1) (received ${porosity}).`,
    );
  }
  return porosity / (1 - porosity);
}

/**
 * Degree of saturation in percent, from e·Sr = w·Gs with w as a fraction:
 *   Sr (%) = w(%) × Gs / e
 * Requires e > 0, w(%) ≥ 0, Gs > 0. The result is intentionally NOT clamped
 * to 100 %: Sr > 100 % signals a physically inconsistent (e, w, Gs) triple
 * and is reported for the caller to interpret.
 */
export function degreeOfSaturationPercent(
  voidRatio: number,
  waterContentPercent: number,
  specificGravity: number,
): number {
  assertFiniteNumber("degreeOfSaturationPercent", voidRatio);
  assertFiniteNumber("degreeOfSaturationPercent", waterContentPercent);
  assertFiniteNumber("degreeOfSaturationPercent", specificGravity);
  if (voidRatio <= 0) {
    throw new ArithmeticDomainError(
      "degreeOfSaturationPercent",
      `Void ratio must be strictly positive (received ${voidRatio}).`,
    );
  }
  if (waterContentPercent < 0) {
    throw new ArithmeticDomainError(
      "degreeOfSaturationPercent",
      `Water content must be non-negative (received ${waterContentPercent} %).`,
    );
  }
  if (specificGravity <= 0) {
    throw new ArithmeticDomainError(
      "degreeOfSaturationPercent",
      `Specific gravity must be strictly positive (received ${specificGravity}).`,
    );
  }
  return (waterContentPercent * specificGravity) / voidRatio;
}
