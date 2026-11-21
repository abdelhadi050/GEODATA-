/**
 * GEODATA HUB — Document validation schemas.
 * File content handling (upload streaming) arrives in M3/M7; these schemas
 * govern the metadata and harden filenames against path traversal.
 */
import { z } from "zod";
import { DOC_TYPES } from "@/lib/constants";

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10 MB demo cap

export const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "text/plain",
  "text/csv",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/zip",
] as const;

// Safe filename: no separators, no parent traversal, limited charset.
const safeFileName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[\w\-. ()[\]]+$/,
    "Filename may only contain letters, digits, spaces, and - _ . ( ) [ ]",
  )
  .refine((name) => !name.includes(".."), {
    message: "Filename must not contain path sequences",
  });

export const createDocumentSchema = z.object({
  projectId: z.string().min(1),
  boreholeId: z.string().min(1).optional(),
  title: z.string().trim().min(3).max(160),
  docType: z.enum(DOC_TYPES),
  fileName: safeFileName,
  mimeType: z.enum(ALLOWED_MIME_TYPES),
  fileSize: z.number().int().min(1).max(MAX_DOCUMENT_BYTES),
});

export const updateDocumentSchema = z.object({
  title: z.string().trim().min(3).max(160).optional(),
  docType: z.enum(DOC_TYPES).optional(),
});

export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;
