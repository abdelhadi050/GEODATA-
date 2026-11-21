/**
 * GEODATA HUB — API handler wrapper (M3).
 *
 * `withApi` wraps every route handler and guarantees:
 *   - same-origin enforcement for unsafe methods (POST/PUT/PATCH/DELETE)
 *   - every thrown error becomes the uniform error envelope (never a
 *     stack trace, SQL fragment, or raw Prisma error)
 *   - a compact, safe access log (method, path, status — no bodies)
 *
 * The ctx parameter is intentionally loose so Next.js's generated route
 * types accept the same wrapper for static and dynamic segments alike.
 */
import type { NextRequest } from "next/server";
import { handleApiError } from "./api-errors";
import { assertSameOrigin } from "./api-validation";

export type RouteCtx = { params: Promise<Record<string, string>> };
export type RouteHandler = (
  req: NextRequest,
  ctx: RouteCtx,
) => Promise<Response>;

type LooseCtx = { params?: Promise<unknown> } | undefined;

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function withApi(handler: RouteHandler) {
  return async (req: NextRequest, ctx?: LooseCtx): Promise<Response> => {
    let status = 500;
    try {
      if (UNSAFE_METHODS.has(req.method)) assertSameOrigin(req);
      const params = (await (ctx?.params ?? {})) as Record<string, string>;
      const res = await handler(req, { params: Promise.resolve(params) });
      status = res.status;
      return res;
    } catch (err) {
      const res = handleApiError(err);
      status = res.status;
      return res;
    } finally {
      console.log(`[api] ${req.method} ${req.nextUrl.pathname} → ${status}`);
    }
  };
}

/** Strip internal fields from an object before returning it to a client. */
export function omit<T extends object, K extends keyof T>(
  obj: T,
  keys: readonly K[],
): Omit<T, K> {
  const out = { ...obj };
  for (const key of keys) delete out[key];
  return out;
}
