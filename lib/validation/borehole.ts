/**
 * GEODATA HUB — Borehole validation schemas.
 */
import { z } from "zod";
import { BOREHOLE_TYPES, BOREHOLE_STATUSES } from "@/lib/constants";

export const createBoreholeSchema = z.object({
  projectId: z.string().min(1),
  code: z
    .string()
    .trim()
    .min(2)
    .max(24)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Code must start with a letter or digit"),
  type: z.enum(BOREHOLE_TYPES),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  elevation: z.number().min(-500).max(4500).optional(),
  depth: z.number().min(0).max(300).optional(),
  drillingDate: z.coerce.date().optional(),
  drilledBy: z.string().trim().max(120).optional(),
  status: z.enum(BOREHOLE_STATUSES).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const updateBoreholeSchema = createBoreholeSchema
  .omit({ projectId: true }) // parent is immutable
  .partial();

export type CreateBoreholeInput = z.infer<typeof createBoreholeSchema>;
export type UpdateBoreholeInput = z.infer<typeof updateBoreholeSchema>;
