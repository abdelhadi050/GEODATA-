/**
 * GEODATA HUB — Laboratory test registry (M2, extended in M5.1).
 *
 * Central authority for the 13 supported geotechnical test types. Every lab
 * result stored in `LabTest.resultData` (Json) is validated against the
 * `resultSchema` of its test type, and every input payload stored in
 * `LabTest.inputData` (Json, M5.1) is validated against its `inputSchema` —
 * neither is EVER stored as unvalidated arbitrary JSON.
 *
 * Each registry entry provides:
 *   - identification: code, label, description, standard reference, category
 *   - inputSchema:  Zod schema for test-definition inputs (planned parameters)
 *   - resultSchema: Zod schema for the structured, measured results
 *   - units:        unit map for every quantitative field family
 *   - validation:   human-readable summary of the cross-field rules enforced
 *   - chart:        chart configuration consumed by the visualization layer (M5)
 *
 * M5.1 scope note: the registry defines DATA CONTRACTS and write-time
 * consistency rules only. Derived quantities (curve fits, interpolations,
 * classifications) belong to the M5.2 calculation engine; every derived
 * parameter that a standard defines through a standard-specific procedure
 * remains user-entered here and is cross-checked only by plain arithmetic
 * identities (e.g. PI = LL − PL, Cc = d30²/(d60·d10)).
 */
import { z } from "zod";

export const LAB_TEST_TYPES = [
  "GRANULOMETRY",
  "ATTERBERG_LIMITS",
  "PROCTOR",
  "CBR",
  "SPT",
  "CPT",
  "UCS",
  "TRIAXIAL",
  "OEDOMETER",
  "DIRECT_SHEAR",
  "WATER_CONTENT",
  "SPECIFIC_GRAVITY",
  "PRESSUREMETER",
] as const;

export type LabTestType = (typeof LAB_TEST_TYPES)[number];

export type ChartConfig =
  | { kind: "grainSizeCurve"; x: string; y: string }
  | { kind: "plasticityChart"; x: string; y: string }
  | { kind: "compactionCurve"; x: string; y: string }
  | { kind: "cbrCurve"; x: string; y: string }
  | { kind: "depthProfile"; y: string; value: string }
  | { kind: "cptProfile"; y: string; series: string[] }
  | { kind: "oedometerCurve"; x: string; y: string }
  | { kind: "barSummary"; value: string; groupBy?: string }
  // M5.1: contract only — the renderer arrives with the M5.3 chart milestone.
  // Until then the M4 chart component renders its "Unknown chart configuration"
  // empty state for this kind (graceful, no crash).
  | { kind: "pressuremeterCurve"; x: string; y: string }
  | { kind: "none" };

export interface LabTestDefinition {
  code: LabTestType;
  label: string;
  description: string;
  standard: string;
  category: "INDEX_PROPERTIES" | "COMPACTION" | "MECHANICAL" | "IN_SITU";
  inputSchema: z.ZodTypeAny;
  resultSchema: z.ZodTypeAny;
  units: Record<string, string>;
  validationNotes: string[];
  chart: ChartConfig;
}

// ---------- shared field builders ----------
const pct = z.number().min(0).max(100);
const deg = (min: number, max: number) => z.number().min(min).max(max);

// ---------- 1. GRANULOMETRY ----------
const granulometryInput = z.object({
  method: z.enum(["SIEVE", "SIEVE_AND_HYDROMETER"]),
  sampleMassKg: z.number().min(0.1).max(50).optional(),
  notes: z.string().max(2000).optional(),
});

const granulometryResult = z
  .object({
    points: z
      .array(
        z.object({
          diameterMm: z.number().positive().max(300),
          percentFiner: pct,
        }),
      )
      .min(4)
      .max(40),
    d10: z.number().positive().optional(),
    d30: z.number().positive().optional(),
    d60: z.number().positive().optional(),
    uniformityCoefficient: z.number().positive().optional(),
    coefficientOfCurvature: z.number().positive().optional(),
    uscsClassification: z.string().max(16).optional(),
  })
  .superRefine((data, ctx) => {
    const pts = [...data.points].sort((a, b) => a.diameterMm - b.diameterMm);
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].percentFiner < pts[i - 1].percentFiner - 0.01) {
        ctx.addIssue({
          code: "custom",
          message:
            "percentFiner must be non-decreasing as particle diameter increases (more material is finer than a larger threshold)",
        });
        return;
      }
    }
    const diameters = new Set(pts.map((p) => p.diameterMm));
    if (diameters.size !== pts.length) {
      ctx.addIssue({
        code: "custom",
        message: "diameterMm values must be unique",
      });
    }
    if (data.d10 && data.d60) {
      const cu = data.d60 / data.d10;
      if (data.uniformityCoefficient && Math.abs(data.uniformityCoefficient - cu) > 0.05) {
        ctx.addIssue({
          code: "custom",
          message: "uniformityCoefficient must equal d60 / d10",
        });
      }
    }
    // M5.1: Cc consistency (Cc = d30² / (d60 · d10)) — plain arithmetic identity,
    // fired only when d10, d30, d60 and the stored Cc are all present.
    if (data.d10 && data.d30 && data.d60 && data.coefficientOfCurvature) {
      const cc = (data.d30 * data.d30) / (data.d60 * data.d10);
      if (Math.abs(data.coefficientOfCurvature - cc) > 0.05) {
        ctx.addIssue({
          code: "custom",
          message: "coefficientOfCurvature must equal d30² / (d60 × d10)",
        });
      }
    }
  });

