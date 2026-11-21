/**
 * GEODATA HUB — Sample validation schemas.
 */
import { z } from "zod";
import { SAMPLE_TYPES, LAB_STATUSES } from "@/lib/constants";

const sampleFields = z.object({
  boreholeId: z.string().min(1),
  layerId: z.string().min(1).optional(),
  code: z
    .string()
    .trim()
    .min(2)
    .max(24)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Code must start with a letter or digit"),
  type: z.enum(SAMPLE_TYPES),
  depthFrom: z.number().min(0).max(300),
  depthTo: z.number().min(0).max(300),
  recovery: z.number().min(0).max(100).optional(),
  labStatus: z.enum(LAB_STATUSES).optional(),
  collectedAt: z.coerce.date().optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const createSampleSchema = sampleFields.refine(
  (d) => d.depthTo > d.depthFrom,
  { message: "depthTo must be greater than depthFrom" },
);

export const updateSampleSchema = sampleFields
  .omit({ boreholeId: true })
  .partial()
  .refine(
    (d) =>
      d.depthTo === undefined ||
      d.depthFrom === undefined ||
      d.depthTo > d.depthFrom,
    { message: "depthTo must be greater than depthFrom" },
  );

export type CreateSampleInput = z.infer<typeof createSampleSchema>;
export type UpdateSampleInput = z.infer<typeof updateSampleSchema>;
