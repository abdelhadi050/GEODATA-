/**
 * GEODATA HUB — M3 API response types consumed by the M4 frontend.
 *
 * These mirror the actual JSON payloads of the documented API (docs/10):
 * the envelope plus the domain projections the service layer returns.
 * Dates arrive as ISO strings (JSON serialization); `filePath` never
 * appears on document payloads (stripped server-side by design).
 */

// ---------- Envelope ----------

export interface ApiMeta {
  page?: number;
  pageSize?: number;
  total?: number;
  totalPages?: number;
  [key: string]: unknown;
}

export interface ApiErrorShape {
  code: string;
  message: string;
  details?: unknown;
}

export type ApiEnvelope<T> =
  | { success: true; data: T; meta?: ApiMeta }
  | { success: false; error: ApiErrorShape };

// ---------- Shared projections ----------

export interface UserSummary {
  id: string;
  name: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

// ---------- Organizations & users ----------

export interface OrganizationInfo {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamUser {
  id: string;
  email: string;
  name: string;
  role: string;
  isActive: boolean;
  createdAt: string;
}

// ---------- Projects ----------

export interface ProjectListItem {
  id: string;
  code: string;
  name: string;
  description: string | null;
  client: string | null;
  status: string;
  locationName: string | null;
  latitude: number | null;
  longitude: number | null;
  createdAt: string;
  updatedAt: string;
  createdBy: UserSummary;
  _count: { boreholes: number; documents: number; reports: number };
  sharedWithYou: boolean;
}

export interface BoreholeSummary {
  id: string;
  code: string;
  type: string;
  status: string;
  latitude: number;
  longitude: number;
  elevation: number | null;
  depth: number | null;
  drillingDate: string | null;
  _count?: { samples: number; layers: number };
}

export interface DocumentSummary {
  id: string;
  title: string;
  docType: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  createdAt: string;
  uploadedBy: UserSummary;
}

export interface ReportSummary {
  id: string;
  reportType: string;
  title: string;
  createdAt: string;
  generatedBy: UserSummary;
}

export interface SharingRequestSummary {
  id: string;
  permission: string;
  status: string;
  message: string | null;
  expiresAt: string | null;
  createdAt: string;
  decidedAt: string | null;
  targetOrganization: { id: string; name: string; slug: string };
  requester: UserSummary;
  decidedBy: UserSummary | null;
}

export interface ProjectDetail extends ProjectListItem {
  accessSource: "own" | "shared";
  organization: { id: string; name: string; slug: string };
  boundary: { type: string; coordinates: number[][][] } | null;
  boreholes: BoreholeSummary[];
  documents: DocumentSummary[];
  reports: ReportSummary[];
  sharingRequests: SharingRequestSummary[];
}

// ---------- Boreholes & layers ----------

export interface BoreholeListItem {
  id: string;
  projectId: string;
  code: string;
  type: string;
  status: string;
  latitude: number;
  longitude: number;
  elevation: number | null;
  depth: number | null;
  drillingDate: string | null;
  drilledBy: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  project: { id: string; code: string; name: string; organizationId: string };
  _count: { samples: number; layers: number; documents: number };
  sharedWithYou: boolean;
}

export interface GeologicalLayer {
  id: string;
  boreholeId: string;
  depthFrom: number;
  depthTo: number;
  layerCode: string | null;
  materialType: string;
  description: string;
  uscs: string | null;
  consistency: string | null;
}

export interface SampleInBorehole {
  id: string;
  code: string;
  type: string;
  depthFrom: number;
  depthTo: number;
  labStatus: string;
  layer: { id: string; layerCode: string | null; uscs: string | null } | null;
  labTests: { id: string; testType: string; status: string; summary: string | null }[];
}

export interface BoreholeDetail extends BoreholeListItem {
  accessSource: "own" | "shared";
  layers: GeologicalLayer[];
  samples: SampleInBorehole[];
  documents: (DocumentSummary & { boreholeId: string | null })[];
}

// ---------- Samples ----------

export interface LabTestBrief {
  id: string;
  testType: string;
  status: string;
  summary: string | null;
}

export interface SampleListItem {
  id: string;
  boreholeId: string;
  code: string;
  type: string;
  depthFrom: number;
  depthTo: number;
  recovery: number | null;
  labStatus: string;
  collectedAt: string | null;
  notes: string | null;
  createdAt: string;
  borehole: {
    id: string;
    code: string;
    projectId: string;
    project: { id: string; code: string; name: string };
  };
  layer: { id: string; layerCode: string | null; uscs: string | null } | null;
  labTests: LabTestBrief[];
}

export interface SampleDetail extends SampleListItem {
  accessSource: "own" | "shared";
  labTests: (LabTestBrief & {
    performedBy: string | null;
    performedAt: string | null;
    notes: string | null;
    createdAt: string;
  })[];
}

// ---------- Laboratory tests ----------

export interface LabTestListItem {
  id: string;
  sampleId: string;
  testType: string;
  status: string;
  performedBy: string | null;
  performedAt: string | null;
  summary: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present in list payloads (always was, via the service query). Optional in the type because older clients ignore it. */
  resultData?: Record<string, unknown> | null;
  sample: {
    id: string;
    code: string;
    type: string;
    borehole: {
      id: string;
      code: string;
      project: { id: string; code: string; name: string };
    };
  };
}

export type ChartConfigDto =
  | { kind: "grainSizeCurve"; x: string; y: string }
  | { kind: "plasticityChart"; x: string; y: string }
  | { kind: "compactionCurve"; x: string; y: string }
  | { kind: "cbrCurve"; x: string; y: string }
  | { kind: "depthProfile"; y: string; value: string }
  | { kind: "cptProfile"; y: string; series: string[] }
  | { kind: "oedometerCurve"; x: string; y: string }
  | { kind: "barSummary"; value: string; groupBy?: string }
  // M5.1: contract added with the PRESSUREMETER registry entry; the renderer
  // arrives with the M5.3 chart milestone.
  | { kind: "pressuremeterCurve"; x: string; y: string }
  | { kind: "none" };

export interface RegistryEntryDto {
  code: string;
  label: string;
  description: string;
  standard: string;
  category: string;
  units: Record<string, string>;
  validationNotes: string[];
  chart: ChartConfigDto;
}

export interface LabTestDetail extends LabTestListItem {
  accessSource: "own" | "shared";
  resultData: Record<string, unknown> | null;
  /** M5.1: test-definition inputs (validated per type at write time; null when never recorded). */
  inputData: Record<string, unknown> | null;
  registry: {
    label: string;
    units: Record<string, string>;
    chart: ChartConfigDto;
    validationNotes: string[];
  } | null;
  sample: LabTestListItem["sample"] & {
    depthFrom: number;
    depthTo: number;
    labStatus: string;
  };
}

// ---------- M5.2 calculations (M5.3 frontend integration) ----------
// Mirror the actual Calculate API payloads (docs/19): dates arrive as ISO
// strings; list items are lean (no snapshots); the detail payload carries
// everything persisted.

export interface EngineInfoDto {
  moduleId: string;
  testType: string;
  label: string;
  description: string;
  moduleVersion: string;
  engineVersion: string;
}

export interface CalculationActor {
  id: string;
  name: string;
}

export interface CalculationListItemDto {
  id: string;
  labTestId: string;
  testType: string;
  moduleId: string;
  moduleVersion: string;
  engineVersion: string;
  status: "PENDING" | "COMPLETED" | "FAILED";
  inputSource: "RESULT_DATA" | "EXPLICIT";
  inputFingerprint: string;
  isValid: boolean;
  invalidatedAt: string | null;
  invalidatedReason: string | null;
  errorCode: string | null;
  method: string | null;
  standard: string | null;
  idempotencyKey: string | null;
  warningCount: number;
  createdAt: string;
  updatedAt: string;
  createdBy: CalculationActor;
}

export interface CalculationWarningDto {
  code: string;
  message: string;
  details?: Record<string, unknown> | null;
}

export interface CalculationDetailDto extends CalculationListItemDto {
  inputSnapshot: Record<string, unknown> | null;
  output: { raw: unknown; results: Record<string, unknown> | null } | null;
  warnings: CalculationWarningDto[] | null;
  errorMessage: string | null;
  errorDetails: Record<string, unknown> | null;
  units: Record<string, string> | null;
  labTest: {
    id: string;
    testType: string;
    status: string;
    sample: {
      id: string;
      code: string;
      borehole: {
        id: string;
        code: string;
        project: { id: string; code: string; name: string };
      };
    };
  };
}

/** GET .../calculations/latest returns the detail plus the access source. */
export interface LatestCalculationDto extends CalculationDetailDto {
  accessSource: "own" | "shared";
}

/** GET /api/calculations/:id returns the detail plus the access source. */
export interface CalculationRecordDto extends CalculationDetailDto {
  accessSource: "own" | "shared";
}

/** The engine outcome envelope returned by the calculate endpoint. */
export interface CalculationOutcomeDto {
  status: "ok" | "error";
  engineVersion?: string;
  moduleId?: string;
  moduleVersion?: string;
  testType?: string;
  raw?: unknown;
  results?: Record<string, unknown> | null;
  warnings?: CalculationWarningDto[];
  error?: { code: string; message: string; details?: unknown };
}

/** POST /api/lab-tests/:id/calculate response body. */
export interface CalculateResultDto {
  record: CalculationRecordDto | null;
  outcome: CalculationOutcomeDto;
  replayed: boolean;
  deduplicated: boolean;
  dryRun: boolean;
}

// ---------- Documents ----------

export interface DocumentListItem {
  id: string;
  projectId: string;
  boreholeId: string | null;
  title: string;
  docType: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  createdAt: string;
  updatedAt: string;
  project: { id: string; code: string; name: string };
  borehole: { id: string; code: string } | null;
  uploadedBy: UserSummary;
}

// ---------- Sharing ----------

export interface SharingRequestItem {
  id: string;
  projectId: string;
  permission: string;
  status: string;
  message: string | null;
  expiresAt: string | null;
  createdAt: string;
  decidedAt: string | null;
  project:
    | { id: string; code: string; name: string }
    | { id: string; code: string; name: string; organization: { id: string; name: string } };
  requester: UserSummary;
  targetOrganization: { id: string; name: string; slug?: string };
  decidedBy: UserSummary | null;
}

export interface SharingLists {
  sent: SharingRequestItem[];
  inbox: SharingRequestItem[];
}

// ---------- Reports & activity ----------

export interface ReportListItem {
  id: string;
  projectId: string;
  reportType: string;
  title: string;
  status: "DRAFT" | "GENERATED" | "FAILED";
  version: number;
  sampleId: string | null;
  boreholeId: string | null;
  hasPdf: boolean;
  pdfFileSize: number | null;
  pdfPageCount: number | null;
  createdAt: string;
  updatedAt: string;
  project: { id: string; code: string; name: string };
  sample: { id: string; code: string } | null;
  borehole: { id: string; code: string } | null;
  generatedBy: UserSummary;
}

export interface ReportDetailDto extends ReportListItem {
  contentSnapshot: unknown;
  pdfStoragePath: string | null;
  pdfGeneratedAt: string | null;
}

// ---------- M5.4 Classification extensions ----------

export interface ClassificationActor {
  id: string;
  name: string;
}

export interface ClassificationListItemDto {
  id: string;
  sampleId: string;
  moduleId: string;
  moduleVersion: string;
  engineVersion: string;
  status: "PENDING" | "COMPLETED" | "FAILED";
  inputSource: "SAMPLE_DATA" | "EXPLICIT";
  inputFingerprint: string;
  isValid: boolean;
  invalidatedAt: string | null;
  invalidatedReason: string | null;
  errorCode: string | null;
  standard: string | null;
  standardVersion: string | null;
  idempotencyKey: string | null;
  warningCount: number;
  createdAt: string;
  updatedAt: string;
  createdBy: ClassificationActor;
}

export interface ClassificationWarningDto {
  code: string;
  message: string;
  details?: Record<string, unknown> | null;
}

export interface ClassificationDetailDto extends ClassificationListItemDto {
  inputSnapshot: Record<string, unknown> | null;
  output: { raw: unknown; results: Record<string, unknown> | null } | null;
  warnings: ClassificationWarningDto[] | null;
  errorMessage: string | null;
  errorDetails: Record<string, unknown> | null;
  sample: {
    id: string;
    code: string;
    borehole: {
      id: string;
      code: string;
      project: { id: string; code: string; name: string };
    };
  };
}

export interface ClassificationRecordDto extends ClassificationDetailDto {
  accessSource: "own" | "shared";
}

export interface LatestClassificationDto extends ClassificationDetailDto {
  accessSource: "own" | "shared";
}

export interface ClassificationOutcomeDto {
  status: "ok" | "error";
  engineVersion?: string;
  moduleId?: string;
  moduleVersion?: string;
  sourceType?: string;
  standard?: string;
  standardVersion?: string;
  raw?: unknown;
  results?: Record<string, unknown> | null;
  warnings?: ClassificationWarningDto[];
  error?: { code: string; message: string; details?: unknown };
}

export interface ClassifyResultDto {
  record: ClassificationRecordDto | null;
  outcome: ClassificationOutcomeDto;
  replayed: boolean;
  deduplicated: boolean;
  dryRun: boolean;
}

export interface ClassificationEngineInfoDto {
  moduleId: string;
  sourceType: string;
  label: string;
  description: string;
  moduleVersion: string;
  engineVersion: string;
  standard: string;
  standardVersion: string;
}

export interface ActivityItem {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
  user: UserSummary | null;
}
