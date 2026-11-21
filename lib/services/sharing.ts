/**
 * GEODATA HUB — Cross-organization sharing service.
 *
 * Permission boundary rules:
 *   - A sharing request is created by the OWNING organization (PROJECT_MANAGER+).
 *   - Only the TARGET organization (PROJECT_MANAGER+) can approve / reject.
 *   - Only the OWNING organization can revoke.
 *   - Approved, non-expired shares grant READ (VIEW) access to the project
 *     chain (project, boreholes, layers, samples, lab tests, documents).
 */
import type { SessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Errors } from "@/lib/errors";
import { can, CAPABILITIES } from "@/lib/rbac";
import {
  createSharingRequestSchema,
  shareDecisionSchema,
} from "@/lib/validation/sharing";
import type { CreateSharingRequestInput, ShareDecision } from "@/lib/validation/sharing";
import { parseOrThrow } from "@/lib/validation/parse";
import { getOwnProjectOrThrow } from "./access";
import { logActivity, ACTIVITY_ACTIONS } from "./activity";

export async function listSharingRequests(actor: SessionUser) {
  const [sent, inbox] = await Promise.all([
    // Requests my organization has SENT (we own the projects).
    db.sharingRequest.findMany({
      where: { project: { organizationId: actor.organizationId } },
      orderBy: { createdAt: "desc" },
      include: {
        project: { select: { id: true, code: true, name: true } },
        requester: { select: { id: true, name: true } },
        targetOrganization: { select: { id: true, name: true, slug: true } },
        decidedBy: { select: { id: true, name: true } },
      },
    }),
    // Requests RECEIVED by my organization (someone else owns the projects).
    db.sharingRequest.findMany({
      where: { targetOrganizationId: actor.organizationId },
      orderBy: { createdAt: "desc" },
      include: {
        project: {
          select: {
            id: true,
            code: true,
            name: true,
            organization: { select: { id: true, name: true } },
          },
        },
        requester: { select: { id: true, name: true } },
        decidedBy: { select: { id: true, name: true } },
      },
    }),
  ]);
  return { sent, inbox };
}

export async function createSharingRequest(
  actor: SessionUser,
  input: CreateSharingRequestInput,
) {
  if (!can(actor.role, CAPABILITIES.SHARING_MANAGE)) {
    throw Errors.forbidden("Your role cannot create sharing requests");
  }
  const data = parseOrThrow(createSharingRequestSchema, input);
  const project = await getOwnProjectOrThrow(actor, data.projectId); // own org only

  if (data.targetOrganizationId === actor.organizationId) {
    throw Errors.validation("You cannot share a project with your own organization");
  }
  const target = await db.organization.findUnique({
    where: { id: data.targetOrganizationId },
  });
  if (!target) throw Errors.notFound("Target organization");

  const existing = await db.sharingRequest.findUnique({
    where: {
      projectId_targetOrganizationId: {
        projectId: data.projectId,
        targetOrganizationId: data.targetOrganizationId,
      },
    },
  });
  if (existing && (existing.status === "PENDING" || existing.status === "APPROVED")) {
    throw Errors.conflict(
      `A ${existing.status.toLowerCase()} share for this project and organization already exists`,
    );
  }

  const request = await db.sharingRequest.create({
    data: {
      projectId: data.projectId,
      requesterId: actor.id,
      targetOrganizationId: data.targetOrganizationId,
      permission: "VIEW",
      status: "PENDING",
      message: data.message,
      expiresAt: data.expiresAt ?? null,
    },
  });

  await logActivity({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: ACTIVITY_ACTIONS.SHARE_REQUESTED,
    entityType: "SharingRequest",
    entityId: request.id,
    details: {
      projectCode: project.code,
      targetOrganization: target.name,
      permission: "VIEW",
    },
  });

  return request;
}

export async function decideSharingRequest(
  actor: SessionUser,
  requestId: string,
  decision: ShareDecision,
) {
  if (!can(actor.role, CAPABILITIES.SHARING_DECIDE)) {
    throw Errors.forbidden("Your role cannot decide sharing requests");
  }
  const parsed = parseOrThrow(shareDecisionSchema, decision);

  const request = await db.sharingRequest.findUnique({
    where: { id: requestId },
    include: { project: { select: { id: true, code: true, organizationId: true } } },
  });
  if (!request) throw Errors.notFound("Sharing request");

  // Boundary: only the TARGET organization decides.
  if (request.targetOrganizationId !== actor.organizationId) {
    throw Errors.forbidden("Only the receiving organization can decide this request");
  }
  if (request.status !== "PENDING") {
    throw Errors.conflict(`This request is already ${request.status.toLowerCase()}`);
  }

  const updated = await db.sharingRequest.update({
    where: { id: requestId },
    data: {
      status: parsed === "APPROVE" ? "APPROVED" : "REJECTED",
      decidedById: actor.id,
      decidedAt: new Date(),
    },
  });

  // Log in BOTH organizations (both see the event in their activity feeds),
  // without leaking anything sensitive.
  await logActivity({
    organizationId: request.project.organizationId,
    userId: null,
    action: parsed === "APPROVE" ? ACTIVITY_ACTIONS.SHARE_APPROVED : ACTIVITY_ACTIONS.SHARE_REJECTED,
    entityType: "SharingRequest",
    entityId: requestId,
    details: { projectCode: request.project.code, decidedByOrg: actor.organizationId },
  });
  await logActivity({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: parsed === "APPROVE" ? ACTIVITY_ACTIONS.SHARE_APPROVED : ACTIVITY_ACTIONS.SHARE_REJECTED,
    entityType: "SharingRequest",
    entityId: requestId,
    details: { projectCode: request.project.code },
  });

  return updated;
}

export async function revokeSharingRequest(actor: SessionUser, requestId: string) {
  if (!can(actor.role, CAPABILITIES.SHARING_MANAGE)) {
    throw Errors.forbidden("Your role cannot revoke sharing requests");
  }
  const request = await db.sharingRequest.findUnique({
    where: { id: requestId },
    include: { project: { select: { id: true, code: true, organizationId: true } } },
  });
  if (!request) throw Errors.notFound("Sharing request");

  // Boundary: only the OWNING organization revokes.
  if (request.project.organizationId !== actor.organizationId) {
    throw Errors.forbidden("Only the owning organization can revoke this share");
  }
  if (request.status !== "APPROVED" && request.status !== "PENDING") {
    throw Errors.conflict(`Only approved or pending shares can be revoked (current: ${request.status})`);
  }

  const updated = await db.sharingRequest.update({
    where: { id: requestId },
    data: { status: "REVOKED", decidedById: actor.id, decidedAt: new Date() },
  });

  await logActivity({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: ACTIVITY_ACTIONS.SHARE_REVOKED,
    entityType: "SharingRequest",
    entityId: requestId,
    details: { projectCode: request.project.code },
  });

  return updated;
}

/** Partner organizations available as share targets (for the share dialog). */
export async function listShareableOrganizations(actor: SessionUser) {
  if (!can(actor.role, CAPABILITIES.SHARING_MANAGE)) {
    throw Errors.forbidden("Your role cannot manage sharing");
  }
  return db.organization.findMany({
    where: { id: { not: actor.organizationId } },
    select: { id: true, name: true, slug: true },
    orderBy: { name: "asc" },
  });
}
