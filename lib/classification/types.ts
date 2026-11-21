/**
 * GEODATA HUB — Classification engine core contracts (M5.4).
 *
 * These types define the interface between the generic classification engine
 * (`engine.ts`) and classification modules (`modules/*.ts`). They mirror the
 * design of the M5.2 calculation engine contracts (`src/lib/calc/types.ts`)
 * because the same engineering rules apply: the engines stay portable,
 * independently testable, deterministic and free of any runtime dependency
 * (no zod, no registry, no database, no UI).
 *
 * Determinism contract: every implementation of these interfaces MUST produce
 * deeply identical output for identical input (no clock, randomness, network
 * or database access). Precision contract: derived numeric values (Group Index,
 * percentages) keep full double precision in `raw`; rounding is applied ONLY
 * at the output boundary (`results`).
 *
 * Standard-text provenance: every classification module cites the exact
 * standard and version it implements (e.g. "ASTM D2487-17", "AASHTO M 145-91
 * (2017)"). The rules implemented are the rules published in those standards;
 * no thresholds, borderline criteria, or formulas are invented.
 */

/**
 * Warning codes emitted by classification modules. Extensible per milestone.
 *
 * - INSUFFICIENT_DATA        a classification-relevant input is missing and the
 *                            module produced the most specific classification
 *                            the available data supports (e.g. coarse-grained
 *                            soil without Atterberg data stays at the GP/SP/GW
 *                            level rather than fabricating plasticity-based
 *                            borderline symbols) — never invented.
 * - BORDERLINE_CASE          the inputs satisfy more than one criterion (e.g.
 *                            a soil within 5 % of the coarse/fine boundary gets
 *                            a borderline symbol with a dual name); the
 *                            standard explicitly mandates the dual symbol.
 * - ENTERED_VALUE_DISCREPANCY a computed quantity deviates from a
 *                            laboratory-entered counterpart beyond a documented
 *                            tolerance (the entered value is echoed unchanged,
 *                            never overwritten).
 * - PARTIAL_DATA             the classification is computed from a subset of
 *                            the standard's required inputs (e.g. only a sieve
 *                            run without hydrometer extension); the result is
 *                            valid but its precision is documented.
 */
export type ClassificationWarningCode =
  | "INSUFFICIENT_DATA"
  | "BORDERLINE_CASE"
  | "ENTERED_VALUE_DISCREPANCY"
  | "PARTIAL_DATA";

/** Scalar detail values allowed inside a warning's `details` record. */
export type ClassificationWarningDetailValue = number | string | boolean | null;

/**
 * A non-fatal advisory produced during classification. Warnings never change
 * the `status` of an outcome and never overwrite laboratory-entered data.
 */
export interface ClassificationWarning {
  code: ClassificationWarningCode;
  message: string;
  details?: Record<string, ClassificationWarningDetailValue>;
}

/**
 * Error codes of the classification engine taxonomy.
 *
 * - MISSING_INPUT          a required input field is absent (the standard
 *                          cannot produce a classification without it)
 * - INVALID_INPUT          a field is present but has the wrong type, violates
 *                          the data contract bounds, or is physically invalid
 * - INCONSISTENT_INPUT     two inputs contradict each other (e.g. liquidLimit
 *                          lower than plasticLimit, percentFiner > 100)
 * - ARITHMETIC_DOMAIN_ERROR mathematically undefined operation (division by
 *                          zero, non-finite produced value, ...)
 * - UNSUPPORTED_DATA_SHAPE the data shape provided is not one the the module
 *                          knows how to classify (e.g. a granulometry with
 *                          fewer than the minimum required sieve points)
 * - INTERNAL_ERROR         unexpected exception — deterministic guard, no stack
 */
export type ClassificationErrorCode =
  | "MISSING_INPUT"
  | "INVALID_INPUT"
  | "INCONSISTENT_INPUT"
  | "ARITHMETIC_DOMAIN_ERROR"
  | "UNSUPPORTED_DATA_SHAPE"
  | "INTERNAL_ERROR";

/** One validation issue, path-addressed, as aggregated into error details. */
export interface ClassificationIssueSummary {
  path: string;
  code: string;
  message: string;
}

/** Structured details attached to a ClassificationFailure. */
export type ClassificationErrorDetails = {
  fieldPath?: string;
  standard?: string;
  operation?: string;
  path?: string;
  issues?: ClassificationIssueSummary[];
} & Record<string, unknown>;

/**
 * What a module's `compute` returns: full-precision `raw` internals (every
 * derived quantity the standard defines — sieve fractions, plasticity-chart
 * coordinates, Group Index components, borderline checks), output-boundary-
 * rounded `results`, and non-fatal `warnings`.
 */
export interface ModuleComputeResult<TRaw, TResults> {
  raw: TRaw;
  results: TResults;
  warnings: ClassificationWarning[];
}

/**
 * A classification module. Pure, deterministic, standard-cited. The
 * `standard` and `standardVersion` fields are mandatory and frozen at module
 * construction — they are written into every persisted record so historical
 * classifications are traceable to the exact rules under which they were
 * produced (a re-issue of the standard with revised thresholds becomes a new
 * module version, never a silent mutation of prior records).
 *
 * Contract for implementors:
 * - `validateInput` MUST throw a ClassificationError subclass on invalid input
 *   (never a raw ZodError — map it with zodErrorToClassificationError).
 * - `compute` MUST be pure and deterministic, MUST treat `input` as immutable,
 *   and MUST NOT produce non-finite numbers without throwing
 *   ArithmeticDomainError (the engine's finiteness guard turns escapees into
 *   failures).
 * - The classification symbol/group returned MUST be a verbatim transcription
 *   of the standard's vocabulary (e.g. "CL", "A-7-6 (20)"), never a paraphrase.
 */
export interface ClassificationModule<TInput, TRaw, TResults> {
  id: string;
  /** Plain string — registry of the source the module is paired with (e.g. "SAMPLE"). */
  sourceType: string;
  version: string;
  label: string;
  description: string;
  /** Standard family cited verbatim (e.g. "ASTM D2487"). */
  standard: string;
  /** Edition/year cited verbatim (e.g. "D2487-17"). */
  standardVersion: string;
  validateInput(raw: unknown): TInput;
  compute(input: TInput): ModuleComputeResult<TRaw, TResults>;
}

/** Successful engine outcome: provenance + echoed input + raw + results + warnings. */
export interface ClassificationSuccess<TInput, TRaw, TResults> {
  status: "ok";
  engineVersion: string;
  moduleId: string;
  moduleVersion: string;
  sourceType: string;
  standard: string;
  standardVersion: string;
  input: TInput;
  raw: TRaw;
  results: TResults;
  warnings: ClassificationWarning[];
}

/** Failed engine outcome: provenance + a single structured, reportable error. */
export interface ClassificationFailure {
  status: "error";
  engineVersion: string;
  moduleId: string;
  moduleVersion: string;
  sourceType: string;
  standard: string;
  standardVersion: string;
  error: {
    code: ClassificationErrorCode;
    message: string;
    details?: ClassificationErrorDetails;
  };
}

/** The engine never throws for classification failures — it returns this union. */
export type ClassificationOutcome<TInput, TRaw, TResults> =
  | ClassificationSuccess<TInput, TRaw, TResults>
  | ClassificationFailure;
