/**
 * GEODATA HUB — schema parsing helper.
 * Converts Zod failures into typed AppErrors so services never leak raw
 * ZodErrors to the API layer.
 */
import type { z } from "zod";
import { Errors } from "@/lib/errors";

export function parseOrThrow<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
): z.output<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path?.length ? `${issue.path.join(".")} — ` : "";
    throw Errors.validation(
      `${path}${issue?.message ?? "Invalid input"}`,
      result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    );
  }
  return result.data;
}
