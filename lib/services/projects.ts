/**
 * GEODATA HUB — Projects service (tenant-scoped, share-aware).
 */
import type { SessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Errors } from "@/lib/errors";
import { can, CAPABILITIES } from "@/lib/rbac";
import {
  createProjectSchema,
  updateProjectSchema,
  projectBoundarySchema,
} from "@/lib/validation/project";
import type { CreateProjectInput, UpdateProjectInput } from "@/lib/validation/project";
import { parseOrThrow } from "@/lib/validation/parse";
import {
  getAccessibleProjectOrThrow,
  getAccessibleProjectIds,
  getOwnProjectOrThrow,
} from "./access";
import { logActivity, ACTIVITY_ACTIONS } from "./activity";

export interface ListProjectsOptions {
  search?: string;
  status?: string;
  sortBy?: "name" | "code" | "createdAt" | "status";
  sortOrder?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

/** Projects visible to the actor: own projects + actively shared ones. */
export async function listProjects(actor: SessionUser, opts: ListProjectsOptions = {}) {
  const { ownIds, sharedIds } = await getAccessibleProjectIds(actor);
  const page = Math.max(opts.page ?? 1, 1);
  const pageSize = Math.min(Math.max(opts.pageSize ?? 20, 1), 100);
  const sortBy = opts.sortBy ?? "createdAt";
  const sortOrder = opts.sortOrder ?? "desc";

  const where = {
    id: { in: [...ownIds, ...sharedIds] },
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.search
      ? {
          OR: [
            { name: { contains: opts.search } },
            { code: { contains: opts.search } },
            { client: { contains: opts.search } },
            { locationName: { contains: opts.search } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    db.project.findMany({
      where,
      orderBy: { [sortBy]: sortOrder },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        createdBy: { select: { id: true, name: true } },
        _count: { select: { boreholes: true, documents: true, reports: true } },
      },
    }),
    db.project.count({ where }),
  ]);

  return {
    items: items.map((p) => ({
      ...p,
      sharedWithYou: sharedIds.includes(p.id),
    })),
    total,
    page,
    pageSize,
  };
}

export async function getProject(actor: SessionUser, projectId: string) {
  const { project, source } = await getAccessibleProjectOrThrow(actor, projectId);
  const detail = await db.project.findUniqueOrThrow({
    where: { id: project.id },
    include: {
      createdBy: { select: { id: true, name: true } },
      organization: { select: { id: true, name: true, slug: true } },
      boreholes: {
        orderBy: { code: "asc" },
        include: { _count: { select: { samples: true, layers: true } } },
      },
      documents: {
        orderBy: { createdAt: "desc" },
        include: { uploadedBy: { select: { id: true, name: true } } },
      },
      reports: {
        orderBy: { createdAt: "desc" },
        include: { generatedBy: { select: { id: true, name: true } } },
      },
      sharingRequests: {
        orderBy: { createdAt: "desc" },
        include: {
          targetOrganization: { select: { id: true, name: true } },
          requester: { select: { id: true, name: true } },
        },
      },
    },
  });
  return { ...detail, accessSource: source, sharedWithYou: source === "shared" };
}

export async function createProject(actor: SessionUser, input: CreateProjectInput) {
  if (!can(actor.role, CAPABILITIES.PROJECT_CREATE)) {
    throw Errors.forbidden("Your role cannot create projects");
  }
  const data = parseOrThrow(createProjectSchema, input);

  const existing = await db.project.findFirst({
    where: { organizationId: actor.organizationId, code: data.code },
  });
  if (existing) {
    throw Errors.conflict(`Project code "${data.code}" already exists in your organization`);
  }

  const project = await db.project.create({
    data: {
      organizationId: actor.organizationId, // NEVER from client input
      code: data.code,
      name: data.name,
      description: data.description,
      client: data.client,
      status: data.status ?? "ACTIVE",
      locationName: data.locationName,
      latitude: data.latitude,
      longitude: data.longitude,
      boundary: (data.boundary ?? undefined) as never,
      createdById: actor.id,
    },
  });

  await logActivity({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: ACTIVITY_ACTIONS.PROJECT_CREATED,
    entityType: "Project",
    entityId: project.id,
    details: { code: project.code, name: project.name },
  });

  return project;
}

export async function updateProject(actor: SessionUser, projectId: string, input: UpdateProjectInput) {
  if (!can(actor.role, CAPABILITIES.PROJECT_EDIT)) {
    throw Errors.forbidden("Your role cannot edit projects");
  }
  // Writes require OWNERSHIP — a shared project is read-only.
  await getOwnProjectOrThrow(actor, projectId);
  const data = parseOrThrow(updateProjectSchema, input);

  if (data.code) {
    const clash = await db.project.findFirst({
      where: {
        organizationId: actor.organizationId,
        code: data.code,
        NOT: { id: projectId },
      },
    });
    if (clash) throw Errors.conflict(`Project code "${data.code}" already exists`);
  }

  const project = await db.project.update({
    where: { id: projectId },
    data: {
      ...(data.code !== undefined ? { code: data.code } : {}),
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.client !== undefined ? { client: data.client } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.locationName !== undefined ? { locationName: data.locationName } : {}),
      ...(data.latitude !== undefined ? { latitude: data.latitude } : {}),
      ...(data.longitude !== undefined ? { longitude: data.longitude } : {}),
    },
  });

  await logActivity({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: ACTIVITY_ACTIONS.PROJECT_UPDATED,
    entityType: "Project",
    entityId: projectId,
    details: { code: project.code },
  });

  return project;
}

export async function setProjectBoundary(actor: SessionUser, projectId: string, boundary: unknown) {
  if (!can(actor.role, CAPABILITIES.PROJECT_EDIT)) {
    throw Errors.forbidden("Your role cannot edit project boundaries");
  }
  await getOwnProjectOrThrow(actor, projectId);
  const parsed = parseOrThrow(projectBoundarySchema, boundary);

  const project = await db.project.update({
    where: { id: projectId },
    data: { boundary: parsed as never },
  });

  await logActivity({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: ACTIVITY_ACTIONS.PROJECT_UPDATED,
    entityType: "Project",
    entityId: projectId,
    details: { code: project.code, change: "boundary updated" },
  });

  return project;
}

export async function deleteProject(actor: SessionUser, projectId: string) {
  if (!can(actor.role, CAPABILITIES.PROJECT_DELETE)) {
    throw Errors.forbidden("Only organization admins can delete projects");
  }
  const project = await getOwnProjectOrThrow(actor, projectId);
  await db.project.delete({ where: { id: projectId } });

  await logActivity({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: ACTIVITY_ACTIONS.PROJECT_DELETED,
    entityType: "Project",
    entityId: null,
    details: { code: project.code, name: project.name },
  });

  return { deleted: true };
}
