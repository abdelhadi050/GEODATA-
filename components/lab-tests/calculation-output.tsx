"use client";

/**
 * GEODATA HUB — calculation results renderer (M5.3).
 *
 * Displays the OUTPUT of a persisted calculation record for every registered
 * engine: primary calculated parameters with their units, engineering charts,
 * measurement tables, the laboratory-entered values the engine echoed back,
 * and engine warnings. Consumed by the lab-test detail section, the calculate
 * panel (immediate feedback) and the calculation record page.
 *
 * Engineering rules (M5.3 §8):
 * - No calculation happens here. Every number rendered comes verbatim from
 *   the engine `results` payload; curves plot reported points, and fitted
 *   lines are drawn ONLY from reported fit parameters (the same convention
 *   as the M4 A-line/U-line reference segments) — nothing is recomputed,
 *   clamped or hidden.
 * - Entered (user-provided) values are rendered in a separate muted group so
 *   calculated values are always visually distinguishable from inputs.
 * - Unknown future engines fall back to a generic renderer (registry-driven,
 *   never a crash).
 */
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceDot,
  ScatterChart,
  Scatter,
} from "recharts";
import { Ruler } from "lucide-react";
import {
  WarningList,
  friendlyKey,
  num,
  valueWithUnit,
} from "@/components/lab-tests/calculation-shared";
import type { CalculationWarningDto } from "@/lib/api-types";

const C1 = "var(--chart-1)";
const C2 = "var(--chart-2)";
const C4 = "var(--chart-4)";
const axisStyle = { fontSize: 11, fill: "var(--muted-foreground)" };

// ---------------------------------------------------------------------------
// Spec types
// ---------------------------------------------------------------------------

interface FieldSpec {
  key: string;
  label: string;
  unit?: string;
}

interface EngineOutputSpec {
  /** Primary calculated numeric parameters (rendered with units). */
  primary: FieldSpec[];
  /** Reported string/enum parameters (e.g. method, condition, probe). */
  texts?: FieldSpec[];
  /** Reported boolean flags. */
  flags?: FieldSpec[];
  /** Laboratory-entered values echoed back by the engine (muted group). */
  entered?: FieldSpec[];
}