// ---------- 2. ATTERBERG LIMITS ----------
const atterbergInput = z.object({
  method: z.enum(["CASAGRANDE_CUP", "CONE_PENETROMETER"]),
  notes: z.string().max(2000).optional(),
});

const atterbergResult = z
  .object({
    liquidLimit: deg(10, 150),
    plasticLimit: deg(5, 100),
    plasticityIndex: deg(0, 100),
    shrinkageLimit: deg(5, 100).optional(),
    liquidityIndex: z.number().min(-1).max(2).optional(),
    uscsSymbol: z.string().max(16).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.plasticLimit >= data.liquidLimit) {
      ctx.addIssue({
        code: "custom",
        message: "plasticLimit must be lower than liquidLimit",
      });
      return;
    }
    const expected = data.liquidLimit - data.plasticLimit;
    if (Math.abs(data.plasticityIndex - expected) > 1.0) {
      ctx.addIssue({
        code: "custom",
        message: "plasticityIndex must equal liquidLimit - plasticLimit (±1)",
      });
    }
  });

// ---------- 3. PROCTOR ----------
const proctorInput = z.object({
  method: z.enum(["STANDARD", "MODIFIED"]),
  mold: z.enum(["101.6MM", "152.4MM"]).optional(),
  notes: z.string().max(2000).optional(),
});

const proctorResult = z
  .object({
    method: z.enum(["STANDARD", "MODIFIED"]),
    points: z
      .array(
        z.object({
          moistureContent: deg(0, 60),
          dryDensity: z.number().min(1.0).max(2.7),
          // M5.1 (approved D4): optional wet (bulk) density per point. The
          // ρd = ρ/(1+w) derivation helper arrives with the M5.2 calculation
          // engine; here we only enforce the physical identity ρwet ≥ ρd.
          wetDensityMgM3: z.number().min(1.0).max(3.0).optional(),
        }),
      )
      .min(3)
      .max(8),
    maxDryDensity: z.number().min(1.0).max(2.7),
    optimumMoisture: deg(0, 60),
  })
  .superRefine((data, ctx) => {
    const densities = data.points.map((p) => p.dryDensity);
    const moistures = data.points.map((p) => p.moistureContent);
    const peak = Math.max(...densities);
    if (data.maxDryDensity < peak - 0.01) {
      ctx.addIssue({
        code: "custom",
        message: "maxDryDensity cannot be lower than the highest measured point",
      });
    }
    if (data.maxDryDensity > peak + 0.2) {
      ctx.addIssue({
        code: "custom",
        message: "maxDryDensity is inconsistent with the measured curve",
      });
    }
    const minM = Math.min(...moistures);
    const maxM = Math.max(...moistures);
    if (data.optimumMoisture < minM - 1 || data.optimumMoisture > maxM + 1) {
      ctx.addIssue({
        code: "custom",
        message: "optimumMoisture must lie within the tested moisture range (±1)",
      });
    }
    // M5.1: wet density, when recorded, can never be lower than the dry
    // density of the same point (ρwet = ρd × (1 + w), w ≥ 0).
    for (const p of data.points) {
      if (p.wetDensityMgM3 != null && p.wetDensityMgM3 < p.dryDensity - 0.001) {
        ctx.addIssue({
          code: "custom",
          message: "wetDensityMgM3 must be greater than or equal to dryDensity (ρwet = ρd × (1 + w))",
        });
        break;
      }
    }
  });

// ---------- 4. CBR ----------
const cbrInput = z.object({
  condition: z.enum(["SOAKED", "UNSOAKED"]),
  surchargeKg: z.number().min(0).max(50).optional(),
  soakingDays: z.number().int().min(0).max(10).optional(),
  notes: z.string().max(2000).optional(),
});

const cbrResult = z
  .object({
    condition: z.enum(["SOAKED", "UNSOAKED"]),
    points: z
      .array(
        z.object({
          penetrationMm: z.number().min(0).max(15),
          loadKn: z.number().min(0).max(60),
        }),
      )
      .min(2)
      .max(20),
    cbrAt2_5: pct,
    cbrAt5_0: pct,
    cbrValue: pct,
    swellPercent: z.number().min(0).max(15).optional(),
  })
  .superRefine((data, ctx) => {
    const expected = Math.max(data.cbrAt2_5, data.cbrAt5_0);
    if (Math.abs(data.cbrValue - expected) > 0.01) {
      ctx.addIssue({
        code: "custom",
        message: "cbrValue must equal max(cbrAt2_5, cbrAt5_0)",
      });
    }
    const penetrations = data.points.map((p) => p.penetrationMm);
    if (new Set(penetrations).size !== penetrations.length) {
      ctx.addIssue({
        code: "custom",
        message: "penetrationMm values must be unique",
      });
    }
  });

