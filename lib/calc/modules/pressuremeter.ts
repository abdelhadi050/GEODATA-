/**
 * GEODATA HUB — Ménard pressuremeter calculation module (M5.2-g).
 *
 * Serves registry test type PRESSUREMETER (standard citations verified in
 * M5.1: NF P94-110-1 / NF P94-110-2 / ASTM D4719). The module implements the
 * authorized M5.2-g scope with the following VERIFIED elements (web-verified
 * during M5.2-g, recorded in the governed constants registry, D8) and
 * DOCUMENTED numerical realizations:
 *
 *   - Injected volume: v(p) = volumeCm3(p) − referenceVolumeCm3 (the
 *     volume-reading baseline). When referenceVolumeCm3 is absent the
 *     supplied volumes are INTERPRETED AS zero-based injected volumes (the
 *     caller declares the baseline by its presence or absence — never a
 *     silent default). NET vs GROSS pressures are kept explicit: the module
 *     works on the measured (gauge) pressures as supplied; no hydrostatic or
 *     membrane correction is applied (see the corrections note below).
 *   - Creep pressure pf (EN ISO 22476-4:2021 definition, verified:
 *     "pressure defined as the intersection of two straight lines fitted on
 *     the creep curve"; the creep at a step is the volume difference between
 *     the 60 s and 30 s readings, V60 − V30). Numerical realization
 *     (documented): the creep curve (creep vs p over the steps that report a
 *     30 s reading) is fitted by two least-squares lines — over the FIRST
 *     HALF and over the SECOND HALF of the creep points — and pf is their
 *     intersection, reported only when it lies inside the measured creep
 *     pressure range (never extrapolated).
 *   - Pressuremeter modulus EM (verified definition, EN ISO 22476-4:2021:
 *     "modulus obtained from the section between (p1, V1) and (p2, V2) of
 *     the pressuremeter curve"; ISSMGE: EM = 2.66(Vc + vm)(p2 − p1)/(V2 − V1)
 *     with 2.66 = 2(1 + ν), ν = 0.33 — governed VERIFIED constant):
 *         EM [kPa] = 2(1+ν) × (Vc + (v1+v2)/2) × (p2 − p1)/(v2 − v1)
 *     where (p1, v1) and (p2, v2) are the boundaries of the PSEUDO-ELASTIC
 *     section: v1/v2 are read off the injected-volume curve by linear
 *     interpolation at the designated pressures. The section [p1, p2] is
 *     DESIGNATED BY THE ANALYST (`emRange`) — the standards determine it by
 *     a graphical construction whose exact procedure could not be verified
 *     against the standard texts (D8); the module never guesses it. p1 is
 *     cross-referenced with pf when both are known (both reported; the
 *     standards take p1 = pf).
 *   - Limit pressure PL (verified operational rule: the limit pressure is
 *     read at the injected volume vL = Vc + 2·v1, where Vc is the
 *     measuring-cell volume and v1 the injected volume at p1 — the total
 *     cell volume doubles from its value at p1, EN ISO 22476-4 "the volume
 *     of the test pocket has doubled its original volume"):
 *         PL = the pressure at injected volume vL, interpolated linearly
 *              between the bracketing curve points.
 *     p1 = the designated emRange.p1 when present, else the computed pf.
 *     When vL exceeds the largest measured injected volume the test has not
 *     reached the limit state: PL is null with an INSUFFICIENT_DATA warning
 *     (extrapolation — including the standard's double-hyperbola fit — is
 *     NOT performed; its model equations are unverified here, D8).
 *   - emPlRatio = EM × 1000 / PL (registry identity, kPa/MPa consistent),
 *     compared with the entered ratio within ±0.5 (registry tolerance).
 *
 * CORRECTIONS NOT APPLIED (D8-blocked, documented): the equipment
 * corrections of NF P94-110-2 (membrane restraint, probe/tubing volume
 * loss — EN ISO 22476-4 describes them through calibration parameters
 * a, b, c, d, e whose application equations could not be verified against
 * the standard text) and the hydrostatic head correction are NOT applied.
 * The registry's `membraneCalibration` / `probeCalibration` arrays are NOT
 * part of the calculable contract (stripped); `testDepthM` is echoed for
 * bookkeeping only. The module therefore analyses the curve AS MEASURED —
 * callers applying corrections upstream pass corrected readings.
 *
 * INPUT CONTRACT: the registry `pressuremeterResult` payload shape —
 * `points` (5–30, pressureKpa 0–5000 strictly increasing, volumeCm3 0–2000
 * non-decreasing — registry rules) plus the entered finals under their
 * registry field names and bounds: creepPressureKpa, limitPressureKpa
 * (0–10000), menardModulusMPa, emPlRatio. Engine-side extensions:
 * `volumeAt30sCm3` per point (the 30 s reading — enables the creep
 * construction), `referenceVolumeCm3`, `measuringCellVolumeCm3` (Vc,
 * required for EM/PL), `emRange` {p1Kpa, p2Kpa} (the analyst-designated
 * pseudo-elastic section, required for EM), `probeType` and `testDepthM`
 * (registry input mirrors, echoed). Unknown keys are stripped.
 *
 * SEMANTIC RULES (mirrors of the M5.1 superRefine): strictly increasing
 * point pressures; non-decreasing volumes with pressure; entered
 * creepPressureKpa < entered limitPressureKpa; entered emPlRatio =
 * entered menardModulusMPa × 1000 / entered limitPressureKpa within ±0.5.
 * Module rules: volumeAt30sCm3 ≤ volumeCm3 per point (expansion continues
 * during a hold); the injected volume must be non-negative at every point.
 *
 * ENTERED-VALUE COMPARISON: the computed emPlRatio is compared with the
 * entered ratio (±0.5, registry tolerance); EM, PL and pf themselves are
 * echoed WITHOUT comparison — the registry defines no tolerance for them
 * and none is invented (the M5.1 seed's entered pf/PL/EM are explicitly
 * "entered from the corrected curve" and need not match the raw-curve
 * construction; documented divergence).
 *
 * PRECISION: `raw` keeps full double precision; rounding happens only at
 * this output boundary — pressures 1 dp, volumes 2 dp, EM 2 dp (MPa),
 * emPlRatio 2 dp. Computed values are never clamped.
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
import { requireVerifiedConstant } from "../constants/sources";

export const PRESSUREMETER_MODULE_ID = "pressuremeter";
export const PRESSUREMETER_MODULE_VERSION = "1.0.0";

/** Registry identity tolerance for the emPlRatio comparison (±0.5, M5.1). */
export const PRESSUREMETER_RATIO_TOLERANCE = 0.5;

