"use client";

/**
 * GEODATA HUB — laboratory test charts (M4).
 *
 * Renders the chart configuration provided by the M2/M3 registry
 * (GET /api/lab-tests/[id] embeds `registry.chart`) using recharts.
 * Chart kinds: grain-size curve (semi-log), Casagrande plasticity chart
 * with A-line/U-line, Proctor compaction curve with MDD/OMC, CBR
 * load–penetration, depth profiles (SPT / water content), CPT dual
 * profile, oedometer e–log p, and bar summaries. No chart data — no
 * invented curves: the component states when a result has no plottable
 * points.
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
  BarChart,
  Bar,
  Cell,
  LabelList,
} from "recharts";
import type { ChartConfigDto } from "@/lib/api-types";

const C1 = "var(--chart-1)";
const C2 = "var(--chart-2)";
const C4 = "var(--chart-4)";

const axisStyle = { fontSize: 11, fill: "var(--muted-foreground)" };

function ChartFrame({
  children,
  height = 280,
}: {
  children: React.ReactNode;
  height?: number;
}) {
  return (
    <div style={{ width: "100%", height }} className="text-xs">
      <ResponsiveContainer width="100%" height="100%">
        {children as React.ReactElement}
      </ResponsiveContainer>
    </div>
  );
}

function unitFor(key: string): string {
  if (key.endsWith("Kpa")) return "kPa";
  if (key.endsWith("Mpa")) return "MPa";
  if (key.endsWith("Percent")) return "%";
  return "";
}

function NoData({ message }: { message: string }) {
  return (
    <div className="flex h-40 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ---------- 1. Grain size curve ----------

function GrainSizeCurve({ result }: { result: Record<string, unknown> }) {
  const points = Array.isArray(result.points) ? result.points : [];
  const data = points
    .map((p) => {
      const r = p as Record<string, unknown>;
      return { x: num(r.diameterMm), y: num(r.percentFiner) };
    })
    .filter((d): d is { x: number; y: number } => d.x != null && d.y != null && d.x > 0)
    .sort((a, b) => a.x - b.x);
  if (data.length < 2) return <NoData message="Not enough sieve points to plot the grading curve." />;

  const min = Math.min(...data.map((d) => d.x));
  const max = Math.max(...data.map((d) => d.x));

  return (
    <ChartFrame>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 18, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey="x"
          type="number"
          scale="log"
          domain={[min * 0.7, max * 1.4]}
          ticks={[0.001, 0.01, 0.1, 1, 10, 100]}
          tickFormatter={(v: number) => v.toString()}
          tick={axisStyle}
          label={{ value: "Particle diameter (mm, log)", position: "insideBottom", offset: -8, fontSize: 11 }}
        />
        <YAxis domain={[0, 100]} tick={axisStyle} label={{ value: "Percent finer (%)", angle: -90, position: "insideLeft", fontSize: 11 }} />
        <Tooltip
          formatter={(v: number, name: string) => [name === "x" ? `${v} mm` : `${v} %`, name === "x" ? "Diameter" : "Finer"]}
        />
        <Line type="monotone" dataKey="y" stroke={C1} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
      </LineChart>
    </ChartFrame>
  );
}

// ---------- 2. Plasticity chart ----------

function PlasticityChart({ result }: { result: Record<string, unknown> }) {
  const ll = num(result.liquidLimit);
  const pi = num(result.plasticityIndex);
  if (ll == null || pi == null) {
    return <NoData message="Liquid limit and plasticity index are required to plot the plasticity chart." />;
  }
  // A-line: PI = 0.73 (LL − 20); U-line: PI = 0.9 (LL − 8) — drawn as segments
  return (
    <ChartFrame>
      <ScatterChart margin={{ top: 8, right: 12, bottom: 18, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          type="number"
          dataKey="x"
          domain={[0, 100]}
          tick={axisStyle}
          label={{ value: "Liquid limit LL (%)", position: "insideBottom", offset: -8, fontSize: 11 }}
        />
        <YAxis
          type="number"
          dataKey="y"
          domain={[0, 60]}
          tick={axisStyle}
          label={{ value: "Plasticity index PI (%)", angle: -90, position: "insideLeft", fontSize: 11 }}
        />
        <Tooltip cursor={{ strokeDasharray: "3 3" }} />
        <ReferenceLine
          segment={[{ x: 20, y: 0 }, { x: 100, y: 58.4 }]}
          stroke="var(--muted-foreground)"
          strokeWidth={1}
          label={{ value: "A-line", fontSize: 10, fill: "var(--muted-foreground)", position: "insideTopRight" }}
        />
        <ReferenceLine
          segment={[{ x: 20, y: 10.8 }, { x: 82, y: 66.6 }]}
          stroke="var(--muted-foreground)"
          strokeWidth={1}
          strokeDasharray="4 4"
        />
        <ReferenceLine segment={[{ x: 25.5, y: 4.1 }, { x: 100, y: 4.1 }]} stroke="var(--border)" />
        <Scatter data={[{ x: ll, y: pi }]} fill={C1} isAnimationActive={false} name="This sample" />
      </ScatterChart>
    </ChartFrame>
  );
}

// ---------- 3. Proctor compaction curve ----------

function CompactionCurve({ result }: { result: Record<string, unknown> }) {
  const points = Array.isArray(result.points) ? result.points : [];
  const data = points
    .map((p) => {
      const r = p as Record<string, unknown>;
      return { x: num(r.moistureContent), y: num(r.dryDensity) };
    })
    .filter((d): d is { x: number; y: number } => d.x != null && d.y != null)
    .sort((a, b) => a.x - b.x);
  const mdd = num(result.maxDryDensity);
  const omc = num(result.optimumMoisture);
  if (data.length < 2) return <NoData message="Not enough compaction points to plot the curve." />;

  return (
    <ChartFrame>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 18, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey="x"
          type="number"
          domain={["dataMin - 1", "dataMax + 1"]}
          tick={axisStyle}
          label={{ value: "Moisture content w (%)", position: "insideBottom", offset: -8, fontSize: 11 }}
        />
        <YAxis
          domain={["dataMin - 0.05", "dataMax + 0.08"]}
          tick={axisStyle}
          tickFormatter={(v: number) => v.toFixed(2)}
          label={{ value: "Dry density ρd (Mg/m³)", angle: -90, position: "insideLeft", fontSize: 11 }}
        />
        <Tooltip formatter={(v: number, n: string) => [n === "x" ? `${v} %` : `${v.toFixed(3)} Mg/m³`, n === "x" ? "Moisture" : "Dry density"]} />
        <Line type="monotone" dataKey="y" stroke={C1} strokeWidth={2} dot={{ r: 4 }} isAnimationActive={false} />
        {mdd != null && omc != null && (
          <ReferenceDot
            x={omc}
            y={mdd}
            r={5}
            fill={C4}
            stroke="var(--background)"
            isFront
            label={{ value: `MDD ${mdd.toFixed(2)} · OMC ${omc.toFixed(1)}%`, position: "top", fontSize: 11, fill: "var(--foreground)" }}
          />
        )}
      </LineChart>
    </ChartFrame>
  );
}

// ---------- 4. CBR load–penetration ----------

function CbrCurve({ result }: { result: Record<string, unknown> }) {
  const points = Array.isArray(result.points) ? result.points : [];
  const data = points
    .map((p) => {
      const r = p as Record<string, unknown>;
      return { x: num(r.penetrationMm), y: num(r.loadKn) };
    })
    .filter((d): d is { x: number; y: number } => d.x != null && d.y != null)
    .sort((a, b) => a.x - b.x);
  if (data.length < 2) return <NoData message="Not enough load–penetration points to plot the CBR curve." />;
  const cbr = num(result.cbrValue);

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
          <ReferenceDot x={2.5} y={data[0].y} r={0} isFront label={{ value: `CBR ${cbr}%`, position: "insideTopLeft", fontSize: 12, fill: "var(--foreground)" }} />
        )}
      </LineChart>
    </ChartFrame>
  );
}

// ---------- 5. Depth profile (SPT N-value, water content) ----------

function DepthProfile({ result, valueKey }: { result: Record<string, unknown>; valueKey: string }) {
  const value = num(result[valueKey]);
  const from = num(result.depthFrom);
  const to = num(result.depthTo);
  if (value == null || from == null || to == null) {
    return <NoData message="Depth and value are required for the depth profile." />;
  }
  const mid = (from + to) / 2;
  const data = [{ depth: mid, value }];
  return (
    <ChartFrame height={220}>
      <BarChart data={data} layout="vertical" margin={{ top: 8, right: 24, bottom: 18, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis type="number" tick={axisStyle} label={{ value: valueKey, position: "insideBottom", offset: -8, fontSize: 11 }} />
        <YAxis type="number" dataKey="depth" domain={[0, Math.ceil(to + 1)]} reversed tick={axisStyle} label={{ value: "Depth (m)", angle: -90, position: "insideLeft", fontSize: 11 }} />
        <Tooltip formatter={(v: number) => [v, valueKey]} labelFormatter={() => `${from.toFixed(2)}–${to.toFixed(2)} m`} />
        <Bar dataKey="value" fill={C1} isAnimationActive={false} barSize={18}>
          <LabelList dataKey="value" position="right" style={{ fontSize: 11 }} />
        </Bar>
      </BarChart>
    </ChartFrame>
  );
}

// ---------- 6. CPT profile (qc and fs vs depth) ----------

function CptProfile({ result }: { result: Record<string, unknown> }) {
  const points = Array.isArray(result.points) ? result.points : [];
  const data = points
    .map((p) => {
      const r = p as Record<string, unknown>;
      return {
        depth: num(r.depth),
        qc: num(r.coneResistanceMpa),
        fs: num(r.sleeveFrictionKpa),
      };
    })
    .filter((d) => d.depth != null)
    .sort((a, b) => (a.depth as number) - (b.depth as number));
  if (data.length < 2) return <NoData message="Not enough depth points to plot the CPT profile." />;

  const panel = (dataKey: "qc" | "fs", color: string, label: string, unit: string) => (
    <div>
      <p className="mb-1 text-center text-xs font-medium text-muted-foreground">
        {label} ({unit})
      </p>
      <ChartFrame height={300}>
        <LineChart data={data} margin={{ top: 4, right: 10, bottom: 6, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis type="number" dataKey={dataKey} tick={axisStyle} />
          <YAxis type="number" dataKey="depth" domain={[0, "dataMax"]} reversed tick={axisStyle} label={{ value: "Depth (m)", angle: -90, position: "insideLeft", fontSize: 11 }} />
          <Tooltip formatter={(v: number) => [`${v} ${unit}`, label]} />
          <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.8} dot={false} isAnimationActive={false} />
        </LineChart>
      </ChartFrame>
    </div>
  );

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {panel("qc", C1, "Cone resistance qc", "MPa")}
      {panel("fs", C2, "Sleeve friction fs", "kPa")}
    </div>
  );
}

// ---------- 7. Oedometer e–log p ----------

function OedometerCurve({ result }: { result: Record<string, unknown> }) {
  const stages = Array.isArray(result.stages) ? result.stages : [];
  const data = stages
    .map((p) => {
      const r = p as Record<string, unknown>;
      return { x: num(r.verticalPressureKpa), y: num(r.voidRatio) };
    })
    .filter((d): d is { x: number; y: number } => d.x != null && d.y != null && d.x > 0)
    .sort((a, b) => a.x - b.x);
  if (data.length < 2) return <NoData message="Not enough loading stages to plot the compression curve." />;
  const pc = num(result.preConsolidationPressureKpa);

  return (
    <ChartFrame>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 18, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey="x"
          type="number"
          scale="log"
          domain={[Math.min(...data.map((d) => d.x)) * 0.8, Math.max(...data.map((d) => d.x)) * 1.25]}
          tick={axisStyle}
          label={{ value: "Vertical pressure σ′v (kPa, log)", position: "insideBottom", offset: -8, fontSize: 11 }}
        />
        <YAxis tick={axisStyle} tickFormatter={(v: number) => v.toFixed(2)} label={{ value: "Void ratio e", angle: -90, position: "insideLeft", fontSize: 11 }} />
        <Tooltip formatter={(v: number, n: string) => [n === "x" ? `${v} kPa` : v.toFixed(3), n === "x" ? "Pressure" : "Void ratio"]} />
        {pc != null && pc > 0 && (
          <ReferenceLine x={pc} stroke={C4} strokeDasharray="4 3" label={{ value: `σ′p ≈ ${pc} kPa`, fontSize: 10, fill: "var(--foreground)" }} />
        )}
        <Line type="monotone" dataKey="y" stroke={C1} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
      </LineChart>
    </ChartFrame>
  );
}

// ---------- 8. Ménard pressuremeter curve (M5.3 renderer — the M5.1
// contract kind previously rendered its graceful unknown state) ----------

function PressuremeterCurve({ result }: { result: Record<string, unknown> }) {
  const points = Array.isArray(result.points) ? result.points : [];
  const data = points
    .map((p) => {
      const r = p as Record<string, unknown>;
      return { x: num(r.pressureKpa), y: num(r.volumeCm3) };
    })
    .filter((d): d is { x: number; y: number } => d.x != null && d.y != null)
    .sort((a, b) => a.x - b.x);
  if (data.length < 2) {
    return <NoData message="Not enough pressure–volume points to plot the pressuremeter curve." />;
  }
  const creep = num(result.creepPressureKpa);
  const limit = num(result.limitPressureKpa);

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
        <YAxis tick={axisStyle} label={{ value: "Volume V (cm³)", angle: -90, position: "insideLeft", fontSize: 11 }} />
        <Tooltip formatter={(v: number, n: string) => [n === "x" ? `${v} kPa` : `${v} cm³`, n === "x" ? "Pressure" : "Volume"]} />
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

// ---------- 9. Bar summary (UCS, triaxial stages, direct shear) ----------

function BarSummary({
  result,
  valueKey,
  groupBy,
  unitLabel,
}: {
  result: Record<string, unknown>;
  valueKey: string;
  groupBy?: string;
  unitLabel: string;
}) {
  let data: { name: string; value: number }[] = [];

  if (Array.isArray(result.stages)) {
    // TRIAXIAL / OEDOMETER-like stage data
    data = (result.stages as Record<string, unknown>[])
      .map((s) => ({
        name: groupBy && s[groupBy] != null ? String(s[groupBy]) : "Stage",
        value: num(s[valueKey]),
      }))
      .filter((d): d is { name: string; value: number } => d.value != null);
  } else {
    const v = num(result[valueKey]);
    const g = groupBy ? result[groupBy] : null;
    if (v != null) data = [{ name: g != null ? String(g) : valueKey, value: v }];
  }

  if (data.length === 0) {
    return <NoData message={`No ${valueKey} values available to plot.`} />;
  }

  return (
    <ChartFrame height={240}>
      <BarChart data={data} margin={{ top: 16, right: 12, bottom: 4, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey="name" tick={axisStyle} />
        <YAxis tick={axisStyle} label={{ value: unitLabel, angle: -90, position: "insideLeft", fontSize: 11 }} />
        <Tooltip formatter={(v: number) => [`${v} ${unitLabel}`, valueKey]} />
        <Bar dataKey="value" fill={C1} isAnimationActive={false} barSize={36}>
          <LabelList dataKey="value" position="top" style={{ fontSize: 11 }} />
        </Bar>
      </BarChart>
    </ChartFrame>
  );
}

// ---------- Router ----------

export function TestChart({
  chart,
  result,
}: {
  chart: ChartConfigDto;
  result: Record<string, unknown> | null;
}) {
  if (chart.kind === "none" || !result) {
    return (
      <NoData
        message={
          chart.kind === "none"
            ? "This test type has no chart configuration in the registry."
            : "No result recorded yet — charts appear once a validated result exists."
        }
      />
    );
  }
  switch (chart.kind) {
    case "grainSizeCurve":
      return <GrainSizeCurve result={result} />;
    case "plasticityChart":
      return <PlasticityChart result={result} />;
    case "compactionCurve":
      return <CompactionCurve result={result} />;
    case "cbrCurve":
      return <CbrCurve result={result} />;
    case "depthProfile":
      return <DepthProfile result={result} valueKey={chart.value} />;
    case "cptProfile":
      return <CptProfile result={result} />;
    case "oedometerCurve":
      return <OedometerCurve result={result} />;
    case "pressuremeterCurve":
      return <PressuremeterCurve result={result} />;
    case "barSummary":
      return (
        <BarSummary
          result={result}
          valueKey={chart.value}
          groupBy={chart.groupBy}
          unitLabel={unitFor(chart.value)}
        />
      );
    default:
      return <NoData message="Unknown chart configuration." />;
  }
}
