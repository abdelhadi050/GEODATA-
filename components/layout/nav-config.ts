/**
 * GEODATA HUB — application navigation map (M4).
 * Each item carries the capability required to see it; the sidebar filters
 * by the DB-fresh role from the layout. The API remains authoritative —
 * this only shapes navigation, never access.
 */
import {
  LayoutDashboard,
  FolderKanban,
  Drill,
  TestTube,
  FlaskConical,
  FileText,
  Share2,
  ClipboardList,
  History,
  Users,
  Building2,
  type LucideIcon,
} from "lucide-react";
import { CAPABILITIES, type Capability } from "@/lib/rbac";

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
  /** Omitted capability = visible to every authenticated user. */
  capability?: Capability;
  description: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [
      {
        title: "Dashboard",
        href: "/dashboard",
        icon: LayoutDashboard,
        capability: CAPABILITIES.DASHBOARD_VIEW,
        description: "Workspace metrics and recent activity",
      },
    ],
  },
  {
    label: "Field & Laboratory",
    items: [
      {
        title: "Projects",
        href: "/projects",
        icon: FolderKanban,
        capability: CAPABILITIES.PROJECT_VIEW,
        description: "Geotechnical investigation projects",
      },
      {
        title: "Boreholes",
        href: "/boreholes",
        icon: Drill,
        capability: CAPABILITIES.BOREHOLE_VIEW,
        description: "Boreholes, soundings and stratigraphy",
      },
      {
        title: "Samples",
        href: "/samples",
        icon: TestTube,
        capability: CAPABILITIES.SAMPLE_VIEW,
        description: "Physical specimens and lab status",
      },
      {
        title: "Laboratory Tests",
        href: "/lab-tests",
        icon: FlaskConical,
        capability: CAPABILITIES.LAB_TEST_VIEW,
        description: "12-type geotechnical test registry",
      },
    ],
  },
  {
    label: "Documents & Deliverables",
    items: [
      {
        title: "Documents",
        href: "/documents",
        icon: FileText,
        capability: CAPABILITIES.PROJECT_VIEW,
        description: "Project files and reports storage",
      },
      {
        title: "Reports",
        href: "/reports",
        icon: ClipboardList,
        capability: CAPABILITIES.REPORT_VIEW,
        description: "Generated report records",
      },
    ],
  },
  {
    label: "Collaboration",
    items: [
      {
        title: "Sharing",
        href: "/sharing",
        icon: Share2,
        capability: CAPABILITIES.SHARING_MANAGE,
        description: "Controlled cross-organization sharing",
      },
      {
        title: "Activity",
        href: "/activity",
        icon: History,
        description: "Audit trail of your organization",
      },
    ],
  },
  {
    label: "Administration",
    items: [
      {
        title: "Users",
        href: "/users",
        icon: Users,
        capability: CAPABILITIES.TEAM_VIEW,
        description: "Team directory and roles",
      },
      {
        title: "Organization",
        href: "/settings",
        icon: Building2,
        description: "Workspace profile",
      },
    ],
  },
];
