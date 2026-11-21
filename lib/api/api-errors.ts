/**
 * GEODATA HUB — API error mapping (M3).
 *
 * Converts every thrown value into the uniform error envelope with the
 * correct HTTP status. Internal details (stack traces, SQL, raw Prisma
 * errors, filesystem paths) are NEVER returned to clients — unexpected
 * errors are logged server-side only and surfaced as a generic 500.
 */
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { AppError } from "@/lib/errors";
import { apiError } from "./api-response";

export function handleApiError(err: unknown): NextResponse {
  // Typed application errors from the service layer — the expected path.
  if (err instanceof AppError) {
    return apiError(err.code, err.message, err.status, err.details);
  }

  // Prisma known-request errors can escape services on unique/race paths.
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      return apiError("CONFLICT", "Resource already exists", 409);
    }
    if (err.code === "P2025") {
      return apiError("NOT_FOUND", "Resource not found", 404);
    }
  }

  // Unexpected: log a safe summary server-side, return a generic 500.
  const summary =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error("[api] unexpected error:", summary);
  return apiError("INTERNAL_ERROR", "An unexpected error occurred", 500);
}
