/**
 * GEODATA HUB — Classification engine (M5.4).
 *
 * Generic, deterministic orchestrator. Mirrors `src/lib/calc/engine.ts`
 * (the M5.2 calculation engine) because the same engineering rules apply:
 *
 * Pipeline:
 *   1. validateInput  — the module parses and validates the raw payload
 *                       (schema + standard-specific rules), throwing
 *                       ClassificationError subclasses on failure;
 *   2. compute        — the module produces full-precision `raw` internals,
 *                       output-boundary-rounded `results` and `warnings`;
 *   3. finiteness guard — the engine scans the echoed input, `raw` and
 *                       `results` for NaN/±Infinity: a module that lets a
 *                       non-finite number escape is buggy and the run becomes
 *                       a reportable ARITHMETIC_DOMAIN_ERROR failure instead of
 *                       poisoning downstream consumers;
 *   4. envelope       — a success or failure outcome carrying module,
 *                       engine, and STANDARD provenance.
 *
 * The engine NEVER throws for classification failures — every failure is a
 * structured ClassificationFailure. Determinism: no clock, randomness, network
 * or database access; repeated runs are deeply identical.
 *
 * STANDARD-TEXT INVARIANT: the engine writes the module's `standard` and
 * `standardVersion` into every outcome (both success and failure). A
 * re-classification under a newer standard edition produces a different
 * module version — historical records are never silently re-judged.
 */
import type {
  ClassificationErrorDetails,
  ClassificationErrorCode,
  ClassificationFailure,
  ClassificationModule,
  ClassificationOutcome,
  ClassificationSuccess,
} from "./types";
import { ClassificationError } from "./errors";

/**
 * The engine version. Bumped only when the pipeline contract itself changes
 * (fingerprint semantics, envelope shape, finiteness-guard behavior). Module
 * versions are independent — a module upgrade never changes the engine
 * version.
 */
export const CLASSIFICATION_ENGINE_VERSION = "1.0.0";

/** Maximum payload nesting the finiteness guard will scan (cycle-safe bound). */
const MAX_SCAN_DEPTH = 32;

interface ModuleProvenance {
  engineVersion: string;
  moduleId: string;
  moduleVersion: string;
  sourceType: string;
  standard: string;
  standardVersion: string;
}

function failure(
  provenance: ModuleProvenance,
  code: ClassificationErrorCode,
  message: string,
  details?: ClassificationErrorDetails,
): ClassificationFailure {
  return {
    status: "error",
    ...provenance,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  };
}

interface NonFiniteFinding {
  path: string;
  value: number;
}

/**
 * Depth-limited, cycle-safe search for the first non-finite number inside a
 * payload. Identical implementation to the calculation engine's guard — see
 * `src/lib/calc/engine.ts` for the design rationale.
 */
function findNonFiniteNumber(value: unknown, path: string, depth: number): NonFiniteFinding | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? null : { path, value };
  }
  if (value === null || typeof value !== "object") {
    return null;
  }
  if (depth >= MAX_SCAN_DEPTH) {
    throw new ClassificationError(
      "INTERNAL_ERROR",
      `Classification payload nesting exceeds ${MAX_SCAN_DEPTH} levels at '${path}'.`,
    );
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findNonFiniteNumber(value[i], `${path}[${i}]`, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const found = findNonFiniteNumber(
      (value as Record<string, unknown>)[key],
      `${path}.${key}`,
      depth + 1,
    );
    if (found !== null) return found;
  }
  return null;
}

/**
 * Run a classification module over a raw payload and return a structured
 * outcome. Identical (module, rawInput) pairs always produce deeply identical
 * outcomes.
 */
export function runClassification<TInput, TRaw, TResults>(
  module: ClassificationModule<TInput, TRaw, TResults>,
  rawInput: unknown,
): ClassificationOutcome<TInput, TRaw, TResults> {
  const provenance: ModuleProvenance = {
    engineVersion: CLASSIFICATION_ENGINE_VERSION,
    moduleId: module.id,
    moduleVersion: module.version,
    sourceType: module.sourceType,
    standard: module.standard,
    standardVersion: module.standardVersion,
  };
  try {
    const input = module.validateInput(rawInput);
    const computed = module.compute(input);
    if (computed === null || typeof computed !== "object") {
      return failure(
        provenance,
        "INTERNAL_ERROR",
        "module.compute must return { raw, results, warnings }.",
      );
    }
    const nonFinite =
      findNonFiniteNumber(input, "input", 0) ??
      findNonFiniteNumber(computed.raw, "raw", 0) ??
      findNonFiniteNumber(computed.results, "results", 0);
    if (nonFinite !== null) {
      return failure(
        provenance,
        "ARITHMETIC_DOMAIN_ERROR",
        `Non-finite number (${String(nonFinite.value)}) produced at '${nonFinite.path}' — the module must guard its arithmetic domain and throw instead.`,
        { path: nonFinite.path },
      );
    }
    const success: ClassificationSuccess<TInput, TRaw, TResults> = {
      status: "ok",
      ...provenance,
      input,
      raw: computed.raw,
      results: computed.results,
      warnings: Array.isArray(computed.warnings) ? computed.warnings : [],
    };
    return success;
  } catch (error) {
    if (error instanceof ClassificationError) {
      return failure(provenance, error.code, error.message, error.details);
    }
    // Unexpected exception — deterministic INTERNAL_ERROR guard (no stack).
    const originalErrorName = error instanceof Error ? error.name : typeof error;
    const originalMessage = error instanceof Error ? error.message : String(error);
    return failure(
      provenance,
      "INTERNAL_ERROR",
      `Unexpected internal error: ${originalMessage}`,
      { originalErrorName },
    );
  }
}

/** Type guard for the success variant of an outcome. */
export function isClassificationSuccess<TInput, TRaw, TResults>(
  outcome: ClassificationOutcome<TInput, TRaw, TResults>,
): outcome is ClassificationSuccess<TInput, TRaw, TResults> {
  return outcome.status === "ok";
}

/** Type guard for the failure variant of an outcome. */
export function isClassificationFailure<TInput, TRaw, TResults>(
  outcome: ClassificationOutcome<TInput, TRaw, TResults>,
): outcome is ClassificationFailure {
  return outcome.status === "error";
}
