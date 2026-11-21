/**
 * GEODATA HUB — Direct shear calculation module (M5.2-f).
 *
 * Serves registry test type DIRECT_SHEAR (standard citations verified in
 * M5.1: ASTM D3080 / NF P94-071-1). The module implements the authorized
 * M5.2-f scope:
 *
 *   - Mohr–Coulomb failure envelope by LEAST-SQUARES regression of the peak
 *     shear stress on the normal stress over the test stages (definitional
 *     regression, docs/14 §6 row 7 — the same class as the M5.2-c flow
 *     curve; no standard-specific constant):
 *         τ = c + σn·tan φ
 *         slope = Sxy/Sxx,  intercept = mean(τ) − slope·mean(σn)
 *         φ = atan(slope) [deg],  c = intercept [kPa]
 *     Peak and residual envelopes are computed and reported SEPARATELY.
 *   - Peak envelope: over all stages (multi-stage program, ≥ 2 stages with
 *     unique normal stresses — registry rules).
 *   - Residual envelope: over the stages that report residual shear stress,
 *     only when ≥ 2 such stages exist; otherwise null with an
 *     INSUFFICIENT_DATA warning when at least one residual value exists
 *     (never fabricated). A peak-only program yields a null residual
 *     envelope without warning (normal test scope).
 *   - Single-stage legacy record (registry scalar shape normalStressKpa +
 *     peakShearStressKpa): a one-point record cannot define an envelope —
 *     c/φ are null with an INSUFFICIENT_DATA warning; the measurement is
 *     echoed, never inventing a second point.
 *   - Fit quality: the coefficient of determination R² of each envelope
 *     (definitional statistic, 1 − SSres/SStot; a perfect two-point fit has
 *     R² = 1 by construction).
 *   - Physical consistency: a NEGATIVE fitted cohesion or friction angle is
 *     reported AS-IS with a PHYSICAL_CONSISTENCY warning (no clamping — the
 *     data, not the module, are questionable; the registry storage bound
 *     gates at write time).
 *   - Drainage condition: the optional engine-side `drainageCondition`
 *     (DRAINED / UNDRAINED) is echoed in the results when supplied — it is
 *     documentation of the test conditions, it never changes a number.
 *
 * INPUT CONTRACT: the registry `directShearResult` payload accepts EITHER
 * `stages` (2–8, unique normalStressKpa, residual ≤ peak per stage) OR the
 * legacy single-stage scalars (normalStressKpa + peakShearStressKpa +
 * optional residualShearStressKpa) — exactly one of the two (registry
 * either-or rule). Entered finals `cohesionKpa` (0–1000) and
 * `frictionAngleDeg` (0–45) carry the registry field names and bounds.
 * Unknown keys — including the registry input's `specimenDiameterMm`,
 * `rateMmMin`, `notes` — are stripped (Zod default).
 *
 * ENTERED-VALUE COMPARISON: computed peak c and φ are compared with the
 * entered finals; a discrepancy beyond ±1.0 (kPa for c, degrees for φ)
 * produces an ENTERED_VALUE_DISCREPANCY warning (entered echoed unchanged).
 * Provenance of ±1.0: the M5.1 seed's own consistency standard — the
 * DS_STAGES_PROGRAM fixture documents "peak values follow τ ≈ 20 kPa +
 * σn × tan 25°, consistent with the c′/φ′ entered" while its regression
 * yields c = 19.67 kPa / φ = 25.17°, i.e. the project's own fixtures treat
 * sub-unit discrepancies as consistent. A project engineering tolerance,
 * not standard-verified (same class as the atterberg ±1, docs/14 §9 R1).
 *
 * PRECISION: `raw` keeps full double precision; rounding happens only at
 * this output boundary — stresses 2 dp, c 2 dp, φ 2 dp, R² 4 dp. Computed
 * values are never clamped.
 */
import { z } from "zod";
import type { CalculationModule, CalculationWarning } from "../types";
import {
  ArithmeticDomainError,
  InvalidInputError,
  MissingInputError,
  assertFiniteNumber,
  zodErrorToCalculationError,
} from "../errors";
import { roundTo } from "../units";

