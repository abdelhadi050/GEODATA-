/**
 * GEODATA HUB — Classification engine typed errors (M5.4).
 *
 * Mirrors `src/lib/calc/errors.ts` because the same engineering rules apply:
 * services and modules throw these typed errors; the engine catches them and
 * converts them into structured ClassificationFailure outcomes. Non-typed
 * exceptions become deterministic INTERNAL_ERROR failures (no stack trace
 * leakage).
 *
 * Determinism: the `details` payload of every error MUST be a plain JSON-
 * serializable object — never an Error instance, never a function, never a
 * circular structure — so identical inputs produce deeply identical failures.
 */
import type {
  ClassificationErrorDetails,
  ClassificationErrorCode,
} from "./types";

/**
 * Base class for all classification-engine errors. Thrown by modules on
 * invalid or insufficient input; converted by the engine into a structured
 * ClassificationFailure.
 */
export class ClassificationError extends Error {
  constructor(
    public readonly code: ClassificationErrorCode,
    message: string,
    public readonly details?: ClassificationErrorDetails,
  ) {
    super(message);
    this.name = "ClassificationError";
  }
}

/** A required input field is absent — the standard cannot classify without it. */
export class MissingInputError extends ClassificationError {
  constructor(fieldPath: string, message: string) {
    super("MISSING_INPUT", message, { fieldPath });
    this.name = "MissingInputError";
  }
}

/** A field is present but has the wrong type, out of bounds, or is invalid. */
export class InvalidInputError extends ClassificationError {
  constructor(fieldPath: string, message: string) {
    super("INVALID_INPUT", message, { fieldPath });
    this.name = "InvalidInputError";
  }
}

/** Two inputs contradict each other (e.g. PL ≥ LL, fines > 100 %). */
export class InconsistentInputError extends ClassificationError {
  constructor(fieldPath: string, message: string) {
    super("INCONSISTENT_INPUT", message, { fieldPath });
    this.name = "InconsistentInputError";
  }
}

/** A mathematically undefined operation (division by zero, NaN, ...). */
export class ArithmeticDomainError extends ClassificationError {
  constructor(operation: string, message: string) {
    super("ARITHMETIC_DOMAIN_ERROR", message, { operation });
    this.name = "ArithmeticDomainError";
  }
}

/** The provided data shape is not one the module knows how to classify. */
export class UnsupportedDataShapeError extends ClassificationError {
  constructor(fieldPath: string, message: string) {
    super("UNSUPPORTED_DATA_SHAPE", message, { fieldPath });
    this.name = "UnsupportedDataShapeError";
  }
}

/**
 * Assert that a value is a finite number (not NaN, not ±Infinity). Throws
 * ArithmeticDomainError otherwise — the engine never lets a non-finite number
 * escape into a result.
 */
export function assertFiniteNumber(operation: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ArithmeticDomainError(
      operation,
      `${operation} produced a non-finite value (${String(value)}) — the module must guard its arithmetic domain and throw instead.`,
    );
  }
}

/**
 * Map a Zod validation error into a ClassificationError. The first issue is
 * surfaced as the headline message; every issue is preserved in `details.issues`
 * for full diagnostic visibility (path + code + message per issue, JSON-safe).
 *
 * The mapping is conservative: every Zod issue becomes an INVALID_INPUT
 * ClassificationError sub-issue; the standard's required-input distinction is
 * applied by the module's own superRefine rules (Zod's `z.required()` does not
 * distinguish "missing" from "invalid" at issue level — the module does).
 */
import type { ZodError } from "zod";

export function zodErrorToClassificationError(
  error: ZodError,
  rawInput: unknown,
): ClassificationError {
  const issues = error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    code: issue.code,
    message: issue.message,
  }));
  const first = issues[0];
  const headline = first
    ? `${first.path} — ${first.message}`
    : "Input failed schema validation";
  // We classify as INVALID_INPUT by default; modules that need to distinguish
  // MISSING_INPUT do so via their own explicit checks (see USCS module).
  return new ClassificationError("INVALID_INPUT", headline, {
    issues,
    receivedShape: describeShape(rawInput),
  });
}

/** A short, JSON-safe shape description of the received input (for diagnostics). */
function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(len=${value.length})`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return `object(keys=[${keys.slice(0, 8).join(",")}${keys.length > 8 ? ",…" : ""}])`;
  }
  return typeof value;
}
