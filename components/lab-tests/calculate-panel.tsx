"use client";

/**
 * GEODATA HUB — calculation execution panel (M5.3).
 *
 * Connects the lab-test page to the M5.2 Calculate API
 * (POST /api/lab-tests/:id/calculate) for every registered engine:
 *
 * - "Recorded data" mode submits an EMPTY body — the backend runs the
 *   registered engine on the stored result payload (its authoritative
 *   behavior, including the oedometer field-name adapter).
 * - "Explicit input" mode renders a spec-driven form that mirrors the ENGINE
 *   input contract (never the registry result contract) and validates it
 *   client-side by calling the engine module's own `validateInput` — the
 *   exact same code the backend runs. Backend validation remains
 *   authoritative in every case.
 *
 * Engineering rules: no defaults are fabricated (forms start empty, or are
 * prefilled from the RECORDED laboratory data with a visible notice — the
 * granulometry reorder is shown, never silent); entered values are preserved
 * when validation fails; submissions are serialized (buttons disabled while
 * pending + a fresh idempotency key per deliberate run); calculation
 * failures (HTTP 200 + FAILED record) are displayed as engine outcomes,
 * never masked; infrastructure errors surface the API error envelope.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Calculator, ChevronDown, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiPost, ApiClientError } from "@/lib/api-client";
import { getCalcModuleForTestType } from "@/lib/calc/registry";
import { CalculationOutput } from "@/components/lab-tests/calculation-output";
import {
  CalcStatusBadge,
  CalculationErrorAlert,
  InputSourceBadge,
  ValidityBadge,
} from "@/components/lab-tests/calculation-shared";
import { handleFormError } from "@/components/projects/project-form-dialog";
import type { CalculateResultDto, EngineInfoDto } from "@/lib/api-types";

// ---------------------------------------------------------------------------
// Form specification types (labels/descriptions only — validation is the
// engine module's own validateInput)
// ---------------------------------------------------------------------------

interface FieldSpec {
  key: string;
  label: string;
  unit?: string;
  kind: "number" | "enum" | "boolean" | "text";
  options?: { value: string; label: string }[];
  required?: boolean;
  help?: string;
}

interface ArraySpec {
  key: string;
  label: string;
  help?: string;
  fields: FieldSpec[];
  min: number;
  max: number;
  /** Registry array key to prefill from (field-NAME mapping only). */
  prefillKey?: string;
  /** Visible reorder applied to prefilled rows (never silent). */
  reorder?: "ascending-diameter";
  /** Engine contract is a scalar array (number[]) — rows map to the single
   * field VALUE, not to an object (e.g. atterberg plasticLimitTrials). */
  scalarItems?: boolean;
}

interface GroupSpec {
  key: string;
  label: string;
  help?: string;
  fields: FieldSpec[];
  arrays?: ArraySpec[];
}

interface EngineFormSpec {
  fields: FieldSpec[];
  arrays: ArraySpec[];
  groups?: GroupSpec[];
  /** Prefill map: engine input key → registry result key (same name = identity). */
  prefill?: Record<string, string>;
}

type Row = Record<string, string>;

const f = (
  key: string,
  label: string,
  unit?: string,
  required = false,
  help?: string,
): FieldSpec => ({ key, label, unit, kind: "number", required, help });

const e = (
  key: string,
  label: string,
  values: readonly string[],
  labels?: Record<string, string>,
  required = true,
  help?: string,
): FieldSpec => ({
  key,
  label,
  kind: "enum",
  required,
  help,
  options: values.map((v) => ({ value: v, label: labels?.[v] ?? v })),
});

const t = (key: string, label: string, required = false, help?: string): FieldSpec => ({
  key,
  label,
  kind: "text",
  required,
  help,
});

const b = (key: string, label: string, help?: string): FieldSpec => ({
  key,
  label,
  kind: "boolean",
  help,
});

const opt = "optional";

// ---------------------------------------------------------------------------
// Per-engine explicit input specifications — field names mirror the ENGINE
// input contracts (src/lib/calc/modules/*), not the registry result schemas.
// ---------------------------------------------------------------------------

