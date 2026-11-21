/**
 * GEODATA HUB — Geological layers service (tenant-scoped; parent = own-org borehole).
 */
import type { SessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Errors } from "@/lib/errors";
import { can, CAPABILITIES } from "@/lib/rbac";
import { createLayerSchema, updateLayerSchema } from "@/lib/validation/layer";
import type { CreateLayerInput, UpdateLayerInput } from "@/lib/validation/layer";
import { parseOrThrow } from "@/lib/validation/parse";
import {
  getAccessibleBoreholeOrThrow,
  getAccessibleLayerOrThrow,
  getOwnBoreholeOrThrow,
  getOwnLayerOrThrow,
} from "./access";
import { logActivity, ACTIVITY_ACTIONS } from "./activity";

export async function listLayersForBorehole(actor: SessionUser, boreholeId: string) {
  // Readable when the parent borehole's project is own or actively shared.
  const { borehole } = await getAccessibleBoreholeOrThrow(actor, boreholeId);
  return db.geologicalLayer.findMany({
    where: { boreholeId: borehole.id },
    orderBy: { depthFrom: "asc" },
    include: { _count: { select: { samples: true } } },
  });
}

export async function createLayer(actor: SessionUser, input: CreateLayerInput) {
  if (!can(actor.role, CAPABILITIES.LAYER_MANAGE)) {
    throw Errors.forbidden("Your role cannot edit stratigraphy");
  }
  const data = parseOrThrow(createLayerSchema, input);
  const borehole = await getOwnBoreholeOrThrow(actor, data.boreholeId);

  // Overlap validation against existing layers of the same borehole.
  const existing = await db.geologicalLayer.findMany({
    where: { boreholeId: data.boreholeId },
    select: { depthFrom: true, depthTo: true },
  });
  const overlaps = existing.some(
    (l) => data.depthFrom < l.depthTo && data.depthTo > l.depthFrom,
  );
  if (overlaps) {
    throw Errors.validation("Layer depth interval overlaps an existing layer of this borehole");
  }
  if (borehole.depth != null && data.depthTo > borehole.depth) {
    throw Errors.validation(
      `Layer bottom (${data.depthTo} m) exceeds the borehole depth (${borehole.depth} m)`,
    );
  }

  const layer = await db.geologicalLayer.create({
    data: {
      boreholeId: data.boreholeId,
      depthFrom: data.depthFrom,
      depthTo: data.depthTo,
      layerCode: data.layerCode,
      materialType: data.materialType,
      description: data.description,
      uscs: data.uscs,
      consistency: data.consistency,
    },
  });

  await logActivity({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: ACTIVITY_ACTIONS.LAYER_CREATED,
    entityType: "GeologicalLayer",
    entityId: layer.id,
    details: { boreholeCode: borehole.code, depthFrom: data.depthFrom, depthTo: data.depthTo },
  });

  return layer;
}

export async function updateLayer(
  actor: SessionUser,
  layerId: string,
  input: UpdateLayerInput,
) {
  if (!can(actor.role, CAPABILITIES.LAYER_MANAGE)) {
    throw Errors.forbidden("Your role cannot edit stratigraphy");
  }
  const existing = await getOwnLayerOrThrow(actor, layerId);
  const data = parseOrThrow(updateLayerSchema, input);

  const nextFrom = data.depthFrom ?? existing.depthFrom;
  const nextTo = data.depthTo ?? existing.depthTo;
  const others = await db.geologicalLayer.findMany({
    where: { boreholeId: existing.boreholeId, NOT: { id: layerId } },
    select: { depthFrom: true, depthTo: true },
  });
  if (others.some((l) => nextFrom < l.depthTo && nextTo > l.depthFrom)) {
    throw Errors.validation("Layer depth interval overlaps another layer of this borehole");
  }

  const layer = await db.geologicalLayer.update({
    where: { id: layerId },
    data: {
      ...(data.depthFrom !== undefined ? { depthFrom: data.depthFrom } : {}),
      ...(data.depthTo !== undefined ? { depthTo: data.depthTo } : {}),
      ...(data.layerCode !== undefined ? { layerCode: data.layerCode } : {}),
      ...(data.materialType !== undefined ? { materialType: data.materialType } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.uscs !== undefined ? { uscs: data.uscs } : {}),
      ...(data.consistency !== undefined ? { consistency: data.consistency } : {}),
    },
  });

  await logActivity({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: ACTIVITY_ACTIONS.LAYER_UPDATED,
    entityType: "GeologicalLayer",
    entityId: layerId,
    details: { boreholeCode: existing.borehole.code },
  });

  return layer;
}

export async function deleteLayer(actor: SessionUser, layerId: string) {
  if (!can(actor.role, CAPABILITIES.LAYER_MANAGE)) {
    throw Errors.forbidden("Your role cannot edit stratigraphy");
  }
  const layer = await getOwnLayerOrThrow(actor, layerId);
  await db.geologicalLayer.delete({ where: { id: layerId } });

  await logActivity({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: ACTIVITY_ACTIONS.LAYER_DELETED,
    entityType: "GeologicalLayer",
    entityId: null,
    details: { boreholeCode: layer.borehole.code, depthFrom: layer.depthFrom },
  });

  return { deleted: true };
}
