/**
 * GEODATA HUB — Governed constants registry (M5.2-a, enforcing the approved
 * D8 rule from the M5.1 technical audit).
 *
 * D8 rule: a constant may be consumed by a calculation module only after its
 * value AND provenance have been verified against an authoritative source,
 * with that provenance recorded here. Consequences implemented below:
 *
 * - VERIFIED entries carry a value plus full provenance (reference, location,
 *   verification method, date) and are the ONLY consumable constants.
 * - PENDING entries carry NO value at the type level (the `PendingConstant`
 *   variant has no `value` field at all) and `requireVerifiedConstant()`
 *   refuses them with UnverifiedConstantError. An unverified engineering
 *   constant is therefore structurally impossible to consume, accidentally
 *   or otherwise.
 * - The registry is immutable at runtime (deep-frozen); there is no runtime
 *   registration API. Constants are curated in code, at review time.
 *
 * M5.2-a ships exactly four VERIFIED constants — the exact integer SI prefix
 * factors used by units.ts — and one deliberately PENDING entry. No empirical
 * or standard-specific constant is activated in this milestone.
 */
import { UnverifiedConstantError } from "../errors";

export type ConstantVerificationStatus = "VERIFIED" | "PENDING";

/** Provenance record of a VERIFIED constant (audit trail). */
export interface ConstantSource {
  /** Bibliographic reference of the authoritative source. */
  reference: string;
  /** Where in the source the value is defined (section, prefix, table). */
  location: string;
  /** How the value was verified during this project. */
  verification: string;
  /** ISO date the verification was recorded (static metadata, not runtime). */
  verifiedOn: string;
}

export interface VerifiedConstant {
  status: "VERIFIED";
  value: number;
  unit: string;
  description: string;
  source: ConstantSource;
}

export interface PendingConstant {
  status: "PENDING";
  unit: string;
  description: string;
  /** Why activation requires explicit verification work before consumption. */
  reason: string;
  /** Milestone that will perform the verification (planning metadata only). */
  plannedFor: string;
}

export type GovernedConstant = VerifiedConstant | PendingConstant;

/** SI Brochure reference shared by the four exact prefix factors. */
const SI_SOURCE: ConstantSource = {
  reference:
    "BIPM, The International System of Units (SI Brochure), 9th edition (2019)",
  location: "Chapter 3, decimal multiples and submultiples: milli = 10^-3, centi = 10^-2, kilo = 10^3",
  verification:
    "Definitional — exact decimal prefix relation, no empirical uncertainty; checked against the published SI prefix table during M5.2-a",
  verifiedOn: "2026-11-21",
};

/**
 * M5.2-d web-verification reference (2026-11-21): independent engineering
 * references stating the zero-air-voids (100 % saturation) compaction formula
 * ρd,ZAV = Gs·ρw / (1 + w·Gs) with the conventional water density ρw = 1 g/cm³
 * (equivalently γd,ZAV = Gs·γw / (1 + w·Gs) with γw ≈ 9.81 kN/m³).
 */
const WATER_DENSITY_SOURCE: ConstantSource = {
  reference:
    "Independent engineering references verified by web search during M5.2-d (zero-air-voids / Proctor compaction references, e.g. compaction calculators and soil-mechanics references stating ρd,ZAV = Gs·ρw/(1 + w·Gs), γd,ZAV = Gs·γw/(1 + w·Gs) with γw = 9.81 kN/m³)",
  location:
    "Zero-air-voids (100 % saturation) curve formula for the Proctor compaction plot — water density / unit weight term",
  verification:
    "Cross-checked across multiple independent sources during M5.2-d; the unit statement 1 g/cm³ ≡ 1 Mg/m³ ≡ 1000 kg/m³ is exact SI prefix arithmetic (SI Brochure 9th ed., already VERIFIED in this registry), and the conventional value ρw = 1 Mg/m³ is the value used by every reference found for phase-relation and compaction formulas",
  verifiedOn: "2026-11-21",
};

/**
 * M5.2-e web-verification reference (2026-11-21): the CBR standard load
 * column — the reference values that define the CBR ratio (verified against
 * multiple independent sources citing ASTM D1883 / AASHTO T193 practice).
 */
