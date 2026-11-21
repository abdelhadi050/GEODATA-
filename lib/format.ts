/**
 * GEODATA HUB — deterministic display formatters (M4).
 *
 * All formatting happens server-side (pages are server components); client
 * components receive preformatted strings, so there are no hydration
 * mismatches from locale/timezone differences.
 */

const DATE_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const DATETIME_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return DATE_FMT.format(d);
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return `${DATETIME_FMT.format(d)} UTC`;
}

/** Date input value (yyyy-MM-dd) — for form defaults. */
export function toDateInput(value: string | Date | null | undefined): string {
  if (!value) return "";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/** "1.50 m" — depths. */
export function formatDepth(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${value.toFixed(2)} m`;
}

/** Depth interval "1.50 – 3.00 m". */
export function formatDepthRange(from: number, to: number): string {
  return `${from.toFixed(2)} – ${to.toFixed(2)} m`;
}

/** "36.470000° N, 2.830000° E" — coordinates. */
export function formatCoordinate(lat: number | null, lng: number | null): string {
  if (lat == null || lng == null) return "—";
  return `${lat.toFixed(6)}°, ${lng.toFixed(6)}°`;
}

/** "1.2 MB" / "345 KB" — file sizes. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Human action label for activity entries: PROJECT_CREATED → "Project created". */
export function formatActionLabel(action: string): string {
  const words = action.toLowerCase().split("_");
  if (words.length === 0) return action;
  return words
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Pluralize a count: "6 projects" / "1 project". */
export function pluralize(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}
