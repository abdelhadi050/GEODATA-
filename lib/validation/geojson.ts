/**
 * GEODATA HUB — GeoJSON validation (project boundaries).
 * Coordinates are [longitude, latitude] per the GeoJSON specification.
 */
import { z } from "zod";

const position = z.tuple([
  z.number().min(-180).max(180), // longitude
  z.number().min(-90).max(90), // latitude
]);

const linearRing = z.array(position).min(4).max(500);

export const geoJsonPolygonSchema = z
  .object({
    type: z.literal("Polygon"),
    coordinates: z.array(linearRing).min(1).max(12),
  })
  .refine(
    (polygon) =>
      polygon.coordinates.every(
        (ring) =>
          ring[0][0] === ring[ring.length - 1][0] &&
          ring[0][1] === ring[ring.length - 1][1],
      ),
    { message: "Every polygon ring must be closed (first point = last point)" },
  );

export type GeoJsonPolygon = z.infer<typeof geoJsonPolygonSchema>;
