import { createHash } from "node:crypto";
import { buildCycleOutcomeMarker } from "../lib/ima-cycle.ts";
import { buildLifecycleArtifact } from "../lib/ima-lifecycle.ts";

export const planeSource = Object.freeze({
  type: "plane",
  workspace: "ima",
  project: "SKYNET",
  sequenceId: 189,
});

export const lifecycleKey = "ima-pi:plane:ima:SKYNET-189";

export const planIdentity = (overrides = {}) => ({
  project: "ima-pi",
  lifecycleKey,
  lifecycleRootMemoryId: "",
  taskwarriorProject: "",
  taskwarriorTask: "",
  taskwarriorUuid: "",
  jiraKey: "",
  planeWorkspace: "ima",
  planeWorkItem: "SKYNET-189",
  sourceRefs: ["plane:ima:SKYNET-189"],
  priorArtifactIds: [],
  ...overrides,
});

export const planContext = Object.freeze({ lifecycleKey, source: planeSource });

export const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

export const recordKey = (name) => `${lifecycleKey}:plan:${name}`;

export const contentHash = (value) => createHash("sha256").update(value, "utf8").digest("hex");

export const planArtifact = (outcome) => outcome
  ? `# Plan\n\n${buildCycleOutcomeMarker({ phase: "plan", outcome })}`
  : "# Legacy Plan\n\nThis is an approved manual implementation contract.";

export const planRecord = ({
  id = uuid(1),
  key = recordKey("one"),
  createdAt = "2026-09-08T00:00:00.000Z",
  artifact = planArtifact("APPROVED"),
  identity = planIdentity(),
  hash = contentHash(key),
  nonce = "01234567-89ab-4def-8abc-0123456789ab",
  ...overrides
} = {}) => ({
  id,
  recordKey: key,
  project: "ima-pi",
  lifecycleKey,
  phase: "plan",
  sourceRefs: [...identity.sourceRefs],
  contentHash: hash,
  createdAt,
  content: buildLifecycleArtifact({ type: "plan", identity, artifact, nonce }),
  ...overrides,
});

export const recallPayload = (records) => ({ results: records });
