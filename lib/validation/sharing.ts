/**
 * GEODATA HUB — Sharing request validation schemas.
 */
import { z } from "zod";

export const createSharingRequestSchema = z.object({
  projectId: z.string().min(1),
  targetOrganizationId: z.string().min(1),
  message: z.string().trim().max(500).optional(),
  expiresAt: z.coerce
    .date()
    .refine((d) => d.getTime() > Date.now(), {
      message: "Expiry must be in the future",
    })
    .optional(),
});

export const shareDecisionSchema = z.enum(["APPROVE", "REJECT"]);

export type CreateSharingRequestInput = z.infer<typeof createSharingRequestSchema>;
export type ShareDecision = z.infer<typeof shareDecisionSchema>;
