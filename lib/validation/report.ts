/**
 * GEODATA HUB — Report validation schemas.
 */
import { z } from "zod";
import { REPORT_TYPES } from "@/lib/constants";

export const createReportSchema = z.object({
  projectId: z.string().min(1),
  reportType: z.enum(REPORT_TYPES),
  title: z.string().trim().min(3).max(160),
});

export type CreateReportInput = z.infer<typeof createReportSchema>;