export const DIRECT_SHEAR_MODULE_ID = "direct-shear";
export const DIRECT_SHEAR_MODULE_VERSION = "1.0.0";

/**
 * Entered-value comparison tolerance (absolute): ±1.0 kPa for cohesion,
 * ±1.0° for the friction angle. Provenance: the M5.1 seed fixture's own
 * consistency standard (see header). Project engineering tolerance.
 */
export const DIRECT_SHEAR_ENTERED_TOLERANCE = 1.0;

/** Registry contract bounds mirrored by this module. */
const MIN_STAGES = 2;
const MAX_STAGES = 8;
const MAX_STRESS = 2000;

/** Output boundary decimals. */
const STRESS_DECIMALS = 2;
const PARAMETER_DECIMALS = 2;
const R2_DECIMALS = 4;
const WARNING_DETAIL_DECIMALS = 4;

/** One multi-stage direct-shear point (registry `stages` item shape). */
export interface DirectShearStage {
  /** applied normal stress at failure (or stage target), 0–2000 [kPa] */
  normalStressKpa: number;
  /** peak shear stress at failure, 0–2000 [kPa] */
  peakShearStressKpa: number;
  /** residual (ultimate) shear stress when measured; ≤ peak [kPa] */
  residualShearStressKpa?: number | undefined;
}

/**
 * Input schema — the calculable core of the registry `directShearResult`
 * contract (either-or stages/scalars rule, bounds identical) plus the
 * engine-side `drainageCondition`. Exported for compatibility tests.
 */
export const directShearCalcInput = z.object({
  stages: z
    .array(
      z.object({
        normalStressKpa: z.number().min(0).max(MAX_STRESS),
        peakShearStressKpa: z.number().min(0).max(MAX_STRESS),
        residualShearStressKpa: z.number().min(0).max(MAX_STRESS).optional(),
      }),
    )
    .min(MIN_STAGES)
    .max(MAX_STAGES)
    .optional(),
  normalStressKpa: z.number().min(0).max(MAX_STRESS).optional(),
  peakShearStressKpa: z.number().min(0).max(MAX_STRESS).optional(),
  residualShearStressKpa: z.number().min(0).max(MAX_STRESS).optional(),
  drainageCondition: z.enum(["DRAINED", "UNDRAINED"]).optional(),
  cohesionKpa: z.number().min(0).max(1000).optional(),
  frictionAngleDeg: z.number().min(0).max(45).optional(),
});

export interface DirectShearInput {
  stages?: DirectShearStage[] | undefined;
  normalStressKpa?: number | undefined;
  peakShearStressKpa?: number | undefined;
  residualShearStressKpa?: number | undefined;
  drainageCondition?: "DRAINED" | "UNDRAINED" | undefined;
  cohesionKpa?: number | undefined;
  frictionAngleDeg?: number | undefined;
}

/** One fitted Mohr–Coulomb envelope at full precision. */
export interface MohrCoulombEnvelope {
  /** fitted cohesion (intercept) [kPa] — may be negative (reported as-is) */
  cohesionKpa: number;
  /** fitted friction angle [deg] — may be negative (reported as-is) */
  frictionAngleDeg: number;
  /** regression slope tan φ */
  slopeTanPhi: number;
  /** coefficient of determination R² (1 − SSres/SStot) */
  rSquared: number;
  /** number of points used by the fit */
  pointCount: number;
}

/** Full-precision internal values (never rounded, never clamped). */
export interface DirectShearRaw {
  /** peak envelope; null when the record cannot define one */
  peakEnvelope: MohrCoulombEnvelope | null;
  /** residual envelope; null without ≥ 2 residual measurements */
  residualEnvelope: MohrCoulombEnvelope | null;
}

