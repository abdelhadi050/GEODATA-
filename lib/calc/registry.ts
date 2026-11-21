/**
 * GEODATA HUB — Calculation engine registry (M5.2 Integration).
 *
 * Single source of truth for every registered calculation module. The
 * integration layer (calculation service, Calculate API, invalidation) resolves
 * engines EXCLUSIVELY through this registry — never by importing individual
 * modules — so no registered engine can be omitted from the API surface.
 *
 * Layering rule (docs/14 §3, unchanged): this file lives in `calc/` and
 * imports ONLY from `calc/` — the engine layer stays independent of the
 * lab-test registry, services, database and UI. The `testType` strings are
 * plain strings by design (engine independence); their correspondence with the
 * M5.1 lab-test registry codes is proven by the compatibility tests of
 * M5.2-a..g, not by a runtime coupling.
 *
 * Registered modules (8): water-content, granulometry, atterberg-limits,
 * proctor, cbr, oedometer, direct-shear, pressuremeter — one per calculable
 * lab-test type. The remaining registry test types (SPT, CPT, UCS, TRIAXIAL,
 * SPECIFIC_GRAVITY) have no calculation engine by design; the service layer
 * rejects them with UNSUPPORTED_CALCULATION_ENGINE.
 */
import type { CalculationModule } from "./types";
import { CALCULATION_ENGINE_VERSION } from "./engine";
import { waterContentModule } from "./modules/water-content";
import { granulometryModule } from "./modules/granulometry";
import { atterbergLimitsModule } from "./modules/atterberg-limits";
import { proctorModule } from "./modules/proctor";
import { cbrModule } from "./modules/cbr";
import { oedometerModule } from "./modules/oedometer";
import { directShearModule } from "./modules/direct-shear";
import { pressuremeterModule } from "./modules/pressuremeter";

/**
 * A calculation module with its generic parameters erased to the JSON-level
 * contract the integration layer consumes: `validateInput` accepts the raw
 * payload, `compute` returns JSON-serializable raw/results. Method-signature
 * bivariance makes every concrete module assignable to this type.
 */
export type RegisteredCalculationModule = CalculationModule<unknown, unknown, unknown>;

/** All registered calculation modules (order = registry order, stable). */
export const CALC_MODULES: readonly RegisteredCalculationModule[] = [
  waterContentModule,
  granulometryModule,
  atterbergLimitsModule,
  proctorModule,
  cbrModule,
  oedometerModule,
  directShearModule,
  pressuremeterModule,
] as unknown as readonly RegisteredCalculationModule[];

const MODULES_BY_ID = new Map<string, RegisteredCalculationModule>(
  CALC_MODULES.map((m) => [m.id, m]),
);

const MODULES_BY_TEST_TYPE = new Map<string, RegisteredCalculationModule>(
  CALC_MODULES.map((m) => [m.testType, m]),
);

/** Resolve a module by its id (e.g. "proctor"). Null when unregistered. */
export function getCalcModuleById(moduleId: string): RegisteredCalculationModule | null {
  return MODULES_BY_ID.get(moduleId) ?? null;
}

/**
 * Resolve the module serving a lab-test type code (e.g. "PROCTOR").
 * Null when the test type has no calculation engine (SPT, CPT, UCS,
 * TRIAXIAL, SPECIFIC_GRAVITY — no engine exists by design).
 */
export function getCalcModuleForTestType(testType: string): RegisteredCalculationModule | null {
  return MODULES_BY_TEST_TYPE.get(testType) ?? null;
}

/** Engine listing for the discovery endpoint (no module references leaked). */
export function listCalcModules(): Array<{
  moduleId: string;
  testType: string;
  label: string;
  description: string;
  moduleVersion: string;
  engineVersion: string;
}> {
  return CALC_MODULES.map((m) => ({
    moduleId: m.id,
    testType: m.testType,
    label: m.label,
    description: m.description,
    moduleVersion: m.version,
    engineVersion: CALCULATION_ENGINE_VERSION,
  }));
}

/**
 * Extract the module-reported calculation method from a successful `results`
 * payload, for provenance metadata on persisted records. Pure, best-effort:
 * returns null when the module reports no method selection. The extraction map
 * is deliberately explicit per module (calc-layer knowledge stays here).
 */
export function describeCalculationMethod(
  moduleId: string,
  results: unknown,
): string | null {
  if (results === null || typeof results !== "object") return null;
  const r = results as Record<string, unknown>;
  switch (moduleId) {
    case "proctor":
      // results.method: "STANDARD" | "MODIFIED"
      return typeof r.method === "string" ? `${r.method} effort` : null;
    case "cbr":
      // results.condition + origin-correction flag
      if (typeof r.condition !== "string") return null;
      return r.originCorrectionApplied === true
        ? `${r.condition}, origin-corrected`
        : r.condition;
    case "oedometer": {
      // σ′p interpretation method (CASAGRANDE) + Cv method when computed
      const parts: string[] = [];
      if (r.preConsolidationMethod === "CASAGRANDE") parts.push("Casagrande σ′p");
      if (typeof r.cvMm2PerMin === "number") {
        parts.push("Casagrande log-time Cv");
      }
      return parts.length > 0 ? parts.join(" · ") : null;
    }
    case "direct-shear":
      // drainage condition echo (documentation of test conditions)
      return typeof r.drainageCondition === "string" ? r.drainageCondition : null;
    case "pressuremeter":
      return "Ménard (uncorrected measured curve)";
    default:
      // water-content, granulometry, atterberg-limits: definitional arithmetic,
      // no method selection exists.
      return null;
  }
}

/**
 * Adapt a stored lab-test result payload (registry field names) to the input
 * contract of a calculation module, for the modules whose engine-side contract
 * RENAMED registry fields. This is a pure, documented FIELD-NAME mapping —
 * never a semantic transformation (no reordering, no sorting, no invention:
 * modules that reject unordered or incomplete data must keep rejecting them).
 *
 * Current mapping (the only one — M5.2-f contract table, docs/18 §10):
 *   oedometer: registry result `stages` (the loading branch — the registry
 *   has no unloading storage) → engine input `loadingStages`.
 *
 * All other modules consume registry field names verbatim and pass through
 * unchanged. Returns null payloads unchanged. Only RESULT_DATA-sourced
 * payloads are adapted; explicit analyst payloads already speak the engine
 * contract.
 */
export function adaptResultDataForModule(moduleId: string, resultData: unknown): unknown {
  if (resultData === null || typeof resultData !== "object" || Array.isArray(resultData)) {
    return resultData;
  }
  switch (moduleId) {
    case "oedometer": {
      const source = resultData as Record<string, unknown>;
      // Adapt only when the registry shape is present and the engine shape is
      // not already supplied (explicit callers use engine names directly).
      if (Array.isArray(source.stages) && source.loadingStages === undefined) {
        const adapted: Record<string, unknown> = { ...source, loadingStages: source.stages };
        delete adapted.stages;
        return adapted;
      }
      return resultData;
    }
    default:
      return resultData;
  }
}