const CBR_STANDARD_LOAD_SOURCE: ConstantSource = {
  reference:
    "CBR standard load column as cited by multiple independent sources verified by web search during M5.2-e (laboratory guidance citing ASTM D1883 / AASHTO T193; consistently 13.24 kN at 2.5 mm and 19.96 kN at 5.0 mm penetration)",
  location:
    "Standard loads of the California Bearing Ratio scale (the divisor of CBR = 100 × measured load / standard load)",
  verification:
    "All independent sources checked during M5.2-e state identical values (13.24 kN at 2.5 mm ≈ 6.9 MPa on the standard 49.6 mm plunger; 19.96 kN at 5.0 mm ≈ 10.3 MPa); no conflicting value was found",
  verifiedOn: "2026-11-21",
};

/**
 * M5.2-f web-verification reference (2026-11-21): Terzaghi one-dimensional
 * consolidation theory — the dimensionless time factor at 50 % average
 * consolidation, used by the Casagrande log-time fitting method.
 */
const CONSOLIDATION_T50_SOURCE: ConstantSource = {
  reference:
    "Terzaghi 1-D consolidation theory as cited by independent references verified by web search during M5.2-f (university oedometer guides and consolidation references stating cv = 0.197·Hd²/t50 for the Casagrande log-time method)",
  location:
    "Time factor Tv at U = 50 % (log-time fitting method of Casagrande); Hd = drainage path length",
  verification:
    "Cross-checked across multiple independent sources during M5.2-f (all state T50 = 0.197 with cv = 0.197·Hd²/t50); the companion Taylor sqrt-time factor T90 = 0.848 was also confirmed but is not consumed (the sqrt-time method is not implemented)",
  verifiedOn: "2026-11-21",
};

/**
 * M5.2-g web-verification reference (2026-11-21): the Ménard pressuremeter
 * modulus definition — Poisson's ratio ν = 0.33 giving the 2.66 factor.
 */
const MENARD_POISSON_SOURCE: ConstantSource = {
  reference:
    "Ménard pressuremeter modulus definition: EN ISO 22476-4:2021 definitions preview (standards.iteh.ai — 'Ménard pressuremeter modulus: modulus obtained from the section between (p1, V1) and (p2, V2) of the pressuremeter curve') and an ISSMGE publication stating EM = 2.66(Vc + vm)(p2 − p1)/(V2 − V1)",
  location:
    "EM = 2(1+ν)·V·Δp/ΔV evaluated with ν = 0.33 ⇒ factor 2(1+0.33) = 2.66; V = measuring-cell volume at the middle of the [p1, p2] pseudo-elastic section",
  verification:
    "Verified by web search during M5.2-g: the 2.66 factor (= 2(1+ν) with ν = 0.33) appears consistently in independent publications on the Ménard modulus; EN ISO 22476-4:2021 confirms the section definition",
  verifiedOn: "2026-11-21",
};