/** Registry contract bounds mirrored by this module. */
const MIN_POINTS = 5;
const MAX_POINTS = 30;
const MAX_POINT_PRESSURE = 5000;
const MAX_POINT_VOLUME = 2000;
const MIN_CREEP_PAIRS = 4;

/** Output boundary decimals. */
const PRESSURE_DECIMALS = 1;
const VOLUME_DECIMALS = 2;
const MODULUS_DECIMALS = 2;
const RATIO_DECIMALS = 2;
const WARNING_DETAIL_DECIMALS = 4;

/** One measured pressure step (registry point shape + the 30 s reading). */
export interface PressuremeterPoint {
  /** applied (gauge) pressure at the step, 0–5000 [kPa] */
  pressureKpa: number;
  /** volume reading at 60 s, 0–2000 [cm³] */
  volumeCm3: number;
  /** volume reading at 30 s (enables the creep construction), ≤ volumeCm3 */
  volumeAt30sCm3?: number | undefined;
}

/**
 * Input schema — the calculable core of the registry `pressuremeterResult`
 * contract (bounds identical) plus engine-side extensions. Exported for
 * compatibility tests. Unknown keys are stripped (Zod default).
 */
export const pressuremeterCalcInput = z.object({
  probeType: z.string().trim().min(1).max(60).optional(),
  testDepthM: z.number().min(0).max(200).optional(),
  points: z
    .array(
      z.object({
        pressureKpa: z.number().min(0).max(MAX_POINT_PRESSURE),
        volumeCm3: z.number().min(0).max(MAX_POINT_VOLUME),
        volumeAt30sCm3: z.number().min(0).max(MAX_POINT_VOLUME).optional(),
      }),
    )
    .min(MIN_POINTS)
    .max(MAX_POINTS),
  referenceVolumeCm3: z.number().min(0).max(MAX_POINT_VOLUME).optional(),
  measuringCellVolumeCm3: z.number().positive().max(5000).optional(),
  emRange: z
    .object({
      p1Kpa: z.number().positive().max(MAX_POINT_PRESSURE),
      p2Kpa: z.number().positive().max(MAX_POINT_PRESSURE),
    })
    .optional(),
  creepPressureKpa: z.number().min(0).max(MAX_POINT_PRESSURE).optional(),
  limitPressureKpa: z.number().min(0).max(10000).optional(),
  menardModulusMPa: z.number().min(0).max(2000).optional(),
  emPlRatio: z.number().min(0).max(200).optional(),
});

