"use client";

/**
 * GEODATA HUB — list toolbar (search + filter selects).
 * URL-driven: submitting the search or changing a filter writes the
 * parameters into the URL and resets to page 1; the server component
 * re-renders with fresh API data. No client-side data duplication.
 */
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface FilterOption {
  value: string;
  label: string;
}

export interface ToolbarFilter {
  /** URL query param name. */
  key: string;
  label: string;
  options: FilterOption[];
}

export function ListToolbar({
  searchPlaceholder = "Search…",
  filters = [],
  /** Extra params to preserve when navigating. */
  preservedParams = [],
}: {
  searchPlaceholder?: string;
  filters?: ToolbarFilter[];
  preservedParams?: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [search, setSearch] = useState(searchParams.get("search") ?? "");

  function navigate(next: URLSearchParams) {
    next.delete("page"); // any filter change resets pagination
    const qs = next.toString();
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  }

  function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next = new URLSearchParams(searchParams.toString());
    if (search.trim()) next.set("search", search.trim());
    else next.delete("search");
    navigate(next);
  }

  function onFilterChange(key: string, value: string) {
    const next = new URLSearchParams();
    for (const p of preservedParams) {
      const v = searchParams.get(p);
      if (v) next.set(p, v);
    }
    if (searchParams.get("search")) next.set("search", searchParams.get("search")!);
    for (const f of filters) {
      const current = searchParams.get(f.key);
      if (f.key === key ? value !== "__all" : current && current !== "__all") {
        next.set(f.key, f.key === key ? value : current!);
      }
    }
    navigate(next);
  }

  const hasActiveFilters =
    filters.some((f) => searchParams.get(f.key)) || !!searchParams.get("search");

  function onReset() {
    setSearch("");
    startTransition(() => {
      router.replace(pathname, { scroll: false });
    });
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <form
        onSubmit={onSearchSubmit}
        className="relative flex-1 sm:max-w-xs"
        role="search"
      >
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={searchPlaceholder}
          aria-label="Search"
          className="pl-8"
        />
      </form>
      <div className="flex flex-wrap items-center gap-2">
        {filters.map((f) => (
          <Select
            key={f.key}
            value={searchParams.get(f.key) ?? "__all"}
            onValueChange={(v) => onFilterChange(f.key, v)}
          >
            <SelectTrigger size="sm" className="w-[160px]" aria-label={f.label}>
              <SelectValue placeholder={f.label} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">All {f.label.toLowerCase()}</SelectItem>
              {f.options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ))}
        {hasActiveFilters && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onReset}
            disabled={pending}
          >
            Reset
          </Button>
        )}
      </div>
    </div>
  );
}
