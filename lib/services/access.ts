/**
 * GEODATA HUB — Tenant access guards (the heart of multi-tenancy).
 *
 * Rules enforced here for EVERY service call:
 *   1. Organization identity derives from the actor (authenticated user),
 *      never from client input.
 *   2. Writes require the entity chain to belong to the actor's organization.
 *   3. Reads additionally allow cross-organization access ONLY through an
 *      APPROVED, non-expired SharingRequest targeting the actor's org.
 *   4. Foreign resources surface as NOT_FOUND — their existence is not leaked.
 */
import type { SessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Errors } from "@/lib/errors";

export type ProjectAccessSource = "own" | "shared";

/** Active (approved, non-expired) share of a project with the actor's org. */
async function activeShare(projectId: string, organizationId: string) {
  return db.sharingRequest.findFirst({
    where: {
      projectId,
      targetOrganizationId: organizationId,
      status: "APPROVED",
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
}

// ---------- Projects ----------

/** Project strictly owned by the actor's organization. Required for writes. */
export async function getOwnProjectOrThrow(actor: SessionUser, projectId: string) {
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.organizationId !== actor.organizationId) {
    throw Errors.notFound("Project");
  }
  return project;
}

/** Project readable by the actor: own, or shared via an approved share. */
export async function getAccessibleProjectOrThrow(actor: SessionUser, projectId: string) {
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) throw Errors.notFound("Project");
  if (project.organizationId === actor.organizationId) {
    return { project, source: "own" as const, share: null };
  }
  const share = await activeShare(projectId, actor.organizationId);
  if (!share) throw Errors.notFound("Project");
  return { project, source: "shared" as const, share };
}

/** All project ids readable by the actor (own + actively shared). */
export async function getAccessibleProjectIds(actor: SessionUser) {
  const own = await db.project.findMany({
    where: { organizationId: actor.organizationId },
    select: { id: true },
  });
  const shared = await db.sharingRequest.findMany({
    where: {
      targetOrganizationId: actor.organizationId,
      status: "APPROVED",
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { projectId: true },
  });
  return {
    ownIds: own.map((p) => p.id),
    sharedIds: shared.map((s) => s.projectId),
  };
}

// ---------- Boreholes ----------

export async function getOwnBoreholeOrThrow(actor: SessionUser, boreholeId: string) {
  const borehole = await db.borehole.findUnique({
    where: { id: boreholeId },
    include: { project: { select: { id: true, organizationId: true, code: true } } },
  });
  if (!borehole || borehole.project.organizationId !== actor.organizationId) {
    throw Errors.notFound("Borehole");
  }
  return borehole;
}

export async function getAccessibleBoreholeOrThrow(actor: SessionUser, boreholeId: string) {
  const borehole = await db.borehole.findUnique({
    where: { id: boreholeId },
    include: { project: { select: { id: true, organizationId: true } } },
  });
  if (!borehole) throw Errors.notFound("Borehole");
  if (borehole.project.organizationId === actor.organizationId) {
    return { borehole, source: "own" as const };
  }
  const share = await activeShare(borehole.project.id, actor.organizationId);
  if (!share) throw Errors.notFound("Borehole");
  return { borehole, source: "shared" as const };
}

// ---------- Samples (via borehole → project) ----------

export async function getOwnSampleOrThrow(actor: SessionUser, sampleId: string) {
  const sample = await db.sample.findUnique({
    where: { id: sampleId },
    include: {
      borehole: {
        include: { project: { select: { id: true, organizationId: true } } },
      },
    },
  });
  if (!sample || sample.borehole.project.organizationId !== actor.organizationId) {
    throw Errors.notFound("Sample");
  }
  return sample;
}

export async function getAccessibleSampleOrThrow(actor: SessionUser, sampleId: string) {
  const sample = await db.sample.findUnique({
    where: { id: sampleId },
    include: {
      borehole: {
        include: { project: { select: { id: true, organizationId: true } } },
      },
    },
  });
  if (!sample) throw Errors.notFound("Sample");
  if (sample.borehole.project.organizationId === actor.organizationId) {
    return { sample, source: "own" as const };
  }
  const share = await activeShare(sample.borehole.project.id, actor.organizationId);
  if (!share) throw Errors.notFound("Sample");
  return { sample, source: "shared" as const };
}

// ---------- Lab tests (via sample → borehole → project) ----------

export async function getOwnLabTestOrThrow(actor: SessionUser, labTestId: string) {
  const labTest = await db.labTest.findUnique({
    where: { id: labTestId },
    include: {
      sample: {
        include: {
          borehole: {
            include: { project: { select: { id: true, organizationId: true } } },
          },
        },
      },
    },
  });
  if (
    !labTest ||
    labTest.sample.borehole.project.organizationId !== actor.organizationId
  ) {
    throw Errors.notFound("Laboratory test");
  }
  return labTest;
}

export async function getAccessibleLabTestOrThrow(actor: SessionUser, labTestId: string) {
  const labTest = await db.labTest.findUnique({
    where: { id: labTestId },
    include: {
      sample: {
        include: {
          borehole: {
            include: { project: { select: { id: true, organizationId: true } } },
          },
        },
      },
    },
  });
  if (!labTest) throw Errors.notFound("Laboratory test");
  if (labTest.sample.borehole.project.organizationId === actor.organizationId) {
    return { labTest, source: "own" as const };
  }
  const share = await activeShare(
    labTest.sample.borehole.project.id,
    actor.organizationId,
  );
  if (!share) throw Errors.notFound("Laboratory test");
  return { labTest, source: "shared" as const };
}

// ---------- Documents (direct organization column) ----------

export async function getOwnDocumentOrThrow(actor: SessionUser, documentId: string) {
  const document = await db.document.findUnique({ where: { id: documentId } });
  if (!document || document.organizationId !== actor.organizationId) {
    throw Errors.notFound("Document");
  }
  return document;
}

/** Documents are readable within own org; cross-org sharing covers projects. */
export async function getAccessibleDocumentOrThrow(actor: SessionUser, documentId: string) {
  const document = await db.document.findUnique({
    where: { id: documentId },
    include: { project: { select: { id: true, organizationId: true } } },
  });
  if (!document) throw Errors.notFound("Document");
  if (document.organizationId === actor.organizationId) {
    return { document, source: "own" as const };
  }
  const share = await activeShare(document.project.id, actor.organizationId);
  if (!share) throw Errors.notFound("Document");
  return { document, source: "shared" as const };
}

// ---------- Layers (via borehole → project) ----------

export async function getOwnLayerOrThrow(actor: SessionUser, layerId: string) {
  const layer = await db.geologicalLayer.findUnique({
    where: { id: layerId },
    include: {
      borehole: {
        include: { project: { select: { id: true, organizationId: true } } },
      },
    },
  });
  if (!layer || layer.borehole.project.organizationId !== actor.organizationId) {
    throw Errors.notFound("Geological layer");
  }
  return layer;
}

export async function getAccessibleLayerOrThrow(actor: SessionUser, layerId: string) {
  const layer = await db.geologicalLayer.findUnique({
    where: { id: layerId },
    include: {
      borehole: {
        include: { project: { select: { id: true, organizationId: true } } },
      },
    },
  });
  if (!layer) throw Errors.notFound("Geological layer");
  if (layer.borehole.project.organizationId === actor.organizationId) {
    return { layer, source: "own" as const };
  }
  const share = await activeShare(layer.borehole.project.id, actor.organizationId);
  if (!share) throw Errors.notFound("Geological layer");
  return { layer, source: "shared" as const };
}
