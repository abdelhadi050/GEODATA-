"use client";

/**
 * GEODATA HUB — report (re)generate button (M5.4).
 *
 * Calls POST /api/reports/:id/generate to render (or re-render) the report
 * PDF. When the report is already GENERATED, the service creates a NEW
 * version row (preserving the previous version as history); when the report
 * is DRAFT, the service promotes it to GENERATED in place.
 *
 * On success, the page is refreshed to reflect the new status/PDF metadata.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { apiPost, ApiClientError } from "@/lib/api-client";

export function ReportGenerateButton({
  reportId,
  hasPdf,
}: {
  reportId: string;
  hasPdf: boolean;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  async function onGenerate() {
    setSubmitting(true);
    try {
      const res = await apiPost<{ pdfGenerated: boolean; report: { version: number } }>(
        `/api/reports/${reportId}/generate`,
        {},
      );
      toast({
        title: res.data.pdfGenerated ? "PDF generated" : "Generation completed",
        description: hasPdf
          ? `New version v${res.data.report.version} created (previous version preserved)`
          : `Report promoted to GENERATED — PDF ready`,
      });
      router.refresh();
    } catch (e) {
      if (e instanceof ApiClientError) {
        if (e.status === 401) {
          window.location.href = "/login";
          return;
        }
        toast({ title: "Generation failed", description: e.message, variant: "destructive" });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Button size="sm" variant="outline" onClick={onGenerate} disabled={submitting}>
      <RefreshCw className={`h-4 w-4 ${submitting ? "animate-spin" : ""}`} />
      {hasPdf ? "Regenerate (new version)" : "Generate PDF"}
    </Button>
  );
}
