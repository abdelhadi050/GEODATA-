/**
 * GEODATA HUB — Activity logging service.
 * Append-only log of significant operations. Details must never contain
 * sensitive information (no passwords, no secrets, no file system paths).
 */
import { db } from "@/lib/db";
import type { SessionUser } from "@/lib/auth";

export const ACTIVITY_ACTIONS = {
  PROJECT_CREATED: "PROJECT_CREATED",
  PROJECT_UPDATED: "PROJECT_UPDATED",
  PROJECT_DELETED: "PROJECT_DELETED",
  BOREHOLE_CREATED: "BOREHOLE_CREATED",
  BOREHOLE_UPDATED: "BOREHOLE_UPDATED",
  BOREHOLE_DELETED: "BOREHOLE_DELETED",
  LAYER_CREATED: "LAYER_CREATED",
  LAYER_UPDATED: "LAYER_UPDATED",
  LAYER_DELETED: "LAYER_DELETED",
  SAMPLE_CREATED: "SAMPLE_CREATED",
  SAMPLE_UPDATED: "SAMPLE_UPDATED",
  SAMPLE_DELETED: "SAMPLE_DELETED",
  LAB_TEST_CREATED: "LAB_TEST_CREATED",
  LAB_TEST_RESULT_RECORDED: "LAB_TEST_RESULT_RECORDED",
  LAB_TEST_STATUS_UPDATED: "LAB_TEST_STATUS_UPDATED",
  LAB_TEST_DELETED: "LAB_TEST_DELETED",
  DOCUMENT_UPLOADED: "DOCUMENT_UPLOADED",
  DOCUMENT_UPDATED: "DOCUMENT_UPDATED",
  DOCUMENT_DELETED: "DOCUMENT_DELETED",
  SHARE_REQUESTED: "SHARE_REQUESTED",
  SHARE_APPROVED: "SHARE_APPROVED",
  SHARE_REJECTED: "SHARE_REJECTED",
  SHARE_REVOKED: "SHARE_REVOKED",
  REPORT_GENERATED: "REPORT_GENERATED",
  // M5.2 Integration — calculation lifecycle events. One CREATED (or
  // RECALCULATED, when prior records exist for the test) row plus one
  // COMPLETED/FAILED row per persisted calculation; INVALIDATED per
  // invalidation batch; ACCESS_DENIED for capability-denied calculation
  // attempts by authenticated users (audit-relevant denial events).
  CALCULATION_CREATED: "CALCULATION_CREATED",
  CALCULATION_COMPLETED: "CALCULATION_COMPLETED",
  CALCULATION_FAILED: "CALCULATION_FAILED",
  CALCULATION_INVALIDATED: "CALCULATION_INVALIDATED",
  CALCULATION_RECALCULATED: "CALCULATION_RECALCULATED",
  CALCULATION_ACCESS_DENIED: "CALCULATION_ACCESS_DENIED",
} as const;

export type ActivityAction =
  (typeof ACTIVITY_ACTIONS)[keyof typeof ACTIVITY_ACTIONS];

export interface LogActivityArgs {
  organizationId: string;
  userId?: string | null;
  action: ActivityAction;
  entityType: string;
  entityId?: string | null;
  details?: Record<string, unknown> | null;
  occurredAt?: Date; // seeding support; defaults to now
}

/** Record an activity entry. Never throws into the caller's success path. */
export async function logActivity(args: LogActivityArgs) {
  try {
    return await db.activityLog.create({
      data: {
        organizationId: args.organizationId,
        userId: args.userId ?? null,
        action: args.action,
        entityType: args.entityType,
        entityId: args.entityId ?? null,
        details: (args.details ?? undefined) as never,
        ...(args.occurredAt ? { createdAt: args.occurredAt } : {}),
      },
    });
  } catch (e) {
    console.error("[activity] failed to record", args.action, (e as Error).message);
    return null;
  }
}

/** Latest activity for the actor's organization (own-tenant only). */
export async function listActivity(actor: SessionUser, limit = 20) {
  return db.activityLog.findMany({
    where: { organizationId: actor.organizationId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 100),
    include: { user: { select: { id: true, name: true } } },
  });
}
