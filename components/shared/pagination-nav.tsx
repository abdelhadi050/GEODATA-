/**
 * GEODATA HUB — link-based pagination for server-rendered lists.
 * Preserves active filters; resets nothing else. Page state lives in the
 * URL (search params), so results are shareable and there is no duplicate
 * client state.
 */
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

function buildHref(
  basePath: string,
  params: Record<string, string | undefined>,
  page: number,
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) sp.set(k, v);
  }
  if (page > 1) sp.set("page", String(page));
  const qs = sp.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

export function PaginationNav({
  basePath,
  params,
  page,
  totalPages,
  total,
}: {
  basePath: string;
  /** Active filter params (already URL-safe values), page excluded. */
  params: Record<string, string | undefined>;
  page: number;
  totalPages: number;
  total: number;
}) {
  if (totalPages <= 1) {
    return (
      <p className="px-1 text-xs text-muted-foreground">
        {total} {total === 1 ? "record" : "records"}
      </p>
    );
  }
  const prev = page > 1 ? buildHref(basePath, params, page - 1) : null;
  const next = page < totalPages ? buildHref(basePath, params, page + 1) : null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-muted-foreground">
        Page {page} of {totalPages} · {total} records
      </p>
      <div className="flex items-center gap-2">
        <Button asChild variant="outline" size="sm" disabled={!prev}>
          {prev ? (
            <Link href={prev}>
              <ChevronLeft className="h-4 w-4" /> Previous
            </Link>
          ) : (
            <span>
              <ChevronLeft className="h-4 w-4" /> Previous
            </span>
          )}
        </Button>
        <Button asChild variant="outline" size="sm" disabled={!next}>
          {next ? (
            <Link href={next}>
              Next <ChevronRight className="h-4 w-4" />
            </Link>
          ) : (
            <span>
              Next <ChevronRight className="h-4 w-4" />
            </span>
          )}
        </Button>
      </div>
    </div>
  );
}
