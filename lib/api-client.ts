"use client";

/**
 * GEODATA HUB — browser API client (M4).
 *
 * All client-side mutations and interactive fetches go through this layer:
 *   - relative URLs (same origin — satisfies the M3 CSRF origin check)
 *   - unwraps the standard M3 envelope
 *   - throws ApiClientError with the API error code + field details
 *   - an HTTP 401 is surfaced as UNAUTHENTICATED so callers can send the
 *     user to /login (session expired or account deactivated mid-session).
 *
 * The API remains the authoritative security boundary; this client only
 * shapes UX — it never re-implements authorization rules.
 */
import type { ApiEnvelope, ApiErrorShape, ApiMeta } from "@/lib/api-types";

export class ApiClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiClientError";
  }

  /** Zod issues from VALIDATION_ERROR, when present: [{path, message}]. */
  get fieldErrors(): Record<string, string> {
    if (!Array.isArray(this.details)) return {};
    const out: Record<string, string> = {};
    for (const d of this.details as { path?: (string | number)[]; message?: string }[]) {
      if (d?.path?.length && d.message) {
        const key = d.path.join(".");
        if (!out[key]) out[key] = d.message;
      }
    }
    return out;
  }
}

export interface ApiFetchResult<T> {
  data: T;
  meta?: ApiMeta;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<ApiFetchResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: {
        ...(init.body instanceof FormData ? {} : init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiClientError(0, "NETWORK_ERROR", "Network request failed");
  }

  let body: ApiEnvelope<T> | null = null;
  try {
    body = (await res.json()) as ApiEnvelope<T>;
  } catch {
    // Non-JSON response (e.g. streamed file) — only expected on download links.
  }

  if (!res.ok || !body || body.success === false) {
    const err: ApiErrorShape | null =
      body && body.success === false ? body.error : null;
    throw new ApiClientError(
      res.status,
      err?.code ?? "UNEXPECTED_RESPONSE",
      err?.message ?? `Request failed (${res.status})`,
      err?.details,
    );
  }

  return { data: body.data, meta: body.meta };
}

export function apiGet<T>(path: string): Promise<ApiFetchResult<T>> {
  return request<T>(path, { method: "GET" });
}

export function apiPost<T>(path: string, body?: unknown): Promise<ApiFetchResult<T>> {
  return request<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function apiPatch<T>(path: string, body?: unknown): Promise<ApiFetchResult<T>> {
  return request<T>(path, {
    method: "PATCH",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function apiPut<T>(path: string, body?: unknown): Promise<ApiFetchResult<T>> {
  return request<T>(path, {
    method: "PUT",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function apiDelete<T>(path: string): Promise<ApiFetchResult<T>> {
  return request<T>(path, { method: "DELETE" });
}

export function apiUpload<T>(
  path: string,
  form: FormData,
): Promise<ApiFetchResult<T>> {
  return request<T>(path, { method: "POST", body: form });
}

/** Query-string helper: keeps undefined/empty params out of the URL. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