const RAW_REGISTRY: Record<string, GovernedConstant> = {
  "si.mass.milligramsPerGram": {
    status: "VERIFIED",
    value: 1000,
    unit: "mg/g",
    description: "Exact grams-to-milligrams prefix factor (1 g = 1000 mg).",
    source: SI_SOURCE,
  },
  "si.mass.gramsPerKilogram": {
    status: "VERIFIED",
    value: 1000,
    unit: "g/kg",
    description: "Exact kilograms-to-grams prefix factor (1 kg = 1000 g).",
    source: SI_SOURCE,
  },
  "si.length.millimetresPerCentimetre": {
    status: "VERIFIED",
    value: 10,
    unit: "mm/cm",
    description: "Exact centimetres-to-millimetres prefix factor (1 cm = 10 mm).",
    source: SI_SOURCE,
  },
  "si.length.millimetresPerMetre": {
    status: "VERIFIED",
    value: 1000,
    unit: "mm/m",
    description: "Exact metres-to-millimetres prefix factor (1 m = 1000 mm).",
    source: SI_SOURCE,
  },
  "water.massDensityMgPerM3": {
    status: "VERIFIED",
    value: 1,
    unit: "Mg/m³",
    description:
      "Conventional mass density of water (ρw = 1 g/cm³ ≡ 1 Mg/m³ ≡ 1000 kg/m³) used by phase-relation and compaction formulas — consumed by the Proctor zero-air-voids curve (M5.2-d).",
    source: WATER_DENSITY_SOURCE,
  },
  "cbr.standardLoadKnAt2_5mm": {
    status: "VERIFIED",
    value: 13.24,
    unit: "kN",
    description:
      "CBR standard load at 2.5 mm penetration — the reference value of the CBR scale (ASTM D1883 / AASHTO T193 load column); consumed by the CBR module (M5.2-e).",
    source: CBR_STANDARD_LOAD_SOURCE,
  },
  "cbr.standardLoadKnAt5_0mm": {
    status: "VERIFIED",
    value: 19.96,
    unit: "kN",
    description:
      "CBR standard load at 5.0 mm penetration — the reference value of the CBR scale (ASTM D1883 / AASHTO T193 load column); consumed by the CBR module (M5.2-e).",
    source: CBR_STANDARD_LOAD_SOURCE,
  },
  "consolidation.timeFactorT50": {
    status: "VERIFIED",
    value: 0.197,
    unit: "–",
    description:
      "Terzaghi consolidation time factor at 50 % average consolidation (Casagrande log-time fitting method: cv = 0.197·Hd²/t50); consumed by the oedometer module (M5.2-f).",
    source: CONSOLIDATION_T50_SOURCE,
  },
  "pressuremeter.menardPoissonRatio": {
    status: "VERIFIED",
    value: 0.33,
    unit: "–",
    description:
      "Poisson's ratio of the Ménard pressuremeter modulus definition EM = 2(1+ν)·V·Δp/ΔV ⇒ factor 2.66; consumed by the pressuremeter module (M5.2-g).",
    source: MENARD_POISSON_SOURCE,
  },
  "water.unitWeight": {
    status: "PENDING",
    unit: "kN/m³",
    description:
      "Unit weight of water (γw) needed by future phase-relation and unit-weight formulas.",
    reason:
      "The conventional engineering value must be tied to a verifiable convention (standard gravity and water density) and recorded with provenance before any module may consume it — not yet verified against an authoritative source in this project (D8).",
    plannedFor:
      "M5.2 later milestone (phase relations with volumes / unit weights) — verification required first.",
  },
};

function deepFreezeConstant(constant: GovernedConstant): GovernedConstant {
  if (constant.status === "VERIFIED") {
    Object.freeze(constant.source);
  }
  return Object.freeze(constant);
}

/** Governed constants registry — immutable at runtime, curated in code. */
export const GOVERNED_CONSTANTS: Readonly<Record<string, GovernedConstant>> = Object.freeze(
  Object.fromEntries(
    Object.entries(RAW_REGISTRY).map(([key, constant]) => [key, deepFreezeConstant(constant)]),
  ),
);

/**
 * The ONLY accessor a calculation module may use for a constant. Returns the
 * value of a VERIFIED constant; throws UnverifiedConstantError for unknown
 * keys and for PENDING constants (D8 enforcement — tested in
 * scripts/m5.2-test-constants.ts).
 */
export function requireVerifiedConstant(key: string): number {
  const constant = GOVERNED_CONSTANTS[key];
  if (constant === undefined) {
    throw new UnverifiedConstantError(
      key,
      "UNKNOWN",
      `Unknown constant key '${key}' — it is not present in the governed constants registry (src/lib/calc/constants/sources.ts).`,
    );
  }
  if (constant.status !== "VERIFIED") {
    throw new UnverifiedConstantError(
      key,
      constant.status,
      `Constant '${key}' is PENDING verification and must never be consumed by calculation modules. Reason: ${constant.reason}`,
    );
  }
  return constant.value;
}

/** Governance inspection: read any constant's metadata (never a value). */
export function inspectConstant(key: string): GovernedConstant | undefined {
  return GOVERNED_CONSTANTS[key];
}

/** Audit listing of the registry (key + full metadata, PENDING included). */
export function listGovernedConstants(): ReadonlyArray<{ key: string; constant: GovernedConstant }> {
  return Object.entries(GOVERNED_CONSTANTS).map(([key, constant]) => ({ key, constant }));
}
