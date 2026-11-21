/**
 * GEODATA HUB — shared constants: roles, statuses, types, labels, colors.
 * Values are the single source of truth shared by Zod schemas, services,
 * seed and (later) UI. Colors are semantic names mapped by the UI layer.
 */
export const ROLES = {
  ORG_ADMIN: "ORG_ADMIN",
  PROJECT_MANAGER: "PROJECT_MANAGER",
  ENGINEER: "ENGINEER",
  VIEWER: "VIEWER",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const ALL_ROLES: Role[] = [
  ROLES.ORG_ADMIN,
  ROLES.PROJECT_MANAGER,
  ROLES.ENGINEER,
  ROLES.VIEWER,
];

export const ROLE_LABELS: Record<Role, string> = {
  ORG_ADMIN: "Organization Admin",
  PROJECT_MANAGER: "Project Manager",
  ENGINEER: "Engineer",
  VIEWER: "Viewer",
};

// --- Project ---
export const PROJECT_STATUSES = [
  "ACTIVE",
  "ON_HOLD",
  "COMPLETED",
  "ARCHIVED",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  ACTIVE: "Active",
  ON_HOLD: "On hold",
  COMPLETED: "Completed",
  ARCHIVED: "Archived",
};

// --- Borehole ---
export const BOREHOLE_TYPES = [
  "ROTARY_CORE",
  "SPT",
  "CPT",
  "TRIAL_PIT",
  "AUGER",
] as const;
export type BoreholeType = (typeof BOREHOLE_TYPES)[number];
export const BOREHOLE_TYPE_LABELS: Record<BoreholeType, string> = {
  ROTARY_CORE: "Rotary core",
  SPT: "SPT boring",
  CPT: "CPT sounding",
  TRIAL_PIT: "Trial pit",
  AUGER: "Auger boring",
};

export const BOREHOLE_STATUSES = [
  "PLANNED",
  "DRILLED",
  "SAMPLED",
  "COMPLETED",
  "ABANDONED",
] as const;
export type BoreholeStatus = (typeof BOREHOLE_STATUSES)[number];
export const BOREHOLE_STATUS_LABELS: Record<BoreholeStatus, string> = {
  PLANNED: "Planned",
  DRILLED: "Drilled",
  SAMPLED: "Sampled",
  COMPLETED: "Completed",
  ABANDONED: "Abandoned",
};

// --- Geological layer ---
export const MATERIAL_TYPES = ["SOIL", "ROCK", "FILL"] as const;
export type MaterialType = (typeof MATERIAL_TYPES)[number];
export const MATERIAL_TYPE_LABELS: Record<MaterialType, string> = {
  SOIL: "Soil",
  ROCK: "Rock",
  FILL: "Fill",
};

// --- Sample ---
// SPT and CPT are laboratory/field TEST types (see the lab-test registry),
// not sample types: a sample is a physical specimen.
export const SAMPLE_TYPES = [
  "DISTURBED",
  "UNDISTURBED",
  "ROCK_CORE",
  "WATER",
] as const;
export type SampleType = (typeof SAMPLE_TYPES)[number];
export const SAMPLE_TYPE_LABELS: Record<SampleType, string> = {
  DISTURBED: "Disturbed",
  UNDISTURBED: "Undisturbed",
  ROCK_CORE: "Rock core",
  WATER: "Water",
};

export const LAB_STATUSES = [
  "NOT_SENT",
  "SENT",
  "IN_TEST",
  "COMPLETED",
  "REJECTED",
] as const;
export type LabStatus = (typeof LAB_STATUSES)[number];
export const LAB_STATUS_LABELS: Record<LabStatus, string> = {
  NOT_SENT: "Not sent",
  SENT: "Sent to lab",
  IN_TEST: "In test",
  COMPLETED: "Completed",
  REJECTED: "Rejected",
};

// --- Laboratory test ---
export const LAB_TEST_STATUSES = [
  "PENDING",
  "IN_PROGRESS",
  "COMPLETED",
  "REJECTED",
] as const;
export type LabTestStatus = (typeof LAB_TEST_STATUSES)[number];
export const LAB_TEST_STATUS_LABELS: Record<LabTestStatus, string> = {
  PENDING: "Pending",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  REJECTED: "Rejected",
};

// --- Calculation records (M5.2 Integration) ---
// Execution states of a persisted calculation. The synchronous Calculate API
// persists final states only (COMPLETED/FAILED) in one atomic insert; PENDING
// is reserved for a future asynchronous execution mode.
export const CALCULATION_STATUSES = [
  "PENDING",
  "COMPLETED",
  "FAILED",
] as const;
export type CalculationStatus = (typeof CALCULATION_STATUSES)[number];
// Where the engine consumed its input from: the stored lab-test resultData
// (auto-invalidated when the data changes) or an explicit analyst payload
// (deliberate snapshot — never auto-invalidated).
export const CALCULATION_INPUT_SOURCES = ["RESULT_DATA", "EXPLICIT"] as const;
export type CalculationInputSource = (typeof CALCULATION_INPUT_SOURCES)[number];

// --- Document ---
export const DOC_TYPES = [
  "REPORT",
  "DRAWING",
  "LAB_DATA",
  "PHOTO",
  "CORRESPONDENCE",
  "OTHER",
] as const;
export type DocType = (typeof DOC_TYPES)[number];
export const DOC_TYPE_LABELS: Record<DocType, string> = {
  REPORT: "Report",
  DRAWING: "Drawing",
  LAB_DATA: "Lab data",
  PHOTO: "Photo",
  CORRESPONDENCE: "Correspondence",
  OTHER: "Other",
};

// --- Sharing ---
export const SHARE_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "REVOKED",
] as const;
export type ShareStatus = (typeof SHARE_STATUSES)[number];
export const SHARE_STATUS_LABELS: Record<ShareStatus, string> = {
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  REVOKED: "Revoked",
};

export const SHARE_PERMISSIONS = ["VIEW"] as const; // COMMENT is a future extension
export type SharePermission = (typeof SHARE_PERMISSIONS)[number];

// --- Report ---
export const REPORT_TYPES = [
  "BOREHOLE_LOG",
  "TEST_SUMMARY",
  "PROJECT_SUMMARY",
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  BOREHOLE_LOG: "Borehole log",
  TEST_SUMMARY: "Test summary",
  PROJECT_SUMMARY: "Project summary",
};

// --- Status colors (semantic names consumed by the UI layer, M4+) ---
export const STATUS_COLORS: Record<string, string> = {
  ACTIVE: "emerald",
  ON_HOLD: "amber",
  COMPLETED: "teal",
  ARCHIVED: "slate",
  PLANNED: "slate",
  DRILLED: "cyan",
  SAMPLED: "cyan",
  ABANDONED: "red",
  NOT_SENT: "slate",
  SENT: "amber",
  IN_TEST: "amber",
  PENDING: "amber",
  IN_PROGRESS: "amber",
  REJECTED: "red",
  APPROVED: "emerald",
  REVOKED: "red",
};