// ---------- 5. SPT ----------
const sptInput = z.object({
  hammerType: z.enum(["SAFETY", "AUTOMATIC", "DONUT"]),
  energyRatio: deg(30, 100).optional(),
  // M5.1: effective vertical stress at the test depth (user-entered, kPa).
  // It enables the (N1)60 overburden correction, which arrives with the M5.2
  // calculation engine once the CN formula is verified and cited (Liao &
  // Whitman / Youd et al. — NOT implemented here; no default is invented).
  effectiveOverburdenKpa: z.number().min(0.1).max(2000).optional(),
  notes: z.string().max(2000).optional(),
});

const sptResult = z
  .object({
    depthFrom: deg(0, 200),
    depthTo: deg(0, 200),
    hammerType: z.enum(["SAFETY", "AUTOMATIC", "DONUT"]),
    blows1st150: z.number().int().min(0).max(60),
    blows2nd150: z.number().int().min(0).max(60),
    blows3rd150: z.number().int().min(0).max(60),
    nValue: z.number().int().min(0).max(120),
    energyRatio: deg(30, 100).optional(),
    n60: z.number().min(0).max(120).optional(),
    refusal: z.boolean().optional(),
    soilDescription: z.string().max(200).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.depthTo <= data.depthFrom) {
      ctx.addIssue({ code: "custom", message: "depthTo must be greater than depthFrom" });
      return;
    }
    if (data.nValue !== data.blows2nd150 + data.blows3rd150) {
      ctx.addIssue({
        code: "custom",
        message: "nValue must equal blows2nd150 + blows3rd150",
      });
    }
    if (data.energyRatio != null && data.n60 != null) {
      const expected = (data.nValue * data.energyRatio) / 60;
      if (Math.abs(data.n60 - expected) > 0.5) {
        ctx.addIssue({
          code: "custom",
          message: "n60 must equal nValue × energyRatio / 60",
        });
      }
    }
  });

// ---------- 6. CPT ----------
const cptInput = z.object({
  coneType: z.enum(["STANDARD_10CM2", "STANDARD_15CM2"]),
  porePressure: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
});

const cptResult = z
  .object({
    finalDepth: z.number().positive().max(100),
    points: z
      .array(
        z.object({
          depth: z.number().positive().max(100),
          coneResistanceMpa: z.number().min(0).max(120),
          sleeveFrictionKpa: z.number().min(0).max(900),
        }),
      )
      .min(2)
      .max(600),
    frictionRatioAvg: z.number().min(0).max(20).optional(),
  })
  .superRefine((data, ctx) => {
    for (let i = 1; i < data.points.length; i++) {
      if (data.points[i].depth <= data.points[i - 1].depth) {
        ctx.addIssue({
          code: "custom",
          message: "point depths must be strictly increasing",
        });
        return;
      }
    }
    if (data.points[data.points.length - 1].depth > data.finalDepth + 0.01) {
      ctx.addIssue({
        code: "custom",
        message: "finalDepth must be at least the deepest point depth",
      });
    }
  });

// ---------- 7. UCS ----------
const ucsInput = z.object({
  specimenDiameterMm: z.number().positive().min(20).max(150),
  specimenHeightMm: z.number().positive().min(40).max(300),
  loadingRateMmMin: z.number().min(0).max(5).optional(),
  notes: z.string().max(2000).optional(),
});

const ucsResult = z.object({
  specimenDiameterMm: z.number().positive().min(20).max(150),
  peakStressKpa: z.number().min(0).max(25000),
  strainAtFailurePercent: deg(0, 20),
  failurePattern: z.enum(["AXIAL", "CONICAL", "SHEAR", "BULGING"]).optional(),
  moistureContentAtTest: deg(0, 60).optional(),
  rockClass: z.string().max(80).optional(),
});

// ---------- 8. TRIAXIAL ----------
const triaxialInput = z.object({
  type: z.enum(["UU", "CU", "CD"]),
  specimenCount: z.number().int().min(1).max(5),
  backPressureKpa: z.number().min(0).max(1000).optional(),
  notes: z.string().max(2000).optional(),
});

