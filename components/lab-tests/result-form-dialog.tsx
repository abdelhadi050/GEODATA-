"use client";

/**
 * GEODATA HUB — laboratory result entry (M4).
 *
 * A generic structured form driven by per-type field specifications.
 * On submit the payload is validated CLIENT-SIDE with the exact registry
 * Zod schema (`parseLabTestResult` — the same code the API uses), then
 * PUT to /api/lab-tests/[id]/result where it is validated again
 * authoritatively. No result is ever invented or stored unvalidated.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardEdit, Plus, Trash2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiPut, ApiClientError } from "@/lib/api-client";
import { parseLabTestResult } from "@/lib/lab-tests/registry";
import type { LabTestType } from "@/lib/lab-tests/registry";
import { handleFormError } from "@/components/projects/project-form-dialog";

interface FieldSpec {
  key: string;
  label: string;
  unit?: string;
  kind: "number" | "enum" | "boolean" | "text";
  options?: { value: string; label: string }[];
  required?: boolean;
}

interface ArraySpec {
  key: string;
  label: string;
  fields: FieldSpec[];
  min: number;
  max: number;
}

interface TypeSpec {
  fields: FieldSpec[];
  array?: ArraySpec;
}

const enumOpts = (values: readonly string[], labels?: Record<string, string>) =>
  values.map((v) => ({ value: v, label: labels?.[v] ?? v }));

const f = (key: string, label: string, unit?: string, required = false): FieldSpec => ({
  key,
  label,
  unit,
  kind: "number",
  required,
});
const e = (key: string, label: string, values: readonly string[], labels?: Record<string, string>, required = true): FieldSpec => ({
  key,
  label,
  kind: "enum",
  options: enumOpts(values, labels),
  required,
});
const t = (key: string, label: string, required = false): FieldSpec => ({
  key,
  label,
  kind: "text",
  required,
});

const RESULT_SPECS: Partial<Record<LabTestType, TypeSpec>> = {
  GRANULOMETRY: {
    fields: [
      f("d10", "d10", "mm"),
      f("d30", "d30", "mm"),
      f("d60", "d60", "mm"),
      f("uniformityCoefficient", "Cu (d60/d10)"),
      f("coefficientOfCurvature", "Cc"),
      t("uscsClassification", "USCS classification"),
    ],
    array: {
      key: "points",
      label: "Sieve / hydrometer points",
      fields: [f("diameterMm", "Diameter", "mm", true), f("percentFiner", "Percent finer", "%", true)],
      min: 4,
      max: 40,
    },
  },
  ATTERBERG_LIMITS: {
    fields: [
      f("liquidLimit", "Liquid limit LL", "%", true),
      f("plasticLimit", "Plastic limit PL", "%", true),
      f("plasticityIndex", "Plasticity index PI", "%", true),
      f("shrinkageLimit", "Shrinkage limit", "%"),
      f("liquidityIndex", "Liquidity index"),
      t("uscsSymbol", "USCS symbol"),
    ],
  },
  PROCTOR: {
    fields: [
      e("method", "Compaction effort", ["STANDARD", "MODIFIED"], { STANDARD: "Standard (D698)", MODIFIED: "Modified (D1557)" }),
      f("maxDryDensity", "Max dry density (MDD)", "Mg/m³", true),
      f("optimumMoisture", "Optimum moisture content (OMC)", "%", true),
    ],
    array: {
      key: "points",
      label: "Compaction points (w, ρd)",
      fields: [f("moistureContent", "Moisture w", "%", true), f("dryDensity", "Dry density ρd", "Mg/m³", true)],
      min: 3,
      max: 8,
    },
  },
  CBR: {
    fields: [
      e("condition", "Condition", ["SOAKED", "UNSOAKED"]),
      f("cbrAt2_5", "CBR at 2.5 mm", "%", true),
      f("cbrAt5_0", "CBR at 5.0 mm", "%", true),
      f("cbrValue", "CBR value (max)", "%", true),
      f("swellPercent", "Swell", "%"),
    ],
    array: {
      key: "points",
      label: "Load–penetration points",
      fields: [f("penetrationMm", "Penetration", "mm", true), f("loadKn", "Load", "kN", true)],
      min: 2,
      max: 20,
    },
  },
  SPT: {
    fields: [
      f("depthFrom", "Depth from", "m", true),
      f("depthTo", "Depth to", "m", true),
      e("hammerType", "Hammer type", ["SAFETY", "AUTOMATIC", "DONUT"]),
      f("blows1st150", "Blows, 1st 150 mm", "count", true),
      f("blows2nd150", "Blows, 2nd 150 mm", "count", true),
      f("blows3rd150", "Blows, 3rd 150 mm", "count", true),
      f("nValue", "N value", "count", true),
      f("energyRatio", "Energy ratio ER", "%"),
      f("n60", "N₆₀"),
      { key: "refusal", label: "Refusal", kind: "boolean" },
      t("soilDescription", "Soil description"),
    ],
  },
  CPT: {
    fields: [f("finalDepth", "Final depth", "m", true), f("frictionRatioAvg", "Avg friction ratio", "%")],
    array: {
      key: "points",
      label: "Depth readings",
      fields: [
        f("depth", "Depth", "m", true),
        f("coneResistanceMpa", "qc", "MPa", true),
        f("sleeveFrictionKpa", "fs", "kPa", true),
      ],
      min: 2,
      max: 600,
    },
  },
  UCS: {
    fields: [
      f("specimenDiameterMm", "Specimen diameter", "mm", true),
      f("peakStressKpa", "Peak stress", "kPa", true),
      f("strainAtFailurePercent", "Strain at failure", "%", true),
      e("failurePattern", "Failure pattern", ["AXIAL", "CONICAL", "SHEAR", "BULGING"], undefined, false),
      f("moistureContentAtTest", "Moisture at test", "%"),
      t("rockClass", "Rock class / description"),
    ],
  },
  TRIAXIAL: {
    fields: [
      e("type", "Test type", ["UU", "CU", "CD"], { UU: "UU (unconsolidated undrained)", CU: "CU (consolidated undrained)", CD: "CD (consolidated drained)" }),
      f("cohesionKpa", "Cohesion c′", "kPa"),
      f("frictionAngleDeg", "Friction angle φ′", "°"),
      f("excessPorePressureKpa", "Excess pore pressure", "kPa"),
    ],
    array: {
      key: "stages",
      label: "Consolidation stages",
      fields: [
        f("confiningPressureKpa", "Confining σ3", "kPa", true),
        f("peakDeviatorStressKpa", "Peak deviator (σ1−σ3)", "kPa", true),
        f("strainAtFailurePercent", "Strain at failure", "%"),
      ],
      min: 1,
      max: 5,
    },
  },
  OEDOMETER: {
    fields: [
      f("compressionIndexCc", "Compression index Cc"),
      f("swellingIndexCs", "Swelling index Cs"),
      f("preConsolidationPressureKpa", "Pre-consolidation σ′p", "kPa"),
      f("coefficientOfConsolidationCvM2PerYear", "Cv", "m²/year"),
    ],
    array: {
      key: "stages",
      label: "Loading stages",
      fields: [f("verticalPressureKpa", "Pressure σ′v", "kPa", true), f("voidRatio", "Void ratio e", undefined, true)],
      min: 2,
      max: 12,
    },
  },
  DIRECT_SHEAR: {
    fields: [
      f("normalStressKpa", "Normal stress", "kPa", true),
      f("peakShearStressKpa", "Peak shear stress", "kPa", true),
      f("residualShearStressKpa", "Residual shear stress", "kPa"),
      f("cohesionKpa", "Cohesion c′", "kPa"),
      f("frictionAngleDeg", "Friction angle φ′", "°"),
    ],
  },
  WATER_CONTENT: {
    fields: [
      f("waterContentPercent", "Water content w", "%", true),
      f("wetMassG", "Wet mass", "g"),
      f("dryMassG", "Dry mass", "g"),
      f("containerMassG", "Container mass", "g"),
    ],
  },
  SPECIFIC_GRAVITY: {
    fields: [
      f("specificGravity", "Specific gravity Gs", undefined, true),
      e("method", "Method", ["PYCNOMETER", "GAS_JAR"], { PYCNOMETER: "Pycnometer", GAS_JAR: "Gas jar" }, false),
      f("temperatureC", "Temperature", "°C"),
    ],
  },
};

type Row = Record<string, string>;

function toValue(spec: FieldSpec, raw: string | boolean | undefined): unknown {
  if (spec.kind === "boolean") return raw === true || raw === "true";
  if (raw === undefined || raw === "") return undefined;
  if (spec.kind === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw; // let Zod report the type error
  }
  return raw;
}

export function ResultFormDialog({
  testId,
  testType,
  testLabel,
  existingResult,
  existingSummary,
}: {
  testId: string;
  testType: string;
  testLabel: string;
  existingResult?: Record<string, unknown> | null;
  existingSummary?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const spec = RESULT_SPECS[testType as LabTestType];
  const arraySpec = spec?.array;

  const [scalars, setScalars] = useState<Row>(() => {
    const init: Row = {};
    if (spec) {
      for (const fs of spec.fields) {
        const v = existingResult?.[fs.key];
        init[fs.key] =
          v === undefined || v === null
            ? fs.kind === "enum" && fs.required
              ? (fs.options?.[0]?.value ?? "")
              : ""
            : String(v);
      }
    }
    return init;
  });
  const [rows, setRows] = useState<Row[]>(() => {
    if (!arraySpec) return [];
    const existing = Array.isArray(existingResult?.[arraySpec.key])
      ? (existingResult![arraySpec.key] as Record<string, unknown>[])
      : [];
    const base =
      existing.length > 0
        ? existing.map((r) => {
            const row: Row = {};
            for (const fs of arraySpec.fields) row[fs.key] = r[fs.key] == null ? "" : String(r[fs.key]);
            return row;
          })
        : Array.from({ length: Math.min(2, arraySpec.min) }, () => {
            const row: Row = {};
            for (const fs of arraySpec.fields) row[fs.key] = "";
            return row;
          });
    return base;
  });
  const [summary, setSummary] = useState(existingSummary ?? "");

  if (!spec) {
    return null; // unknown type: no structured form (registry remains authoritative)
  }

  function setScalar(key: string, value: string) {
    setScalars((s) => ({ ...s, [key]: value }));
  }
  function setRow(i: number, key: string, value: string) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));
  }

  const onSubmit = async () => {
    setValidationError(null);
    const payload: Record<string, unknown> = {};
    for (const fs of spec.fields) {
      const v = toValue(fs, scalars[fs.key] as string | undefined);
      if (v !== undefined) payload[fs.key] = v;
    }
    if (arraySpec) {
      payload[arraySpec.key] = rows
        .map((row) => {
          const out: Record<string, unknown> = {};
          for (const fs of arraySpec.fields) {
            const v = toValue(fs, row[fs.key]);
            if (v !== undefined) out[fs.key] = v;
          }
          return out;
        })
        .filter((r) => Object.keys(r).length > 0);
    }

    // Client-side validation with the EXACT registry schema (shared code).
    const parsed = parseLabTestResult(testType, payload);
    if (!parsed.ok) {
      setValidationError(parsed.error);
      return;
    }

    setSubmitting(true);
    try {
      await apiPut(`/api/lab-tests/${testId}/result`, {
        result: parsed.data,
        summary: summary || undefined,
      });
      toast({ title: "Result recorded", description: testLabel });
      setOpen(false);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 400) {
        setValidationError(err.message);
        return;
      }
      handleFormError(err, () => undefined, "Result could not be recorded");
    } finally {
      setSubmitting(false);
    }
  };

  const renderField = (fs: FieldSpec, value: string | boolean, onChange: (v: string) => void, idPrefix: string) => {
    const id = `${idPrefix}-${fs.key}`;
    const strValue = typeof value === "boolean" ? (value ? "true" : "") : value;
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
            onChange={(e) => onChange(e.target.value)}
            placeholder={fs.unit ?? ""}
          />
        )}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <ClipboardEdit className="h-4 w-4" />
          {existingResult ? "Edit result" : "Record result"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Result — {testLabel}</DialogTitle>
          <DialogDescription>
            Values are validated against the registry schema before submission
            (cross-field rules included); the API re-validates authoritatively.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {spec.fields.map((fs) => renderField(fs, scalars[fs.key] ?? "", (v) => setScalar(fs.key, v), "s"))}
          </div>

          {arraySpec && (
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">
                  {arraySpec.label}{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    ({rows.length} / min {arraySpec.min} / max {arraySpec.max})
                  </span>
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={rows.length >= arraySpec.max}
                  onClick={() =>
                    setRows((rs) => [
                      ...rs,
                      Object.fromEntries(arraySpec.fields.map((fs) => [fs.key, ""])),
                    ])
                  }
                >
                  <Plus className="h-3.5 w-3.5" /> Row
                </Button>
              </div>
              {rows.length === 0 ? (
                <p className="text-xs text-muted-foreground">No rows — add at least {arraySpec.min}.</p>
              ) : (
                <div className="space-y-2">
                  <div
                    className="grid gap-2"
                    style={{
                      gridTemplateColumns: `repeat(${arraySpec.fields.length}, minmax(0, 1fr)) 2rem`,
                    }}
                  >
                    {arraySpec.fields.map((fs) => (
                      <span key={fs.key} className="text-[11px] text-muted-foreground">
                        {fs.label} {fs.unit ? `(${fs.unit})` : ""} *
                      </span>
                    ))}
                    <span />
                  </div>
                  {rows.map((row, i) => (
                    <div
                      key={i}
                      className="grid gap-2"
                      style={{
                        gridTemplateColumns: `repeat(${arraySpec.fields.length}, minmax(0, 1fr)) 2rem`,
                      }}
                    >
                      {arraySpec.fields.map((fs) => (
                        <Input
                          key={fs.key}
                          className="h-8"
                          type="number"
                          step="any"
                          value={row[fs.key]}
                          onChange={(e) => setRow(i, fs.key, e.target.value)}
                          aria-label={`${arraySpec.label} row ${i + 1} ${fs.label}`}
                        />
                      ))}
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-destructive"
                        aria-label={`Remove row ${i + 1}`}
                        disabled={rows.length <= arraySpec.min}
                        onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="result-summary">Summary (shown in lists)</Label>
            <Input
              id="result-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="e.g. w = 18.5 %"
            />
          </div>

          {validationError && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {validationError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={onSubmit} disabled={submitting}>
            {submitting ? "Recording…" : "Save result"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
