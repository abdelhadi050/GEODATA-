"use client";

/**
 * GEODATA HUB — sample classification panel (M5.4).
 *
 * Displays the latest VALID USCS and AASHTO classifications for a sample,
 * plus a "Classify now" button that runs both engines from the sample's
 * current lab-test data. Shows the classification symbol, group name,
 * standard citation, and any engine warnings.
 *
 * RBAC: the "Classify now" button is shown only to roles with LAB_TEST_RESULT
 * (ORG_ADMIN, PROJECT_MANAGER, ENGINEER). VIEWER sees the latest valid
 * results (read-only).
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Beaker, Loader2, AlertCircle } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { apiGet, apiPost, ApiClientError } from "@/lib/api-client";
import type {
  ClassificationEngineInfoDto,
  LatestClassificationDto,
  ClassifyResultDto,
} from "@/lib/api-types";

interface ClassificationPanelProps {
  sampleId: string;
  canClassify: boolean;
}

export function ClassificationPanel({ sampleId, canClassify }: ClassificationPanelProps) {
  const router = useRouter();
  const [engines, setEngines] = useState<ClassificationEngineInfoDto[]>([]);
  const [uscs, setUscs] = useState<LatestClassificationDto | null>(null);
  const [aashto, setAashto] = useState<LatestClassificationDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [classifying, setClassifying] = useState(false);

  async function loadAll() {
    setLoading(true);
    try {
      const [engRes, uscsRes, aashtoRes] = await Promise.allSettled([
        apiGet<ClassificationEngineInfoDto[]>("/api/classifications/engines"),
        apiGet<LatestClassificationDto>(`/api/samples/${sampleId}/classifications/latest?moduleId=uscs`),
        apiGet<LatestClassificationDto>(`/api/samples/${sampleId}/classifications/latest?moduleId=aashto`),
      ]);
      if (engRes.status === "fulfilled") setEngines(engRes.value.data);
      setUscs(uscsRes.status === "fulfilled" ? uscsRes.value.data : null);
      setAashto(aashtoRes.status === "fulfilled" ? aashtoRes.value.data : null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, [sampleId]);

  async function onClassify(moduleId: string) {
    setClassifying(true);
    try {
      const res = await apiPost<ClassifyResultDto>(`/api/samples/${sampleId}/classify`, {
        moduleId,
      });
      const rec = res.data.record;
      if (rec && rec.status === "COMPLETED") {
        toast({
          title: `${moduleId.toUpperCase()} classification completed`,
          description: `${rec.standard} ${rec.standardVersion ?? ""}`.trim(),
        });
      } else if (rec && rec.status === "FAILED") {
        toast({
          title: `${moduleId.toUpperCase()} classification failed`,
          description: rec.errorMessage ?? "Engine reported an error",
          variant: "destructive",
        });
      }
      if (res.data.replayed) {
        toast({ title: "Replayed existing classification", description: "Idempotency key matched" });
      }
      await loadAll();
      router.refresh();
    } catch (e) {
      if (e instanceof ApiClientError) {
        if (e.status === 401) {
          window.location.href = "/login";
          return;
        }
        if (e.status === 403) {
          toast({
            title: "Not authorized",
            description: "Your role cannot run classifications",
            variant: "destructive",
          });
          return;
        }
        toast({ title: "Classification failed", description: e.message, variant: "destructive" });
      }
    } finally {
      setClassifying(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Beaker className="h-4 w-4" />
            Classification
          </CardTitle>
          <CardDescription>Loading…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Beaker className="h-4 w-4" />
          Soil classification
        </CardTitle>
        <CardDescription>
          USCS (ASTM D2487) and AASHTO (M 145) classifications computed from this
          sample&apos;s granulometry and Atterberg lab-test data.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* USCS */}
        <ClassificationResult
          title="USCS"
          standard="ASTM D2487-17"
          result={uscs}
          canClassify={canClassify}
          classifying={classifying}
          onClassify={() => onClassify("uscs")}
        />
        {/* AASHTO */}
        <ClassificationResult
          title="AASHTO"
          standard="AASHTO M 145-91 (2004)"
          result={aashto}
          canClassify={canClassify}
          classifying={classifying}
          onClassify={() => onClassify("aashto")}
        />

        {/* Available engines */}
        {engines.length > 0 && (
          <div className="text-xs text-muted-foreground">
            <span className="font-medium">Available engines:</span>{" "}
            {engines.map((e) => `${e.moduleId} (${e.standard} ${e.standardVersion})`).join(", ")}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ClassificationResult({
  title,
  standard,
  result,
  canClassify,
  classifying,
  onClassify,
}: {
  title: string;
  standard: string;
  result: LatestClassificationDto | null;
  canClassify: boolean;
  classifying: boolean;
  onClassify: () => void;
}) {
  const results = result?.output?.results as Record<string, unknown> | null | undefined;
  const symbol = results
    ? title === "USCS"
      ? (results.symbol as string | undefined) ?? "—"
      : (results.designation as string | undefined) ?? (results.group as string | undefined) ?? "—"
    : "—";
  const groupName = results?.groupName as string | undefined;
  const hasWarnings = !!(result && result.warnings && result.warnings.length > 0);
  const hasReasoning = !!(result && title === "USCS" && results?.reasoning);

  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm">{title}</span>
            <Badge variant="outline" className="text-xs">
              {standard}
            </Badge>
          </div>
          {result ? (
            <div className="mt-1 space-y-0.5">
              <div className="font-mono text-lg font-bold">{symbol}</div>
              {groupName ? <div className="text-xs text-muted-foreground">{groupName}</div> : null}
              <div className="text-xs text-muted-foreground">
                {new Date(result.createdAt).toLocaleDateString()} · {result.warningCount} warning(s)
              </div>
            </div>
          ) : (
            <div className="mt-1 text-xs text-muted-foreground">
              No valid classification yet — run the engine to compute one.
            </div>
          )}
        </div>
        {canClassify && (
          <Button size="sm" variant="outline" onClick={onClassify} disabled={classifying}>
            {classifying ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {result ? "Re-run" : "Classify"}
          </Button>
        )}
      </div>

      {/* Reasoning + warnings — collapsed by default */}
      {hasWarnings && result && result.warnings ? (
        <div className="mt-2 space-y-1 rounded border bg-amber-500/5 p-2 text-xs">
          <div className="flex items-center gap-1 font-medium text-amber-700 dark:text-amber-300">
            <AlertCircle className="h-3 w-3" />
            Warnings
          </div>
          {result.warnings.slice(0, 3).map((w, i) => (
            <div key={i} className="text-amber-700 dark:text-amber-300">
              [{w.code}] {w.message}
            </div>
          ))}
        </div>
      ) : null}

      {/* Reasoning steps — USCS-specific */}
      {hasReasoning && result && title === "USCS" && results?.reasoning ? (
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:underline">
            Reasoning ({(results.reasoning as unknown[]).length} steps)
          </summary>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-muted-foreground">
            {(results.reasoning as Array<{ clause: string; decision: string }>).map((s, i) => (
              <li key={i}>
                <span className="font-mono text-[10px]">{s.clause}</span>: {s.decision}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}
