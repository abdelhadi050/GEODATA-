/**
 * GEODATA HUB — server-side API client (M4).
 *
 * Server components read data through the SAME M3 HTTP endpoints the rest
 * of the world uses — never by duplicating service logic in the UI. The
 * incoming session cookie is forwarded, so tenant scoping, RBAC and share
 * boundaries are enforced end-to-end by the API (the UI adds no second,
 * potentially wrong, authorization layer).
 *
 *   apiGet<T>(path)  → ApiResult<T> (never throws for expected statuses)
 *   requireOk(result)→ data, or redirects: 401 → /login, 404 → notFound()
 *   isForbidden(r)   → render an unauthorized state instead of crashing
 *
 * React `cache()` dedupes identical GETs within one render pass.
 */
import { cache } from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { ApiMeta } from "@/lib/api-types";

const API_BASE = process.env.API_BASE_URL ?? "http://127.0.0.1:3000";

export type ApiResult<T> =
  | { ok: true; data: T; meta?: ApiMeta }
  | { ok: false; status: number; code: string; message: string };

async function rawGet<T>(path: string): Promise<ApiResult<T>> {
  const cookieStore = await cookies();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { cookie: cookieStore.toString() },
      cache: "no-store",
    });
  } catch {
    return {
      ok: false,
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "The API could not be reached",
    };
  }

  type Envelope<TData> =
    | { success: true; data: TData; meta?: ApiMeta }
    | { success: false; error: { code: string; message: string } };
  let body: Envelope<T> | null = null;
  try {
    body = (await res.json()) as Envelope<T> | null;
  } catch {
    body = null;
  }

  if (res.ok && body && body.success === true) {
    return { ok: true, data: body.data, meta: body.meta };
  }
  return {
    ok: false,
    status: res.status,
    code: body && body.success === false ? body.error.code : "UNEXPECTED_RESPONSE",
    message: body && body.success === false ? body.error.message : `Request failed (${res.status})`,
  };
}

/** Cached per render pass: several components may need the same endpoint. */
export const apiGet = cache(rawGet);

/**
 * Resolve an ApiResult for a page that REQUIRES the data:
 * 401 → redirect to login (expired session), 404 → styled not-found,
 * 403 → unauthorized state, otherwise { data, meta }.
 */
export async function requireData<T>(
  result: ApiResult<T>,
): Promise<{ data: T; meta?: ApiMeta }> {
  if (result.ok) return { data: result.data, meta: result.meta };
  if (result.status === 401) redirect("/login");
  if (result.status === 403) redirect("/dashboard?denied=1");
  notFound();
}

/** True when the API answered 403 (capability missing) — caller renders a 403 UI. */
export function isForbidden<T>(result: ApiResult<T>): boolean {
  return !result.ok && result.status === 403;
}

/** True when the API answered 401 — caller redirects to /login. */
export function isUnauthenticated<T>(result: ApiResult<T>): boolean {
  return !result.ok && result.status === 401;
}
