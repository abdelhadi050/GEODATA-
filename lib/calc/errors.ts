/**
 * GEODATA HUB — Calculation engine error taxonomy (M5.2-a).
 *
 * Error classes (codes documented in types.ts) + shared helpers used by every
 * calculation module. Pure TypeScript + zod types only — no runtime dependency
 * on the registry, services, database or UI (docs/14 §3).
 */
import type { ZodError } from "zod";
import type {
  CalculationErrorCode,
  CalculationErrorDetails,
  CalculationIssueSummary,
} from "./types";

/** Base class of every deterministic, reportable calculation failure. */
export class CalculationError extends Error {
  readonly code: CalculationErrorCode;
  readonly details?: CalculationErrorDetails;

  constructor(code: CalculationErrorCode, message: string, details?: CalculationErrorDetails) {
    super(message);
    this.name = "CalculationError";
    this.code = code;
    this.details = details;
  }
}

/** One or more required input fields are absent. */
export class MissingInputError extends CalculationError {
  constructor(message: string, issues: CalculationIssueSummary[]) {
    super("MISSING_INPUT", message, { issues });
    this.name = "MissingInputError";
  }
}

/**
 * A field is present but invalid: wrong type, outside the data-contract
 * bounds, or a physically invalid combination.
 */
export class InvalidInputError extends CalculationError {
  readonly fieldPath: string;

  constructor(fieldPath: string, message: string, issues: CalculationIssueSummary[] = []) {
    super("INVALID_INPUT", message, issues.length > 0 ? { fieldPath, issues } : { fieldPath });
    this.name = "InvalidInputError";
    this.fieldPath = fieldPath;
  }
}

/**
 * D8 enforcement (constants/sources.ts): the requested constant is unknown or
 * is registered PENDING and therefore must never be consumed by a calculation.
 */
export class UnverifiedConstantError extends CalculationError {
  readonly constantKey: string;

  constructor(constantKey: string, status: string, message: string) {
    super("UNVERIFIED_CONSTANT", message, { constantKey, constantStatus: status });
    this.name = "UnverifiedConstantError";
    this.constantKey = constantKey;
  }
}

/** Unknown unit, or a non-finite value passed to a conversion. */
export class UnitConversionError extends CalculationError {
  constructor(message: string) {
    super("UNIT_CONVERSION_ERROR", message);
    this.name = "UnitConversionError";
  }
}

/**
 * Mathematically undefined or out-of-domain operation (empty dataset, division
 * by zero, negative mass of solids, ...). Domain violations are NEVER silently
 * clamped to plausible values (docs/14 §4.9) — they throw.
 */
export class ArithmeticDomainError extends CalculationError {
  constructor(operation: string, message: string) {
    super("ARITHMETIC_DOMAIN_ERROR", message, { operation });
    this.name = "ArithmeticDomainError";
  }
}

/** Assert a value is a finite number, else throw ArithmeticDomainError. */
export function assertFiniteNumber(operation: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ArithmeticDomainError(
      operation,
      `${operation}: expected a finite number, received ${typeof value === "number" ? String(value) : typeof value}`,
    );
  }
}

/** Read the value at a (possibly empty) issue path inside the raw payload. */
function getPathValue(raw: unknown, path: readonly (string | number | symbol)[]): unknown {
  let current: unknown = raw;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number | symbol, unknown>)[key];
  }
  return current;
}

function issuePath(issue: { path: (string | number | symbol)[] }): string {
  return issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
}

/**
 * Map a Zod v4 validation failure to the engine taxonomy.
 *
 * Classification rule (independent of zod message wording): an
 * `invalid_type` issue whose raw value at the issue path is `undefined` means
 * the field is ABSENT → MISSING_INPUT (all absent fields aggregated into one
 * message); anything else (wrong type, out of bounds, ...) → INVALID_INPUT
 * anchored at the first issue, with every issue summarized in `details.issues`.
 * A payload that is both missing and invalid reports MISSING_INPUT first.
 */
export function zodErrorToCalculationError(error: ZodError, raw: unknown): CalculationError {
  const issues: CalculationIssueSummary[] = error.issues.map((issue) => ({
    path: issuePath(issue),
    code: String(issue.code),
    message: issue.message,
  }));

  const missingFields = error.issues
    .filter(
      (issue) =>
        issue.code === "invalid_type" && getPathValue(raw, issue.path) === undefined,
    )
    .map(issuePath);

  if (missingFields.length > 0) {
    return new MissingInputError(
      `Missing required input field(s): ${missingFields.join(", ")}`,
      issues,
    );
  }

  const first = error.issues[0];
  const path = first ? issuePath(first) : "(root)";
  return new InvalidInputError(path, first ? first.message : "invalid input", issues);
}