/** Measurement table derived from results / the input snapshot. */
function TableCard({
  title,
  caption,
  columns,
  rows,
}: {
  title: string;
  caption?: string;
  columns: { key: string; label: string; unit?: string }[];
  rows: Record<string, unknown>[];
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">
        {title} <span className="text-xs font-normal text-muted-foreground">({rows.length})</span>
      </p>
      {caption && <p className="text-xs text-muted-foreground">{caption}</p>}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className="whitespace-nowrap px-3 py-2 text-left text-xs font-medium text-muted-foreground"
                >
                  {c.label}
                  {c.unit ? ` (${c.unit})` : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t">
                {columns.map((c) => (
                  <td key={c.key} className="whitespace-nowrap px-3 py-1.5 tabular-nums">
                    {typeof row[c.key] === "boolean"
                      ? row[c.key]
                        ? "Yes"
                        : "No"
                      : String(row[c.key] ?? "—")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ScalarGrid({
  fields,
  results,
  muted,
}: {
  fields: FieldSpec[];
  results: Record<string, unknown>;
  muted?: boolean;
}) {
  return (
    <dl
      className={`grid gap-x-8 gap-y-2 sm:grid-cols-2 lg:grid-cols-3 ${muted ? "" : ""}`}
      data-testid={muted ? "calculation-entered" : "calculation-primary"}
    >
      {fields.map((f) => (
        <div
          key={f.key}
          className="flex items-baseline justify-between gap-3 border-b border-dashed py-1"
        >
          <dt className={`text-sm ${muted ? "text-muted-foreground" : "text-muted-foreground"}`}>
            {f.label}
            {f.unit ? <span className="text-xs"> ({f.unit})</span> : null}
          </dt>
          <dd className={`font-medium tabular-nums ${muted ? "text-muted-foreground" : ""}`}>
            {valueWithUnit(results[f.key], f.unit)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ChartFrame({ children, height = 280 }: { children: React.ReactNode; height?: number }) {
  return (
    <div style={{ width: "100%", height }} className="text-xs">
      <ResponsiveContainer width="100%" height="100%">
        {children as React.ReactElement}
      </ResponsiveContainer>
    </div>
  );
}

function NoData({ message }: { message: string }) {
  return (
    <div className="flex h-32 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Charts — plot REPORTED points; fitted lines drawn from REPORTED parameters
// ---------------------------------------------------------------------------

function ProctorChart({ results }: { results: Record<string, unknown> }) {
  const points = Array.isArray(results.points) ? (results.points as Record<string, unknown>[]) : [];
  const data = points
    .map((p) => ({ x: num(p.moistureContent), y: num(p.dryDensity) }))
    .filter((d): d is { x: number; y: number } => d.x != null && d.y != null)
    .sort((a, b) => a.x - b.x);
  const zavCurve = Array.isArray(results.zavCurve)
    ? (results.zavCurve as { moistureContent: unknown; zavMgM3: unknown }[])
    : [];
  const zavByW = new Map(
    zavCurve
      .map((p) => [num(p.moistureContent), num(p.zavMgM3)] as const)
      .filter((e): e is readonly [number, number] => e[0] != null && e[1] != null)
      .map((e) => [e[0], e[1]]),
  );
  const merged = data.map((d) => ({ ...d, zav: zavByW.get(d.x) ?? null }));
  const mdd = num(results.maxDryDensity);
  const omc = num(results.optimumMoisture);
  if (data.length < 2) return <NoData message="Not enough compaction points to plot the curve." />;

  return (
    <ChartFrame>
      <LineChart data={merged} margin={{ top: 8, right: 16, bottom: 18, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey="x"
          type="number"
          domain={["dataMin - 1", "dataMax + 1"]}
          tick={axisStyle}
          label={{ value: "Moisture content w (%)", position: "insideBottom", offset: -8, fontSize: 11 }}
        />
        <YAxis
          tick={axisStyle}
          tickFormatter={(v: number) => v.toFixed(2)}
          label={{ value: "Dry density ρd (Mg/m³)", angle: -90, position: "insideLeft", fontSize: 11 }}
        />
        <Tooltip
          formatter={(v: number, n: string) =>
            n === "zav"
              ? [`${v.toFixed(3)} Mg/m³`, "ZAV"]
              : [n === "x" ? `${v} %` : `${v.toFixed(3)} Mg/m³`, n === "x" ? "Moisture" : "Dry density"]
          }
        />
        <Line type="monotone" dataKey="y" stroke={C1} strokeWidth={2} dot={{ r: 4 }} isAnimationActive={false} />
        {zavByW.size > 0 && (
          <Line
            type="monotone"
            dataKey="zav"
            stroke={C2}
            strokeWidth={1.5}
            strokeDasharray="5 4"
            dot={false}
            connectNulls
            isAnimationActive={false}
            name="ZAV"
          />
        )}
        {mdd != null && omc != null && (
          <ReferenceDot
            x={omc}
            y={mdd}
            r={5}
            fill={C4}
            stroke="var(--background)"
            isFront
            label={{
              value: `MDD ${mdd.toFixed(3)} · OMC ${omc.toFixed(2)}%`,
              position: "top",
              fontSize: 11,
              fill: "var(--foreground)",
            }}
          />
        )}
      </LineChart>
    </ChartFrame>
  );
}

function CbrChart({ results }: { results: Record<string, unknown> }) {
  const curve = Array.isArray(results.curve) ? (results.curve as Record<string, unknown>[]) : [];
  const data = curve
    .map((p) => ({ x: num(p.penetrationMm), y: num(p.loadKn) }))
    .filter((d): d is { x: number; y: number } => d.x != null && d.y != null)
    .sort((a, b) => a.x - b.x);
  if (data.length < 2) return <NoData message="Not enough load–penetration points to plot the CBR curve." />;
  const cbr = num(results.cbrValue);

  return (
    <ChartFrame>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 18, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey="x"
          type="number"
          domain={[0, Math.max(12.5, ...data.map((d) => d.x))]}
          tick={axisStyle}
          label={{ value: "Penetration (mm)", position: "insideBottom", offset: -8, fontSize: 11 }}
        />
        <YAxis tick={axisStyle} label={{ value: "Load (kN)", angle: -90, position: "insideLeft", fontSize: 11 }} />
        <Tooltip formatter={(v: number, n: string) => [n === "x" ? `${v} mm` : `${v} kN`, n === "x" ? "Penetration" : "Load"]} />
        <ReferenceLine x={2.5} stroke={C2} strokeDasharray="4 3" label={{ value: "2.5 mm", fontSize: 10, fill: "var(--muted-foreground)" }} />
        <ReferenceLine x={5} stroke={C2} strokeDasharray="4 3" label={{ value: "5.0 mm", fontSize: 10, fill: "var(--muted-foreground)" }} />
        <Line type="monotone" dataKey="y" stroke={C1} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
        {cbr != null && (
          <ReferenceDot
            x={2.5}
            y={data[0].y}
            r={0}
            isFront
            label={{ value: `CBR ${cbr}%`, position: "insideTopLeft", fontSize: 12, fill: "var(--foreground)" }}
          />
        )}
      </LineChart>
    </ChartFrame>
  );
}

function OedometerChart({ results }: { results: Record<string, unknown> }) {
  const curve = Array.isArray(results.curve) ? (results.curve as Record<string, unknown>[]) : [];
  const pts = curve
    .map((p) => ({
      x: num(p.verticalPressureKpa),
      y: num(p.voidRatio),
      unloading: p.branch === "UNLOADING",
    }))
    .filter((d): d is { x: number; y: number; unloading: boolean } => d.x != null && d.y != null && d.x > 0);
  const loading = pts.filter((p) => !p.unloading).sort((a, b) => a.x - b.x);
  if (loading.length < 2) return <NoData message="Not enough loading stages to plot the compression curve." />;
  const unloading = pts.filter((p) => p.unloading).sort((a, b) => a.x - b.x);
  const pc = num(results.preConsolidationPressureKpa);
  const xs = loading.map((p) => p.x).concat(unloading.map((p) => p.x));

  return (
    <ChartFrame>
      <LineChart data={loading} margin={{ top: 8, right: 16, bottom: 18, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey="x"
          type="number"
          scale="log"
          domain={[Math.min(...xs) * 0.8, Math.max(...xs) * 1.25]}
          tick={axisStyle}
          label={{ value: "Vertical pressure σ′v (kPa, log)", position: "insideBottom", offset: -8, fontSize: 11 }}
        />
        <YAxis
          tick={axisStyle}
          tickFormatter={(v: number) => v.toFixed(3)}
          label={{ value: "Void ratio e", angle: -90, position: "insideLeft", fontSize: 11 }}
        />
        <Tooltip formatter={(v: number, n: string) => [n === "x" ? `${v} kPa` : v.toFixed(4), n === "x" ? "Pressure" : "Void ratio"]} />
        {pc != null && pc > 0 && (
          <ReferenceLine x={pc} stroke={C4} strokeDasharray="4 3" label={{ value: `σ′p ≈ ${pc} kPa`, fontSize: 10, fill: "var(--foreground)" }} />
        )}
        <Line type="monotone" dataKey="y" stroke={C1} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} name="Loading" />
        {unloading.length >= 2 && (
          <Line
            data={unloading}
            type="monotone"
            dataKey="y"
            stroke={C2}
            strokeWidth={1.5}
            strokeDasharray="5 4"
            dot={{ r: 2 }}
            isAnimationActive={false}
            name="Unloading"
          />
        )}
      </LineChart>
    </ChartFrame>
  );
}

/**
 * Mohr–Coulomb envelope chart. Points and the envelope line are drawn from
 * REPORTED values only: the line τ = c′ + σn·tanφ′ visualizes the engine's
 * reported c′/φ′ (the same convention as the M4 A-line reference segments) —
 * no fitting is recomputed in the frontend.
 */
function DirectShearChart({ results }: { results: Record<string, unknown> }) {
  const stages = Array.isArray(results.stages) ? (results.stages as Record<string, unknown>[]) : [];
  const single =
    results.singleStage && typeof results.singleStage === "object"
      ? (results.singleStage as Record<string, unknown>)
      : null;
  const pts = stages
    .map((s) => ({ x: num(s.normalStressKpa), peak: num(s.peakShearStressKpa), res: num(s.residualShearStressKpa) }))
    .filter((d): d is { x: number; peak: number; res: number | null } => d.x != null && d.peak != null);
  if (pts.length < 1 && !single) return <NoData message="No shear stages to plot." />;

  const c = num(results.peakCohesionKpa);
  const phi = num(results.peakFrictionAngleDeg);
  const rc = num(results.residualCohesionKpa);
  const rphi = num(results.residualFrictionAngleDeg);
  const singlePts: { x: number; peak: number; res: number | null }[] =
    single != null
      ? [
          {
            x: num(single.normalStressKpa) ?? 0,
            peak: num(single.peakShearStressKpa) ?? 0,
            res: num(single.residualShearStressKpa),
          },
        ]
      : [];
  const allPts = pts.length > 0 ? pts : singlePts;
  const maxX = Math.max(...allPts.map((p) => p.x));
  const domain = [0, maxX * 1.15];
  const envelope = (co: number | null, ph: number | null) =>
    co != null && ph != null
      ? [
          { x: 0, y: co },
          { x: domain[1], y: co + domain[1] * Math.tan((ph * Math.PI) / 180) },
        ]
      : null;
  const peakLine = envelope(c, phi);
  const resLine = envelope(rc, rphi);
  const peakData = pts.filter((p) => p.res == null || p.res !== null).map((p) => ({ x: p.x, y: p.peak }));
  const resData = pts.filter((p) => p.res != null).map((p) => ({ x: p.x, y: p.res as number }));
  const singlePeak = peakData.length === 0 && singlePts.length === 1 ? [{ x: singlePts[0].x, y: singlePts[0].peak }] : [];
  const singleRes =
    singlePts.length === 1 && singlePts[0].res != null ? [{ x: singlePts[0].x, y: singlePts[0].res as number }] : [];

  return (
    <ChartFrame>
      <LineChart margin={{ top: 8, right: 16, bottom: 18, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          type="number"
          dataKey="x"
          domain={domain}
          tick={axisStyle}
          label={{ value: "Normal stress σn (kPa)", position: "insideBottom", offset: -8, fontSize: 11 }}
        />
        <YAxis tick={axisStyle} label={{ value: "Shear stress τ (kPa)", angle: -90, position: "insideLeft", fontSize: 11 }} />
        <Tooltip formatter={(v: number, n: string) => [`${v} kPa`, n]} />
        {peakLine && <Line data={peakLine} type="linear" dataKey="y" stroke={C2} strokeWidth={1.5} dot={false} isAnimationActive={false} name="Peak envelope (reported c′, φ′)" />}
        {resLine && (
          <Line data={resLine} type="linear" dataKey="y" stroke={C4} strokeWidth={1.5} strokeDasharray="5 4" dot={false} isAnimationActive={false} name="Residual envelope (reported)" />
        )}
        <Line data={peakData.length > 0 ? peakData : singlePeak} type="monotone" dataKey="y" stroke={C1} strokeWidth={0} dot={{ r: 4 }} isAnimationActive={false} name="Peak measurements" />
        {(resData.length > 0 || singleRes.length > 0) && (
          <Line data={resData.length > 0 ? resData : singleRes} type="monotone" dataKey="y" stroke={C1} strokeWidth={0} dot={{ r: 3, fill: C4 }} isAnimationActive={false} name="Residual measurements" />
        )}
      </LineChart>
    </ChartFrame>
  );
}

function PressuremeterChart({ results }: { results: Record<string, unknown> }) {
  const curve = Array.isArray(results.curve) ? (results.curve as Record<string, unknown>[]) : [];
  const data = curve
    .map((p) => ({ x: num(p.pressureKpa), y: num(p.injectedVolumeCm3) }))
    .filter((d): d is { x: number; y: number } => d.x != null && d.y != null)
    .sort((a, b) => a.x - b.x);
  if (data.length < 2) return <NoData message="Not enough pressure–volume points to plot the curve." />;
  const creep = num(results.creepPressureKpa);
  const limit = num(results.limitPressureKpa);

  return (
    <ChartFrame>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 18, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey="x"
          type="number"
          domain={[0, Math.max(...data.map((d) => d.x)) * 1.05]}
          tick={axisStyle}
          label={{ value: "Pressure p (kPa)", position: "insideBottom", offset: -8, fontSize: 11 }}
        />
        <YAxis tick={axisStyle} label={{ value: "Injected volume ΔV (cm³)", angle: -90, position: "insideLeft", fontSize: 11 }} />
        <Tooltip formatter={(v: number, n: string) => [n === "x" ? `${v} kPa` : `${v} cm³`, n === "x" ? "Pressure" : "Injected volume"]} />
        {creep != null && creep > 0 && (
          <ReferenceLine x={creep} stroke={C2} strokeDasharray="4 3" label={{ value: `pf ${creep} kPa`, fontSize: 10, fill: "var(--muted-foreground)" }} />
        )}
        {limit != null && limit > 0 && (
          <ReferenceLine x={limit} stroke={C4} strokeDasharray="4 3" label={{ value: `PL ${limit} kPa`, fontSize: 10, fill: "var(--foreground)" }} />
        )}
        <Line type="monotone" dataKey="y" stroke={C1} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
      </LineChart>
    </ChartFrame>
  );
}

function GradingCurveChart({ input }: { input: Record<string, unknown> | null }) {
  const points = input && Array.isArray(input.points) ? (input.points as Record<string, unknown>[]) : [];
  const data = points
    .map((p) => ({ x: num(p.diameterMm), y: num(p.percentFiner) }))
    .filter((d): d is { x: number; y: number } => d.x != null && d.y != null && d.x > 0)
    .sort((a, b) => a.x - b.x);
  if (data.length < 2) return <NoData message="Not enough sieve points to plot the grading curve." />;

  return (
    <ChartFrame>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 18, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey="x"
          type="number"
          scale="log"
          domain={[Math.min(...data.map((d) => d.x)) * 0.7, Math.max(...data.map((d) => d.x)) * 1.4]}
          ticks={[0.001, 0.01, 0.1, 1, 10, 100]}
          tickFormatter={(v: number) => v.toString()}
          tick={axisStyle}
          label={{ value: "Particle diameter (mm, log) — input", position: "insideBottom", offset: -8, fontSize: 11 }}
        />
        <YAxis domain={[0, 100]} tick={axisStyle} label={{ value: "Percent finer (%)", angle: -90, position: "insideLeft", fontSize: 11 }} />
        <Tooltip formatter={(v: number, name: string) => [name === "x" ? `${v} mm` : `${v} %`, name === "x" ? "Diameter" : "Finer"]} />
        <Line type="monotone" dataKey="y" stroke={C1} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
      </LineChart>
    </ChartFrame>
  );
}

function AtterbergCharts({ results, input }: { results: Record<string, unknown>; input: Record<string, unknown> | null }) {
  const slope = num(results.flowCurveSlope);
  const intercept = num(results.flowCurveIntercept);
  const ll = num(results.liquidLimit);
  const pi = num(results.plasticityIndex);
  const flowPts =
    input && Array.isArray(input.liquidLimitPoints) ? (input.liquidLimitPoints as Record<string, unknown>[]) : [];
  const flowData = flowPts
    .map((p) => ({ x: num(p.blows), y: num(p.waterContentPercent) }))
    .filter((d): d is { x: number; y: number } => d.x != null && d.y != null && d.x > 0)
    .sort((a, b) => a.x - b.x);

  const flowCurve =
    flowData.length >= 2 && slope != null && intercept != null
      ? [
          { x: flowData[0].x, y: intercept + slope * Math.log10(flowData[0].x) },
          { x: flowData[flowData.length - 1].x, y: intercept + slope * Math.log10(flowData[flowData.length - 1].x) },
        ]
      : null;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div>
        <p className="mb-1 text-center text-xs font-medium text-muted-foreground">Flow curve — input points + reported fit</p>
        {flowData.length >= 2 ? (
          <ChartFrame height={260}>
            <ScatterChart margin={{ top: 8, right: 12, bottom: 18, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                type="number"
                dataKey="x"
                scale="log"
                domain={[Math.min(...flowData.map((d) => d.x)) * 0.7, Math.max(...flowData.map((d) => d.x)) * 1.4]}
                tick={axisStyle}
                label={{ value: "Blows N (log)", position: "insideBottom", offset: -8, fontSize: 11 }}
              />
              <YAxis tick={axisStyle} label={{ value: "Water content w (%)", angle: -90, position: "insideLeft", fontSize: 11 }} />
              <Tooltip cursor={{ strokeDasharray: "3 3" }} />
              {ll != null && <ReferenceLine x={25} stroke={C2} strokeDasharray="4 3" label={{ value: "25 blows", fontSize: 10, fill: "var(--muted-foreground)" }} />}
              {flowCurve && <Line data={flowCurve} type="linear" dataKey="y" stroke={C2} strokeWidth={1.5} dot={false} isAnimationActive={false} name="Reported fit" />}
              <Scatter data={flowData} fill={C1} isAnimationActive={false} name="Measurements" />
              {ll != null && <ReferenceDot x={25} y={ll} r={5} fill={C4} stroke="var(--background)" isFront label={{ value: `LL ${ll}%`, position: "top", fontSize: 11, fill: "var(--foreground)" }} />}
            </ScatterChart>
          </ChartFrame>
        ) : (
          <NoData message="Not enough flow-curve points to plot." />
        )}
      </div>
      <div>
        <p className="mb-1 text-center text-xs font-medium text-muted-foreground">Plasticity chart position (calculated)</p>
        {ll != null && pi != null ? (
          <ChartFrame height={260}>
            <ScatterChart margin={{ top: 8, right: 12, bottom: 18, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis type="number" dataKey="x" domain={[0, 100]} tick={axisStyle} label={{ value: "Liquid limit LL (%)", position: "insideBottom", offset: -8, fontSize: 11 }} />
              <YAxis type="number" dataKey="y" domain={[0, 60]} tick={axisStyle} label={{ value: "Plasticity index PI (%)", angle: -90, position: "insideLeft", fontSize: 11 }} />
              <Tooltip cursor={{ strokeDasharray: "3 3" }} />
              <ReferenceLine segment={[{ x: 20, y: 0 }, { x: 100, y: 58.4 }]} stroke="var(--muted-foreground)" strokeWidth={1} label={{ value: "A-line", fontSize: 10, fill: "var(--muted-foreground)", position: "insideTopRight" }} />
              <ReferenceLine segment={[{ x: 20, y: 10.8 }, { x: 82, y: 66.6 }]} stroke="var(--muted-foreground)" strokeWidth={1} strokeDasharray="4 4" />
              <ReferenceLine segment={[{ x: 25.5, y: 4.1 }, { x: 100, y: 4.1 }]} stroke="var(--border)" />
              <Scatter data={[{ x: ll, y: pi }]} fill={C1} isAnimationActive={false} name="This sample" />
            </ScatterChart>
          </ChartFrame>
        ) : (
          <NoData message="Plasticity index not derivable (non-plastic or insufficient data)." />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-engine output specifications (field names mirror the module contracts)
// ---------------------------------------------------------------------------

const OUTPUT_SPECS: Record<string, EngineOutputSpec> = {
  "water-content": {
    primary: [
      { key: "waterContentPercent", label: "Water content w", unit: "%" },
      { key: "waterMassG", label: "Water mass", unit: "g" },
      { key: "drySoilMassG", label: "Dry soil mass", unit: "g" },
      { key: "discrepancyPercent", label: "Difference vs entered", unit: "pp" },
    ],
    entered: [{ key: "enteredWaterContentPercent", label: "Entered water content", unit: "%" }],
  },
  granulometry: {
    primary: [
      { key: "d10", label: "d10", unit: "mm" },
      { key: "d30", label: "d30", unit: "mm" },
      { key: "d60", label: "d60", unit: "mm" },
      { key: "uniformityCoefficient", label: "Uniformity coefficient Cu" },
      { key: "coefficientOfCurvature", label: "Coefficient of curvature Cc" },
      { key: "percentPassing0075Mm", label: "Passing 0.075 mm", unit: "%" },
      { key: "percentPassing475Mm", label: "Passing 4.75 mm", unit: "%" },
      { key: "percentCoarserThan475Mm", label: "Coarser than 4.75 mm", unit: "%" },
    ],
    entered: [
      { key: "enteredD10", label: "Entered d10", unit: "mm" },
      { key: "enteredD30", label: "Entered d30", unit: "mm" },
      { key: "enteredD60", label: "Entered d60", unit: "mm" },
      { key: "enteredUniformityCoefficient", label: "Entered Cu" },
      { key: "enteredCoefficientOfCurvature", label: "Entered Cc" },
    ],
  },
  "atterberg-limits": {
    primary: [
      { key: "liquidLimit", label: "Liquid limit LL", unit: "%" },
      { key: "plasticLimit", label: "Plastic limit PL", unit: "%" },
      { key: "plasticityIndex", label: "Plasticity index PI", unit: "%" },
      { key: "flowCurveSlope", label: "Flow curve slope" },
      { key: "flowCurveIntercept", label: "Flow curve intercept" },
      { key: "plasticLimitTrialCount", label: "PL trial count" },
      { key: "plasticLimitTrialStdDev", label: "PL trial std dev", unit: "%" },
      { key: "plasticLimitTrialRange", label: "PL trial range", unit: "%" },
    ],
    flags: [{ key: "nonPlastic", label: "Non-plastic" }],
    entered: [
      { key: "enteredLiquidLimit", label: "Entered LL", unit: "%" },
      { key: "enteredPlasticLimit", label: "Entered PL", unit: "%" },
      { key: "enteredPlasticityIndex", label: "Entered PI", unit: "%" },
    ],
  },
  proctor: {
    primary: [
      { key: "maxDryDensity", label: "Max dry density (fitted)", unit: "Mg/m³" },
      { key: "optimumMoisture", label: "Optimum moisture (fitted)", unit: "%" },
      { key: "pointCount", label: "Compaction points" },
      { key: "curveCoefficientConstant", label: "Curve c0" },
      { key: "curveCoefficientLinear", label: "Curve c1" },
      { key: "curveCoefficientQuadratic", label: "Curve c2" },
    ],
    texts: [
      { key: "method", label: "Compaction effort" },
      { key: "mold", label: "Mold" },
    ],
    entered: [
      { key: "enteredMaxDryDensity", label: "Entered max dry density", unit: "Mg/m³" },
      { key: "enteredOptimumMoisture", label: "Entered optimum moisture", unit: "%" },
    ],
  },
  cbr: {
    primary: [
      { key: "cbrValue", label: "Reported CBR value", unit: "%" },
      { key: "cbrAt2_5", label: "CBR at 2.5 mm", unit: "%" },
      { key: "cbrAt5_0", label: "CBR at 5.0 mm", unit: "%" },
      { key: "loadAt2_5Kn", label: "Load at 2.5 mm", unit: "kN" },
      { key: "loadAt5_0Kn", label: "Load at 5.0 mm", unit: "kN" },
      { key: "swellPercent", label: "Swell", unit: "%" },
    ],
    texts: [
      { key: "condition", label: "Condition" },
      { key: "reportedFrom", label: "Governing penetration" },
    ],
    flags: [{ key: "originCorrectionApplied", label: "Origin correction applied" }],
    entered: [
      { key: "enteredCbrAt2_5", label: "Entered CBR @ 2.5 mm", unit: "%" },
      { key: "enteredCbrAt5_0", label: "Entered CBR @ 5.0 mm", unit: "%" },
      { key: "enteredCbrValue", label: "Entered CBR value", unit: "%" },
    ],
  },
  oedometer: {
    primary: [
      { key: "compressionIndexCc", label: "Compression index Cc" },
      { key: "swellingIndexCs", label: "Swelling index Cs" },
      { key: "preConsolidationPressureKpa", label: "Pre-consolidation σ′p (Casagrande)", unit: "kPa" },
      { key: "initialVoidRatio", label: "Initial void ratio e0" },
      { key: "finalVoidRatio", label: "Final void ratio" },
      { key: "cvMm2PerMin", label: "Cv (log-time)", unit: "mm²/min" },
      { key: "cvCm2PerS", label: "Cv (log-time)", unit: "cm²/s" },
    ],
    entered: [
      { key: "enteredCompressionIndexCc", label: "Entered Cc" },
      { key: "enteredSwellingIndexCs", label: "Entered Cs" },
      { key: "enteredPreConsolidationPressureKpa", label: "Entered σ′p", unit: "kPa" },
      { key: "enteredCvM2PerYear", label: "Entered Cv", unit: "m²/year" },
    ],
  },
  "direct-shear": {
    primary: [
      { key: "peakCohesionKpa", label: "Peak cohesion c′", unit: "kPa" },
      { key: "peakFrictionAngleDeg", label: "Peak friction angle φ′", unit: "°" },
      { key: "peakRSquared", label: "Peak fit R²" },
      { key: "peakPointCount", label: "Peak stage count" },
      { key: "residualCohesionKpa", label: "Residual cohesion c′r", unit: "kPa" },
      { key: "residualFrictionAngleDeg", label: "Residual friction angle φ′r", unit: "°" },
      { key: "residualRSquared", label: "Residual fit R²" },
      { key: "residualPointCount", label: "Residual stage count" },
    ],
    texts: [{ key: "drainageCondition", label: "Drainage condition" }],
    entered: [
      { key: "enteredCohesionKpa", label: "Entered cohesion", unit: "kPa" },
      { key: "enteredFrictionAngleDeg", label: "Entered friction angle", unit: "°" },
    ],
  },
  pressuremeter: {
    primary: [
      { key: "menardModulusMPa", label: "Ménard modulus EM", unit: "MPa" },
      { key: "limitPressureKpa", label: "Limit pressure PL", unit: "kPa" },
      { key: "creepPressureKpa", label: "Creep pressure pf", unit: "kPa" },
      { key: "emPlRatio", label: "EM/PL ratio" },
      { key: "analysisP1Kpa", label: "Analysis range p1", unit: "kPa" },
      { key: "testDepthM", label: "Test depth", unit: "m" },
    ],
    texts: [{ key: "probeType", label: "Probe type" }],
    entered: [
      { key: "enteredCreepPressureKpa", label: "Entered pf", unit: "kPa" },
      { key: "enteredLimitPressureKpa", label: "Entered PL", unit: "kPa" },
      { key: "enteredMenardModulusMPa", label: "Entered EM", unit: "MPa" },
      { key: "enteredEmPlRatio", label: "Entered EM/PL" },
    ],
  },
};

// ---------------------------------------------------------------------------
// Main renderer
// ---------------------------------------------------------------------------

export function CalculationOutput({
  moduleId,
  results,
  inputSnapshot,
  warnings,
}: {
  moduleId: string;
  results: Record<string, unknown> | null;
  inputSnapshot?: Record<string, unknown> | null;
  warnings?: CalculationWarningDto[] | null;
}) {
  if (!results || typeof results !== "object") {
    return <p className="text-sm text-muted-foreground">No calculation output recorded.</p>;
  }

  const spec = OUTPUT_SPECS[moduleId];

  // Generic fallback for engines without a dedicated renderer (future
  // registry additions): scalar grid over the results payload.
  if (!spec) {
    const entries = Object.entries(results).filter(([, v]) => v === null || typeof v !== "object");
    return (
      <div className="space-y-4">
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Ruler className="h-3.5 w-3.5" /> Generic rendering — no dedicated view for engine “{moduleId}”.
        </p>
        <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="calculation-primary">
          {entries.map(([key, value]) => (
            <div key={key} className="flex items-baseline justify-between gap-3 border-b border-dashed py-1">
              <dt className="text-sm text-muted-foreground">{friendlyKey(key)}</dt>
              <dd className="font-medium tabular-nums">
                {typeof value === "boolean" ? (value ? "Yes" : "No") : String(value ?? "—")}
              </dd>
            </div>
          ))}
        </dl>
        <WarningList warnings={warnings} />
      </div>
    );
  }

  const input = inputSnapshot ?? null;

  return (
    <div className="space-y-5" data-testid="calculation-output">
      {spec.texts && spec.texts.length > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {spec.texts.map((t) => {
            const v = results[t.key];
            return (
              <p key={t.key}>
                <span className="text-muted-foreground">{t.label}: </span>
                <span className="font-medium">{v == null ? "—" : String(v)}</span>
              </p>
            );
          })}
        </div>
      )}

      <ScalarGrid fields={spec.primary} results={results} />

      {spec.flags && spec.flags.length > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {spec.flags.map((t) => {
            const v = results[t.key];
            return (
              <p key={t.key}>
                <span className="text-muted-foreground">{t.label}: </span>
                <span className="font-medium">{typeof v === "boolean" ? (v ? "Yes" : "No") : "—"}</span>
              </p>
            );
          })}
        </div>
      )}

      {/* Charts — reported data only */}
      <div>
        <p className="mb-2 text-sm font-medium">Visualization</p>
        {moduleId === "proctor" && <ProctorChart results={results} />}
        {moduleId === "cbr" && <CbrChart results={results} />}
        {moduleId === "oedometer" && <OedometerChart results={results} />}
        {moduleId === "direct-shear" && <DirectShearChart results={results} />}
        {moduleId === "pressuremeter" && <PressuremeterChart results={results} />}
        {moduleId === "granulometry" && <GradingCurveChart input={input} />}
        {moduleId === "atterberg-limits" && <AtterbergCharts results={results} input={input} />}
        {moduleId === "water-content" && (
          <NoData message="Water content has no chart — the calculated values above are the result." />
        )}
      </div>

      {/* Measurement tables */}
      {moduleId === "proctor" && Array.isArray(results.points) && (
        <TableCard
          title="Compaction points (calculated, input order)"
          columns={[
            { key: "moistureContent", label: "Moisture w", unit: "%" },
            { key: "dryDensity", label: "Dry density ρd", unit: "Mg/m³" },
            { key: "wetDensityMgM3", label: "Wet density ρ", unit: "Mg/m³" },
            { key: "zavDryDensityMgM3", label: "ZAV density", unit: "Mg/m³" },
          ]}
          rows={results.points as Record<string, unknown>[]}
        />
      )}
      {moduleId === "cbr" && Array.isArray(results.curve) && (
        <TableCard
          title="Load–penetration curve"
          columns={[
            { key: "penetrationMm", label: "Penetration", unit: "mm" },
            { key: "loadKn", label: "Load", unit: "kN" },
          ]}
          rows={results.curve as Record<string, unknown>[]}
        />
      )}
      {moduleId === "oedometer" && Array.isArray(results.curve) ? (
        <TableCard
          title="Compression curve (e–σ′v)"
          columns={[
            { key: "verticalPressureKpa", label: "Pressure σ′v", unit: "kPa" },
            { key: "voidRatio", label: "Void ratio e" },
            { key: "branch", label: "Branch" },
          ]}
          rows={results.curve as Record<string, unknown>[]}
        />
      ) : null}
      {moduleId === "direct-shear" && Array.isArray(results.stages) && (
        <TableCard
          title="Shear stages"
          columns={[
            { key: "normalStressKpa", label: "Normal stress σn", unit: "kPa" },
            { key: "peakShearStressKpa", label: "Peak shear τ", unit: "kPa" },
            { key: "residualShearStressKpa", label: "Residual shear τr", unit: "kPa" },
          ]}
          rows={results.stages as Record<string, unknown>[]}
        />
      )}
      {moduleId === "direct-shear" &&
        !Array.isArray(results.stages) &&
        typeof results.singleStage === "object" &&
        results.singleStage !== null && (
          <TableCard
            title="Single stage (echoed)"
            caption="One stage cannot fit an envelope — the measurement is echoed; entered c′/φ′ remain user values."
            columns={[
              { key: "normalStressKpa", label: "Normal stress σn", unit: "kPa" },
              { key: "peakShearStressKpa", label: "Peak shear τ", unit: "kPa" },
              { key: "residualShearStressKpa", label: "Residual shear τr", unit: "kPa" },
            ]}
            rows={[results.singleStage as Record<string, unknown>]}
          />
        )}
      {moduleId === "pressuremeter" && Array.isArray(results.curve) && (
        <TableCard
          title="Pressure–volume readings"
          columns={[
            { key: "pressureKpa", label: "Pressure p", unit: "kPa" },
            { key: "volumeCm3", label: "Volume V", unit: "cm³" },
            { key: "injectedVolumeCm3", label: "Injected ΔV", unit: "cm³" },
          ]}
          rows={results.curve as Record<string, unknown>[]}
        />
      )}
      {moduleId === "granulometry" && input && Array.isArray(input.points) && (
        <TableCard
          title="Input — sieve / hydrometer points"
          caption="User-provided measurements consumed by the engine (plotted above)."
          columns={[
            { key: "diameterMm", label: "Diameter", unit: "mm" },
            { key: "percentFiner", label: "Percent finer", unit: "%" },
          ]}
          rows={input.points as Record<string, unknown>[]}
        />
      )}
      {moduleId === "atterberg-limits" && input && Array.isArray(input.liquidLimitPoints) && (
        <TableCard
          title="Input — flow-curve points"
          caption="User-provided measurements consumed by the engine (plotted above)."
          columns={[
            { key: "blows", label: "Blows N" },
            { key: "waterContentPercent", label: "Water content w", unit: "%" },
          ]}
          rows={input.liquidLimitPoints as Record<string, unknown>[]}
        />
      )}

      {/* Laboratory-entered values — echoed by the engine, never overwritten */}
      {spec.entered && spec.entered.length > 0 && (
        <div className="rounded-md border border-dashed bg-muted/30 p-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Laboratory-entered values (echoed unchanged for comparison — discrepancies are reported as warnings)
          </p>
          <ScalarGrid fields={spec.entered} results={results} muted />
        </div>
      )}

      <WarningList warnings={warnings} />
    </div>
  );
}