const triaxialResult = z
  .object({
    type: z.enum(["UU", "CU", "CD"]),
    stages: z
      .array(
        z.object({
          confiningPressureKpa: z.number().min(0).max(2000),
          peakDeviatorStressKpa: z.number().min(0).max(6000),
          strainAtFailurePercent: deg(0, 25).optional(),
          // M5.1: optional per-stage stress–strain curve (the raw reading
          // sequence). Structural rules only — peak-vs-curve and Mohr-Coulomb
          // regression consistency checks arrive with the M5.2 engine.
          stressStrain: z
            .array(
              z.object({
                strainPercent: deg(0, 25),
                deviatorStressKpa: z.number().min(0).max(6000),
              }),
            )
            .min(2)
            .max(60)
            .optional(),
          // M5.1: optional per-stage pore pressure at failure (the physically
          // meaningful value for multi-stage CU tests). The legacy scalar
          // excessPorePressureKpa below remains valid for single-value records.
          porePressureAtFailureKpa: z.number().min(-500).max(1000).optional(),
        }),
      )
      .min(1)
      .max(5),
    cohesionKpa: z.number().min(0).max(1500).optional(),
    frictionAngleDeg: deg(0, 45).optional(),
    excessPorePressureKpa: z.number().min(-500).max(1000).optional(),
  })
  .superRefine((data, ctx) => {
    const confinements = data.stages.map((s) => s.confiningPressureKpa);
    if (new Set(confinements).size !== confinements.length) {
      ctx.addIssue({
        code: "custom",
        message: "confining pressures must be unique across stages",
      });
    }
    if (data.cohesionKpa != null && data.frictionAngleDeg != null && data.stages.length < 2) {
      ctx.addIssue({
        code: "custom",
        message: "Mohr-Coulomb parameters require at least 2 stages",
      });
    }
    // M5.1: per-stage stress–strain curves must be actual reading sequences —
    // strictly increasing axial strain (a curve cannot fold back on itself).
    for (const stage of data.stages) {
      if (!stage.stressStrain) continue;
      for (let i = 1; i < stage.stressStrain.length; i++) {
        if (stage.stressStrain[i].strainPercent <= stage.stressStrain[i - 1].strainPercent) {
          ctx.addIssue({
            code: "custom",
            message: "stressStrain strainPercent values must be strictly increasing within a stage",
          });
          return;
        }
      }
    }
  });

// ---------- 9. OEDOMETER ----------
const oedometerInput = z.object({
  specimenDiameterMm: z.number().positive().min(50).max(120),
  specimenHeightMm: z.number().positive().min(15).max(60),
  initialVoidRatio: z.number().min(0.2).max(4).optional(),
  notes: z.string().max(2000).optional(),
});

const oedometerResult = z
  .object({
    stages: z
      .array(
        z.object({
          verticalPressureKpa: z.number().min(0).max(3200),
          voidRatio: z.number().min(0.15).max(4),
        }),
      )
      .min(2)
      .max(12),
    compressionIndexCc: z.number().min(0).max(3).optional(),
    swellingIndexCs: z.number().min(0).max(1).optional(),
    preConsolidationPressureKpa: z.number().min(0).max(3200).optional(),
    coefficientOfConsolidationCvM2PerYear: z.number().min(0).max(50).optional(),
  })
  .superRefine((data, ctx) => {
    for (let i = 1; i < data.stages.length; i++) {
      if (data.stages[i].verticalPressureKpa <= data.stages[i - 1].verticalPressureKpa) {
        ctx.addIssue({
          code: "custom",
          message: "vertical pressures must be strictly increasing",
        });
        return;
      }
    }
  });

// ---------- 10. DIRECT SHEAR ----------
const directShearInput = z.object({
  specimenDiameterMm: z.number().positive().min(50).max(120),
  rateMmMin: z.number().min(0).max(5).optional(),
  notes: z.string().max(2000).optional(),
});

// M5.1: two accepted shapes, preserving the original scalar single-stage
// format for backward compatibility —
//   legacy  : { normalStressKpa, peakShearStressKpa, residualShearStressKpa? }
//   M5.1+   : { stages: [{ normalStressKpa, peakShearStressKpa,
//             residualShearStressKpa? }, …] } (multi-stage envelope program)
// Exactly one of the two must be provided. The least-squares c′/φ′ envelope
// fit and its consistency rule arrive with the M5.2 calculation engine.
const directShearResult = z
  .object({
    normalStressKpa: z.number().min(0).max(2000).optional(),
    peakShearStressKpa: z.number().min(0).max(2000).optional(),
    residualShearStressKpa: z.number().min(0).max(2000).optional(),
    stages: z
      .array(
        z.object({
          normalStressKpa: z.number().min(0).max(2000),
          peakShearStressKpa: z.number().min(0).max(2000),
          residualShearStressKpa: z.number().min(0).max(2000).optional(),
        }),
      )
      .min(2)
      .max(8)
      .optional(),
    cohesionKpa: z.number().min(0).max(1000).optional(),
    frictionAngleDeg: deg(0, 45).optional(),
  })
  .superRefine((data, ctx) => {
    const hasStages = Array.isArray(data.stages) && data.stages.length > 0;
    const hasScalars = data.normalStressKpa != null && data.peakShearStressKpa != null;
    if (!hasStages && !hasScalars) {
      ctx.addIssue({
        code: "custom",
        message:
          "provide either stages[] (multi-stage program) or normalStressKpa + peakShearStressKpa (single-stage record)",
      });
      return;
    }
    if (hasStages && hasScalars) {
      ctx.addIssue({
        code: "custom",
        message: "provide either stages[] or the single-stage scalar fields, not both",
      });
      return;
    }
    if (hasScalars) {
      if (
        data.residualShearStressKpa != null &&
        data.residualShearStressKpa > data.peakShearStressKpa!
      ) {
        ctx.addIssue({
          code: "custom",
          message: "residualShearStressKpa cannot exceed peakShearStressKpa",
        });
      }
    }
    if (hasStages) {
      const normals = data.stages!.map((s) => s.normalStressKpa);
      if (new Set(normals).size !== normals.length) {
        ctx.addIssue({
          code: "custom",
          message: "stages normalStressKpa values must be unique",
        });
      }
      for (const s of data.stages!) {
        if (s.residualShearStressKpa != null && s.residualShearStressKpa > s.peakShearStressKpa) {
          ctx.addIssue({
            code: "custom",
            message: "stages residualShearStressKpa cannot exceed peakShearStressKpa",
          });
          break;
        }
      }
      if (data.cohesionKpa != null && data.frictionAngleDeg != null && data.stages!.length < 2) {
        ctx.addIssue({
          code: "custom",
          message: "Mohr-Coulomb parameters require at least 2 stages",
        });
      }
    }
  });