export interface PressuremeterInput {
  probeType?: string | undefined;
  testDepthM?: number | undefined;
  points: PressuremeterPoint[];
  referenceVolumeCm3?: number | undefined;
  measuringCellVolumeCm3?: number | undefined;
  emRange?: { p1Kpa: number; p2Kpa: number } | undefined;
  creepPressureKpa?: number | undefined;
  limitPressureKpa?: number | undefined;
  menardModulusMPa?: number | undefined;
  emPlRatio?: number | undefined;
}

/** Full-precision internal values (never rounded, never clamped). */
export interface PressuremeterRaw {
  /** injected volume at each point [cm³] (reading − reference, or reading) */
  injectedVolumesCm3: number[];
  /** creep (V60 − V30) at the steps reporting a 30 s reading [cm³] */
  creepCm3: Array<{ pressureKpa: number; creepCm3: number }>;
  /** creep pressure from the two-line intersection; null when not derivable */
  creepPressureKpa: number | null;
  /** the p1 used for EM/PL (designated emRange.p1 or the computed pf) [kPa] */
  analysisP1Kpa: number | null;
  /** injected volume at p1 [cm³]; null when p1 is unknown */
  v1Cm3: number | null;
  /** injected volume at the designated p2 [cm³]; null without emRange */
  v2Cm3: number | null;
  /** Ménard modulus [kPa]; null when not computable */
  menardModulusKpa: number | null;
  /** limit-pressure target injected volume Vc + 2·v1 [cm³]; null when not derivable */
  limitVolumeCm3: number | null;
  /** limit pressure [kPa]; null when not reached within the measured range */
  limitPressureKpa: number | null;
  /** EM × 1000 / PL (registry identity); null when EM or PL is missing */
  emPlRatio: number | null;
}

/** Output-boundary results (rounded; entered values echoed unchanged). */
export interface PressuremeterResults {
  probeType: string | null;
  testDepthM: number | null;
  /** the analysis curve (as measured — no corrections applied, documented) */
  curve: Array<{ pressureKpa: number; volumeCm3: number; injectedVolumeCm3: number }>;
  /** creep pressure (two-line construction), 1 dp [kPa]; null when not derivable */
  creepPressureKpa: number | null;
  /** Ménard modulus, 2 dp [MPa]; null when not computable */
  menardModulusMPa: number | null;
  /** limit pressure, 1 dp [kPa]; null when not reached within the measured range */
  limitPressureKpa: number | null;
  /** EM × 1000 / PL, 2 dp; null when EM or PL is missing */
  emPlRatio: number | null;
  /** the p1 used for the EM/PL analysis [kPa]; null when unknown */
  analysisP1Kpa: number | null;
  /** laboratory-entered finals, echoed unchanged (null when absent) */
  enteredCreepPressureKpa: number | null;
  enteredLimitPressureKpa: number | null;
  enteredMenardModulusMPa: number | null;
  enteredEmPlRatio: number | null;
}

// ---------------------------------------------------------------------------
// Curve helpers (exported for direct unit testing)
// ---------------------------------------------------------------------------

/**
 * Injected volume at a target pressure: exact hit returns the point's
 * injected volume; otherwise linear interpolation in pressure between the
 * bracketing points. Targets outside the measured range throw
 * ArithmeticDomainError (never extrapolated).
 * PRECONDITION: points have strictly increasing pressure.
 */
