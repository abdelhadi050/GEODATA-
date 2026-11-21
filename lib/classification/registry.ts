/**
 * GEODATA HUB — Classification engine registry (M5.4).
 *
 * Single source of truth for every registered classification module. The
 * integration layer (classification service, Classify API, invalidation)
 * resolves modules EXCLUSIVELY through this registry — never by importing
 * individual modules — so no registered engine can be omitted from the API
 * surface.
 *
 * Mirrors `src/lib/calc/registry.ts` (the M5.2 calculation registry) in
 * design because the same layering and independence rules apply: this file
 * lives in `classification/` and imports ONLY from `classification/` — the
 * engine layer stays independent of the lab-test registry, services,
 * database and UI. The `sourceType` strings are plain strings by design
 * (engine independence); their correspondence with the source entity types
 * is proven by the integration tests, not by a runtime coupling.
 *
 * Registered modules (2): USCS (ASTM D2487), AASHTO (M 145). One module per
 * supported classification standard. Both classify at the SAMPLE level
 * (sourceType = "SAMPLE") — they consume granulometry + Atterberg inputs
 * attached to a sample.
 */
import type { ClassificationModule } from "./types";
import { CLASSIFICATION_ENGINE_VERSION } from "./engine";
import { uscsModule } from "./modules/uscs";
import { aashtoModule } from "./modules/aashto";

/**
 * A classification module with its generic parameters erased to the JSON-level
 * contract the integration layer consumes.
 */
export type RegisteredClassificationModule = ClassificationModule<unknown, unknown, unknown>;

/** All registered classification modules (order = registry order, stable). */
export const CLASS_MODULES: readonly RegisteredClassificationModule[] = [
  uscsModule,
  aashtoModule,
] as unknown as readonly RegisteredClassificationModule[];

const MODULES_BY_ID = new Map<string, RegisteredClassificationModule>(
  CLASS_MODULES.map((m) => [m.id, m]),
);

/** Resolve a module by its id (e.g. "uscs"). Null when unregistered. */
export function getClassModuleById(moduleId: string): RegisteredClassificationModule | null {
  return MODULES_BY_ID.get(moduleId) ?? null;
}

/** Engine listing for the discovery endpoint (no module references leaked). */
export function listClassModules(): Array<{
  moduleId: string;
  sourceType: string;
  label: string;
  description: string;
  moduleVersion: string;
  engineVersion: string;
  standard: string;
  standardVersion: string;
}> {
  return CLASS_MODULES.map((m) => ({
    moduleId: m.id,
    sourceType: m.sourceType,
    label: m.label,
    description: m.description,
    moduleVersion: m.version,
    engineVersion: CLASSIFICATION_ENGINE_VERSION,
    standard: m.standard,
    standardVersion: m.standardVersion,
  }));
}