// ---------- 11. WATER CONTENT ----------
const waterContentInput = z.object({
  containerId: z.string().max(40).optional(),
  ovenTemperatureC: z.number().min(100).max(120).optional(),
  notes: z.string().max(2000).optional(),
});

// M5.1 mass semantics (approved, audit F2) — explicitly defined:
//   containerMassG = tare (empty container)
//   wetMassG       = tare + wet soil   (gross mass at removal)
//   dryMassG       = tare + dry soil   (gross mass after oven drying)
// ⇒ w = 100 × (wetMassG − dryMassG) / (dryMassG − containerMassG)
// The consistency rule fires only when all three masses are present; records
// with fewer masses (e.g. waterContentPercent alone) remain valid.
const waterContentResult = z
  .object({
    waterContentPercent: z.number().min(0).max(300),
    wetMassG: z.number().positive().max(8000).optional(),
    dryMassG: z.number().positive().max(8000).optional(),
    containerMassG: z.number().positive().max(2000).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.wetMassG != null && data.dryMassG != null && data.wetMassG <= data.dryMassG) {
      ctx.addIssue({
        code: "custom",
        message: "wetMassG must be greater than dryMassG",
      });
    }
    if (
      data.wetMassG != null &&
      data.dryMassG != null &&
      data.containerMassG != null
    ) {
      if (data.dryMassG <= data.containerMassG) {
        ctx.addIssue({
          code: "custom",
          message: "dryMassG must exceed containerMassG (dryMassG = tare + dry solids)",
        });
        return;
      }
      const computed =
        (100 * (data.wetMassG - data.dryMassG)) / (data.dryMassG - data.containerMassG);
      if (Math.abs(computed - data.waterContentPercent) > 0.5) {
        ctx.addIssue({
          code: "custom",
          message:
            "waterContentPercent must equal 100 × (wetMassG − dryMassG) / (dryMassG − containerMassG) within ±0.5 (masses include the tare)",
        });
      }
    }
  });

// ---------- 12. SPECIFIC GRAVITY ----------
const specificGravityInput = z.object({
  method: z.enum(["PYCNOMETER", "GAS_JAR"]),
  notes: z.string().max(2000).optional(),
});

const specificGravityResult = z.object({
  specificGravity: z.number().min(2.3).max(2.95),
  method: z.enum(["PYCNOMETER", "GAS_JAR"]).optional(),
  temperatureC: deg(15, 30).optional(),
});

// ---------- 13. PRESSUREMETER (Ménard) — M5.1 ----------
// Standard: NF P94-110-1 / NF P94-110-2 / ASTM D4719 (citations verified M5.1
// against AFNOR/ASTM listings). The Ménard correction procedure, the creep/
// limit-pressure construction, EM = 2(1+ν)·V·ΔP/ΔV and the rhéologique α
// table are standard-specific procedures: per the approved D8 rule they are
// NOT coded here — pf, PL, EM, emPlRatio and rheologicalCategory remain
// user-entered (entered from the corrected curve) and are cross-checked only
// by plain arithmetic identities. Automatic derivation arrives with the M5.2
// calculation engine after standard-text verification.
const pmCalPoint = z.object({
  pressureKpa: z.number().min(0).max(2000),
  volumeCm3: z.number().min(0).max(2000),
});

const pressuremeterInput = z.object({
  // Probe designation as recorded by the lab (e.g. "Ménard NB (74 mm)") —
  // free text: no standard-specific probe enumeration is invented here.
  probeType: z.string().trim().min(1).max(60),
  testDepthM: z.number().min(0).max(200),
  boreholeDiameterMm: z.number().min(40).max(300).optional(),
  groundwaterPresent: z.boolean().optional(),
  // Raw calibration readings (membrane in free air / complete probe in a
  // calibration tube) — plain measurement arrays; the correction procedure
  // that consumes them is applied in M5.2.
  membraneCalibration: z.array(pmCalPoint).min(1).max(20).optional(),
  probeCalibration: z.array(pmCalPoint).min(1).max(20).optional(),
  notes: z.string().max(2000).optional(),
});

