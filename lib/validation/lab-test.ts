/**
 * GEODATA HUB — Laboratory test validation schemas.
 * Structured RESULT data is validated separately by the lab-test registry
 * (src/lib/lab-tests/registry.ts) — never as arbitrary JSON. The same holds
 * for the optional INPUT payload (M5.1): `input` passes the strict body
 * schema as `unknown` and is validated per test type inside the service,
 * exactly like `result`.
 */
import { z } from "zod";
import { LAB_TEST_STATUSES } from "@/lib/constants";
import { LAB_TEST_TYPES } from "@/lib/lab-tests/registry";

export const createLabTestSchema = z.object({
  sampleId: z.string().min(1),
  testType: z.enum(LAB_TEST_TYPES),
  notes: z.string().trim().max(2000).optional(),
  // M5.1: optional test-definition inputs. Validated per test type by the
  // registry inputSchema inside the service (parseLabTestInput) — the same
  // pattern as labTestResultBody's `result`.
  input: z.unknown().optional(),
});

export const updateLabTestSchema = z.object({
  notes: z.string().trim().max(2000).optional(),
  status: z.enum(LAB_TEST_STATUSES).optional(),
  // M5.1: optional input edit. The service enforces the approved editability
  // rule: inputs are locked once a result exists; re-opening a test (which
  // clears its result) re-enables input editing.
  input: z.unknown().optional(),
});

export const labTestStatusSchema = z.enum(LAB_TEST_STATUSES);

export type CreateLabTestInput = z.infer<typeof createLabTestSchema>;
export type UpdateLabTestInput = z.infer<typeof updateLabTestSchema>;
