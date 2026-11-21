"use client";

import { usePathname } from "next/navigation";
import { Fragment } from "react";
import Link from "next/link";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

const LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  projects: "Projects",
  boreholes: "Boreholes",
  samples: "Samples",
  "lab-tests": "Laboratory Tests",
  documents: "Documents",
  sharing: "Sharing",
  reports: "Reports",
  activity: "Activity",
  users: "Users",
  settings: "Organization",
};

/** Looks like a database id (cuid) — hide from breadcrumbs; the page title identifies the record. */
function isIdSegment(segment: string): boolean {
  return segment.length >= 16 && /^[A-Za-z0-9_-]+$/.test(segment);
}

export function Breadcrumbs() {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);
  const crumbs = segments
    .filter((s) => !isIdSegment(s))
    .map((s) => ({ segment: s, label: LABELS[s] ?? s }));

  if (crumbs.length === 0) return null;

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          // Link intermediate static segments back to their index pages.
          const href = `/${crumbs.slice(0, i + 1).map((c) => c.segment).join("/")}`;
          return (
            <Fragment key={crumb.segment}>
              {i > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem>
                {isLast ? (
                  <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link href={href}>{crumb.label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
