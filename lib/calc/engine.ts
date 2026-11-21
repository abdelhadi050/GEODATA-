/**
 * GEODATA HUB — Calculation engine (M5.2-a).
 *
 * Generic, deterministic orchestrator. Pipeline (docs/14 §4.2):
 *
 *   1. validateInput  — the module parses and validates the raw payload
 *                       (schema + physical rules), throwing CalculationError
 *                       subclasses on failure;
 *   2. compute        — the module produces full-precision `raw` values,
 *                       output-boundary-rounded `results` and `warnings`;
 *   3. finiteness guard — the engine scans the echoed input, `raw` and
 *                       `results` for NaN/±Infinity: a module that lets a
 *                       non-finite number escape is buggy and the run becomes
 *                       a reportable ARITHMETIC_DOMAIN_ERROR failure instead of
 *                       poisoning downstream consumers;
 *   4. envelope       — a success or failure outcome carrying module and
 *                       engine provenance.
 *
 * The engine NEVER throws for calculation failures — every failure is a
 * structured CalculationFailure. Determinism: no clock, randomness, network
 * or database access (docs/14 §4.5); repeated runs are deeply identical
 * (asserted by scripts/m5.2-test-engine.ts).
 */
import type {
  CalculationErrorDetails,
  CalculationErrorCode,
  CalculationFailure,
  CalculationModule,
  CalculationOutcome,
  CalculationSuccess,
} from "./types";
import { CalculationError } from "./errors";

export const CALCULATION_ENGINE_VERSION = "1.0.0";

/** Maximum payload nesting the finiteness guard will scan (cycle-safe bound). */
const MAX_SCAN_DEPTH = 32;

interface ModuleProvenance {
  engineVersion: string;
  moduleId: string;
  moduleVersion: string;
  testType: string;
}

function failure(
  provenance: ModuleProvenance,
  code: CalculationErrorCode,
  message: string,
  details?: CalculationErrorDetails,
): CalculationFailure {
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
 * payload. Objects, arrays and primitives other than numbers are traversed;
 * nesting beyond MAX_SCAN_DEPTH throws (mapped to INTERNAL_ERROR by the
 * engine's catch).
 */
function findNonFiniteNumber(value: unknown, path: string, depth: number): NonFiniteFinding | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? null : { path, value };
  }
  if (value === null || typeof value !== "object") {
    return null;
  }
  if (depth >= MAX_SCAN_DEPTH) {
    throw new CalculationError(
      "INTERNAL_ERROR",
      `Calculation payload nesting exceeds ${MAX_SCAN_DEPTH} levels at '${path}'.`,
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
 * Run a calculation module over a raw payload and return a structured outcome.
 * Identical (module, rawInput) pairs always produce deeply identical outcomes.
 */
export function runCalculation<TInput, TRaw, TResults>(
  module: CalculationModule<TInput, TRaw, TResults>,
  rawInput: unknown,
): CalculationOutcome<TInput, TRaw, TResults> {
  const provenance: ModuleProvenance = {
    engineVersion: CALCULATION_ENGINE_VERSION,
    moduleId: module.id,
    moduleVersion: module.version,
    testType: module.testType,
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
    const success: CalculationSuccess<TInput, TRaw, TResults> = {
      status: "ok",
      ...provenance,
      input,
      raw: computed.raw,
      results: computed.results,
      warnings: Array.isArray(computed.warnings) ? computed.warnings : [],
    };
    return success;
  } catch (error) {
    if (error instanceof CalculationError) {
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
export function isCalculationSuccess<TInput, TRaw, TResults>(
  outcome: CalculationOutcome<TInput, TRaw, TResults>,
): outcome is CalculationSuccess<TInput, TRaw, TResults> {
  return outcome.status === "ok";
}

/** Type guard for the failure variant of an outcome. */
export function isCalculationFailure<TInput, TRaw, TResults>(
  outcome: CalculationOutcome<TInput, TRaw, TResults>,
): outcome is CalculationFailure {
  return outcome.status === "error";
}
