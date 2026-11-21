/**
 * GEODATA HUB — Boreholes service (tenant-scoped; parent = own-org project).
 */
import type { SessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Errors } from "@/lib/errors";
import { can, CAPABILITIES } from "@/lib/rbac";
import {
  createBoreholeSchema,
  updateBoreholeSchema,
} from "@/lib/validation/borehole";
import type {
  CreateBoreholeInput,
  UpdateBoreholeInput,
} from "@/lib/validation/borehole";
import { parseOrThrow } from "@/lib/validation/parse";
import {
  getAccessibleBoreholeOrThrow,
  getAccessibleProjectIds,
  getOwnBoreholeOrThrow,
  getOwnProjectOrThrow,
} from "./access";
import { logActivity, ACTIVITY_ACTIONS } from "./activity";

export interface ListBoreholesOptions {
  projectId?: string;
  search?: string;
  type?: string;
  status?: string;
  sortBy?: "code" | "depth" | "createdAt";
  sortOrder?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export async function listBoreholes(actor: SessionUser, opts: ListBoreholesOptions = {}) {
  const { ownIds, sharedIds } = await getAccessibleProjectIds(actor);
  const visibleProjectIds = [...ownIds, ...sharedIds];
  const page = Math.max(opts.page ?? 1, 1);
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);

  const where = {
    // Scope by accessible projects — never by a raw organizationId from input.
    project: { id: { in: visibleProjectIds } },
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    ...(opts.type ? { type: opts.type } : {}),
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.search
      ? {
          OR: [
            { code: { contains: opts.search } },
            { drilledBy: { contains: opts.search } },
            { notes: { contains: opts.search } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    db.borehole.findMany({
      where,
      orderBy: { [opts.sortBy ?? "code"]: opts.sortOrder ?? "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        project: { select: { id: true, code: true, name: true, organizationId: true } },
        _count: { select: { samples: true, layers: true, documents: true } },
      },
    }),
    db.borehole.count({ where }),
  ]);

  return {
    items: items.map((b) => ({
      ...b,
      sharedWithYou: sharedIds.includes(b.projectId),
    })),
    total,
    page,
    pageSize,
  };
}

export async function getBorehole(actor: SessionUser, boreholeId: string) {
  const { borehole, source } = await getAccessibleBoreholeOrThrow(actor, boreholeId);
  const detail = await db.borehole.findUniqueOrThrow({
    where: { id: borehole.id },
    include: {
      project: { select: { id: true, code: true, name: true, organizationId: true } },
      layers: { orderBy: { depthFrom: "asc" } },
      samples: {
        orderBy: { depthFrom: "asc" },
        include: {
          layer: { select: { id: true, layerCode: true, uscs: true } },
          labTests: true,
        },
      },
      documents: {
        include: { uploadedBy: { select: { id: true, name: true } } },
      },
    },
  });
  return { ...detail, accessSource: source, sharedWithYou: source === "shared" };
}

export async function createBorehole(actor: SessionUser, input: CreateBoreholeInput) {
  if (!can(actor.role, CAPABILITIES.BOREHOLE_MANAGE)) {
    throw Errors.forbidden("Your role cannot create boreholes");
  }
  const data = parseOrThrow(createBoreholeSchema, input);
  // Parent-child validation: the project must belong to the ACTOR's org.
  await getOwnProjectOrThrow(actor, data.projectId);

  const clash = await db.borehole.findFirst({
    where: { projectId: data.projectId, code: data.code },
  });
  if (clash) throw Errors.conflict(`Borehole code "${data.code}" already exists in this project`);

  const borehole = await db.borehole.create({
    data: {
      projectId: data.projectId,
      code: data.code,
      type: data.type,
      latitude: data.latitude,
      longitude: data.longitude,
      elevation: data.elevation,
      depth: data.depth,
      drillingDate: data.drillingDate,
      drilledBy: data.drilledBy,
      status: data.status ?? "PLANNED",
      notes: data.notes,
    },
  });

  await logActivity({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: ACTIVITY_ACTIONS.BOREHOLE_CREATED,
    entityType: "Borehole",
    entityId: borehole.id,
    details: { code: borehole.code, projectId: borehole.projectId },
  });

  return borehole;
}

export async function updateBorehole(
  actor: SessionUser,
  boreholeId: string,
  input: UpdateBoreholeInput,
) {
  if (!can(actor.role, CAPABILITIES.BOREHOLE_MANAGE)) {
    throw Errors.forbidden("Your role cannot edit boreholes");
  }
  const existing = await getOwnBoreholeOrThrow(actor, boreholeId);
  const data = parseOrThrow(updateBoreholeSchema, input);

  if (data.code && data.code !== existing.code) {
    const clash = await db.borehole.findFirst({
      where: { projectId: existing.projectId, code: data.code, NOT: { id: boreholeId } },
    });
    if (clash) throw Errors.conflict(`Borehole code "${data.code}" already exists in this project`);
  }

  const borehole = await db.borehole.update({
    where: { id: boreholeId },
    data: {
      ...(data.code !== undefined ? { code: data.code } : {}),
      ...(data.type !== undefined ? { type: data.type } : {}),
      ...(data.latitude !== undefined ? { latitude: data.latitude } : {}),
      ...(data.longitude !== undefined ? { longitude: data.longitude } : {}),
      ...(data.elevation !== undefined ? { elevation: data.elevation } : {}),
      ...(data.depth !== undefined ? { depth: data.depth } : {}),
      ...(data.drillingDate !== undefined ? { drillingDate: data.drillingDate } : {}),
      ...(data.drilledBy !== undefined ? { drilledBy: data.drilledBy } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
    },
  });

  await logActivity({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: ACTIVITY_ACTIONS.BOREHOLE_UPDATED,
    entityType: "Borehole",
    entityId: boreholeId,
    details: { code: borehole.code },
  });

  return borehole;
}

export async function deleteBorehole(actor: SessionUser, boreholeId: string) {
  if (!can(actor.role, CAPABILITIES.BOREHOLE_MANAGE)) {
    throw Errors.forbidden("Your role cannot delete boreholes");
  }
  const borehole = await getOwnBoreholeOrThrow(actor, boreholeId);
  await db.borehole.delete({ where: { id: boreholeId } });

  await logActivity({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: ACTIVITY_ACTIONS.BOREHOLE_DELETED,
    entityType: "Borehole",
    entityId: null,
    details: { code: borehole.code },
  });

  return { deleted: true };
}
