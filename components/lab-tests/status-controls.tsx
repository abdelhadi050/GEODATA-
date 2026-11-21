"use client";

/**
 * GEODATA HUB — laboratory test status control (M4).
 * PATCH /api/lab-tests/[id] { status }. Re-opening a completed test
 * clears its recorded result (server rule) — the UI warns beforehand.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/hooks/use-toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiPatch, ApiClientError } from "@/lib/api-client";
import { LAB_TEST_STATUSES, LAB_TEST_STATUS_LABELS } from "@/lib/constants";

export function TestStatusControl({
  testId,
  status,
  hasResult,
}: {
  testId: string;
  status: string;
  hasResult: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function change(next: string) {
    if (
      status === "COMPLETED" &&
      next !== "COMPLETED" &&
      hasResult &&
      !window.confirm(
        "Re-opening a completed test permanently clears its recorded result. Continue?",
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await apiPatch(`/api/lab-tests/${testId}`, { status: next });
      toast({ title: "Status updated", description: LAB_TEST_STATUS_LABELS[next as keyof typeof LAB_TEST_STATUS_LABELS] ?? next });
      router.refresh();
    } catch (e) {
      if (e instanceof ApiClientError) {
        toast({ title: "Status not changed", description: e.message, variant: "destructive" });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Status</span>
      <Select value={status} onValueChange={change} disabled={busy}>
        <SelectTrigger size="sm" className="w-[150px]" aria-label="Test status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {LAB_TEST_STATUSES.map((s) => (
            <SelectItem key={s} value={s}>
              {LAB_TEST_STATUS_LABELS[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
