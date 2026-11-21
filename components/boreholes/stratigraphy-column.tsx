/**
 * GEODATA HUB — stratigraphic column visualization (M4, CSS-only).
 *
 * Renders a borehole's geological layers as a depth-proportional vertical
 * column with a depth axis, material-type coloring, USCS codes and sample
 * position markers. This is a stratigraphy diagram, not a map — the full
 * GIS map belongs to the later GIS milestone.
 */
import { MATERIAL_TYPE_LABELS, type MaterialType } from "@/lib/constants";
import { formatDepthRange } from "@/lib/format";
import type { GeologicalLayer, SampleInBorehole } from "@/lib/api-types";
import { cn } from "@/lib/utils";

const MATERIAL_COLORS: Record<string, string> = {
  SOIL: "bg-amber-400/50 dark:bg-amber-600/35 border-amber-600/40",
  ROCK: "bg-slate-400/50 dark:bg-slate-500/40 border-slate-500/40",
  FILL: "bg-stone-500/40 dark:bg-stone-600/40 border-stone-600/40",
};

const MATERIAL_HATCHES: Record<string, string> = {
  SOIL: "........",
  ROCK: "////////",
  FILL: "xxxxxxx",
};

export function StratigraphyColumn({
  layers,
  samples,
  boreholeDepth,
}: {
  layers: GeologicalLayer[];
  samples: SampleInBorehole[];
  boreholeDepth: number | null;
}) {
  const deepestLayer = layers.length > 0 ? Math.max(...layers.map((l) => l.depthTo)) : 0;
  const deepestSample = samples.length > 0 ? Math.max(...samples.map((s) => s.depthTo)) : 0;
  const maxDepth = Math.max(boreholeDepth ?? 0, deepestLayer, deepestSample, 1);
  const height = Math.min(640, Math.max(240, Math.round(maxDepth * 22)));
  const pct = (v: number) => `${(v / maxDepth) * 100}%`;

  // Depth axis ticks: 0 … maxDepth in ~5 steps.
  const step = maxDepth <= 5 ? 1 : maxDepth <= 20 ? 5 : maxDepth <= 60 ? 10 : 20;
  const ticks: number[] = [];
  for (let d = 0; d <= maxDepth; d += step) ticks.push(d);

  return (
    <div className="flex gap-3">
      {/* Depth axis */}
      <div className="relative w-10 shrink-0" style={{ height }} aria-hidden="true">
        {ticks.map((t) => (
          <div
            key={t}
            className="absolute right-0 flex items-center gap-1 text-[10px] tabular-nums text-muted-foreground"
            style={{ top: pct(t), transform: "translateY(-50%)" }}
          >
            <span className="leading-none">{t.toFixed(0)}</span>
            <span className="block h-px w-1.5 bg-border" />
          </div>
        ))}
      </div>

      {/* Layer bands */}
      <div
        className="relative w-24 shrink-0 overflow-hidden rounded-md border bg-muted/60 sm:w-32"
        style={{ height }}
        role="img"
        aria-label={`Stratigraphic column, 0 to ${maxDepth.toFixed(1)} m, ${layers.length} layers`}
      >
        {layers.map((layer) => {
          const top = (layer.depthFrom / maxDepth) * 100;
          const bandHeight = Math.max(2, ((layer.depthTo - layer.depthFrom) / maxDepth) * 100);
          return (
            <div
              key={layer.id}
              className={cn(
                "absolute left-0 right-0 border-x",
                MATERIAL_COLORS[layer.materialType] ?? MATERIAL_COLORS.FILL,
              )}
              style={{ top: `${top}%`, height: `${bandHeight}%` }}
              title={`${formatDepthRange(layer.depthFrom, layer.depthTo)} — ${MATERIAL_TYPE_LABELS[layer.materialType as MaterialType] ?? layer.materialType}${layer.uscs ? ` (${layer.uscs})` : ""}: ${layer.description}`}
            >
              <span className="absolute inset-x-0 top-1 flex flex-col items-center text-[9px] font-medium leading-tight text-foreground/70">
                {bandHeight > 6 && <span>{layer.layerCode ?? ""}</span>}
                {bandHeight > 10 && <span>{layer.uscs ?? ""}</span>}
              </span>
            </div>
          );
        })}

        {/* Sample markers */}
        {samples.map((s) => {
          const mid = ((s.depthFrom + s.depthTo) / 2 / maxDepth) * 100;
          return (
            <div
              key={s.id}
              className="absolute -right-0.5 z-10 h-2.5 w-2.5 -translate-y-1/2 rotate-45 border border-primary bg-primary/80"
              style={{ top: `${mid}%` }}
              title={`Sample ${s.code} (${s.type}) at ${formatDepthRange(s.depthFrom, s.depthTo)} — ${s.labStatus}`}
            />
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-col justify-between py-0.5 text-xs">
        <div className="space-y-2">
          {(["SOIL", "ROCK", "FILL"] as const).map((m) => (
            <div key={m} className="flex items-center gap-2">
              <span
                className={cn(
                  "inline-block h-3.5 w-5 rounded-sm border",
                  MATERIAL_COLORS[m],
                )}
              />
              <span className="text-muted-foreground">
                {MATERIAL_TYPE_LABELS[m]}{" "}
                <span className="font-mono text-[10px] opacity-70">
                  {MATERIAL_HATCHES[m]}
                </span>
              </span>
            </div>
          ))}
          <div className="flex items-center gap-2 pt-1">
            <span className="inline-block h-2.5 w-2.5 rotate-45 border border-primary bg-primary/80" />
            <span className="text-muted-foreground">Sample</span>
          </div>
        </div>
        <p className="max-w-[120px] text-[10px] leading-tight text-muted-foreground">
          Total logged depth {maxDepth.toFixed(2)} m
        </p>
      </div>
    </div>
  );
}
