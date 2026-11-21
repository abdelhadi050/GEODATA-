/**
 * GEODATA HUB — Calculation engine core contracts (M5.2-a).
 *
 * These types define the interface between the generic engine (`engine.ts`)
 * and calculation modules (`modules/*.ts`). They are deliberately free of any
 * runtime dependency (no zod, no registry, no database, no UI) so that the
 * engine stays portable and independently testable — see
 * docs/14-m5.2-architecture-plan.md §3 (layering rule) and §4.
 *
 * Determinism contract: every implementation of these interfaces must produce
 * deeply identical output for identical input (no clock, randomness, network
 * or database access). Precision contract: `raw` values keep full double
 * precision; rounding is applied ONLY at output boundaries (`results`) via
 * `roundTo` from `units.ts`.
 */

/**
 * Warning codes emitted by calculation modules. Extensible per milestone.
 *
 * - ENTERED_VALUE_DISCREPANCY  a computed quantity deviates from its
 *   laboratory-entered counterpart beyond the documented tolerance (the
 *   entered value is echoed unchanged, never overwritten — M5.2-a code)
 * - INSUFFICIENT_DATA          a requested/derived parameter cannot be
 *   supported by the supplied measurements and is reported as null with the
 *   reason (never fabricated) — M5.2-d code
 * - PHYSICAL_CONSISTENCY       the supplied data are physically questionable
 *   (e.g. a dry density above the zero-air-voids curve, a negative fitted
 *   cohesion); the calculation proceeds and reports, it does not silently
 *   clamp — M5.2-d code
 * - CORRECTION_APPLIED         a documented standard curve correction was
 *   applied to the raw measurements (e.g. the CBR concave-upward origin
 *   correction) — M5.2-e code
 * - REPORTING_RULE             the reported value follows a specific
 *   standard/registry reporting rule rather than the default reading (e.g.
 *   the CBR 5.0 mm value governs per the max rule) — M5.2-e code
 */
export type CalculationWarningCode =
  | "ENTERED_VALUE_DISCREPANCY"
  | "INSUFFICIENT_DATA"
  | "PHYSICAL_CONSISTENCY"
  | "CORRECTION_APPLIED"
  | "REPORTING_RULE";

/** Scalar detail values allowed inside a warning's `details` record. */
export type CalculationWarningDetailValue = number | string | boolean | null;

/**
 * A non-fatal advisory produced during computation. Warnings never change the
 * `status` of an outcome and never overwrite laboratory-entered data; they
 * report (e.g.) a computed-vs-entered discrepancy for the caller to surface.
 */
export interface CalculationWarning {
  code: CalculationWarningCode;
  message: string;
  details?: Record<string, CalculationWarningDetailValue>;
}

/**
 * Error codes of the calculation engine taxonomy.
 *
 * - MISSING_INPUT          a required input field is absent
 * - INVALID_INPUT          a field is present but has the wrong type, violates
 *                          the data contract bounds, or is physically invalid
 * - UNVERIFIED_CONSTANT    D8 governance: a PENDING or unknown constant was
 *                          requested (see constants/sources.ts)
 * - UNIT_CONVERSION_ERROR  unknown unit or non-finite value in a conversion
 * - ARITHMETIC_DOMAIN_ERROR mathematically undefined operation (empty dataset,
 *                          division by zero, non-finite produced value, ...)
 * - INTERNAL_ERROR         unexpected exception — deterministic guard, no stack
 */
export type CalculationErrorCode =
  | "MISSING_INPUT"
  | "INVALID_INPUT"
  | "UNVERIFIED_CONSTANT"
  | "UNIT_CONVERSION_ERROR"
  | "ARITHMETIC_DOMAIN_ERROR"
  | "INTERNAL_ERROR";

/** One validation issue, path-addressed, as aggregated into error details. */
export interface CalculationIssueSummary {
  path: string;
  code: string;
  message: string;
}

/** Structured details attached to a CalculationFailure. */
export type CalculationErrorDetails = {
  fieldPath?: string;
  constantKey?: string;
  constantStatus?: string;
  operation?: string;
  path?: string;
  issues?: CalculationIssueSummary[];
} & Record<string, unknown>;

/**
 * What a module's `compute` returns: full-precision `raw` internals,
 * output-boundary-rounded `results`, and non-fatal `warnings`.
 */
export interface ModuleComputeResult<TRaw, TResults> {
  raw: TRaw;
  results: TResults;
  warnings: CalculationWarning[];
}

/**
 * A calculation module. `testType` carries the registry LabTestType code as a
 * plain string on purpose: the engine never imports the lab-test registry
 * (independence rule); compatibility with the registry contract is proven by
 * tests (scripts/m5.2-test-water-content.ts), not by coupling.
 *
 * Contract for implementors:
 * - `validateInput` MUST throw a CalculationError subclass on invalid input
 *   (never a raw ZodError — map it with zodErrorToCalculationError).
 * - `compute` MUST be pure and deterministic, MUST treat `input` as immutable,
 *   and MUST NOT produce non-finite numbers without throwing
 *   ArithmeticDomainError (the engine's finiteness guard turns escapees into
 *   failures).
 */
export interface CalculationModule<TInput, TRaw, TResults> {
  id: string;
  testType: string;
  version: string;
  label: string;
  description: string;
  validateInput(raw: unknown): TInput;
  compute(input: TInput): ModuleComputeResult<TRaw, TResults>;
}

/** Successful engine outcome: provenance + echoed input + raw + results + warnings. */
export interface CalculationSuccess<TInput, TRaw, TResults> {
  status: "ok";
  engineVersion: string;
  moduleId: string;
  moduleVersion: string;
  testType: string;
  input: TInput;
  raw: TRaw;
  results: TResults;
  warnings: CalculationWarning[];
}

/** Failed engine outcome: provenance + a single structured, reportable error. */
export interface CalculationFailure {
  status: "error";
  engineVersion: string;
  moduleId: string;
  moduleVersion: string;
  testType: string;
  error: {
    code: CalculationErrorCode;
    message: string;
    details?: CalculationErrorDetails;
  };
}

/** The engine never throws for calculation failures — it returns this union. */
export type CalculationOutcome<TInput, TRaw, TResults> =
  | CalculationSuccess<TInput, TRaw, TResults>
  | CalculationFailure;