export function injectedVolumeAtPressure(
  points: ReadonlyArray<{ pressureKpa: number; injectedVolumeCm3: number }>,
  targetPressureKpa: number,
): number {
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.pressureKpa === targetPressureKpa) return p.injectedVolumeCm3;
    if (p.pressureKpa > targetPressureKpa) {
      if (i === 0) {
        throw new ArithmeticDomainError(
          "injectedVolumeAtPressure",
          `Target pressure ${targetPressureKpa} kPa lies below the measured range (first point ${p.pressureKpa} kPa) — extrapolation is not performed.`,
        );
      }
      const prev = points[i - 1];
      const span = p.pressureKpa - prev.pressureKpa;
      const fraction = (targetPressureKpa - prev.pressureKpa) / span;
      const interpolated = prev.injectedVolumeCm3 + (p.injectedVolumeCm3 - prev.injectedVolumeCm3) * fraction;
      assertFiniteNumber("injectedVolumeAtPressure", interpolated);
      return interpolated;
    }
  }
  throw new ArithmeticDomainError(
    "injectedVolumeAtPressure",
    `Target pressure ${targetPressureKpa} kPa lies above the measured range (last point ${points[points.length - 1].pressureKpa} kPa) — extrapolation is not performed.`,
  );
}

/**
 * Pressure at a target INJECTED volume: linear interpolation in volume
 * between the bracketing points; a target below the first or above the last
 * injected volume returns null (never extrapolated — the caller decides how
 * to report an unreached limit state).
 * PRECONDITION: points have strictly increasing pressure and non-decreasing
 * injected volume.
 */
export function pressureAtInjectedVolume(
  points: ReadonlyArray<{ pressureKpa: number; injectedVolumeCm3: number }>,
  targetVolumeCm3: number,
): number | null {
  if (targetVolumeCm3 < points[0].injectedVolumeCm3) return null;
  for (let i = 1; i < points.length; i++) {
    const v1 = points[i - 1].injectedVolumeCm3;
    const v2 = points[i].injectedVolumeCm3;
    if (targetVolumeCm3 <= v2) {
      if (v2 === v1) return points[i - 1].pressureKpa;
      const fraction = (targetVolumeCm3 - v1) / (v2 - v1);
      const interpolated = points[i - 1].pressureKpa + (points[i].pressureKpa - points[i - 1].pressureKpa) * fraction;
      assertFiniteNumber("pressureAtInjectedVolume", interpolated);
      return interpolated;
    }
  }
  return null;
}

/**
 * Creep pressure: intersection of the least-squares line over the FIRST
 * HALF and the line over the SECOND HALF of the creep points (the
 * documented numerical realization of the standard's "intersection of two
 * straight lines fitted on the creep curve"). Returns null when fewer than
 * 4 creep points exist, the lines are parallel, or the intersection lies
 * outside the measured creep pressure range.
 */