/** Output-boundary results (rounded; entered values echoed unchanged). */
export interface DirectShearResults {
  /** peak Mohr–Coulomb parameters; null when not derivable */
  peakCohesionKpa: number | null;
  peakFrictionAngleDeg: number | null;
  peakRSquared: number | null;
  peakPointCount: number;
  /** residual Mohr–Coulomb parameters; null when not derivable */
  residualCohesionKpa: number | null;
  residualFrictionAngleDeg: number | null;
  residualRSquared: number | null;
  residualPointCount: number;
  /** the measured stages echoed (registry-compatible shape) */
  stages: Array<{ normalStressKpa: number; peakShearStressKpa: number; residualShearStressKpa: number | null }>;
  /** legacy single-stage record echoed; null for multi-stage programs */
  singleStage: { normalStressKpa: number; peakShearStressKpa: number; residualShearStressKpa: number | null } | null;
  /** test drainage condition, echoed when supplied */
  drainageCondition: "DRAINED" | "UNDRAINED" | null;
  /** laboratory-entered finals, echoed unchanged (null when absent) */
  enteredCohesionKpa: number | null;
  enteredFrictionAngleDeg: number | null;
}

// ---------------------------------------------------------------------------
// Envelope helper (exported for direct unit testing)
// ---------------------------------------------------------------------------

/**
 * Mohr–Coulomb least-squares envelope of (σn, τ) points:
 *   slope = Sxy/Sxx (tan φ),  intercept = mean(τ) − slope·mean(σn) (c),
 *   φ = atan(slope) in DEGREES,  R² = 1 − SSres/SStot.
 * PRECONDITION: ≥ 2 points with ≥ 2 DISTINCT σn values (registry uniqueness
 * makes this guaranteed for stage arrays; single distinct σn is
 * ARITHMETIC_DOMAIN_ERROR — the regression is undefined).
 */
