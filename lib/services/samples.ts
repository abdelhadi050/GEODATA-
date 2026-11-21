/**
 * GEODATA HUB — Samples service (tenant-scoped; parent = own-org borehole).
 */
import type { SessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Errors } from "@/lib/errors";
import { can, CAPABILITIES } from "@/lib/rbac";
import { createSampleSchema, updateSampleSchema } from "@/lib/validation/sample";
import type { CreateSampleInput, UpdateSampleInput } from "@/lib/validation/sample";
import { parseOrThrow } from "@/lib/validation/parse";
import {
  getAccessibleProjectIds,
  getAccessibleSampleOrThrow,
  getOwnBoreholeOrThrow,
  getOwnSampleOrThrow,
} from "./access";
import { logActivity, ACTIVITY_ACTIONS } from "./activity";

export interface ListSamplesOptions {
  boreholeId?: string;
  projectId?: string;
  type?: string;
  labStatus?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function listSamples(actor: SessionUser, opts: ListSamplesOptions = {}) {
  const { ownIds, sharedIds } = await getAccessibleProjectIds(actor);
  const visibleProjectIds = [...ownIds, ...sharedIds];
  const page = Math.max(opts.page ?? 1, 1);
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);

  const where = {
    borehole: { project: { id: { in: visibleProjectIds } } },
    ...(opts.boreholeId ? { boreholeId: opts.boreholeId } : {}),
    ...(opts.projectId ? { borehole: { projectId: opts.projectId } } : {}),
    ...(opts.type ? { type: opts.type } : {}),
    ...(opts.labStatus ? { labStatus: opts.labStatus } : {}),
    ...(opts.search
      ? {
          OR: [
            { code: { contains: opts.search } },
            { notes: { contains: opts.search } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    db.sample.findMany({
      where,
      orderBy: [{ borehole: { code: "asc" } }, { depthFrom: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        borehole: {
          select: {
            id: true,
            code: true,
            projectId: true,
            project: { select: { id: true, code: true, name: true } },
          },
        },
        layer: { select: { id: true, layerCode: true, uscs: true } },
        labTests: { select: { id: true, testType: true, status: true, summary: true } },
      },
    }),
    db.sample.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

export async function getSample(actor: SessionUser, sampleId: string) {
  const { sample, source } = await getAccessibleSampleOrThrow(actor, sampleId);
  const detail = await db.sample.findUniqueOrThrow({
    where: { id: sample.id },
    include: {
      borehole: {
        select: {
          id: true,
          code: true,
          projectId: true,
          project: { select: { id: true, code: true, name: true } },
        },
      },
      layer: true,
      labTests: true,
    },
  });
  return { ...detail, accessSource: source };
}

export async function createSample(actor: SessionUser, input: CreateSampleInput) {
  if (!can(actor.role, CAPABILITIES.SAMPLE_MANAGE)) {
    throw Errors.forbidden("Your role cannot create samples");
  }
  const data = parseOrThrow(createSampleSchema, input);
  const borehole = await getOwnBoreholeOrThrow(actor, data.boreholeId);

  const clash = await db.sample.findFirst({
    where: { boreholeId: data.boreholeId, code: data.code },
  });
  if (clash) throw Errors.conflict(`Sample code "${data.code}" already exists in this borehole`);

  if (data.layerId) {
    const layer = await db.geologicalLayer.findUnique({ where: { id: data.layerId } });
    if (!layer || layer.boreholeId !== data.boreholeId) {
      throw Errors.validation("Layer does not belong to this borehole");
    }
  }
  if (borehole.depth != null && data.depthTo > borehole.depth) {
    throw Errors.validation(
      `Sample bottom (${data.depthTo} m) exceeds the borehole depth (${borehole.depth} m)`,
    );
  }

  const sample = await db.sample.create({
    data: {
      boreholeId: data.boreholeId,
      layerId: data.layerId,
      code: data.code,
      type: data.type,
      depthFrom: data.depthFrom,
      depthTo: data.depthTo,
      recovery: data.recovery,
      labStatus: data.labStatus ?? "NOT_SENT",
      collectedAt: data.collectedAt,
      notes: data.notes,
    },
  });

  await logActivity({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: ACTIVITY_ACTIONS.SAMPLE_CREATED,
    entityType: "Sample",
    entityId: sample.id,
    details: { code: sample.code, boreholeCode: borehole.code, type: sample.type },
  });

  return sample;
}

export async function updateSample(
  actor: SessionUser,
  sampleId: string,
  input: UpdateSampleInput,
) {
  if (!can(actor.role, CAPABILITIES.SAMPLE_MANAGE)) {
    throw Errors.forbidden("Your role cannot edit samples");
  }
  const existing = await getOwnSampleOrThrow(actor, sampleId);
  const data = parseOrThrow(updateSampleSchema, input);

  if (data.code && data.code !== existing.code) {
    const clash = await db.sample.findFirst({
      where: { boreholeId: existing.boreholeId, code: data.code, NOT: { id: sampleId } },
    });
    if (clash) throw Errors.conflict(`Sample code "${data.code}" already exists in this borehole`);
  }

  const sample = await db.sample.update({
    where: { id: sampleId },
    data: {
      ...(data.layerId !== undefined ? { layerId: data.layerId } : {}),
      ...(data.code !== undefined ? { code: data.code } : {}),
      ...(data.type !== undefined ? { type: data.type } : {}),
      ...(data.depthFrom !== undefined ? { depthFrom: data.depthFrom } : {}),
      ...(data.depthTo !== undefined ? { depthTo: data.depthTo } : {}),
      ...(data.recovery !== undefined ? { recovery: data.recovery } : {}),
      ...(data.labStatus !== undefined ? { labStatus: data.labStatus } : {}),
      ...(data.collectedAt !== undefined ? { collectedAt: data.collectedAt } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
    },
  });

  await logActivity({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: ACTIVITY_ACTIONS.SAMPLE_UPDATED,
    entityType: "Sample",
    entityId: sampleId,
    details: { code: sample.code },
  });

  return sample;
}

export async function deleteSample(actor: SessionUser, sampleId: string) {
  if (!can(actor.role, CAPABILITIES.SAMPLE_MANAGE)) {
    throw Errors.forbidden("Your role cannot delete samples");
  }
  const sample = await getOwnSampleOrThrow(actor, sampleId);
  await db.sample.delete({ where: { id: sampleId } });

  await logActivity({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: ACTIVITY_ACTIONS.SAMPLE_DELETED,
    entityType: "Sample",
    entityId: null,
    details: { code: sample.code },
  });

  return { deleted: true };
}
