/**
 * GEODATA HUB — Statistical utilities for calculation modules (M5.2-a).
 *
 * Deterministic sequential summation and two-pass variance: identical input
 * always produces bit-identical output. Do NOT replace the summation with a
 * parallelized/vectorized variant without re-verifying the golden values in
 * scripts/m5.2-test-formulas.ts.
 *
 * Domain policy: violations throw ArithmeticDomainError — never silently
 * clamped, never defaulted (docs/14 §4.9).
 */
import { ArithmeticDomainError } from "../errors";

function assertFiniteDataset(operation: string, values: readonly number[]): void {
  if (!Array.isArray(values)) {
    throw new ArithmeticDomainError(operation, "values must be an array of numbers.");
  }
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new ArithmeticDomainError(
        operation,
        `values[${i}] must be a finite number (received ${typeof v === "number" ? String(v) : typeof v}).`,
      );
    }
  }
}

/** Arithmetic mean. At least one value required. */
export function mean(values: readonly number[]): number {
  assertFiniteDataset("mean", values);
  if (values.length === 0) {
    throw new ArithmeticDomainError("mean", "At least one value is required.");
  }
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Population variance (divisor n). At least one value required. */
export function populationVariance(values: readonly number[]): number {
  const m = mean(values); // validates the dataset
  let sumOfSquares = 0;
  for (const v of values) sumOfSquares += (v - m) * (v - m);
  return sumOfSquares / values.length;
}

/** Population standard deviation (divisor n). */
export function populationStandardDeviation(values: readonly number[]): number {
  return Math.sqrt(populationVariance(values));
}

/** Sample variance (divisor n − 1). At least two values required. */
export function sampleVariance(values: readonly number[]): number {
  assertFiniteDataset("sampleVariance", values);
  if (values.length < 2) {
    throw new ArithmeticDomainError("sampleVariance", "At least two values are required.");
  }
  const m = mean(values);
  let sumOfSquares = 0;
  for (const v of values) sumOfSquares += (v - m) * (v - m);
  return sumOfSquares / (values.length - 1);
}

/** Sample standard deviation (divisor n − 1). */
export function sampleStandardDeviation(values: readonly number[]): number {
  return Math.sqrt(sampleVariance(values));
}

/**
 * Coefficient of variation, 100 × s / mean (sample estimator, percent).
 * Undefined for a zero mean — throws rather than dividing by zero.
 */
export function coefficientOfVariationPercent(values: readonly number[]): number {
  const m = mean(values); // validates the dataset
  const s = sampleStandardDeviation(values); // enforces n ≥ 2
  if (m === 0) {
    throw new ArithmeticDomainError(
      "coefficientOfVariationPercent",
      "Coefficient of variation is undefined for a zero mean.",
    );
  }
  return (100 * s) / m;
}
