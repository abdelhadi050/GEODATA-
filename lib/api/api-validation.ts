/**
 * GEODATA HUB — API request validation (M3).
 *
 * Centralizes:
 *   - route-parameter validation (safe id format → 400 before any lookup)
 *   - JSON body parsing with Zod (malformed JSON → 400, never a 500)
 *   - query-string parsing with Zod coercion (strings → numbers/enums)
 *   - same-origin enforcement for cookie-authenticated mutations (CSRF
 *     defense in depth on top of the SameSite=Lax session cookie)
 *
 * Validation failures throw AppError("VALIDATION_ERROR", 400, …) with a
 * normalized `details` array ({ path, message }[]).
 */
import type { NextRequest } from "next/server";
import type { z } from "zod";
import { AppError, Errors } from "@/lib/errors";
import { parseOrThrow } from "@/lib/validation/parse";

/** Cuid-style identifier charset (all our model ids satisfy this). */
export const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Validate a route id parameter. Bad format → 400 (unknown-but-valid id → 404 from the service). */
export function requireId(value: string | undefined, label = "id"): string {
  if (!value || !ID_PATTERN.test(value)) {
    throw Errors.validation(`Invalid ${label} parameter`);
  }
  return value;
}

/** Parse and validate a JSON request body against a Zod schema. */
export async function parseJsonBody<S extends z.ZodTypeAny>(
  req: NextRequest,
  schema: S,
): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw Errors.validation("Request body must be valid JSON");
  }
  return parseOrThrow(schema, raw);
}

/** Parse and validate query parameters (all values arrive as strings). */
export function parseQuery<S extends z.ZodTypeAny>(
  req: NextRequest,
  schema: S,
): z.output<S> {
  const raw: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  return parseOrThrow(schema, raw);
}

/**
 * Reject cross-origin mutations. Browsers always send `Origin` with
 * unsafe methods; when present it must match the request host (direct or
 * behind the proxy via X-Forwarded-Host). Non-browser clients without an
 * Origin header pass — the SameSite=Lax session cookie remains the
 * primary CSRF barrier, consistent with the NextAuth security model.
 */
export function assertSameOrigin(req: NextRequest): void {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  let originHost: string | null = null;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = null;
  }
  if (!host || !originHost || originHost !== host) {
    throw new AppError("CROSS_ORIGIN_REJECTED", 403, "Cross-origin request rejected");
  }
}