export function creepPressureFromCreepCurve(
  creep: ReadonlyArray<{ pressureKpa: number; creepCm3: number }>,
): { pressureKpa: number | null; firstHalfSlope: number; secondHalfSlope: number } {
  const n = creep.length;
  const half = Math.floor(n / 2);
  const first = creep.slice(0, Math.max(2, half));
  const second = creep.slice(Math.max(2, half));
  const fit = (pts: ReadonlyArray<{ pressureKpa: number; creepCm3: number }>) => {
    const m = pts.length;
    let sx = 0;
    let sy = 0;
    for (const p of pts) {
      sx += p.pressureKpa;
      sy += p.creepCm3;
    }
    const xm = sx / m;
    const ym = sy / m;
    let sxy = 0;
    let sxx = 0;
    for (const p of pts) {
      sxy += (p.pressureKpa - xm) * (p.creepCm3 - ym);
      sxx += (p.pressureKpa - xm) * (p.pressureKpa - xm);
    }
    const slope = sxy / sxx;
    return { slope, intercept: ym - slope * xm };
  };
  const firstFit = fit(first);
  const secondFit = fit(second);
  const denominator = firstFit.slope - secondFit.slope;
  if (denominator === 0 || !Number.isFinite(denominator)) {
    return { pressureKpa: null, firstHalfSlope: firstFit.slope, secondHalfSlope: secondFit.slope };
  }
  const intersection =
    (secondFit.intercept - firstFit.intercept) / denominator;
  assertFiniteNumber("creepPressureFromCreepCurve", intersection);
  const minP = creep[0].pressureKpa;
  const maxP = creep[creep.length - 1].pressureKpa;
  if (!(intersection >= minP && intersection <= maxP)) {
    return { pressureKpa: null, firstHalfSlope: firstFit.slope, secondHalfSlope: secondFit.slope };
  }
  return { pressureKpa: intersection, firstHalfSlope: firstFit.slope, secondHalfSlope: secondFit.slope };
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export const pressuremeterModule: CalculationModule<
  PressuremeterInput,
  PressuremeterRaw,
  PressuremeterResults
> = {
  id: PRESSUREMETER_MODULE_ID,
  testType: "PRESSUREMETER",
  version: PRESSUREMETER_MODULE_VERSION,
  label: "Ménard pressuremeter (pf creep construction, EM from the designated section, PL at Vc + 2·v1)",
  description:
    "Analyses the measured pressure-volume curve as supplied (no equipment or hydrostatic corrections — their standard procedures are unverified, D8): computes the creep pressure from the intersection of two fitted lines on the V60−V30 creep curve (EN ISO 22476-4 definition), the Ménard modulus EM = 2(1+ν)·(Vc + vm)·(p2−p1)/(v2−v1) with the governed ν = 0.33 over the analyst-designated pseudo-elastic section (the standard's graphical section determination is not encoded — never guessed), the limit pressure at the doubled-volume target vL = Vc + 2·v1 interpolated on the measured curve (null when the test has not reached the limit state — no extrapolation), and the EM/PL ratio; cross-checks the entered ratio within the registry ±0.5 and echoes all entered finals without overwriting them.",

  validateInput(raw: unknown): PressuremeterInput {
    if (raw !== null && typeof raw === "object") {
      const record = raw as Record<string, unknown>;
      if (record.points === undefined) {
        throw new MissingInputError(
          "Missing required input field(s): points",
          [{ path: "points", code: "missing", message: "points is required (the pressure-volume readings)." }],
        );
      }
    }
    const parsed = pressuremeterCalcInput.safeParse(raw);
    if (!parsed.success) {
      throw zodErrorToCalculationError(parsed.error, raw);
    }
    const input = parsed.data;

    // Registry mirrors: strictly increasing pressures, non-decreasing volumes.
    for (let i = 1; i < input.points.length; i++) {
      if (input.points[i].pressureKpa <= input.points[i - 1].pressureKpa) {
        throw new InvalidInputError(
          `points.${i}.pressureKpa`,
          `Point pressures must be strictly increasing (point ${i}: ${input.points[i].pressureKpa} kPa follows ${input.points[i - 1].pressureKpa} kPa) — M5.1 contract.`,
        );
      }
      if (input.points[i].volumeCm3 < input.points[i - 1].volumeCm3 - 0.01) {
        throw new InvalidInputError(
          `points.${i}.volumeCm3`,
          `volumeCm3 must be non-decreasing with pressure (point ${i}: ${input.points[i].volumeCm3} cm³ follows ${input.points[i - 1].volumeCm3} cm³) — M5.1 contract (monotonic loading sequence).`,
        );
      }
      const reading30 = input.points[i].volumeAt30sCm3;
      if (reading30 !== undefined && reading30 > input.points[i].volumeCm3) {
        throw new InvalidInputError(
          `points.${i}.volumeAt30sCm3`,
          `volumeAt30sCm3 (${reading30} cm³) cannot exceed the 60 s reading volumeCm3 (${input.points[i].volumeCm3} cm³) — expansion continues during a pressure hold.`,
        );
      }
    }
    // The reference baseline must not exceed any reading.
    if (input.referenceVolumeCm3 !== undefined) {
      for (let i = 0; i < input.points.length; i++) {
        if (input.referenceVolumeCm3 > input.points[i].volumeCm3) {
          throw new InvalidInputError(
            `points.${i}.volumeCm3`,
            `referenceVolumeCm3 (${input.referenceVolumeCm3} cm³) exceeds the reading at point ${i} (${input.points[i].volumeCm3} cm³) — the injected volume would be negative.`,
          );
        }
      }
    }
    // emRange internal ordering.
    if (input.emRange !== undefined && input.emRange.p2Kpa <= input.emRange.p1Kpa) {
      throw new InvalidInputError(
        "emRange.p2Kpa",
        `emRange.p2Kpa (${input.emRange.p2Kpa} kPa) must be greater than p1Kpa (${input.emRange.p1Kpa} kPa) — the pseudo-elastic section is a positive pressure interval.`,
      );
    }
    // Registry identity mirrors on the entered finals.
    if (
      input.creepPressureKpa !== undefined &&
      input.limitPressureKpa !== undefined &&
      input.creepPressureKpa >= input.limitPressureKpa
    ) {
      throw new InvalidInputError(
        "creepPressureKpa",
        `creepPressureKpa (pf = ${input.creepPressureKpa} kPa) must be lower than limitPressureKpa (PL = ${input.limitPressureKpa} kPa) — M5.1 contract.`,
      );
    }
    if (
      input.menardModulusMPa !== undefined &&
      input.limitPressureKpa !== undefined &&
      input.limitPressureKpa > 0 &&
      input.emPlRatio !== undefined
    ) {
      const expected = (input.menardModulusMPa * 1000) / input.limitPressureKpa;
      if (Math.abs(input.emPlRatio - expected) > PRESSUREMETER_RATIO_TOLERANCE) {
        throw new InvalidInputError(
          "emPlRatio",
          `emPlRatio must equal menardModulusMPa × 1000 / limitPressureKpa (entered ${input.emPlRatio} vs ` +
            `${input.menardModulusMPa} × 1000 / ${input.limitPressureKpa} = ${expected}; tolerance ±${PRESSUREMETER_RATIO_TOLERANCE}, M5.1 contract).`,
        );
      }
    }
    return input;
  },

  compute(input: PressuremeterInput) {
    const warnings: CalculationWarning[] = [];

    // 1. Analysis curve: injected volumes (reading − reference, or reading).
    const curve = input.points.map((p) => ({
      pressureKpa: p.pressureKpa,
      injectedVolumeCm3:
        input.referenceVolumeCm3 === undefined ? p.volumeCm3 : p.volumeCm3 - input.referenceVolumeCm3,
    }));

    // 2. Creep pressure — two-line intersection on the creep curve.
    const creep = input.points
      .filter((p) => p.volumeAt30sCm3 !== undefined)
      .map((p) => ({ pressureKpa: p.pressureKpa, creepCm3: p.volumeCm3 - (p.volumeAt30sCm3 ?? 0) }));
    let creepPressureKpa: number | null = null;
    if (creep.length >= MIN_CREEP_PAIRS) {
      const construction = creepPressureFromCreepCurve(creep);
      creepPressureKpa = construction.pressureKpa;
      if (creepPressureKpa === null) {
        warnings.push({
          code: "INSUFFICIENT_DATA",
          message:
            `The two-line creep construction does not yield a creep pressure inside the measured creep range ` +
              `[${creep[0].pressureKpa}, ${creep[creep.length - 1].pressureKpa}] kPa (fitted slopes ` +
              `${roundTo(construction.firstHalfSlope, 6)} and ${roundTo(construction.secondHalfSlope, 6)} cm³/kPa) — ` +
              `pf is not reported (never extrapolated).`,
          details: {
            creepPointCount: creep.length,
            firstHalfSlope: roundTo(construction.firstHalfSlope, WARNING_DETAIL_DECIMALS),
            secondHalfSlope: roundTo(construction.secondHalfSlope, WARNING_DETAIL_DECIMALS),
          },
        });
      }
    } else if (creep.length > 0) {
      warnings.push({
        code: "INSUFFICIENT_DATA",
        message:
          `Only ${creep.length} of ${input.points.length} steps report a 30 s reading — at least ${MIN_CREEP_PAIRS} ` +
            `creep pairs are needed for the two-line creep construction; pf is not reported (never invented).`,
        details: { creepPointCount: creep.length },
      });
    } else {
      warnings.push({
        code: "INSUFFICIENT_DATA",
        message:
          `No 30 s readings supplied — the creep construction (V60 − V30 per step) is not possible; ` +
            `pf is not reported (never invented).`,
        details: { creepPointCount: 0 },
      });
    }

    // 3. Analysis p1: the designated emRange.p1, else the computed pf.
    const analysisP1Kpa = input.emRange?.p1Kpa ?? creepPressureKpa;

    // 4. Ménard modulus — over the designated section (needs Vc and emRange).
    let menardModulusKpa: number | null = null;
    let v1Cm3: number | null = null;
    let v2Cm3: number | null = null;
    if (input.measuringCellVolumeCm3 === undefined) {
      warnings.push({
        code: "INSUFFICIENT_DATA",
        message:
          `No measuringCellVolumeCm3 (Vc) supplied — the Ménard modulus and the limit pressure depend on the ` +
            `probe cell volume; neither is computed (never invented).`,
        details: { measuringCellVolumeCm3: null },
      });
    }
    if (input.emRange === undefined) {
      warnings.push({
        code: "INSUFFICIENT_DATA",
        message:
          `No emRange supplied — the pseudo-elastic section [p1, p2] of the Ménard modulus must be designated ` +
            `by the analyst (the standards determine it by a graphical construction not encoded here, D8); ` +
            `EM is not computed (never guessed).`,
        details: { emRange: null },
      });
    }
    if (input.measuringCellVolumeCm3 !== undefined && input.emRange !== undefined) {
      const { p1Kpa, p2Kpa } = input.emRange;
      try {
        v1Cm3 = injectedVolumeAtPressure(curve, p1Kpa);
        v2Cm3 = injectedVolumeAtPressure(curve, p2Kpa);
      } catch (error) {
        throw new InvalidInputError(
          "emRange",
          `The designated pseudo-elastic section [${p1Kpa}, ${p2Kpa}] kPa lies outside the measured pressure range ` +
            `[${curve[0].pressureKpa}, ${curve[curve.length - 1].pressureKpa}] kPa — ${(error as Error).message}`,
        );
      }
      if (v2Cm3 <= v1Cm3) {
        throw new InvalidInputError(
          "emRange",
          `The designated section does not expand (v2 = ${roundTo(v2Cm3, VOLUME_DECIMALS)} cm³ ≤ v1 = ${roundTo(v1Cm3, VOLUME_DECIMALS)} cm³) — the pseudo-elastic section must show a positive volume increase.`,
        );
      }
      const nu = requireVerifiedConstant("pressuremeter.menardPoissonRatio");
      const factor = 2 * (1 + nu);
      const vMid = (v1Cm3 + v2Cm3) / 2;
      const totalVolumeAtMid = input.measuringCellVolumeCm3 + vMid;
      const modulusKpa = (factor * totalVolumeAtMid * (p2Kpa - p1Kpa)) / (v2Cm3 - v1Cm3);
      assertFiniteNumber("menardModulus", modulusKpa);
      menardModulusKpa = modulusKpa;
    }

    // 5. Limit pressure — at the doubled-volume target vL = Vc + 2·v1.
    let limitVolumeCm3: number | null = null;
    let limitPressureKpa: number | null = null;
    if (input.measuringCellVolumeCm3 !== undefined && analysisP1Kpa !== null) {
      try {
        v1Cm3 = v1Cm3 ?? injectedVolumeAtPressure(curve, analysisP1Kpa);
      } catch (error) {
        throw new InvalidInputError(
          "emRange",
          `The analysis pressure p1 (${analysisP1Kpa} kPa) lies outside the measured pressure range — ${(error as Error).message}`,
        );
      }
      limitVolumeCm3 = input.measuringCellVolumeCm3 + 2 * v1Cm3;
      const maxInjected = curve[curve.length - 1].injectedVolumeCm3;
      limitPressureKpa = pressureAtInjectedVolume(curve, limitVolumeCm3);
      if (limitPressureKpa === null) {
        warnings.push({
          code: "INSUFFICIENT_DATA",
          message:
            `The limit-state volume vL = Vc + 2·v1 = ${roundTo(limitVolumeCm3, VOLUME_DECIMALS)} cm³ exceeds the largest ` +
              `measured injected volume (${roundTo(maxInjected, VOLUME_DECIMALS)} cm³) — the test has not reached the ` +
              `limit state within the measured range; extrapolation (including the standard's model-based ` +
              `extension) is not performed and PL is not reported.`,
          details: {
            limitVolumeCm3: roundTo(limitVolumeCm3, WARNING_DETAIL_DECIMALS),
            maxInjectedVolumeCm3: roundTo(maxInjected, WARNING_DETAIL_DECIMALS),
            measuringCellVolumeCm3: input.measuringCellVolumeCm3,
            v1Cm3: roundTo(v1Cm3, WARNING_DETAIL_DECIMALS),
          },
        });
      }
    } else if (input.measuringCellVolumeCm3 !== undefined && analysisP1Kpa === null) {
      warnings.push({
        code: "INSUFFICIENT_DATA",
        message:
          `No analysis pressure p1 available (neither a designated emRange.p1 nor a computable creep pressure) — ` +
            `the limit-pressure volume target vL = Vc + 2·v1 is undefined; PL is not reported.`,
        details: { analysisP1Kpa: null },
      });
    }

    // 6. emPlRatio (registry identity) + entered comparison (±0.5).
    const emPlRatio =
      menardModulusKpa !== null && limitPressureKpa !== null && limitPressureKpa > 0
        ? (menardModulusKpa * 1) / limitPressureKpa
        : null;
    if (
      emPlRatio !== null &&
      input.emPlRatio !== undefined &&
      Math.abs(emPlRatio - input.emPlRatio) > PRESSUREMETER_RATIO_TOLERANCE
    ) {
      warnings.push({
        code: "ENTERED_VALUE_DISCREPANCY",
        message:
          `Computed EM/PL ratio ${roundTo(emPlRatio, RATIO_DECIMALS)} deviates by ` +
            `${roundTo(emPlRatio - input.emPlRatio, RATIO_DECIMALS)} from the entered ${input.emPlRatio} ` +
            `(tolerance ±${PRESSUREMETER_RATIO_TOLERANCE}).`,
        details: {
          field: "emPlRatio",
          computedValue: roundTo(emPlRatio, WARNING_DETAIL_DECIMALS),
          enteredValue: input.emPlRatio,
          discrepancy: roundTo(emPlRatio - input.emPlRatio, WARNING_DETAIL_DECIMALS),
          tolerance: PRESSUREMETER_RATIO_TOLERANCE,
        },
      });
    }

    const raw: PressuremeterRaw = {
      injectedVolumesCm3: curve.map((c) => c.injectedVolumeCm3),
      creepCm3: creep,
      creepPressureKpa,
      analysisP1Kpa,
      v1Cm3,
      v2Cm3,
      menardModulusKpa,
      limitVolumeCm3,
      limitPressureKpa,
      emPlRatio,
    };

    // 7. Output boundary.
    const results: PressuremeterResults = {
      probeType: input.probeType ?? null,
      testDepthM: input.testDepthM ?? null,
      curve: input.points.map((p, i) => ({
        pressureKpa: roundTo(p.pressureKpa, PRESSURE_DECIMALS),
        volumeCm3: roundTo(p.volumeCm3, VOLUME_DECIMALS),
        injectedVolumeCm3: roundTo(curve[i].injectedVolumeCm3, VOLUME_DECIMALS),
      })),
      creepPressureKpa: creepPressureKpa === null ? null : roundTo(creepPressureKpa, PRESSURE_DECIMALS),
      menardModulusMPa: menardModulusKpa === null ? null : roundTo(menardModulusKpa / 1000, MODULUS_DECIMALS),
      limitPressureKpa: limitPressureKpa === null ? null : roundTo(limitPressureKpa, PRESSURE_DECIMALS),
      emPlRatio: emPlRatio === null ? null : roundTo(emPlRatio, RATIO_DECIMALS),
      analysisP1Kpa: analysisP1Kpa === null ? null : roundTo(analysisP1Kpa, PRESSURE_DECIMALS),
      enteredCreepPressureKpa: input.creepPressureKpa ?? null,
      enteredLimitPressureKpa: input.limitPressureKpa ?? null,
      enteredMenardModulusMPa: input.menardModulusMPa ?? null,
      enteredEmPlRatio: input.emPlRatio ?? null,
    };

    return { raw, results, warnings };
  },
};
