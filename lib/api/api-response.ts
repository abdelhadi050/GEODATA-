/**
 * GEODATA HUB — uniform API response envelope (M3).
 *
 * Every API route responds with the same envelope:
 *   Success: { success: true,  data: <payload>, meta?: { ... } }
 *   Failure: { success: false, error: { code, message, details? } }
 *
 * All responses carry `Cache-Control: private, no-store` — private tenant
 * data must never be cached by shared or browser caches.
 */
import { NextResponse } from "next/server";

export interface ApiMeta {
  [key: string]: unknown;
}

/** Standard list meta returned by every paginated endpoint. */
export function listMeta(result: {
  page: number;
  pageSize: number;
  total: number;
}): ApiMeta {
  return {
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    totalPages: Math.max(1, Math.ceil(result.total / result.pageSize)),
  };
}

const BASE_HEADERS: Record<string, string> = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

export function apiSuccess<T>(
  data: T,
  opts: {
    status?: number;
    meta?: ApiMeta;
    headers?: Record<string, string>;
  } = {},
): NextResponse {
  const body: Record<string, unknown> = { success: true, data };
  if (opts.meta !== undefined) body.meta = opts.meta;
  return NextResponse.json(body, {
    status: opts.status ?? 200,
    headers: { ...BASE_HEADERS, ...opts.headers },
  });
}

export function apiError(
  code: string,
  message: string,
  status: number,
  details?: unknown,
): NextResponse {
  const error: Record<string, unknown> = { code, message };
  if (details !== undefined) error.details = details;
  return NextResponse.json(
    { success: false, error },
    { status, headers: { ...BASE_HEADERS } },
  );
}