const pressuremeterResult = z
  .object({
    points: z
      .array(
        z.object({
          pressureKpa: z.number().min(0).max(5000),
          volumeCm3: z.number().min(0).max(2000),
        }),
      )
      .min(5)
      .max(30),
    // User-entered from the corrected curve (see header note):
    creepPressureKpa: z.number().min(0).max(5000).optional(), // pf
    limitPressureKpa: z.number().min(0).max(10000).optional(), // PL
    menardModulusMPa: z.number().min(0).max(2000).optional(), // EM
    emPlRatio: z.number().min(0).max(200).optional(),
    rheologicalCategory: z.string().trim().max(10).optional(), // α — user-entered until the NF table is verified
  })
  .superRefine((data, ctx) => {
    for (let i = 1; i < data.points.length; i++) {
      if (data.points[i].pressureKpa <= data.points[i - 1].pressureKpa) {
        ctx.addIssue({
          code: "custom",
          message: "point pressures must be strictly increasing",
        });
        return;
      }
      if (data.points[i].volumeCm3 < data.points[i - 1].volumeCm3 - 0.01) {
        ctx.addIssue({
          code: "custom",
          message: "volumeCm3 must be non-decreasing with pressure (monotonic loading sequence)",
        });
        return;
      }
    }
    if (
      data.creepPressureKpa != null &&
      data.limitPressureKpa != null &&
      data.creepPressureKpa >= data.limitPressureKpa
    ) {
      ctx.addIssue({
        code: "custom",
        message: "creepPressureKpa (pf) must be lower than limitPressureKpa (PL)",
      });
    }
    if (
      data.menardModulusMPa != null &&
      data.limitPressureKpa != null &&
      data.limitPressureKpa > 0 &&
      data.emPlRatio != null
    ) {
      // emPlRatio is dimensionless: EM [MPa] × 1000 / PL [kPa].
      const expected = (data.menardModulusMPa * 1000) / data.limitPressureKpa;
      if (Math.abs(data.emPlRatio - expected) > 0.5) {
        ctx.addIssue({
          code: "custom",
          message: "emPlRatio must equal menardModulusMPa × 1000 / limitPressureKpa within ±0.5",
        });
      }
    }
  });

