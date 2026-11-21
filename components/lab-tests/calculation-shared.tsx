/**
 * GEODATA HUB — calculation UI primitives (M5.3).
 *
 * Shared, purely presentational pieces used by every calculation surface
 * (lab-test detail section, calculation record page, project tab): status,
 * validity and input-source badges, the engine-warning list and the
 * failed-calculation alert. No hooks — usable from server and client
 * components alike. All content is derived from the actual M5.2 API payloads
 * (docs/19); nothing is recomputed or altered here.
 */
import { AlertTriangle, CircleAlert, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CalculationWarningDto } from "@/lib/api-types";

const CALC_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending",
  COMPLETED: "Completed",
  FAILED: "Failed",
};

const TONES = {
  emerald:
    "border-transparent bg-emerald-600/15 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  amber:
    "border-transparent bg-amber-500/20 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  red: "border-transparent bg-red-600/15 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  slate:
    "border-transparent bg-slate-500/15 text-slate-700 dark:bg-slate-400/15 dark:text-slate-300",
  cyan: "border-transparent bg-cyan-600/15 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300",
} as const;

/** Execution status of a calculation record (COMPLETED / FAILED / PENDING). */
export function CalcStatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const tone = status === "COMPLETED" ? "emerald" : status === "FAILED" ? "red" : "amber";
  return (
    <Badge variant="outline" className={cn(TONES[tone], className)}>
      {CALC_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

/**
 * Validity of a record against the CURRENT recorded data: VALID (current) or
 * STALE (invalidated — kept as history, never silently overwritten).
 */
export function ValidityBadge({
  isValid,
  className,
}: {
  isValid: boolean;
  className?: string;
}) {
  return isValid ? (
    <Badge variant="outline" className={cn(TONES.emerald, className)}>
      <ShieldCheck className="mr-1 h-3 w-3" /> Valid
    </Badge>
  ) : (
    <Badge variant="outline" className={cn(TONES.amber, className)}>
      <AlertTriangle className="mr-1 h-3 w-3" /> Stale
    </Badge>
  );
}

/** Whether the engine consumed the stored result payload or an explicit one. */
export function InputSourceBadge({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  return (
    <Badge variant="outline" className={cn(TONES[source === "EXPLICIT" ? "cyan" : "slate"], className)}>
      {source === "EXPLICIT" ? "Explicit input" : "Recorded data"}
    </Badge>
  );
}

/** Human-readable label from a camelCase/SNAKE field key. */
export function friendlyKey(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/ Kpa/, " (kPa)")
    .replace(/ Mpa/, " (MPa)")
    .replace(/ Percent/, " (%)")
    .replace(/ Kn$/, " (kN)")
    .replace(/ Mm$/, " (mm)")
    .replace(/ Mg M3/, " (Mg/m³)")
    .replace(/ Cm3/, " (cm³)")
    .replace(/ Deg/, " (°)")
    .replace(/ G$/, " (g)")
    .trim();
}

/** Finite number guard for rendering engine-reported values. */
export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Render a numeric value with its unit, or an em-dash for null/absent. */
export function valueWithUnit(v: unknown, unit?: string | null): string {
  const n = num(v);
  if (n == null) return "—";
  return unit ? `${n} ${unit}` : String(n);
}

/** Non-fatal engine advisories, displayed verbatim (never hidden). */
export function WarningList({
  warnings,
  className,
}: {
  warnings: CalculationWarningDto[] | null | undefined;
  className?: string;
}) {
  const list = (warnings ?? []).filter((w) => w && typeof w.message === "string");
  if (list.length === 0) return null;
  return (
    <ul className={cn("space-y-2", className)} data-testid="calculation-warnings">
      {list.map((w, i) => (
        <li
          key={i}
          className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span>
            <span className="font-medium text-amber-700 dark:text-amber-300">{w.code}</span>
            {" — "}
            {w.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Structured engine failure of a persisted FAILED record: code + message (+
 * per-field issues when the engine reported them). Calculation failures are
 * engine outcomes, not infrastructure errors — they are shown, never masked.
 */
export function CalculationErrorAlert({
  code,
  message,
  details,
  className,
}: {
  code: string | null;
  message: string | null;
  details?: Record<string, unknown> | null;
  className?: string;
}) {
  const issues = Array.isArray(details?.issues)
    ? (details!.issues as { path?: string; message?: string }[])
    : [];
  return (
    <div
      className={cn(
        "rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs leading-relaxed",
        className,
      )}
      data-testid="calculation-error"
    >
      <p className="flex items-center gap-2 font-medium text-destructive">
        <CircleAlert className="h-4 w-4 shrink-0" />
        Calculation failed — {code ?? "UNKNOWN"}
      </p>
      {message && <p className="mt-1 text-destructive/90">{message}</p>}
      {issues.length > 0 && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-8 text-destructive/80">
          {issues.slice(0, 12).map((iss, i) => (
            <li key={i}>
              {iss.path ? <span className="font-mono">{iss.path}: </span> : null}
              {iss.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Amber notice for stale records: invalidated reason + timestamp. */
export function StaleNotice({
  reason,
  invalidatedAt,
  className,
}: {
  reason: string | null;
  invalidatedAt: string | null;
  className?: string;
}) {
  const reasons: Record<string, string> = {
    LAB_TEST_RESULT_UPDATED:
      "invalidated because the recorded laboratory result changed after this calculation",
    LAB_TEST_RESULT_CLEARED:
      "invalidated because the recorded laboratory result was cleared (test re-opened)",
  };
  return (
    <div
      className={cn(
        "rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-300",
        className,
      )}
      data-testid="stale-notice"
    >
      <span className="inline-flex items-center gap-1.5 font-medium">
        <AlertTriangle className="h-3.5 w-3.5" /> Stale record
      </span>{" "}
      — {reasons[reason ?? ""] ?? `invalidated (${reason ?? "unknown reason"})`}
      {invalidatedAt ? ` on ${new Date(invalidatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}.
      The record is preserved as history; it no longer represents the current data.
    </div>
  );
}
