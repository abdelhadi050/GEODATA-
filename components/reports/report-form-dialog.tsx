"use client";

/**
 * GEODATA HUB — report generation dialog (M4 + M5.4 extension).
 *
 * M4: created report records (metadata only) for an own-org project.
 * M5.4: extends the dialog with sampleId / boreholeId selection for
 * TEST_SUMMARY / BOREHOLE_LOG report types and an optional generatePdf
 * toggle (default true). When the report type is PROJECT_SUMMARY, neither
 * sample nor borehole is requested. PDF generation runs server-side in the
 * same request when generatePdf is true.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { apiGet, apiPost, ApiClientError } from "@/lib/api-client";
import { REPORT_TYPES, REPORT_TYPE_LABELS } from "@/lib/constants";
import type { ProjectListItem, BoreholeListItem, SampleListItem } from "@/lib/api-types";

export function ReportFormDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [boreholes, setBoreholes] = useState<BoreholeListItem[]>([]);
  const [samples, setSamples] = useState<SampleListItem[]>([]);
  const [projectId, setProjectId] = useState("");
  const [reportType, setReportType] = useState<string>("PROJECT_SUMMARY");
  const [title, setTitle] = useState("");
  const [boreholeId, setBoreholeId] = useState("");
  const [sampleId, setSampleId] = useState("");
  const [generatePdf, setGeneratePdf] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load projects when the dialog opens.
  useEffect(() => {
    if (!open || projects.length > 0) return;
    apiGet<ProjectListItem[]>("/api/projects?pageSize=100&sortBy=code&sortOrder=asc")
      .then((res) => setProjects(res.data.filter((p) => !p.sharedWithYou)))
      .catch(() => setProjects([]));
  }, [open, projects.length]);

  // Load boreholes when a project is selected (for BOREHOLE_LOG).
  useEffect(() => {
    if (!projectId || reportType !== "BOREHOLE_LOG") {
      setBoreholes([]);
      setBoreholeId("");
      return;
    }
    apiGet<BoreholeListItem[]>(`/api/boreholes?projectId=${projectId}&pageSize=200`)
      .then((res) => setBoreholes(res.data))
      .catch(() => setBoreholes([]));
  }, [projectId, reportType]);

  // Load samples when a project is selected (for TEST_SUMMARY).
  useEffect(() => {
    if (!projectId || reportType !== "TEST_SUMMARY") {
      setSamples([]);
      setSampleId("");
      return;
    }
    apiGet<{ items: SampleListItem[] }>(`/api/samples?projectId=${projectId}&pageSize=200`)
      .then((res) => setSamples(res.data.items ?? []))
      .catch(() => setSamples([]));
  }, [projectId, reportType]);

  function onTypeChange(t: string) {
    setReportType(t);
    setBoreholeId("");
    setSampleId("");
  }

  async function onSubmit() {
    setError(null);
    if (!projectId) return setError("Select one of your organization's projects.");
    if (title.trim().length < 3) return setError("Title must be at least 3 characters.");
    if (reportType === "TEST_SUMMARY" && !sampleId) return setError("Select a sample for a TEST_SUMMARY report.");
    if (reportType === "BOREHOLE_LOG" && !boreholeId) return setError("Select a borehole for a BOREHOLE_LOG report.");

    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        projectId,
        reportType,
        title: title.trim(),
        generatePdf,
      };
      if (reportType === "TEST_SUMMARY") body.sampleId = sampleId;
      if (reportType === "BOREHOLE_LOG") body.boreholeId = boreholeId;

      const res = await apiPost<{ report: { id: string }; pdfGenerated: boolean }>("/api/reports", body);
      toast({
        title: res.data.pdfGenerated ? "Report generated" : "Report record created",
        description: res.data.pdfGenerated
          ? `${title.trim()} — PDF ready`
          : `${title.trim()} — generate the PDF from the report detail page`,
      });
      setOpen(false);
      setTitle("");
      setProjectId("");
      setSampleId("");
      setBoreholeId("");
      // Navigate to the new report's detail page
      router.push(`/reports/${res.data.report.id}`);
    } catch (e) {
      if (e instanceof ApiClientError) {
        if (e.status === 401) {
          window.location.href = "/login";
          return;
        }
        setError(e.message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-4 w-4" /> Generate report
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Generate report</DialogTitle>
          <DialogDescription>
            Creates a geotechnical report (borehole log, test summary or project summary)
            for one of your projects. The PDF is generated server-side from the project's,
            sample's or borehole's lab tests, calculations and classifications.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="report-project">Project *</Label>
            <Select value={projectId || undefined} onValueChange={setProjectId}>
              <SelectTrigger id="report-project" className="w-full">
                <SelectValue placeholder={projects.length === 0 ? "No projects" : "Select project"} />
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
          <div className="space-y-1.5">
            <Label htmlFor="report-type">Report type</Label>
            <Select value={reportType} onValueChange={onTypeChange}>
              <SelectTrigger id="report-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REPORT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {REPORT_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {reportType === "BOREHOLE_LOG" && (
            <div className="space-y-1.5">
              <Label htmlFor="report-borehole">Borehole *</Label>
              <Select value={boreholeId || undefined} onValueChange={setBoreholeId}>
                <SelectTrigger id="report-borehole" className="w-full">
                  <SelectValue placeholder={boreholes.length === 0 ? "No boreholes" : "Select borehole"} />
                </SelectTrigger>
                <SelectContent>
                  {boreholes.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.code} — {b.type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {reportType === "TEST_SUMMARY" && (
            <div className="space-y-1.5">
              <Label htmlFor="report-sample">Sample *</Label>
              <Select value={sampleId || undefined} onValueChange={setSampleId}>
                <SelectTrigger id="report-sample" className="w-full">
                  <SelectValue placeholder={samples.length === 0 ? "No samples" : "Select sample"} />
                </SelectTrigger>
                <SelectContent>
                  {samples.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.code} — {s.type} ({s.depthFrom.toFixed(1)}–{s.depthTo.toFixed(1)} m)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="report-title">Title *</Label>
            <Input
              id="report-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Algiers Metro — Test Summary Report"
            />
          </div>

          <div className="flex items-center gap-2">
            <Switch id="report-pdf" checked={generatePdf} onCheckedChange={setGeneratePdf} />
            <Label htmlFor="report-pdf" className="cursor-pointer">
              Generate PDF now {generatePdf ? "(server-side rendering)" : "(create as DRAFT)"}
            </Label>
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
            {submitting ? "Generating…" : "Generate report"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
