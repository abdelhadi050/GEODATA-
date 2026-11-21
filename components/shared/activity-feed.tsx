/**
 * GEODATA HUB — activity feed (server component).
 * Renders ActivityItem[] from GET /api/activity with a per-action icon,
 * a readable sentence and the logged timestamp. Shared by the dashboard
 * and the Activity page.
 */
import {
  FolderKanban,
  Drill,
  Layers,
  TestTube,
  FlaskConical,
  FileText,
  Share2,
  ClipboardList,
  CircleDot,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format";
import type { ActivityItem } from "@/lib/api-types";

const ACTION_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  PROJECT: FolderKanban,
  BOREHOLE: Drill,
  LAYER: Layers,
  SAMPLE: TestTube,
  LAB_TEST: FlaskConical,
  DOCUMENT: FileText,
  SHARE: Share2,
  REPORT: ClipboardList,
};

function iconFor(action: string) {
  const prefix = action.split("_")[0];
  return ACTION_ICON[prefix] ?? CircleDot;
}

const VERBS: Record<string, string> = {
  PROJECT_CREATED: "created project",
  PROJECT_UPDATED: "updated project",
  PROJECT_DELETED: "deleted project",
  BOREHOLE_CREATED: "created borehole",
  BOREHOLE_UPDATED: "updated borehole",
  BOREHOLE_DELETED: "deleted borehole",
  LAYER_CREATED: "added geological layer",
  LAYER_UPDATED: "updated geological layer",
  LAYER_DELETED: "deleted geological layer",
  SAMPLE_CREATED: "created sample",
  SAMPLE_UPDATED: "updated sample",
  SAMPLE_DELETED: "deleted sample",
  LAB_TEST_CREATED: "registered laboratory test",
  LAB_TEST_RESULT_RECORDED: "recorded a laboratory test result",
  LAB_TEST_STATUS_UPDATED: "changed a laboratory test status",
  LAB_TEST_DELETED: "deleted a laboratory test",
  DOCUMENT_UPLOADED: "uploaded document",
  DOCUMENT_UPDATED: "updated document",
  DOCUMENT_DELETED: "deleted document",
  SHARE_REQUESTED: "sent a sharing request",
  SHARE_APPROVED: "approved a sharing request",
  SHARE_REJECTED: "rejected a sharing request",
  SHARE_REVOKED: "revoked a sharing request",
  REPORT_GENERATED: "generated a report",
};

function reference(details: Record<string, unknown> | null): string | null {
  if (!details) return null;
  const v =
    details.code ??
    details.projectCode ??
    details.testType ??
    details.title ??
    details.name;
  return typeof v === "string" ? v : null;
}

export function ActivityFeed({
  items,
  compact = false,
}: {
  items: ActivityItem[];
  compact?: boolean;
}) {
  return (
    <ul className="space-y-1">
      {items.map((item) => {
        const Icon = iconFor(item.action);
        const verb = VERBS[item.action] ?? item.action.toLowerCase().replace(/_/g, " ");
        const ref = reference(item.details);
        return (
          <li
            key={item.id}
            className={cn(
              "flex items-start gap-3 rounded-md px-2 py-2",
              !compact && "hover:bg-accent/50",
            )}
          >
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-primary">
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm leading-snug">
                <span className="font-medium">{item.user?.name ?? "System"}</span>{" "}
                <span className="text-muted-foreground">{verb}</span>
                {ref && (
                  <span className="ml-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {ref}
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {formatDateTime(item.createdAt)}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
