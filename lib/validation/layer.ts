/**
 * GEODATA HUB — Geological layer validation schemas.
 */
import { z } from "zod";
import { MATERIAL_TYPES } from "@/lib/constants";

const layerFields = z.object({
  boreholeId: z.string().min(1),
  layerCode: z.string().trim().max(16).optional(),
  materialType: z.enum(MATERIAL_TYPES),
  description: z.string().trim().min(3).max(400),
  uscs: z
    .string()
    .trim()
    .max(16)
    .regex(/^[A-Z]{2}(\([A-Z]\))?$/, "USCS symbol, e.g. CL, SP, SM, GP, CH")
    .optional(),
  consistency: z.string().trim().max(80).optional(),
  depthFrom: z.number().min(0).max(300),
  depthTo: z.number().min(0).max(300),
});

export const createLayerSchema = layerFields.refine(
  (d) => d.depthTo > d.depthFrom,
  { message: "depthTo must be greater than depthFrom" },
);

export const updateLayerSchema = layerFields
  .omit({ boreholeId: true })
  .partial()
  .refine(
    (d) =>
      d.depthTo === undefined ||
      d.depthFrom === undefined ||
      d.depthTo > d.depthFrom,
    { message: "depthTo must be greater than depthFrom" },
  );

export type CreateLayerInput = z.infer<typeof createLayerSchema>;
export type UpdateLayerInput = z.infer<typeof updateLayerSchema>;