const FORM_SPECS: Record<string, EngineFormSpec> = {
  "water-content": {
    fields: [
      f("waterContentPercent", "Entered water content", "%", true, "Laboratory-entered value, cross-checked against the masses"),
      f("wetMassG", "Wet gross mass", "g", true, "Tare + wet soil (M5.1 F2 semantics)"),
      f("dryMassG", "Dry gross mass", "g", true, "Tare + dry soil"),
      f("containerMassG", "Container (tare) mass", "g", true),
    ],
    arrays: [],
    prefill: {},
  },
  granulometry: {
    fields: [
      f("d10", "Entered d10", "mm", false, opt),
      f("d30", "Entered d30", "mm", false, opt),
      f("d60", "Entered d60", "mm", false, opt),
      f("uniformityCoefficient", "Entered Cu", undefined, false, opt),
      f("coefficientOfCurvature", "Entered Cc", undefined, false, opt),
    ],
    arrays: [
      {
        key: "points",
        label: "Sieve / hydrometer points",
        help: "4–40 points, ordered by STRICTLY increasing diameter (unordered input is rejected by the engine, never silently sorted).",
        fields: [f("diameterMm", "Diameter", "mm", true), f("percentFiner", "Percent finer", "%", true)],
        min: 4,
        max: 40,
        prefillKey: "points",
        reorder: "ascending-diameter",
      },
    ],
    prefill: {},
  },
  "atterberg-limits": {
    fields: [
      e("method", "Method", ["CASAGRANDE_CUP", "CONE_PENETROMETER"], {
        CASAGRANDE_CUP: "Casagrande cup",
        CONE_PENETROMETER: "Cone penetrometer",
      }),
      f("liquidLimit", "Entered LL", "%", false, opt),
      f("plasticLimit", "Entered PL", "%", false, opt),
      f("plasticityIndex", "Entered PI", "%", false, opt),
      b("nonPlastic", "Non-plastic"),
    ],
    arrays: [
      {
        key: "liquidLimitPoints",
        label: "Flow-curve points",
        help: "3–10 points with ≥ 2 distinct blow counts (the regression needs spread).",
        fields: [f("blows", "Blows N", "count", true), f("waterContentPercent", "Water content", "%", true)],
        min: 3,
        max: 10,
      },
      {
        key: "plasticLimitTrials",
        label: "Plastic limit trials",
        help: "1–6 trial water contents; averaged by the engine (std dev / range reported).",
        fields: [f("waterContentPercent", "Trial water content", "%", true)],
        min: 1,
        max: 6,
        scalarItems: true,
      },
    ],
    prefill: {},
  },
  proctor: {
    fields: [
      e("method", "Compaction effort", ["STANDARD", "MODIFIED"], {
        STANDARD: "Standard (D698)",
        MODIFIED: "Modified (D1557)",
      }),
      e("mold", "Mold", ["101.6MM", "152.4MM"], { "101.6MM": "101.6 mm", "152.4MM": "152.4 mm" }, false, "Required for mass-based points"),
      f("moldVolumeCm3", "Mold volume", "cm³", false, "Internal mold volume; required for mass-based points"),
      f("specificGravity", "Specific gravity Gs", undefined, false, "2.30–2.95; enables the zero-air-voids curve"),
      f("maxDryDensity", "Entered max dry density", "Mg/m³", false, opt),
      f("optimumMoisture", "Entered optimum moisture", "%", false, opt),
    ],
    arrays: [
      {
        key: "points",
        label: "Compaction points",
        help: "3–8 points. Per point: moisture, or the dish triple (wet/dry/container masses); density from dryDensity, wetSoilMassG + mold volume, or wetDensityMgM3.",
        fields: [
          f("moistureContent", "Moisture w", "%", false),
          f("wetMassG", "Wet gross mass", "g", false),
          f("dryMassG", "Dry gross mass", "g", false),
          f("containerMassG", "Tare mass", "g", false),
          f("wetSoilMassG", "Net wet soil in mold", "g", false),
          f("wetDensityMgM3", "Wet density", "Mg/m³", false),
          f("dryDensity", "Dry density", "Mg/m³", false),
        ],
        min: 3,
        max: 8,
        prefillKey: "points",
      },
    ],
    prefill: {},
  },
  cbr: {
    fields: [
      e("condition", "Condition", ["SOAKED", "UNSOAKED"]),
      b("originCorrection", "Apply origin correction", "Concave-upward curve correction per the standard"),
      f("swellPercent", "Entered swell", "%", false, opt),
      f("cbrAt2_5", "Entered CBR @ 2.5 mm", "%", false, opt),
      f("cbrAt5_0", "Entered CBR @ 5.0 mm", "%", false, opt),
      f("cbrValue", "Entered CBR value", "%", false, opt),
    ],
    arrays: [
      {
        key: "points",
        label: "Load–penetration points",
        help: "2–20 points, ascending penetration.",
        fields: [f("penetrationMm", "Penetration", "mm", true), f("loadKn", "Load", "kN", true)],
        min: 2,
        max: 20,
        prefillKey: "points",
      },
    ],
    prefill: {},
  },
  oedometer: {
    fields: [
      f("referenceHeightMm", "Reference height", "mm", false, opt),
      f("referenceVoidRatio", "Reference void ratio", undefined, false, opt),
      f("initialVoidRatio", "Initial void ratio", undefined, false, opt),
      f("specimenDiameterMm", "Specimen diameter", "mm", false, opt),
      f("specimenHeightMm", "Specimen height", "mm", false, opt),
      f("compressionIndexCc", "Entered Cc", undefined, false, opt),
      f("swellingIndexCs", "Entered Cs", undefined, false, opt),
      f("preConsolidationPressureKpa", "Entered σ′p", "kPa", false, opt),
      f("coefficientOfConsolidationCvM2PerYear", "Entered Cv", "m²/year", false, opt),
    ],
    arrays: [
      {
        key: "loadingStages",
        label: "Loading stages",
        help: "2–12 stages; per stage give voidRatio, or specimenHeightMm with a reference (height + void ratio).",
        fields: [
          f("verticalPressureKpa", "Pressure σ′v", "kPa", true),
          f("voidRatio", "Void ratio e", undefined, false),
          f("specimenHeightMm", "Specimen height", "mm", false),
        ],
        min: 2,
        max: 12,
        // Registry stores the loading branch under `stages` — same field-NAME
        // mapping as the backend adapter (calc/registry.ts), never semantic.
        prefillKey: "stages",
      },
      {
        key: "unloadingStages",
        label: "Unloading stages",
        help: "Optional (the registry has no unloading storage — explicit input only).",
        fields: [
          f("verticalPressureKpa", "Pressure σ′v", "kPa", true),
          f("voidRatio", "Void ratio e", undefined, false),
          f("specimenHeightMm", "Specimen height", "mm", false),
        ],
        min: 2,
        max: 12,
      },
    ],
    groups: [
      {
        key: "consolidationReading",
        label: "Consolidation reading (Cv by Casagrande log-time)",
        help: "Optional dial readings of one increment; 6–60 readings.",
        fields: [
          f("incrementFromIndex", "Loading-stage index", undefined, true, "0-based index into loadingStages"),
          f("drainagePathMm", "Drainage path", "mm", true),
        ],
        arrays: [
          {
            key: "readings",
            label: "Dial readings",
            fields: [f("timeMin", "Time", "min", true), f("dialMm", "Dial", "mm", true)],
            min: 6,
            max: 60,
          },
        ],
      },
    ],
    prefill: {},
  },
  "direct-shear": {
    fields: [
      e("drainageCondition", "Drainage condition", ["DRAINED", "UNDRAINED"], undefined, false, opt),
      f("normalStressKpa", "Normal stress (single stage)", "kPa", false, "Single-stage path — leave empty when using stages below"),
      f("peakShearStressKpa", "Peak shear (single stage)", "kPa", false, "Single-stage path"),
      f("residualShearStressKpa", "Residual shear (single stage)", "kPa", false, "Single-stage path"),
      f("cohesionKpa", "Entered cohesion", "kPa", false, opt),
      f("frictionAngleDeg", "Entered friction angle", "°", false, opt),
    ],
    arrays: [
      {
        key: "stages",
        label: "Shear stages (multi-stage envelope)",
        help: "2–8 stages with ≥ 2 distinct normal stresses (the Mohr–Coulomb regression needs spread).",
        fields: [
          f("normalStressKpa", "Normal stress σn", "kPa", true),
          f("peakShearStressKpa", "Peak shear τ", "kPa", true),
          f("residualShearStressKpa", "Residual shear τr", "kPa", false),
        ],
        min: 2,
        max: 8,
      },
    ],
    prefill: {},
  },
  pressuremeter: {
    fields: [
      t("probeType", "Probe type", false, opt),
      f("testDepthM", "Test depth", "m", false, opt),
      f("referenceVolumeCm3", "Reference volume", "cm³", false, opt),
      f("measuringCellVolumeCm3", "Measuring cell volume", "cm³", false, opt),
      f("creepPressureKpa", "Entered pf", "kPa", false, opt),
      f("limitPressureKpa", "Entered PL", "kPa", false, opt),
      f("menardModulusMPa", "Entered EM", "MPa", false, opt),
      f("emPlRatio", "Entered EM/PL", undefined, false, opt),
    ],
    arrays: [
      {
        key: "points",
        label: "Pressure–volume points",
        help: "5–30 points, strictly increasing pressure, non-decreasing volume.",
        fields: [
          f("pressureKpa", "Pressure p", "kPa", true),
          f("volumeCm3", "Volume V", "cm³", true),
          f("volumeAt30sCm3", "Volume @ 30 s", "cm³", false, "Creep-stage reading (optional)"),
        ],
        min: 5,
        max: 30,
        prefillKey: "points",
      },
    ],
    groups: [
      {
        key: "emRange",
        label: "EM analysis range",
        help: "Optional explicit p1–p2 range for the Ménard modulus.",
        fields: [f("p1Kpa", "p1", "kPa", true), f("p2Kpa", "p2", "kPa", true)],
      },
    ],
    prefill: {},
  },
};