export function fitMohrCoulombEnvelope(
  points: ReadonlyArray<{ normalStressKpa: number; shearStressKpa: number }>,
): MohrCoulombEnvelope {
  const distinctSigma = new Set(points.map((p) => p.normalStressKpa));
  if (distinctSigma.size < 2) {
    throw new ArithmeticDomainError(
      "fitMohrCoulombEnvelope",
      `At least 2 distinct normal stresses are required to fit a Mohr–Coulomb envelope (all ${points.length} points share σn = ${points[0]?.normalStressKpa} kPa) — the regression is undefined.`,
    );
  }
  const n = points.length;
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.normalStressKpa;
    sy += p.shearStressKpa;
  }
  const xMean = sx / n;
  const yMean = sy / n;
  let sxy = 0;
  let sxx = 0;
  let ssTot = 0;
  for (const p of points) {
    const dx = p.normalStressKpa - xMean;
    const dy = p.shearStressKpa - yMean;
    sxy += dx * dy;
    sxx += dx * dx;
    ssTot += dy * dy;
  }
  const slopeTanPhi = sxy / sxx;
  const cohesionKpa = yMean - slopeTanPhi * xMean;
  assertFiniteNumber("fitMohrCoulombEnvelope.slope", slopeTanPhi);
  assertFiniteNumber("fitMohrCoulombEnvelope.cohesion", cohesionKpa);
  const frictionAngleDeg = (Math.atan(slopeTanPhi) * 180) / Math.PI;
  assertFiniteNumber("fitMohrCoulombEnvelope.frictionAngle", frictionAngleDeg);
  // R² = 1 − SSres/SStot (definitional; SStot = 0 only for identical τ,
  // which the distinct-σ precondition makes pathological — guard anyway).
  let ssRes = 0;
  for (const p of points) {
    const residual = p.shearStressKpa - (cohesionKpa + slopeTanPhi * p.normalStressKpa);
    ssRes += residual * residual;
  }
  const rSquared = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  assertFiniteNumber("fitMohrCoulombEnvelope.rSquared", rSquared);
  return { cohesionKpa, frictionAngleDeg, slopeTanPhi, rSquared, pointCount: n };
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export const directShearModule: CalculationModule<DirectShearInput, DirectShearRaw, DirectShearResults> = {
  id: DIRECT_SHEAR_MODULE_ID,
  testType: "DIRECT_SHEAR",
  version: DIRECT_SHEAR_MODULE_VERSION,
  label: "Direct shear (Mohr–Coulomb c/φ by least squares, peak and residual separate)",
  description:
    "Fits the Mohr–Coulomb failure envelope τ = c + σn·tan φ by least squares over the multi-stage program — peak and residual envelopes separately, the residual only from stages that report residual shear stress (never fabricated) — reports the coefficient of determination, keeps single-stage legacy records as echoes without inventing an envelope, flags physically questionable negative fitted parameters without clamping them, echoes the drainage condition when supplied, and cross-checks laboratory-entered c′/φ′ finals — warning on discrepancies beyond ±1 without overwriting them.",

  validateInput(raw: unknown): DirectShearInput {
    if (raw !== null && typeof raw === "object") {
      const record = raw as Record<string, unknown>;
      const hasStages = Array.isArray(record.stages) && (record.stages as unknown[]).length > 0;
      const hasScalars =
        record.normalStressKpa !== undefined && record.peakShearStressKpa !== undefined;
      if (!hasStages && !hasScalars) {
        // Mirror of the registry either-or rule, aggregated as missing input.
        throw new MissingInputError(
          `Missing required input field(s): stages, normalStressKpa, peakShearStressKpa — ` +
            `provide either stages[] (multi-stage program) or the single-stage scalar fields`,
          [
            { path: "stages", code: "missing", message: "provide stages[] (multi-stage) or the single-stage scalars" },
            { path: "normalStressKpa", code: "missing", message: "single-stage record needs normalStressKpa" },
            { path: "peakShearStressKpa", code: "missing", message: "single-stage record needs peakShearStressKpa" },
          ],
        );
      }
      if (hasStages && hasScalars) {
        throw new InvalidInputError(
          "stages",
          `Provide either stages[] (multi-stage program) or the single-stage scalar fields, not both — M5.1 contract.`,
        );
      }
    }
    const parsed = directShearCalcInput.safeParse(raw);
    if (!parsed.success) {
      throw zodErrorToCalculationError(parsed.error, raw);
    }
    const input = parsed.data;

    if (input.stages !== undefined) {
      // Unique normal stresses (registry rule).
      const normals = input.stages.map((s) => s.normalStressKpa);
      if (new Set(normals).size !== normals.length) {
        throw new InvalidInputError(
          "stages",
          `stages normalStressKpa values must be unique — M5.1 contract.`,
        );
      }
      // Residual ≤ peak per stage (registry rule).
      for (let i = 0; i < input.stages.length; i++) {
        const s = input.stages[i];
        if (s.residualShearStressKpa !== undefined && s.residualShearStressKpa > s.peakShearStressKpa) {
          throw new InvalidInputError(
            `stages.${i}.residualShearStressKpa`,
            `residualShearStressKpa (${s.residualShearStressKpa}) cannot exceed peakShearStressKpa (${s.peakShearStressKpa}) — M5.1 contract.`,
          );
        }
      }
    } else {
      // Legacy scalar record: residual ≤ peak mirror.
      if (
        input.residualShearStressKpa !== undefined &&
        input.peakShearStressKpa !== undefined &&
        input.residualShearStressKpa > input.peakShearStressKpa
      ) {
        throw new InvalidInputError(
          "residualShearStressKpa",
          `residualShearStressKpa (${input.residualShearStressKpa}) cannot exceed peakShearStressKpa (${input.peakShearStressKpa}) — M5.1 contract.`,
        );
      }
    }
    return input;
  },

  compute(input: DirectShearInput) {
    const warnings: CalculationWarning[] = [];

    let peakEnvelope: MohrCoulombEnvelope | null = null;
    let residualEnvelope: MohrCoulombEnvelope | null = null;

    if (input.stages !== undefined) {
      // Peak envelope over all stages (unique σn guaranteed by validation).
      peakEnvelope = fitMohrCoulombEnvelope(
        input.stages.map((s) => ({ normalStressKpa: s.normalStressKpa, shearStressKpa: s.peakShearStressKpa })),
      );
      // Residual envelope over the stages reporting residual values.
      const residualStages = input.stages.filter((s) => s.residualShearStressKpa !== undefined);
      if (residualStages.length >= 2) {
        const distinctSigma = new Set(residualStages.map((s) => s.normalStressKpa));
        if (distinctSigma.size >= 2) {
          residualEnvelope = fitMohrCoulombEnvelope(
            residualStages.map((s) => ({
              normalStressKpa: s.normalStressKpa,
              shearStressKpa: s.residualShearStressKpa!,
            })),
          );
        } else {
          warnings.push({
            code: "INSUFFICIENT_DATA",
            message:
              `The ${residualStages.length} residual measurements share a single normal stress — ` +
                `the residual envelope is undefined and is not reported.`,
            details: { residualPointCount: residualStages.length },
          });
        }
      } else if (residualStages.length === 1) {
        warnings.push({
          code: "INSUFFICIENT_DATA",
          message:
            `Only 1 of ${input.stages.length} stages reports a residual shear stress — at least 2 ` +
              `(distinct normal stress) residual measurements are needed for a residual envelope; ` +
              `the residual parameters are not reported (never fabricated).`,
          details: { residualPointCount: 1, stageCount: input.stages.length },
        });
      }
    } else {
      // Legacy single-stage record: one point cannot define an envelope.
      warnings.push({
        code: "INSUFFICIENT_DATA",
        message:
          `Single-stage record (σn = ${input.normalStressKpa} kPa, τ_peak = ${input.peakShearStressKpa} kPa) — ` +
            `a Mohr–Coulomb envelope needs at least 2 stages; c and φ are not reported (a second ` +
            `measurement is never invented).`,
        details: {
          normalStressKpa: input.normalStressKpa ?? null,
          peakShearStressKpa: input.peakShearStressKpa ?? null,
        },
      });
    }

    // Physical consistency — negative fitted parameters are reported as-is
    // (no clamping) with an advisory.
    for (const [kind, envelope] of [
      ["peak", peakEnvelope],
      ["residual", residualEnvelope],
    ] as const) {
      if (envelope !== null && (envelope.cohesionKpa < 0 || envelope.frictionAngleDeg < 0)) {
        warnings.push({
          code: "PHYSICAL_CONSISTENCY",
          message:
            `The fitted ${kind} Mohr–Coulomb envelope has a negative parameter ` +
              `(c = ${roundTo(envelope.cohesionKpa, PARAMETER_DECIMALS)} kPa, φ = ${roundTo(envelope.frictionAngleDeg, PARAMETER_DECIMALS)}°) — ` +
              `reported as computed, never clamped; check the stage measurements (curved or scattered ` +
              `strength envelopes extrapolate to negative intercepts).`,
          details: {
            envelope: kind,
            cohesionKpa: roundTo(envelope.cohesionKpa, WARNING_DETAIL_DECIMALS),
            frictionAngleDeg: roundTo(envelope.frictionAngleDeg, WARNING_DETAIL_DECIMALS),
          },
        });
      }
    }

    const raw: DirectShearRaw = { peakEnvelope, residualEnvelope };

    // Entered-value comparisons (peak envelope only — the registry stores
    // one c′/φ′ pair): ±1.0, entered echoed unchanged.
    if (input.cohesionKpa !== undefined && peakEnvelope !== null) {
      if (Math.abs(peakEnvelope.cohesionKpa - input.cohesionKpa) > DIRECT_SHEAR_ENTERED_TOLERANCE) {
        warnings.push({
          code: "ENTERED_VALUE_DISCREPANCY",
          message:
            `Computed peak cohesion ${roundTo(peakEnvelope.cohesionKpa, PARAMETER_DECIMALS)} kPa deviates by ` +
              `${roundTo(peakEnvelope.cohesionKpa - input.cohesionKpa, PARAMETER_DECIMALS)} kPa from the entered ` +
              `${input.cohesionKpa} kPa (tolerance ±${DIRECT_SHEAR_ENTERED_TOLERANCE}).`,
          details: {
            field: "cohesionKpa",
            computedValue: roundTo(peakEnvelope.cohesionKpa, WARNING_DETAIL_DECIMALS),
            enteredValue: input.cohesionKpa,
            discrepancy: roundTo(peakEnvelope.cohesionKpa - input.cohesionKpa, WARNING_DETAIL_DECIMALS),
            tolerance: DIRECT_SHEAR_ENTERED_TOLERANCE,
          },
        });
      }
    }
    if (input.frictionAngleDeg !== undefined && peakEnvelope !== null) {
      if (Math.abs(peakEnvelope.frictionAngleDeg - input.frictionAngleDeg) > DIRECT_SHEAR_ENTERED_TOLERANCE) {
        warnings.push({
          code: "ENTERED_VALUE_DISCREPANCY",
          message:
            `Computed peak friction angle ${roundTo(peakEnvelope.frictionAngleDeg, PARAMETER_DECIMALS)}° deviates by ` +
              `${roundTo(peakEnvelope.frictionAngleDeg - input.frictionAngleDeg, PARAMETER_DECIMALS)}° from the entered ` +
              `${input.frictionAngleDeg}° (tolerance ±${DIRECT_SHEAR_ENTERED_TOLERANCE}).`,
          details: {
            field: "frictionAngleDeg",
            computedValue: roundTo(peakEnvelope.frictionAngleDeg, WARNING_DETAIL_DECIMALS),
            enteredValue: input.frictionAngleDeg,
            discrepancy: roundTo(peakEnvelope.frictionAngleDeg - input.frictionAngleDeg, WARNING_DETAIL_DECIMALS),
            tolerance: DIRECT_SHEAR_ENTERED_TOLERANCE,
          },
        });
      }
    }

    // Output boundary.
    const results: DirectShearResults = {
      peakCohesionKpa: peakEnvelope === null ? null : roundTo(peakEnvelope.cohesionKpa, PARAMETER_DECIMALS),
      peakFrictionAngleDeg: peakEnvelope === null ? null : roundTo(peakEnvelope.frictionAngleDeg, PARAMETER_DECIMALS),
      peakRSquared: peakEnvelope === null ? null : roundTo(peakEnvelope.rSquared, R2_DECIMALS),
      peakPointCount: peakEnvelope?.pointCount ?? 0,
      residualCohesionKpa: residualEnvelope === null ? null : roundTo(residualEnvelope.cohesionKpa, PARAMETER_DECIMALS),
      residualFrictionAngleDeg: residualEnvelope === null ? null : roundTo(residualEnvelope.frictionAngleDeg, PARAMETER_DECIMALS),
      residualRSquared: residualEnvelope === null ? null : roundTo(residualEnvelope.rSquared, R2_DECIMALS),
      residualPointCount: residualEnvelope?.pointCount ?? 0,
      stages:
        input.stages?.map((s) => ({
          normalStressKpa: roundTo(s.normalStressKpa, STRESS_DECIMALS),
          peakShearStressKpa: roundTo(s.peakShearStressKpa, STRESS_DECIMALS),
          residualShearStressKpa:
            s.residualShearStressKpa === undefined ? null : roundTo(s.residualShearStressKpa, STRESS_DECIMALS),
        })) ?? [],
      singleStage:
        input.stages === undefined && input.normalStressKpa !== undefined && input.peakShearStressKpa !== undefined
          ? {
              normalStressKpa: roundTo(input.normalStressKpa, STRESS_DECIMALS),
              peakShearStressKpa: roundTo(input.peakShearStressKpa, STRESS_DECIMALS),
              residualShearStressKpa:
                input.residualShearStressKpa === undefined ? null : roundTo(input.residualShearStressKpa, STRESS_DECIMALS),
            }
          : null,
      drainageCondition: input.drainageCondition ?? null,
      enteredCohesionKpa: input.cohesionKpa ?? null,
      enteredFrictionAngleDeg: input.frictionAngleDeg ?? null,
    };

    return { raw, results, warnings };
  },
};