// ---------- registry ----------
export const LAB_TEST_REGISTRY: Record<LabTestType, LabTestDefinition> = {
  GRANULOMETRY: {
    code: "GRANULOMETRY",
    label: "Granulometry (sieve & hydrometer)",
    description:
      "Particle size distribution by sieve analysis, optionally extended with hydrometer testing for fines.",
    // NF P94-057 (hydrometer method, < 80 µm) added in M5.1 — verified against
    // the AFNOR catalogue. Covers the SIEVE_AND_HYDROMETER input method.
    standard: "ASTM D6913 / NF P94-056 / NF P94-057",
    category: "INDEX_PROPERTIES",
    inputSchema: granulometryInput,
    resultSchema: granulometryResult,
    units: { diameterMm: "mm", percentFiner: "%" },
    validationNotes: [
      "4–40 points, unique diameters",
      "percentFiner 0–100 and non-decreasing with increasing diameter",
      "uniformityCoefficient = d60 / d10 when both given",
      "coefficientOfCurvature = d30² / (d60 × d10) when d10, d30 and d60 are given (M5.1)",
    ],
    chart: { kind: "grainSizeCurve", x: "diameterMm (log scale)", y: "percentFiner (%)" },
  },
  ATTERBERG_LIMITS: {
    code: "ATTERBERG_LIMITS",
    label: "Atterberg limits",
    description:
      "Liquid limit, plastic limit and plasticity index of fine-grained soils.",
    standard: "ASTM D4318 / NF P94-051",
    category: "INDEX_PROPERTIES",
    inputSchema: atterbergInput,
    resultSchema: atterbergResult,
    units: { liquidLimit: "%", plasticLimit: "%", plasticityIndex: "%" },
    validationNotes: [
      "liquidLimit 10–150 %, plasticLimit 5–100 %",
      "plasticLimit < liquidLimit",
      "plasticityIndex = liquidLimit − plasticLimit (±1)",
    ],
    chart: { kind: "plasticityChart", x: "liquidLimit (%)", y: "plasticityIndex (%)" },
  },
  PROCTOR: {
    code: "PROCTOR",
    label: "Proctor compaction",
    description:
      "Moisture–density compaction curve; standard (ASTM D698) or modified (ASTM D1557) effort.",
    standard: "ASTM D698 / ASTM D1557 / NF P94-093",
    category: "COMPACTION",
    inputSchema: proctorInput,
    resultSchema: proctorResult,
    units: { moistureContent: "%", dryDensity: "Mg/m³", wetDensityMgM3: "Mg/m³" },
    validationNotes: [
      "3–8 compaction points",
      "maxDryDensity ≥ highest measured point (curve peak)",
      "optimumMoisture within the tested moisture range (±1)",
      "optional wetDensityMgM3 per point; must be ≥ dryDensity (ρwet = ρd × (1 + w)) (M5.1)",
    ],
    chart: { kind: "compactionCurve", x: "moistureContent (%)", y: "dryDensity (Mg/m³)" },
  },
  CBR: {
    code: "CBR",
    label: "California Bearing Ratio",
    description:
      "Penetration resistance of compacted or natural soil, soaked or unsoaked.",
    standard: "ASTM D1883 / NF P94-078",
    category: "COMPACTION",
    inputSchema: cbrInput,
    resultSchema: cbrResult,
    units: { penetrationMm: "mm", loadKn: "kN", cbrValue: "%" },
    validationNotes: [
      "2–20 load–penetration points, unique penetrations (0–15 mm)",
      "cbrValue = max(cbrAt2_5, cbrAt5_0)",
      "swellPercent 0–15 % (soaked tests)",
    ],
    chart: { kind: "cbrCurve", x: "penetrationMm (mm)", y: "loadKn (kN)" },
  },
  SPT: {
    code: "SPT",
    label: "Standard Penetration Test",
    description:
      "Dynamic penetration resistance recorded in 150 mm increments with the N-value.",
    standard: "ASTM D1586 / NF P94-116",
    category: "IN_SITU",
    inputSchema: sptInput,
    resultSchema: sptResult,
    units: { depth: "m", blows: "count (per 150 mm)", nValue: "count" },
    validationNotes: [
      "nValue = blows2nd150 + blows3rd150",
      "n60 = nValue × energyRatio / 60 when energy correction given",
      "depthTo > depthFrom",
      "input: optional effectiveOverburdenKpa at the test depth (enables the (N1)60 correction in M5.2)",
    ],
    chart: { kind: "depthProfile", y: "depth (m)", value: "nValue" },
  },
  CPT: {
    code: "CPT",
    label: "Cone Penetration Test",
    description:
      "Continuous cone resistance and sleeve friction with depth (CPTu capable).",
    // M5.1 correction: the French CPT reference is NF P94-113 (essai de
    // pénétration statique) / NF EN ISO 22476-1 — verified against the AFNOR
    // and ISO catalogues. The previous citation (NF P94-119) was incorrect.
    standard: "ASTM D5778 / NF P94-113 / NF EN ISO 22476-1",
    category: "IN_SITU",
    inputSchema: cptInput,
    resultSchema: cptResult,
    units: { depth: "m", coneResistanceMpa: "MPa", sleeveFrictionKpa: "kPa" },
    validationNotes: [
      "2–600 depth points, strictly increasing depth",
      "finalDepth ≥ deepest point",
      "coneResistanceMpa 0–120 MPa, sleeveFrictionKpa 0–900 kPa",
    ],
    chart: { kind: "cptProfile", y: "depth (m)", series: ["coneResistanceMpa", "sleeveFrictionKpa"] },
  },
  UCS: {
    code: "UCS",
    label: "Unconfined Compressive Strength",
    description:
      "Peak compressive strength of a rock or soil specimen without confinement.",
    standard: "ASTM D2166 / ASTM D7012 / NF P94-425",
    category: "MECHANICAL",
    inputSchema: ucsInput,
    resultSchema: ucsResult,
    units: { peakStressKpa: "kPa", strainAtFailurePercent: "%" },
    validationNotes: [
      "peakStressKpa 0–25000 kPa",
      "strainAtFailurePercent 0–20 %",
      "specimen geometry consistency between input and result",
    ],
    chart: { kind: "barSummary", value: "peakStressKpa", groupBy: "rockClass" },
  },
  TRIAXIAL: {
    code: "TRIAXIAL",
    label: "Triaxial compression (UU / CU / CD)",
    description:
      "Consolidated or unconsolidated triaxial test program with Mohr-Coulomb parameters.",
    // M5.1: ASTM D7181 added — it is the consolidated-drained (CD) standard,
    // matching the supported CD test type.
    standard: "ASTM D2850 / ASTM D4767 / ASTM D7181 / NF P94-077",
    category: "MECHANICAL",
    inputSchema: triaxialInput,
    resultSchema: triaxialResult,
    units: { stress: "kPa", frictionAngleDeg: "°" },
    validationNotes: [
      "1–5 stages with unique confining pressures",
      "cohesionKpa / frictionAngleDeg require ≥ 2 stages",
      "frictionAngleDeg 0–45°",
      "optional per-stage stressStrain curve (2–60 points, strictly increasing strain) and porePressureAtFailureKpa (M5.1)",
      "excessPorePressureKpa retained for legacy single-value records; per-stage porePressureAtFailureKpa preferred for multi-stage CU",
    ],
    chart: { kind: "barSummary", value: "peakDeviatorStressKpa", groupBy: "confiningPressureKpa" },
  },
  OEDOMETER: {
    code: "OEDOMETER",
    label: "Oedometer consolidation",
    description:
      "One-dimensional compression curve (e–log p) with consolidation parameters.",
    // M5.1: ISO 17892-5 added (incremental loading oedometer) — verified
    // against the ISO catalogue.
    standard: "ASTM D2435 / NF P94-090 / ISO 17892-5",
    category: "MECHANICAL",
    inputSchema: oedometerInput,
    resultSchema: oedometerResult,
    units: { verticalPressureKpa: "kPa", voidRatio: "–", cv: "m²/year" },
    validationNotes: [
      "2–12 loading stages with strictly increasing pressure",
      "voidRatio 0.15–4",
      "Cc / Cs / pre-consolidation pressure optional",
    ],
    chart: { kind: "oedometerCurve", x: "verticalPressureKpa (log scale)", y: "voidRatio" },
  },
  DIRECT_SHEAR: {
    code: "DIRECT_SHEAR",
    label: "Direct shear",
    description:
      "Shear strength under a controlled normal stress — single-stage scalar record or multi-stage envelope program (M5.1).",
    standard: "ASTM D3080 / NF P94-071-1",
    category: "MECHANICAL",
    inputSchema: directShearInput,
    resultSchema: directShearResult,
    units: { stress: "kPa", frictionAngleDeg: "°" },
    validationNotes: [
      "single-stage: normalStressKpa + peakShearStressKpa (residual ≤ peak)",
      "multi-stage (M5.1): 2–8 stages with unique normalStressKpa; residual ≤ peak per stage",
      "provide either stages[] or the scalar fields, not both",
      "frictionAngleDeg 0–45°; c′/φ′ consistency vs the stage envelope arrives with the M5.2 calculation engine",
    ],
    chart: { kind: "barSummary", value: "peakShearStressKpa", groupBy: "normalStressKpa" },
  },
  WATER_CONTENT: {
    code: "WATER_CONTENT",
    label: "Water content",
    description:
      "Gravimetric water content by oven drying, with optional mass bookkeeping.",
    standard: "ASTM D2216 / NF P94-050",
    category: "INDEX_PROPERTIES",
    inputSchema: waterContentInput,
    resultSchema: waterContentResult,
    units: { waterContentPercent: "%", mass: "g" },
    validationNotes: [
      "waterContentPercent 0–300 %",
      "wetMassG > dryMassG when both given",
      "mass semantics (M5.1): containerMassG = tare, wetMassG = tare + wet soil, dryMassG = tare + dry soil",
      "when all three masses given: waterContentPercent = 100 × (wetMassG − dryMassG) / (dryMassG − containerMassG) within ±0.5",
    ],
    chart: { kind: "depthProfile", y: "depth (m)", value: "waterContentPercent" },
  },
  SPECIFIC_GRAVITY: {
    code: "SPECIFIC_GRAVITY",
    label: "Specific gravity",
    description: "Specific gravity of soil solids by pycnometer or gas jar.",
    standard: "ASTM D854 / NF P94-054",
    category: "INDEX_PROPERTIES",
    inputSchema: specificGravityInput,
    resultSchema: specificGravityResult,
    units: { specificGravity: "–", temperatureC: "°C" },
    validationNotes: [
      "specificGravity 2.30–2.95 (typical mineral-soil range)",
    ],
    chart: { kind: "none" },
  },
  PRESSUREMETER: {
    code: "PRESSUREMETER",
    label: "Pressuremeter (Ménard)",
    description:
      "Prebored Ménard pressuremeter test: pressure-controlled expansion steps with volume readings; creep pressure, limit pressure and Ménard modulus are entered from the corrected curve (automatic derivation arrives with the M5.2 calculation engine).",
    standard: "NF P94-110-1 / NF P94-110-2 / ASTM D4719",
    category: "IN_SITU",
    inputSchema: pressuremeterInput,
    resultSchema: pressuremeterResult,
    units: { pressureKpa: "kPa", volumeCm3: "cm³", menardModulusMPa: "MPa" },
    validationNotes: [
      "5–30 pressure–volume points, strictly increasing pressure, non-decreasing volume",
      "creepPressureKpa (pf) < limitPressureKpa (PL) when both given",
      "emPlRatio = menardModulusMPa × 1000 / limitPressureKpa within ±0.5 when EM, PL and the ratio are given",
      "pf, PL, EM, emPlRatio and rheologicalCategory are user-entered from the corrected curve — the NF P94-110-2 correction and derivation procedure is implemented in M5.2 only after standard-text verification",
    ],
    // Renderer arrives with the M5.3 chart milestone; until then the M4 chart
    // component shows its graceful "Unknown chart configuration" state.
    chart: { kind: "pressuremeterCurve", x: "pressureKpa (kPa)", y: "volumeCm3 (cm³)" },
  },
};

