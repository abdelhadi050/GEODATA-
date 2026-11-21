/**
 * GEODATA HUB — RBAC foundation.
 * Single source of truth for the role × capability matrix (architecture doc 02 §6).
 * Consumed by the API guard (M3) and UI action guards (M4). Exported now as
 * approved M1 scope; callers arrive in later milestones — exports are not
 * flagged as unused.
 */
import type { Role } from "@/lib/constants";

export const CAPABILITIES = {
  DASHBOARD_VIEW: "dashboard:view",
  MAP_VIEW: "map:view",
  PROJECT_VIEW: "project:view",
  PROJECT_CREATE: "project:create",
  PROJECT_EDIT: "project:edit",
  PROJECT_DELETE: "project:delete",
  BOREHOLE_VIEW: "borehole:view",
  BOREHOLE_MANAGE: "borehole:manage",
  LAYER_MANAGE: "layer:manage",
  SAMPLE_VIEW: "sample:view",
  SAMPLE_MANAGE: "sample:manage",
  LAB_TEST_VIEW: "labtest:view",
  LAB_TEST_MANAGE: "labtest:manage",
  LAB_TEST_RESULT: "labtest:result",
  DOCUMENT_DOWNLOAD: "document:download",
  DOCUMENT_MANAGE: "document:manage",
  SHARING_MANAGE: "sharing:manage",
  SHARING_DECIDE: "sharing:decide",
  REPORT_VIEW: "report:view",
  REPORT_GENERATE: "report:generate",
  TEAM_VIEW: "team:view",
  TEAM_MANAGE: "team:manage",
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

const {
  DASHBOARD_VIEW, MAP_VIEW,
  PROJECT_VIEW, PROJECT_CREATE, PROJECT_EDIT, PROJECT_DELETE,
  BOREHOLE_VIEW, BOREHOLE_MANAGE, LAYER_MANAGE,
  SAMPLE_VIEW, SAMPLE_MANAGE,
  LAB_TEST_VIEW, LAB_TEST_MANAGE, LAB_TEST_RESULT,
  DOCUMENT_DOWNLOAD, DOCUMENT_MANAGE,
  SHARING_MANAGE, SHARING_DECIDE,
  REPORT_VIEW, REPORT_GENERATE,
  TEAM_VIEW, TEAM_MANAGE,
} = CAPABILITIES;

const ALL: Capability[] = Object.values(CAPABILITIES);

const MATRIX: Record<Role, Capability[]> = {
  ORG_ADMIN: ALL,
  PROJECT_MANAGER: [
    DASHBOARD_VIEW, MAP_VIEW,
    PROJECT_VIEW, PROJECT_CREATE, PROJECT_EDIT,
    BOREHOLE_VIEW, BOREHOLE_MANAGE, LAYER_MANAGE,
    SAMPLE_VIEW, SAMPLE_MANAGE,
    LAB_TEST_VIEW, LAB_TEST_MANAGE, LAB_TEST_RESULT,
    DOCUMENT_DOWNLOAD, DOCUMENT_MANAGE,
    SHARING_MANAGE, SHARING_DECIDE,
    REPORT_VIEW, REPORT_GENERATE,
    TEAM_VIEW,
  ],
  ENGINEER: [
    DASHBOARD_VIEW, MAP_VIEW,
    PROJECT_VIEW,
    BOREHOLE_VIEW, BOREHOLE_MANAGE, LAYER_MANAGE,
    SAMPLE_VIEW, SAMPLE_MANAGE,
    LAB_TEST_VIEW, LAB_TEST_MANAGE, LAB_TEST_RESULT,
    DOCUMENT_DOWNLOAD, DOCUMENT_MANAGE,
    REPORT_VIEW, REPORT_GENERATE,
  ],
  VIEWER: [
    DASHBOARD_VIEW, MAP_VIEW,
    PROJECT_VIEW, BOREHOLE_VIEW, SAMPLE_VIEW, LAB_TEST_VIEW,
    DOCUMENT_DOWNLOAD, REPORT_VIEW,
  ],
};

const MATRIX_SETS: Record<Role, Set<Capability>> = {
  ORG_ADMIN: new Set(MATRIX.ORG_ADMIN),
  PROJECT_MANAGER: new Set(MATRIX.PROJECT_MANAGER),
  ENGINEER: new Set(MATRIX.ENGINEER),
  VIEWER: new Set(MATRIX.VIEWER),
};

export function can(role: Role | string | null | undefined, capability: Capability): boolean {
  if (!role) return false;
  const caps = MATRIX_SETS[role as Role];
  return Boolean(caps) && caps.has(capability);
}
