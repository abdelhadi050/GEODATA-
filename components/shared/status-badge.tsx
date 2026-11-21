/**
 * GEODATA HUB — semantic status badge.
 * Maps domain statuses (constants.ts STATUS_COLORS) to tone classes in both
 * themes. Uses the app palette (emerald/teal/amber/red/slate) — no raw
 * Tailwind color scale, so dark mode stays consistent with the tokens.
 */
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  PROJECT_STATUS_LABELS,
  BOREHOLE_STATUS_LABELS,
  BOREHOLE_TYPE_LABELS,
  LAB_STATUS_LABELS,
  LAB_TEST_STATUS_LABELS,
  DOC_TYPE_LABELS,
  SHARE_STATUS_LABELS,
  REPORT_TYPE_LABELS,
  SAMPLE_TYPE_LABELS,
  MATERIAL_TYPE_LABELS,
  ROLE_LABELS,
  STATUS_COLORS,
  type Role,
} from "@/lib/constants";

const TONES: Record<string, string> = {
  emerald:
    "border-transparent bg-emerald-600/15 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  teal: "border-transparent bg-teal-600/15 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300",
  cyan: "border-transparent bg-cyan-600/15 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300",
  amber:
    "border-transparent bg-amber-500/20 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  red: "border-transparent bg-red-600/15 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  slate:
    "border-transparent bg-slate-500/15 text-slate-700 dark:bg-slate-400/15 dark:text-slate-300",
};

/** Tailwind classes for a status tone — reused by charts/bars for consistency. */
export function statusToneClass(value: string): string {
  return TONES[STATUS_COLORS[value] ?? "slate"];
}

/** Semantic color name for a status (constants.ts STATUS_COLORS). */
export function statusTone(value: string): string {
  return STATUS_COLORS[value] ?? "slate";
}

function labelFor(value: string): string | undefined {
  return (
    PROJECT_STATUS_LABELS[value as keyof typeof PROJECT_STATUS_LABELS] ??
    BOREHOLE_STATUS_LABELS[value as keyof typeof BOREHOLE_STATUS_LABELS] ??
    LAB_STATUS_LABELS[value as keyof typeof LAB_STATUS_LABELS] ??
    LAB_TEST_STATUS_LABELS[value as keyof typeof LAB_TEST_STATUS_LABELS] ??
    SHARE_STATUS_LABELS[value as keyof typeof SHARE_STATUS_LABELS] ??
    SAMPLE_TYPE_LABELS[value as keyof typeof SAMPLE_TYPE_LABELS] ??
    DOC_TYPE_LABELS[value as keyof typeof DOC_TYPE_LABELS] ??
    REPORT_TYPE_LABELS[value as keyof typeof REPORT_TYPE_LABELS] ??
    BOREHOLE_TYPE_LABELS[value as keyof typeof BOREHOLE_TYPE_LABELS] ??
    MATERIAL_TYPE_LABELS[value as keyof typeof MATERIAL_TYPE_LABELS] ??
    ROLE_LABELS[value as Role] ??
    undefined
  );
}

export function StatusBadge({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  const tone = STATUS_COLORS[value] ?? "slate";
  return (
    <Badge variant="outline" className={cn(TONES[tone], className)}>
      {labelFor(value) ?? value}
    </Badge>
  );
}

/** Neutral badge for typed values that are not workflow statuses (e.g. borehole type, USCS). */
export function TypeBadge({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  return (
    <Badge variant="outline" className={className}>
      {labelFor(value) ?? value}
    </Badge>
  );
}