// ---------------------------------------------------------------------------
// Value conversion (same conventions as the M4 result dialog: empty → omitted,
// numeric strings → numbers, invalid numbers left for the schema to report)
// ---------------------------------------------------------------------------

function toValue(spec: FieldSpec, raw: string | boolean | undefined): unknown {
  if (spec.kind === "boolean") return raw === true || raw === "true";
  if (raw === undefined || raw === "") return undefined;
  if (spec.kind === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  return raw;
}

function rowsToPayload(spec: ArraySpec, rows: Row[]): unknown[] {
  if (spec.scalarItems) {
    // Scalar arrays (engine contract number[]): each row contributes its
    // single field value directly.
    return rows
      .map((row) => toValue(spec.fields[0], row[spec.fields[0].key]))
      .filter((v): v is number => typeof v === "number");
  }
  return rows
    .map((row) => {
      const out: Record<string, unknown> = {};
      for (const fs of spec.fields) {
        const v = toValue(fs, row[fs.key]);
        if (v !== undefined) out[fs.key] = v;
      }
      return out;
    })
    .filter((r) => Object.keys(r).length > 0);
}

// ---------------------------------------------------------------------------
// Prefill from the RECORDED result (visible, never silent)
// ---------------------------------------------------------------------------

interface PrefillData {
  scalars: Row;
  arrays: Record<string, Row[]>;
  notice: string | null;
}

function buildPrefill(
  spec: EngineFormSpec,
  moduleId: string,
  recorded: Record<string, unknown> | null | undefined,
): PrefillData | null {
  if (!recorded || typeof recorded !== "object") return null;
  const scalars: Row = {};
  for (const fs of spec.fields) {
    const key = fs.key;
    const v = (recorded as Record<string, unknown>)[key];
    if (v !== undefined && v !== null) scalars[key] = String(v);
  }
  const arrays: Record<string, Row[]> = {};
  for (const arr of spec.arrays) {
    const sourceKey = arr.prefillKey ?? arr.key;
    const src = (recorded as Record<string, unknown>)[sourceKey];
    if (!Array.isArray(src)) continue;
    let rows: Row[] = src.map((r) => {
      const rec = r as Record<string, unknown>;
      if (arr.scalarItems) {
        // Scalar arrays: the stored value IS the row value.
        return { [arr.fields[0].key]: rec == null ? "" : String(r) };
      }
      const row: Row = {};
      for (const fs of arr.fields) row[fs.key] = rec[fs.key] == null ? "" : String(rec[fs.key]);
      return row;
    });
    if (arr.reorder === "ascending-diameter") {
      rows = [...rows].sort((a, b) => Number(a.diameterMm) - Number(b.diameterMm));
    }
    arrays[arr.key] = rows;
  }
  const hasContent =
    Object.keys(scalars).length > 0 || Object.values(arrays).some((r) => r.length > 0);
  if (!hasContent) return null;
  const notice =
    moduleId === "granulometry"
      ? "Prefilled from the recorded result — rows reordered by increasing diameter (required by the engine). Review before running."
      : moduleId === "oedometer"
        ? "Prefilled from the recorded result — the registry loading branch (stages) maps to the engine's loadingStages field. Review before running."
        : "Prefilled from the recorded laboratory result — review before running.";
  return { scalars, arrays, notice };
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function CalculatePanel({
  testId,
  testType,
  testLabel,
  engine,
  canCalculate,
  hasRecordedResult,
  recordedResult,
  disabledReason,
}: {
  testId: string;
  testType: string;
  testLabel: string;
  engine: EngineInfoDto | null;
  canCalculate: boolean;
  hasRecordedResult: boolean;
  recordedResult: Record<string, unknown> | null;
  disabledReason?: string | null;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"stored" | "explicit">("stored");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<CalculateResultDto | null>(null);

  const spec = FORM_SPECS[engine?.moduleId ?? ""];
  const initialRows = (min: number) =>
    Array.from({ length: Math.min(Math.max(min, 1), 3) }, () => ({}));

  const [scalars, setScalars] = useState<Row>({});
  const [arrays, setArrays] = useState<Record<string, Row[]>>({});
  const [groupEnabled, setGroupEnabled] = useState<Record<string, boolean>>({});
  const [groupScalars, setGroupScalars] = useState<Record<string, Row>>({});
  const [groupArrays, setGroupArrays] = useState<Record<string, Record<string, Row[]>>>({});
  const [prefillNotice, setPrefillNotice] = useState<string | null>(null);
  const [explicitOpened, setExplicitOpened] = useState(false);

  function ensureExplicitInitialized() {
    if (explicitOpened || !spec) return;
    setExplicitOpened(true);
    const init: Row = {};
    for (const fs of spec.fields) init[fs.key] = "";
    const initArrays: Record<string, Row[]> = {};
    for (const arr of spec.arrays)
      initArrays[arr.key] = initialRows(arr.min).map(() =>
        Object.fromEntries(arr.fields.map((fs) => [fs.key, ""])),
      );
    const prefill = buildPrefill(spec, engine!.moduleId, recordedResult);
    if (prefill) {
      setScalars({ ...init, ...prefill.scalars });
      setArrays({ ...initArrays, ...prefill.arrays });
      setPrefillNotice(prefill.notice);
    } else {
      setScalars(init);
      setArrays(initArrays);
    }
    for (const g of spec.groups ?? []) {
      setGroupEnabled((s) => ({ ...s, [g.key]: false }));
      setGroupScalars((s) => ({
        ...s,
        [g.key]: Object.fromEntries(g.fields.map((fs) => [fs.key, ""])),
      }));
      setGroupArrays((s) => ({
        ...s,
        [g.key]: Object.fromEntries((g.arrays ?? []).map((a) => [a.key, []])),
      }));
    }
  }

  function setScalar(key: string, value: string) {
    setScalars((s) => ({ ...s, [key]: value }));
  }
  function setRow(arrKey: string, i: number, key: string, value: string) {
    setArrays((s) => ({
      ...s,
      [arrKey]: (s[arrKey] ?? []).map((r, idx) => (idx === i ? { ...r, [key]: value } : r)),
    }));
  }
  function addRows(arrKey: string, fieldKeys: string[]) {
    setArrays((s) => ({
      ...s,
      [arrKey]: [...(s[arrKey] ?? []), Object.fromEntries(fieldKeys.map((k) => [k, ""]))],
    }));
  }
  function removeRow(arrKey: string, i: number) {
    setArrays((s) => ({ ...s, [arrKey]: (s[arrKey] ?? []).filter((_, idx) => idx !== i) }));
  }

  // ---------------- submission ----------------

  async function submit(body: Record<string, unknown>) {
    setSubmitting(true);
    setFormError(null);
    setResult(null);
    // Fresh idempotency key per deliberate run — accidental in-flight
    // duplicates are prevented by the disabled buttons; server-side replay
    // covers network-level retries of the SAME key.
    const key = `ui-${crypto.randomUUID()}`;
    try {
      const { data } = await apiPost<CalculateResultDto>(
        `/api/lab-tests/${testId}/calculate`,
        { ...body, idempotencyKey: key },
      );
      setResult(data);
      if (data.record?.status === "COMPLETED") {
        toast({
          title: data.deduplicated
            ? "No change — existing result returned"
            : data.replayed
              ? "Existing calculation returned (idempotent replay)"
              : "Calculation completed",
          description: `${testLabel} · engine ${data.outcome.moduleId}`,
        });
      } else {
        toast({
          title: "Calculation failed",
          description: "The engine rejected the input — see the failure details.",
          variant: "destructive",
        });
      }
      router.refresh();
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.status === 403) {
          setFormError("Your role does not include permission to run calculations on this test.");
        } else if (err.status === 404) {
          setFormError("This test is not accessible for calculation (it may belong to another organization).");
        } else if (err.status === 422) {
          setFormError(err.message);
        } else {
          handleFormError(err, () => undefined, "Calculation could not be run");
        }
      } else {
        setFormError("Unexpected error while running the calculation.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function runFromStored() {
    await submit({});
  }

  async function runExplicit() {
    if (!spec || !engine) return;
    // Build the payload from the form state (untouched rows omitted).
    const payload: Record<string, unknown> = {};
    for (const fs of spec.fields) {
      const v = toValue(fs, scalars[fs.key]);
      if (v !== undefined) payload[fs.key] = v;
    }
    for (const arr of spec.arrays) {
      const rows = rowsToPayload(arr, arrays[arr.key] ?? []);
      if (rows.length > 0) payload[arr.key] = rows;
    }
    for (const g of spec.groups ?? []) {
      if (!groupEnabled[g.key]) continue;
      const gPayload: Record<string, unknown> = {};
      for (const fs of g.fields) {
        const v = toValue(fs, groupScalars[g.key]?.[fs.key]);
        if (v !== undefined) gPayload[fs.key] = v;
      }
      for (const gArr of g.arrays ?? []) {
        const rows = rowsToPayload(gArr, groupArrays[g.key]?.[gArr.key] ?? []);
        if (rows.length > 0) gPayload[gArr.key] = rows;
      }
      payload[g.key] = gPayload;
    }

    // Client-side validation with the EXACT engine schema — the same module
    // code the backend runs (values are preserved on failure).
    const calcModule = getCalcModuleForTestType(testType);
    if (calcModule) {
      try {
        calcModule.validateInput(payload);
      } catch (validation) {
        setFormError(
          validation instanceof Error
            ? validation.message
            : "The input does not satisfy the engine contract.",
        );
        return;
      }
    }

    await submit({ input: payload });
  }

  // ---------------- rendering ----------------

  if (!engine) {
    return (
      <div className="rounded-md border border-dashed px-4 py-5 text-sm text-muted-foreground" data-testid="no-engine">
        No calculation engine is registered for test type <span className="font-mono">{testType}</span>.
        Engine-less types (SPT, CPT, UCS, triaxial, specific gravity) remain laboratory-entered results.
      </div>
    );
  }

  const storedDisabled = !canCalculate || !hasRecordedResult;
  const storedReason = !canCalculate
    ? (disabledReason ?? "You are not permitted to run calculations on this test.")
    : !hasRecordedResult
      ? "No laboratory result recorded yet — record a result first, or use explicit input."
      : null;

  const renderField = (
    fs: FieldSpec,
    value: string | boolean | undefined,
    onChange: (v: string) => void,
    idPrefix: string,
  ) => {
    const id = `${idPrefix}-${fs.key}`;
    const strValue = typeof value === "boolean" ? (value ? "true" : "") : (value ?? "");
    return (
      <div key={fs.key} className="space-y-1">
        <Label htmlFor={id} className="text-xs">
          {fs.label}
          {fs.unit ? ` (${fs.unit})` : ""}
          {fs.required ? " *" : ""}
        </Label>
        {fs.kind === "enum" ? (
          <Select value={strValue || undefined} onValueChange={onChange}>
            <SelectTrigger id={id} size="sm" className="w-full">
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              {(fs.options ?? []).map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : fs.kind === "boolean" ? (
          <div className="flex h-8 items-center gap-2">
            <Checkbox
              id={id}
              checked={value === true || value === "true"}
              onCheckedChange={(c) => onChange(c ? "true" : "")}
            />
            <span className="text-xs text-muted-foreground">Yes</span>
          </div>
        ) : (
          <Input
            id={id}
            className="h-8"
            type={fs.kind === "number" ? "number" : "text"}
            step={fs.kind === "number" ? "any" : undefined}
            value={strValue}
            onChange={(ev) => onChange(ev.target.value)}
            placeholder={fs.unit ?? ""}
            aria-label={`${idPrefix} ${fs.label}`}
          />
        )}
        {fs.help && <p className="text-[11px] leading-snug text-muted-foreground">{fs.help}</p>}
      </div>
    );
  };

  const renderArray = (arr: ArraySpec, idPrefix: string) => {
    const rows = arrays[arr.key] ?? [];
    return (
      <div key={arr.key} className="space-y-2 rounded-md border p-3" data-testid={`array-${arr.key}`}>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium">
            {arr.label}{" "}
            <span className="text-xs font-normal text-muted-foreground">
              ({rows.length} / min {arr.min} / max {arr.max})
            </span>
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={rows.length >= arr.max}
            onClick={() => addRows(arr.key, arr.fields.map((x) => x.key))}
          >
            <Plus className="h-3.5 w-3.5" /> Row
          </Button>
        </div>
        {arr.help && <p className="text-[11px] leading-snug text-muted-foreground">{arr.help}</p>}
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No rows — add at least {arr.min}.</p>
        ) : (
          <div className="space-y-2">
            <div
              className="grid gap-2"
              style={{ gridTemplateColumns: `repeat(${arr.fields.length}, minmax(0, 1fr)) 2rem` }}
            >
              {arr.fields.map((fs) => (
                <span key={fs.key} className="text-[11px] text-muted-foreground">
                  {fs.label} {fs.unit ? `(${fs.unit})` : ""} {fs.required ? "*" : ""}
                </span>
              ))}
              <span />
            </div>
            {rows.map((row, i) => (
              <div
                key={i}
                className="grid gap-2"
                style={{ gridTemplateColumns: `repeat(${arr.fields.length}, minmax(0, 1fr)) 2rem` }}
              >
                {arr.fields.map((fs) => (
                  <Input
                    key={fs.key}
                    className="h-8"
                    type={fs.kind === "number" ? "number" : "text"}
                    step={fs.kind === "number" ? "any" : undefined}
                    value={row[fs.key] ?? ""}
                    onChange={(ev) => setRow(arr.key, i, fs.key, ev.target.value)}
                    aria-label={`${arr.label} row ${i + 1} ${fs.label}`}
                  />
                ))}
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-destructive"
                  aria-label={`Remove row ${i + 1}`}
                  onClick={() => removeRow(arr.key, i)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4" data-testid="calculate-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <p>
          Engine <span className="font-medium text-foreground">{engine.label}</span> · module{" "}
          <span className="font-mono">{engine.moduleId}</span> v{engine.moduleVersion} · engine v
          {engine.engineVersion}
        </p>
        {engine && <p>{engine.description}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={runFromStored}
          disabled={storedDisabled || submitting}
          data-testid="calculate-stored"
          title={storedReason ?? "Run the registered engine on the recorded result payload"}
        >
          {submitting && mode === "stored" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Calculator className="h-4 w-4" />
          )}
          Calculate from recorded data
        </Button>
        {spec && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setMode("explicit");
              ensureExplicitInitialized();
            }}
            disabled={!canCalculate || submitting}
            data-testid="calculate-explicit-toggle"
          >
            Explicit analyst input…
          </Button>
        )}
      </div>

      {storedReason && (
        <p className="text-xs text-muted-foreground" data-testid="calculate-stored-reason">
          {storedReason}
        </p>
      )}

      {/* Explicit input form (collapsible; opens on demand) */}
      {spec && mode === "explicit" && explicitOpened && (
        <Collapsible open onOpenChange={() => undefined} className="space-y-3">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm font-medium"
              onClick={() => setMode("stored")}
              data-testid="explicit-collapse"
            >
              <span>Explicit analyst input — {engine.label}</span>
              <ChevronDown className="h-4 w-4" />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Runs the engine on the payload below instead of the recorded result (persisted as an
              EXPLICIT snapshot — deliberate analysis input, never auto-invalidated and never shown
              as the test’s current result). Fields mirror the engine input contract; validation
              runs client-side with the exact engine schema before submission.
            </p>
            {prefillNotice && (
              <p className="rounded-md bg-accent px-3 py-2 text-xs text-primary" data-testid="prefill-notice">
                {prefillNotice}
              </p>
            )}

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {spec.fields.map((fs) =>
                renderField(fs, scalars[fs.key], (v) => setScalar(fs.key, v), "x"),
              )}
            </div>

            {spec.arrays.map((arr) => renderArray(arr, "x"))}

            {(spec.groups ?? []).map((g) => (
              <div key={g.key} className="space-y-3 rounded-md border p-3" data-testid={`group-${g.key}`}>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`grp-${g.key}`}
                    checked={groupEnabled[g.key] === true}
                    onCheckedChange={(c) =>
                      setGroupEnabled((s) => ({ ...s, [g.key]: c === true }))
                    }
                  />
                  <Label htmlFor={`grp-${g.key}`} className="text-sm font-medium">
                    {g.label}
                  </Label>
                </div>
                {g.help && <p className="text-[11px] text-muted-foreground">{g.help}</p>}
                {groupEnabled[g.key] && (
                  <div className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {g.fields.map((fs) =>
                        renderField(
                          fs,
                          groupScalars[g.key]?.[fs.key],
                          (v) =>
                            setGroupScalars((s) => ({
                              ...s,
                              [g.key]: { ...(s[g.key] ?? {}), [fs.key]: v },
                            })),
                          `g-${g.key}`,
                        ),
                      )}
                    </div>
                    {(g.arrays ?? []).map((gArr) => {
                      const rows = groupArrays[g.key]?.[gArr.key] ?? [];
                      return (
                        <div key={gArr.key} className="space-y-2 rounded-md border p-3" data-testid={`array-${g.key}-${gArr.key}`}>
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-medium">
                              {gArr.label}{" "}
                              <span className="text-xs font-normal text-muted-foreground">
                                ({rows.length} / min {gArr.min} / max {gArr.max})
                              </span>
                            </p>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={rows.length >= gArr.max}
                              onClick={() =>
                                setGroupArrays((s) => ({
                                  ...s,
                                  [g.key]: {
                                    ...(s[g.key] ?? {}),
                                    [gArr.key]: [
                                      ...(s[g.key]?.[gArr.key] ?? []),
                                      Object.fromEntries(gArr.fields.map((x) => [x.key, ""])),
                                    ],
                                  },
                                }))
                              }
                            >
                              <Plus className="h-3.5 w-3.5" /> Row
                            </Button>
                          </div>
                          {rows.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                              No rows — add at least {gArr.min}.
                            </p>
                          ) : (
                            <div className="space-y-2">
                              {rows.map((row, i) => (
                                <div
                                  key={i}
                                  className="grid gap-2"
                                  style={{
                                    gridTemplateColumns: `repeat(${gArr.fields.length}, minmax(0, 1fr)) 2rem`,
                                  }}
                                >
                                  {gArr.fields.map((fs) => (
                                    <Input
                                      key={fs.key}
                                      className="h-8"
                                      type={fs.kind === "number" ? "number" : "text"}
                                      step={fs.kind === "number" ? "any" : undefined}
                                      value={row[fs.key] ?? ""}
                                      onChange={(ev) =>
                                        setGroupArrays((s) => ({
                                          ...s,
                                          [g.key]: {
                                            ...(s[g.key] ?? {}),
                                            [gArr.key]: (s[g.key]?.[gArr.key] ?? []).map((r, idx) =>
                                              idx === i ? { ...r, [fs.key]: ev.target.value } : r,
                                            ),
                                          },
                                        }))
                                      }
                                      aria-label={`${gArr.label} row ${i + 1} ${fs.label}`}
                                    />
                                  ))}
                                  <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    className="h-8 w-8 text-destructive"
                                    aria-label={`Remove row ${i + 1}`}
                                    onClick={() =>
                                      setGroupArrays((s) => ({
                                        ...s,
                                        [g.key]: {
                                          ...(s[g.key] ?? {}),
                                          [gArr.key]: (s[g.key]?.[gArr.key] ?? []).filter(
                                            (_, idx) => idx !== i,
                                          ),
                                        },
                                      }))
                                    }
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={runExplicit}
                disabled={!canCalculate || submitting}
                data-testid="calculate-explicit-run"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calculator className="h-4 w-4" />}
                Run with explicit input
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMode("stored")}>
                Close
              </Button>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {formError && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid="calculate-form-error">
          {formError}
        </p>
      )}

      {/* Immediate feedback for the last submission (the persisted record) */}
      {result && result.record && (
        <div className="space-y-3 rounded-md border p-3" data-testid="calculate-result">
          <div className="flex flex-wrap items-center gap-2">
            <CalcStatusBadge status={result.record.status} />
            <ValidityBadge isValid={result.record.isValid} />
            <InputSourceBadge source={result.record.inputSource} />
            {result.replayed && <span className="text-xs text-muted-foreground">(idempotent replay)</span>}
            {result.deduplicated && (
              <span className="text-xs text-muted-foreground">(no change — existing record returned)</span>
            )}
            <Link
              href={`/calculations/${result.record.id}`}
              className="ml-auto text-xs text-primary hover:underline"
            >
              View full record →
            </Link>
          </div>
          {result.record.status === "COMPLETED" ? (
            <CalculationOutput
              moduleId={result.record.moduleId}
              results={
                (result.record.output?.results as Record<string, unknown> | null) ?? null
              }
              inputSnapshot={result.record.inputSnapshot}
              warnings={result.record.warnings}
            />
          ) : (
            <CalculationErrorAlert
              code={result.record.errorCode}
              message={result.record.errorMessage}
              details={result.record.errorDetails}
            />
          )}
        </div>
      )}
    </div>
  );
}