export function isLabTestType(value: string): value is LabTestType {
  return (LAB_TEST_TYPES as readonly string[]).includes(value);
}

export function getLabTestDefinition(type: string): LabTestDefinition | undefined {
  return isLabTestType(type) ? LAB_TEST_REGISTRY[type] : undefined;
}

/** Validate a lab-test result payload against its registry schema. */
export function parseLabTestResult(
  type: string,
  data: unknown,
): { ok: true; data: unknown } | { ok: false; error: string } {
  const def = getLabTestDefinition(type);
  if (!def) return { ok: false, error: `Unknown laboratory test type: ${type}` };
  const parsed = def.resultSchema.safeParse(data);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    error: `${def.label}: ${issue?.path?.join(".") ? issue.path.join(".") + " — " : ""}${issue?.message ?? "invalid result"}`,
  };
}

/** Validate a lab-test input payload against its registry schema. */
export function parseLabTestInput(
  type: string,
  data: unknown,
): { ok: true; data: unknown } | { ok: false; error: string } {
  const def = getLabTestDefinition(type);
  if (!def) return { ok: false, error: `Unknown laboratory test type: ${type}` };
  const parsed = def.inputSchema.safeParse(data);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    error: `${def.label} (input): ${issue?.path?.join(".") ? issue.path.join(".") + " — " : ""}${issue?.message ?? "invalid input"}`,
  };
}
