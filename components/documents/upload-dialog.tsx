"use client";

/**
 * GEODATA HUB — document upload dialog (M4).
 * Posts multipart form data to the secure M3 upload endpoint. File size,
 * MIME allowlist, magic-byte sniffing and filename safety are all enforced
 * server-side; this form surfaces those errors readably.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiGet, apiUpload, ApiClientError } from "@/lib/api-client";
import { DOC_TYPES, DOC_TYPE_LABELS } from "@/lib/constants";
import type { ProjectListItem, BoreholeListItem } from "@/lib/api-types";

const MAX_MB = 10;

export function UploadDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [boreholes, setBoreholes] = useState<BoreholeListItem[]>([]);
  const [projectId, setProjectId] = useState("");
  const [boreholeId, setBoreholeId] = useState("");
  const [docType, setDocType] = useState<string>("REPORT");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Own projects only (uploads to shared projects are rejected by the API).
  useEffect(() => {
    if (!open || projects.length > 0) return;
    apiGet<ProjectListItem[]>("/api/projects?pageSize=100&sortBy=code&sortOrder=asc")
      .then((res) => setProjects(res.data.filter((p) => !p.sharedWithYou)))
      .catch(() => setProjects([]));
  }, [open, projects.length]);

  // Boreholes of the selected project.
  useEffect(() => {
    setBoreholeId("");
    setBoreholes([]);
    if (!projectId) return;
    apiGet<BoreholeListItem[]>(`/api/boreholes?projectId=${projectId}&pageSize=200`)
      .then((res) => setBoreholes(res.data.filter((b) => !b.sharedWithYou)))
      .catch(() => setBoreholes([]));
  }, [projectId]);

  function onFileChange(f: File | null) {
    setFile(f);
    if (f && !title) {
      setTitle(f.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").slice(0, 160));
    }
    if (f && f.size > MAX_MB * 1024 * 1024) {
      setError(`File exceeds the ${MAX_MB} MB limit (got ${(f.size / (1024 * 1024)).toFixed(1)} MB).`);
    } else {
      setError(null);
    }
  }

  async function onSubmit() {
    setError(null);
    if (!file) return setError("Choose a file to upload.");
    if (!projectId) return setError("Select the project this document belongs to.");
    if (title.trim().length < 3) return setError("Title must be at least 3 characters.");

    const form = new FormData();
    form.append("file", file);
    form.append("projectId", projectId);
    form.append("title", title.trim());
    form.append("docType", docType);
    if (boreholeId) form.append("boreholeId", boreholeId);

    setSubmitting(true);
    try {
      const res = await apiUpload<{ id: string; title: string }>(
        "/api/documents/upload",
        form,
      );
      toast({ title: "Document uploaded", description: res.data.title });
      setOpen(false);
      setFile(null);
      setTitle("");
      setProjectId("");
      setBoreholeId("");
      setDocType("REPORT");
      router.refresh();
    } catch (e) {
      if (e instanceof ApiClientError) {
        if (e.status === 401) {
          window.location.href = "/login";
          return;
        }
        const hints: Record<string, string> = {
          PAYLOAD_TOO_LARGE: `The server rejects files over ${MAX_MB} MB.`,
          UNSUPPORTED_MEDIA_TYPE:
            "File type not allowed (PDF, TXT, CSV, PNG, JPEG, WebP, DOCX, XLSX, ZIP) or the content does not match the declared type.",
        };
        setError(hints[e.code] ?? e.message);
      } else {
        setError("Upload failed — please retry.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Upload className="h-4 w-4" /> Upload document
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload document</DialogTitle>
          <DialogDescription>
            Up to {MAX_MB} MB. Allowed: PDF, TXT, CSV, PNG, JPEG, WebP, DOCX,
            XLSX, ZIP. Files are stored privately — access is enforced per
            project and share.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="upload-file">File</Label>
            <Input
              id="upload-file"
              type="file"
              onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="upload-project">Project *</Label>
            <Select value={projectId || undefined} onValueChange={setProjectId}>
              <SelectTrigger id="upload-project" className="w-full">
                <SelectValue placeholder={projects.length === 0 ? "No own projects" : "Select project"} />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.code} — {p.name.length > 40 ? `${p.name.slice(0, 40)}…` : p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="upload-borehole">Borehole (optional)</Label>
              <Select
                value={boreholeId || undefined}
                onValueChange={setBoreholeId}
                disabled={!projectId || boreholes.length === 0}
              >
                <SelectTrigger id="upload-borehole" className="w-full">
                  <SelectValue
                    placeholder={
                      !projectId
                        ? "Select a project first"
                        : boreholes.length === 0
                          ? "No boreholes"
                          : "Optional"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {boreholes.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="upload-type">Document type</Label>
              <Select value={docType} onValueChange={setDocType}>
                <SelectTrigger id="upload-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DOC_TYPES.map((d) => (
                    <SelectItem key={d} value={d}>
                      {DOC_TYPE_LABELS[d]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="upload-title">Title *</Label>
            <Input
              id="upload-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Document title"
            />
          </div>
          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={onSubmit} disabled={submitting}>
            {submitting ? "Uploading…" : "Upload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
