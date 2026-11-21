/**
 * GEODATA HUB — Project validation schemas.
 */
import { z } from "zod";
import { PROJECT_STATUSES } from "@/lib/constants";
import { geoJsonPolygonSchema } from "./geojson";

export const createProjectSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(24)
    .regex(
      /^[A-Z0-9][A-Z0-9_-]*$/,
      "Code must use uppercase letters, digits, dashes or underscores",
    ),
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().max(2000).optional(),
  client: z.string().trim().max(120).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  locationName: z.string().trim().max(120).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  boundary: geoJsonPolygonSchema.optional(),
});

export const updateProjectSchema = createProjectSchema.partial();

export const projectBoundarySchema = geoJsonPolygonSchema;

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
