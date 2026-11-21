/**
 * GEODATA HUB — Documents service (tenant-scoped; private storage).
 *
 * Files live under storage/uploads with generated names; original names are
 * metadata only. Downloads stream through a permission-checked handler (M3/M7).
 * This M2 service governs metadata, paths and deletion; the upload endpoint
 * itself arrives with the API layer.
 */
import type { SessionUser } from "@/lib/auth";
import path from "node:path";
import fs from "node:fs/promises";
import { db } from "@/lib/db";
import { Errors } from "@/lib/errors";
import { can, CAPABILITIES } from "@/lib/rbac";
import {
  createDocumentSchema,
  updateDocumentSchema,
} from "@/lib/validation/document";
import type { CreateDocumentInput, UpdateDocumentInput } from "@/lib/validation/document";
import { parseOrThrow } from "@/lib/validation/parse";
import {
  getAccessibleDocumentOrThrow,
  getAccessibleProjectIds,
  getOwnDocumentOrThrow,
  getOwnProjectOrThrow,
} from "./access";
import { logActivity, ACTIVITY_ACTIONS } from "./activity";

export const STORAGE_ROOT = path.join(process.cwd(), "storage", "uploads");

/** Resolve a stored relative path, refusing anything outside STORAGE_ROOT. */
export function resolveStoragePath(relativePath: string): string {
  const resolved = path.resolve(STORAGE_ROOT, relativePath);
  if (!resolved.startsWith(STORAGE_ROOT + path.sep) && resolved !== STORAGE_ROOT) {
    throw Errors.forbidden("Invalid storage path");
  }
  return resolved;
}

export interface ListDocumentsOptions {
  projectId?: string;
  boreholeId?: string;
  docType?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function listDocuments(actor: SessionUser, opts: ListDocumentsOptions = {}) {
  const { ownIds, sharedIds } = await getAccessibleProjectIds(actor);
  const visibleProjectIds = [...ownIds, ...sharedIds];
  const page = Math.max(opts.page ?? 1, 1);
  const pageSize = Math.min(Math.max(opts.pageSize ?? 30, 1), 200);

  const where = {
    project: { id: { in: visibleProjectIds } },
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    ...(opts.boreholeId ? { boreholeId: opts.boreholeId } : {}),
    ...(opts.docType ? { docType: opts.docType } : {}),
    ...(opts.search
      ? { OR: [{ title: { contains: opts.search } }, { fileName: { contains: opts.search } }] }
      : {}),
  };

  const [items, total] = await Promise.all([
    db.document.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        project: { select: { id: true, code: true, name: true } },
        borehole: { select: { id: true, code: true } },
        uploadedBy: { select: { id: true, name: true } },
      },
    }),
    db.document.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

export async function getDocument(actor: SessionUser, documentId: string) {
  const { document, source } = await getAccessibleDocumentOrThrow(actor, documentId);
  return { ...document, accessSource: source };
}

/**
 * Register a stored document (used by the future upload endpoint and the seed).
 * `storedName` is the generated file name inside storage/uploads.
 */
export async function createDocument(
  actor: SessionUser,
  input: CreateDocumentInput,
  storedName: string,
) {
  if (!can(actor.role, CAPABILITIES.DOCUMENT_MANAGE)) {
    throw Errors.forbidden("Your role cannot upload documents");
  }
  const data = parseOrThrow(createDocumentSchema, input);
  // Parent-child validation: project (and optional borehole) must be own-org.
  await getOwnProjectOrThrow(actor, data.projectId);
  if (data.boreholeId) {
    const borehole = await db.borehole.findUnique({
      where: { id: data.boreholeId },
      include: { project: { select: { id: true } } },
    });
    if (!borehole || borehole.project.id !== data.projectId) {
      throw Errors.validation("Borehole does not belong to this project");
    }
  }
  // storedName must be a bare generated name (no separators / traversal).
  if (!/^[\w-]+\.[A-Za-z0-9]{1,8}$/.test(storedName)) {
    throw Errors.validation("Invalid stored file name");
  }

  const document = await db.document.create({
    data: {
      organizationId: actor.organizationId, // NEVER from client input
      projectId: data.projectId,
      boreholeId: data.boreholeId,
      title: data.title,
      docType: data.docType,
      fileName: data.fileName,
      filePath: `storage/uploads/${storedName}`,
      fileSize: data.fileSize,
      mimeType: data.mimeType,
      uploadedById: actor.id,
    },
  });

  await logActivity({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: ACTIVITY_ACTIONS.DOCUMENT_UPLOADED,
    entityType: "Document",
    entityId: document.id,
    details: { title: data.title, docType: data.docType, sizeBytes: data.fileSize },
  });

  return document;
}

export async function updateDocument(
  actor: SessionUser,
  documentId: string,
  input: UpdateDocumentInput,
) {
  if (!can(actor.role, CAPABILITIES.DOCUMENT_MANAGE)) {
    throw Errors.forbidden("Your role cannot edit documents");
  }
  await getOwnDocumentOrThrow(actor, documentId);
  const data = parseOrThrow(updateDocumentSchema, input);

  const document = await db.document.update({
    where: { id: documentId },
    data: {
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.docType !== undefined ? { docType: data.docType } : {}),
    },
  });

  await logActivity({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: ACTIVITY_ACTIONS.DOCUMENT_UPDATED,
    entityType: "Document",
    entityId: documentId,
    details: { title: document.title },
  });

  return document;
}

export async function deleteDocument(actor: SessionUser, documentId: string) {
  if (!can(actor.role, CAPABILITIES.DOCUMENT_MANAGE)) {
    throw Errors.forbidden("Your role cannot delete documents");
  }
  const document = await getOwnDocumentOrThrow(actor, documentId);
  await db.document.delete({ where: { id: documentId } });

  // Best-effort file removal; the DB record is the authority.
  try {
    const abs = resolveStoragePath(document.filePath.replace(/^storage\/uploads\//, ""));
    await fs.unlink(abs);
  } catch {
    // File already gone — not an error.
  }

  await logActivity({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: ACTIVITY_ACTIONS.DOCUMENT_DELETED,
    entityType: "Document",
    entityId: null,
    details: { title: document.title },
  });

  return { deleted: true };
}
