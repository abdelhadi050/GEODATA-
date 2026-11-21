/**
 * GEODATA HUB — Organization & team service (tenant-scoped).
 */
import type { SessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Errors } from "@/lib/errors";
import { can, CAPABILITIES } from "@/lib/rbac";
import { ROLES, ALL_ROLES, type Role } from "@/lib/constants";

export async function getOrganization(actor: SessionUser) {
  const org = await db.organization.findUnique({
    where: { id: actor.organizationId },
  });
  if (!org) throw Errors.notFound("Organization");
  return org;
}

export async function listOrganizationUsers(
  actor: SessionUser,
  opts: { search?: string } = {},
) {
  if (!can(actor.role, CAPABILITIES.TEAM_VIEW)) {
    throw Errors.forbidden("Your role cannot view the team directory");
  }
  return db.user.findMany({
    where: {
      organizationId: actor.organizationId,
      ...(opts.search
        ? {
            OR: [
              { name: { contains: opts.search } },
              { email: { contains: opts.search } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      createdAt: true,
    },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
  });
}

export async function changeUserRole(
  actor: SessionUser,
  targetUserId: string,
  role: Role,
) {
  if (!can(actor.role, CAPABILITIES.TEAM_MANAGE)) {
    throw Errors.forbidden("Only organization admins can change roles");
  }
  if (!ALL_ROLES.includes(role)) throw Errors.validation("Unknown role");
  const target = await db.user.findUnique({ where: { id: targetUserId } });
  if (!target || target.organizationId !== actor.organizationId) {
    throw Errors.notFound("User");
  }
  if (target.id === actor.id) {
    throw Errors.validation("You cannot change your own role");
  }
  return db.user.update({
    where: { id: targetUserId },
    data: { role },
    select: { id: true, email: true, name: true, role: true, isActive: true },
  });
}

export async function setUserActive(
  actor: SessionUser,
  targetUserId: string,
  isActive: boolean,
) {
  if (!can(actor.role, CAPABILITIES.TEAM_MANAGE)) {
    throw Errors.forbidden("Only organization admins can deactivate or reactivate users");
  }
  const target = await db.user.findUnique({ where: { id: targetUserId } });
  if (!target || target.organizationId !== actor.organizationId) {
    throw Errors.notFound("User");
  }
  if (target.id === actor.id && !isActive) {
    throw Errors.validation("You cannot deactivate your own account");
  }
  if (target.role === ROLES.ORG_ADMIN && !isActive) {
    const activeAdmins = await db.user.count({
      where: {
        organizationId: actor.organizationId,
        role: ROLES.ORG_ADMIN,
        isActive: true,
      },
    });
    if (activeAdmins <= 1) {
      throw Errors.conflict("The organization must keep at least one active admin");
    }
  }
  return db.user.update({
    where: { id: targetUserId },
    data: { isActive },
    select: { id: true, email: true, name: true, role: true, isActive: true },
  });
}
