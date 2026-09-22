/** FNR-3016 production boundary for external IMA context and lifecycle services. */
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import { parseDocument } from "yaml";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  derivePhaseContext,
  evaluateSerenaBootstrap,
  type ContextSource,
  normalizeCorpusLifecycleRecord,
  normalizeSourcePayload,
  prepareContextArguments,
  sanitizeContextError,
  sanitizeContextText,
  STANDARD_MEMORIES,
  validateContextRequest,
} from "../lib/ima-context.ts";
import {
  deriveLifecycleResult,
  evaluateLifecycleArtifact,
  LIFECYCLE_PHASES,
  PLANE_WORK_ITEM_PATTERN,
  PLANE_WORKSPACE_PATTERN,
  normalizeLifecycleRecordKey,
  prepareLifecycleArtifact,
  sanitizeLifecycleError,
  validateLifecycleWriteRequest,
  validateLifecycleStoreReceipt,
  type LifecyclePhase,
  type ValidLifecycleRequest,
} from "../lib/ima-lifecycle.ts";
import { storeInstitutionalManifest } from "../lib/qdrant-corpus.ts";
import {
  withMcpSession,
  type McpToolDiscovery,
  type McpToolCaller,
} from "../lib/mcp-client.ts";
import { createQdrantCorpusClient, type QdrantCorpusClient } from "../lib/qdrant-http.ts";
import { createQdrantLifecycleProvider } from "../lib/qdrant-lifecycle.ts";
import {
  createBookStackLifecycleClient,
  type BookStackLifecycleClient,
} from "../lib/bookstack-lifecycle-client.ts";
import {
  bookStackLifecycleResultIsNoWrite,
  createBookStackLifecycleProvider,
  type BookStackRecoveryDiscovery,
} from "../lib/bookstack-lifecycle.ts";
import {
  placementMatchesRequest,
  projectLifecyclePlacement,
  type LifecyclePlacement,
} from "../lib/bookstack-lifecycle-record.ts";
import {
  sameBookStackPageRecoveryCheckpoint,
} from "../lib/bookstack-lifecycle-recovery.ts";
import { resolveBookStackOrigin } from "../lib/bookstack-migrate-config.ts";
import { createMarkdownLifecycleAdapter } from "../lib/markdown-lifecycle.ts";
import { createSerenaLifecycleClient } from "../lib/serena-lifecycle-client.ts";
import {
  createLegacySerenaMcpSession,
  createSerenaMcpSession,
  type SerenaMcpSession,
} from "../lib/serena-mcp-session.ts";
import { createSerenaLifecycleProvider } from "../lib/serena-lifecycle.ts";
import { createSerenaLifecycleProject } from "../lib/serena-lifecycle-record.ts";
import {
  createLifecycleProviderPin,
  createLifecycleProviderPinAttempt,
  sameLifecycleProviderPin,
  sameLifecycleProviderPinAttempt,
  type LifecycleProviderPin,
  type LifecycleProviderPinAttempt,
} from "../lib/ima-lifecycle-pin.ts";
import {
  abandonLifecyclePinAttemptWith,
  beginLifecyclePinWith,
  claimLifecyclePinRecoveryWith,
  confirmLifecyclePinWith,
  loadLifecyclePinStateWith,
  markLifecyclePinAttemptWritingWith,
  type LifecyclePinLoadResult,
} from "../lib/ima-lifecycle-pin-store.ts";
import {
  containsRecognizedLifecycleSecret,
  createLifecycleRouting,
  lifecycleReadNativeReferenceFor,
  lifecycleReadReferenceFor,
  projectLifecycleReadReference,
  resolvePinnedLifecycleLineage,
  routeLifecycleGet,
  routeLifecyclePersistence,
  routeLifecycleRecall,
  routePinnedLifecycleGet,
  routePinnedLifecyclePersistence,
  routePinnedLifecycleRecall,
  routePinnedLifecycleReference,
  sameLifecycleReadReference,
  validateInitialLifecycleWriteRequest,
  verifyRoutedLifecycleReadRecord,
  type LifecycleReadReference,
  type PinnedLifecycleLineage,
  type LifecycleRoutingAdapter,
  type RoutedLifecyclePersistResult,
  type RoutedLifecycleRecallResult,
  type RoutedLifecycleRecord,
} from "../lib/ima-lifecycle-routing.ts";
import {
  createLifecycleContentAdjudicator,
  MAX_LIFECYCLE_CONTENT_FINDINGS,
  screenLifecycleContent,
  type LifecycleContentFinding,
  type LifecycleContentScreening,
} from "../lib/ima-lifecycle-security.ts";
import {
  lifecycleProviderRecommendation,
  normalizeLifecycleProvider,
  resolveLifecycleProviderRecommendation,
  type LifecycleProviderName,
  type LifecycleProviderPreferenceInputs,
  type LifecycleProviderRecommendation,
} from "../lib/ima-lifecycle-selection.ts";
import { defaultResolveCycleProjectRoot } from "../lib/ima-cycle-persistence.ts";

const execFile = promisify(execFileCallback);
const TIMEOUT = 30_000;
const MCP_TIMEOUT = 300_000;
const VESTIGE_TIMEOUT = 300_000;
const LIFECYCLE_RECALL_LIMIT = 50;
const INSTITUTIONAL_RECALL_LIMIT = 20;
const MAX_LIFECYCLE_READ_REFERENCE_BYTES = 2_048;
const MAX_LIFECYCLE_READ_SUMMARY_BYTES = 2_000;
const MAX_LIFECYCLE_READ_ARTIFACT_BYTES = 160_000;
const MAX_LIFECYCLE_READ_OUTPUT_BYTES = (MAX_LIFECYCLE_READ_ARTIFACT_BYTES * 6) + 32_000;
const MAX_LIFECYCLE_READ_RESULTS = 50;
const MAX_LIFECYCLE_CONTENT_DECISIONS = 20;
const MAX_BUFFER = 128 * 1024;
const MAX_BOOKSTACK_RECOVERY_CONFIRMATION_BYTES = 16_384;
const PLANE_SOURCE_CONTENT_MAXIMUM_BYTES = 64_000;
const SOURCE_ERROR_CODES = ["source_path_outside_project", "source_file_unreadable", "source_file_too_large"];
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceErrorCode = (error: unknown) => error instanceof Error && SOURCE_ERROR_CODES.includes(error.message) ? error.message : "source_boundary_unavailable";
const inside = (root: string, target: string) => { const path = relative(root, target); return path === "" || (!path.startsWith("..") && !isAbsolute(path)); };
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const ownDataRecord = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.some((key) => typeof key !== "string")
      || keys.length < required.length
      || !required.every((field) => keys.includes(field))
      || keys.some((key) => ![...required, ...optional].includes(key as string))
      || keys.some((key) => {
        const descriptor = descriptors[key as string];
        return !descriptor
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable
          || !Object.hasOwn(descriptor, "value");
      })
    ) return null;
    return Object.fromEntries(keys.map((key) => [key, descriptors[key as string].value]));
  } catch {
    return null;
  }
};
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const PIN_ATTEMPT_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89ab][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const normalizeUuid = (value: unknown) => typeof value === "string" && UUID_PATTERN.test(value)
  ? value.toLowerCase()
  : null;
const envelope = (value: string) => { try { return JSON.parse(value); } catch { return null; } };
const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) signal.throwIfAborted();
};

type LifecycleContentAdmission = object;
export type LifecycleContentAdmissionKind = "write" | "read-get" | "read-recall";
type LifecycleContentAdmissionData = {
  kind: LifecycleContentAdmissionKind;
  approvedWarningBindings?: readonly string[];
};
export type LifecycleContentDecision = "continue_after_review" | "reject";
export type PendingLifecycleContentDecision = {
  finding: string;
  findings: readonly LifecycleContentFinding[];
  binding?: string;
};
export type PendingLifecycleContentOperation = {
  kind: LifecycleContentAdmissionKind;
  request: unknown;
  warningDecisions: readonly PendingLifecycleContentDecision[];
  approvedWarningBindings?: readonly string[];
};

const lifecycleContentAdjudicator = createLifecycleContentAdjudicator();
const lifecycleContentAdmissions = new WeakMap<object, LifecycleContentAdmissionData>();
const LIFECYCLE_CONTENT_SCREENING_MESSAGES = {
  lifecycle_content_adjudication_declined: "Lifecycle content adjudication was declined.",
  lifecycle_content_adjudication_expired: "Lifecycle content adjudication expired before execution.",
  lifecycle_content_adjudication_invalid: "Lifecycle content adjudication is invalid.",
  lifecycle_content_adjudication_mismatch: "Lifecycle content changed before adjudication completed.",
  lifecycle_content_adjudication_required: "Lifecycle content requires explicit owner adjudication.",
  lifecycle_content_adjudication_unavailable: "Lifecycle content adjudication is unavailable.",
  lifecycle_content_blocked: "Lifecycle content is blocked by local screening.",
} as const;

type LifecycleContentScreeningFailureCode = keyof typeof LIFECYCLE_CONTENT_SCREENING_MESSAGES;

const lifecycleContentScreeningFailure = (
  code: LifecycleContentScreeningFailureCode,
  screening: LifecycleContentScreening,
) => ({
  schemaVersion: 1,
  status: "failed" as const,
  artifactId: null,
  recordKey: null,
  error: {
    code,
    message: LIFECYCLE_CONTENT_SCREENING_MESSAGES[code],
    ...(screening.tier === "allow" ? {} : { findings: screening.findings }),
  },
});

const lifecycleContentWarningResult = (input: {
  handle: string;
  warningDecisions: readonly PendingLifecycleContentDecision[];
}) => ({
  schemaVersion: 1,
  status: "pending" as const,
  warning: {
    code: "lifecycle_content_adjudication_required",
    message: LIFECYCLE_CONTENT_SCREENING_MESSAGES.lifecycle_content_adjudication_required,
  },
  adjudication: {
    handle: input.handle,
    decisionValues: ["continue_after_review", "reject"] as const,
    findings: input.warningDecisions.map(({ finding, findings }) => ({
      finding,
      findings,
    })),
  },
});

const registerLifecycleContentAdmission = (
  data: LifecycleContentAdmissionData,
): LifecycleContentAdmission => {
  const admission = Object.freeze({});
  lifecycleContentAdmissions.set(admission, {
    kind: data.kind,
    ...(data.approvedWarningBindings
      ? { approvedWarningBindings: [...data.approvedWarningBindings] }
      : {}),
  });
  return admission;
};

const consumeLifecycleContentAdmission = (
  value: unknown,
  kind: LifecycleContentAdmissionKind,
): LifecycleContentAdmissionData | null => {
  if (!value || typeof value !== "object") return null;
  const admission = lifecycleContentAdmissions.get(value);
  lifecycleContentAdmissions.delete(value);
  return admission?.kind === kind ? admission : null;
};

type BookStackRecoveryAction = "pin-existing-page" | "create-page";

type BookStackRecoveryConfirmation = {
  summary: string;
  placement: LifecyclePlacement;
  origin: string;
  requestHash: string;
  attemptId: string;
  lifecycleKey: string;
  pageSlug: string;
  action: BookStackRecoveryAction;
  pageCount: number;
  existing: boolean;
  phase: LifecyclePhase;
};

const projectBookStackRecoveryPlacement = (placement: LifecyclePlacement): LifecyclePlacement => ({
  projectSlug: placement.projectSlug,
  sourceRef: placement.sourceRef,
  lifecycleKey: placement.lifecycleKey,
  shelfId: placement.shelfId,
  shelfSlug: placement.shelfSlug,
  bookId: placement.bookId,
  bookSlug: placement.bookSlug,
  chapterId: placement.chapterId,
  chapterSlug: placement.chapterSlug,
});

const bookStackRecoveryConfirmation = (input: {
  request: ValidLifecycleRequest;
  placement: LifecyclePlacement;
  attempt: LifecycleProviderPinAttempt;
  discovery: BookStackRecoveryDiscovery;
}): BookStackRecoveryConfirmation => ({
  summary: input.request.summary,
  placement: projectBookStackRecoveryPlacement(input.placement),
  origin: input.discovery.origin,
  requestHash: input.discovery.checkpoint.requestHash,
  attemptId: input.attempt.attemptId,
  lifecycleKey: input.request.identity.lifecycleKey,
  pageSlug: input.discovery.checkpoint.pageSlug,
  action: input.discovery.existing ? "pin-existing-page" : "create-page",
  pageCount: input.discovery.pageCount,
  existing: input.discovery.existing !== null,
  phase: input.request.type,
});

const bookStackRecoveryActionText = (action: BookStackRecoveryAction) => action === "pin-existing-page"
  ? "Pin the exact verified existing page without a page POST."
  : "Authorize at most one page POST.";

const renderBookStackRecoveryConfirmation = (input: BookStackRecoveryConfirmation) => {
  const value = (text: string) => JSON.stringify(text);
  const placement = input.placement;
  const rendered = [
    "Review the supplied BookStack recovery inputs:",
    `Action: ${bookStackRecoveryActionText(input.action)}`,
    `BookStack origin: ${value(input.origin)}`,
    `Lifecycle key: ${value(input.lifecycleKey)}`,
    `Attempt ID: ${input.attemptId}`,
    `Request hash: ${input.requestHash}`,
    `Phase: ${input.phase}`,
    `Summary: ${value(input.summary)}`,
    `Page slug: ${input.pageSlug}`,
    `Discovered page count: ${input.pageCount}`,
    "Destination placement:",
    `  Project slug: ${value(placement.projectSlug)}`,
    `  Source reference: ${value(placement.sourceRef)}`,
    `  Placement lifecycle key: ${value(placement.lifecycleKey)}`,
    `  Shelf: ${value(placement.shelfSlug)} (ID ${placement.shelfId})`,
    `  Book: ${value(placement.bookSlug)} (ID ${placement.bookId})`,
    `  Chapter: ${value(placement.chapterSlug)} (ID ${placement.chapterId})`,
    "",
    "This display is not machine-verifiable proof of a historical request.",
    "Are these the unchanged original inputs for this recovery?",
  ].join("\n");
  if (Buffer.byteLength(rendered, "utf8") > MAX_BOOKSTACK_RECOVERY_CONFIRMATION_BYTES) {
    throw new Error("bookstack_recovery_confirmation_too_large");
  }
  return rendered;
};

const mcpServer = async (name: string) => {
  try {
    const config = object(envelope(await readFile(join(packageRoot, "config", "mcp.json"), "utf8")));
    const server = object(object(config?.mcpServers)?.[name]);
    const command = text(server?.command);
    const args = server?.args === undefined
      ? []
      : Array.isArray(server.args) && server.args.every((value) => typeof value === "string")
        ? server.args
        : null;

    return command && args ? { command, args } : null;
  } catch {
    return null;
  }
};

export type { McpToolCaller } from "../lib/mcp-client.ts";

export type McpSession = <Result>(
  serverName: string,
  callback: (call: McpToolCaller, listTools?: McpToolDiscovery) => Promise<Result>,
  signal?: AbortSignal,
) => Promise<Result | null>;

export const withConfiguredMcpSession: McpSession = async (
  serverName,
  callback,
  signal,
) => {
  const server = await mcpServer(serverName);
  if (!server) return null;

  try {
    return await withMcpSession(server, callback, signal);
  } catch {
    return null;
  }
};

const LIFECYCLE_PHASE_SET = new Set<string>(LIFECYCLE_PHASES);
const DOCUMENT_COMPATIBILITY_RECALL_LIMIT = LIFECYCLE_RECALL_LIMIT / 2;

type RecalledLifecycleRecord = {
  id: string;
  recordKey: string;
  project: string;
  site: string;
  repo: string;
  lifecycleKey: string;
  phase: string;
  summary: string;
  sourceRefs: string[];
  contentHash: string;
  createdAt: string;
  content: string;
};

const lifecycleRecallQuery = (value: string) => {
  const trimmed = value.trim();
  const separator = trimmed.lastIndexOf(" ");
  if (separator < 1) return null;
  const lifecycleKey = trimmed.slice(0, separator);
  const phase = trimmed.slice(separator + 1);
  return lifecycleKey && LIFECYCLE_PHASE_SET.has(phase)
    ? { lifecycleKey, phase }
    : null;
};

const LIFECYCLE_READ_HASH = /^[a-f0-9]{64}$/;

const exactLifecycleReadSelectorText = (value: unknown, maximum: number): string | null =>
  typeof value === "string"
  && value === value.trim()
  && value.length > 0
  && Buffer.from(value, "utf8").toString("utf8") === value
  && Buffer.byteLength(value, "utf8") <= maximum
  && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
    ? value
    : null;

const exactLifecycleReadText = (value: unknown, maximum: number) => {
  const text = exactLifecycleReadSelectorText(value, maximum);
  return text && !containsRecognizedLifecycleSecret(text) ? text : null;
};

const exactLifecycleReadKey = (value: unknown) => {
  const key = exactLifecycleReadText(value, 512);
  return key && normalizeLifecycleRecordKey(key) === key ? key : null;
};

const exactLifecycleReadPhase = (value: unknown): LifecyclePhase | null =>
  typeof value === "string" && LIFECYCLE_PHASE_SET.has(value)
    ? value as LifecyclePhase
    : null;

const exactLifecycleReadUuid = (value: unknown): string | null => {
  const uuid = normalizeUuid(value);
  return uuid && uuid === value ? uuid : null;
};

const exactLifecycleReadHash = (value: unknown): string | null => {
  const hash = exactLifecycleReadText(value, 64);
  return hash && LIFECYCLE_READ_HASH.test(hash) ? hash : null;
};

type LifecycleReadRecallRequest = {
  lifecycleKey: string;
  phase?: LifecyclePhase;
  limit: number;
};

type LifecycleReadGetSelector = {
  lifecycleKey: string;
  phase: LifecyclePhase;
  artifactId: string;
};

type LifecycleReadGetRequest = {
  lifecycleKey: string;
  phase: LifecyclePhase;
  artifactId: string;
  recordKey: string;
  contentHash: string;
  reference: LifecycleReadReference;
};

type LifecycleReadGetInput =
  | { kind: "descriptor"; request: LifecycleReadGetRequest }
  | { kind: "selector"; selector: LifecycleReadGetSelector };

const lifecycleReadRecallRequest = (value: unknown): LifecycleReadRecallRequest | null => {
  const request = ownDataRecord(value, ["lifecycleKey"], ["phase", "limit"]);
  if (!request) return null;
  const lifecycleKey = exactLifecycleReadKey(request.lifecycleKey);
  const hasPhase = Object.hasOwn(request, "phase");
  const phase = hasPhase ? exactLifecycleReadPhase(request.phase) : undefined;
  const limit = Object.hasOwn(request, "limit") ? request.limit : LIFECYCLE_RECALL_LIMIT;
  if (
    !lifecycleKey
    || hasPhase && !phase
    || typeof limit !== "number"
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > MAX_LIFECYCLE_READ_RESULTS
  ) return null;
  return {
    lifecycleKey,
    ...(phase ? { phase } : {}),
    limit,
  };
};

const lifecycleReadDescriptorRequest = (value: unknown): LifecycleReadGetRequest | null => {
  const request = ownDataRecord(value, [
    "lifecycleKey",
    "phase",
    "artifactId",
    "recordKey",
    "contentHash",
    "reference",
  ], ["summary"]);
  if (!request) return null;
  const lifecycleKey = exactLifecycleReadKey(request.lifecycleKey);
  const phase = exactLifecycleReadPhase(request.phase);
  const artifactId = exactLifecycleReadUuid(request.artifactId);
  const recordKey = exactLifecycleReadKey(request.recordKey);
  const contentHash = exactLifecycleReadHash(request.contentHash);
  const summary = Object.hasOwn(request, "summary")
    ? exactLifecycleReadSelectorText(request.summary, MAX_LIFECYCLE_READ_SUMMARY_BYTES)
    : undefined;
  const summaryScreening = summary === undefined
    ? { tier: "allow" as const }
    : screenLifecycleContent({ summary });
  const reference = projectLifecycleReadReference(request.reference);
  if (!reference) return null;
  let serializedReference: string;
  try {
    serializedReference = JSON.stringify(reference);
  } catch {
    return null;
  }
  return lifecycleKey
    && phase
    && artifactId
    && recordKey
    && contentHash
    && summary !== null
    && summaryScreening.tier !== "block"
    && Buffer.byteLength(serializedReference, "utf8") <= MAX_LIFECYCLE_READ_REFERENCE_BYTES
    ? { lifecycleKey, phase, artifactId, recordKey, contentHash, reference }
    : null;
};

const lifecycleReadGetSelector = (value: unknown): LifecycleReadGetSelector | null => {
  const selector = ownDataRecord(value, ["lifecycleKey", "phase", "artifactId"]);
  if (!selector) return null;
  const lifecycleKey = exactLifecycleReadKey(selector.lifecycleKey);
  const phase = exactLifecycleReadPhase(selector.phase);
  const artifactId = exactLifecycleReadUuid(selector.artifactId);
  return lifecycleKey && phase && artifactId
    ? { lifecycleKey, phase, artifactId }
    : null;
};

const lifecycleReadGetRequest = (value: unknown): LifecycleReadGetInput | null => {
  const descriptor = lifecycleReadDescriptorRequest(value);
  if (descriptor) return { kind: "descriptor", request: descriptor };
  const selector = lifecycleReadGetSelector(value);
  return selector ? { kind: "selector", selector } : null;
};

const recalledLifecycleRecord = (value: unknown): RecalledLifecycleRecord | null => {
  const record = object(value);
  const id = typeof record?.id === "string" ? record.id : "";
  const rawRecordKey = record?.recordKey;
  const recordKey = normalizeLifecycleRecordKey(rawRecordKey);
  const project = typeof record?.project === "string" ? record.project : "";
  const site = typeof record?.site === "string" ? record.site : "";
  const repo = typeof record?.repo === "string" ? record.repo : "";
  const lifecycleKey = typeof record?.lifecycleKey === "string" ? record.lifecycleKey : "";
  const phase = typeof record?.phase === "string" ? record.phase : "";
  const summary = typeof record?.summary === "string" ? record.summary : "";
  const sourceRefs = Array.isArray(record?.sourceRefs)
    && record.sourceRefs.every((reference) => typeof reference === "string")
    ? [...record.sourceRefs]
    : null;
  const contentHash = typeof record?.contentHash === "string" ? record.contentHash : "";
  const createdAt = typeof record?.createdAt === "string" ? record.createdAt : "";
  const content = typeof record?.detail === "string" ? record.detail : "";
  return id && recordKey && rawRecordKey === recordKey && project && repo && lifecycleKey && LIFECYCLE_PHASE_SET.has(phase)
    && summary && sourceRefs && contentHash && createdAt && content
    ? {
      id,
      recordKey,
      project,
      site,
      repo,
      lifecycleKey,
      phase,
      summary,
      sourceRefs,
      contentHash,
      createdAt,
      content,
    }
    : null;
};

const recallCorpusLifecyclePhase = async (
  selection: { lifecycleKey: string; phase: string },
  corpus: QdrantCorpusClient,
  limit: number,
  signal?: AbortSignal,
): Promise<RecalledLifecycleRecord[] | null> => {
  const directRecall = corpus.recallLifecycleInstitutional;
  if (typeof directRecall === "function") {
    const recalled = await directRecall({ ...selection, limit }, signal);
    throwIfAborted(signal);
    if (!recalled.success || !Array.isArray(recalled.data) || recalled.data.length > limit) return null;
    const records = recalled.data.map(recalledLifecycleRecord);
    return records.every((record) => record !== null
      && record.lifecycleKey === selection.lifecycleKey
      && record.phase === selection.phase)
      ? records as RecalledLifecycleRecord[]
      : null;
  }

  const institutionalLimit = Math.min(limit, INSTITUTIONAL_RECALL_LIMIT);
  const recalled = await corpus.recallInstitutional({ ...selection, limit: institutionalLimit }, signal);
  throwIfAborted(signal);
  if (!recalled.success || recalled.data.length >= institutionalLimit) return null;

  const records: RecalledLifecycleRecord[] = [];
  const recordKeys = new Set<string>();
  for (const summary of recalled.data) {
    const summaryRecordKey = normalizeLifecycleRecordKey(summary.recordKey);
    if (!summaryRecordKey || summary.recordKey !== summaryRecordKey || recordKeys.has(summaryRecordKey)) return null;
    const full = await corpus.getInstitutional(summaryRecordKey, signal);
    throwIfAborted(signal);
    if (!full.success) return null;
    const record = recalledLifecycleRecord(full.data);
    if (
      !record
      || record.recordKey !== summaryRecordKey
      || record.lifecycleKey !== selection.lifecycleKey
      || record.phase !== selection.phase
    ) return null;
    recordKeys.add(record.recordKey);
    records.push(record);
  }
  return records;
};

export const recallCorpusLifecycle = async (
  query: string,
  corpus: QdrantCorpusClient = createQdrantCorpusClient(),
  signal?: AbortSignal,
) => {
  const selection = lifecycleRecallQuery(query);
  if (!selection) return null;

  try {
    const phases = selection.phase === "document"
      ? ["document", "closeout"]
      : [selection.phase];
    const limit = phases.length === 1
      ? LIFECYCLE_RECALL_LIMIT
      : DOCUMENT_COMPATIBILITY_RECALL_LIMIT;
    const records: RecalledLifecycleRecord[] = [];
    const recordKeys = new Set<string>();
    for (const phase of phases) {
      const recalled = await recallCorpusLifecyclePhase(
        { lifecycleKey: selection.lifecycleKey, phase },
        corpus,
        limit,
        signal,
      );
      if (!recalled) return null;
      for (const record of recalled) {
        if (recordKeys.has(record.recordKey)) return null;
        recordKeys.add(record.recordKey);
        records.push(record);
      }
    }
    return { structuredContent: { results: records } };
  } catch {
    throwIfAborted(signal);
    return null;
  }
};

export type IntegrationDependencies = {
  run?: (program: string, args: string[], signal?: AbortSignal) => Promise<unknown>;
  read?: (path: string) => Promise<string>;
  canonical?: (path: string) => Promise<string>;
  stat?: typeof lstat;
  session?: McpSession;
  corpus?: QdrantCorpusClient;
  home?: () => string;
  now?: () => Date;
};

export type LifecycleRoutingOptions = {
  cwd?: string;
  provider?: unknown;
  pinAttemptId?: unknown;
  preferences?: LifecycleProviderPreferenceInputs;
  routing?: ReturnType<typeof createLifecycleRouting>;
  environment?: Record<string, string | undefined>;
  confirmProvider?: (input: {
    recommendation: LifecycleProviderRecommendation;
    provider: LifecycleProviderName;
  }) => Promise<boolean> | boolean;
  confirmBookStackPlacement?: (preview: unknown) => Promise<boolean> | boolean;
  confirmBookStackRecovery?: (input: BookStackRecoveryConfirmation) => Promise<boolean> | boolean;
  bookStackLifecycleClient?: BookStackLifecycleClient;
  resolveProjectRoot?: (cwd: string) => Promise<string>;
};

export type LifecycleIntegrationDependencies = IntegrationDependencies & LifecycleRoutingOptions & {
  contentScreeningAdmission?: LifecycleContentAdmission;
  captureContentWarning?: (input: {
    kind: "read-get" | "read-recall";
    warnings: readonly {
      binding: string;
      findings: readonly LifecycleContentFinding[];
    }[];
  }) => void;
};

const productionDependencies: Required<IntegrationDependencies> = {
  run: async (program, args, signal) => {
    throwIfAborted(signal);
    try {
      const { stdout } = await execFile(program, args, {
        timeout: TIMEOUT,
        maxBuffer: MAX_BUFFER,
        signal,
      });
      return envelope(stdout);
    } catch {
      throwIfAborted(signal);
      return null;
    }
  },
  read: (path) => readFile(path, "utf8"),
  canonical: realpath,
  stat: lstat,
  session: withConfiguredMcpSession,
  corpus: createQdrantCorpusClient(),
  home: homedir,
  now: () => new Date(),
};

const depsFor = (given?: IntegrationDependencies) => ({ ...productionDependencies, ...given });
const directResponse = (value: unknown) => {
  const response = object(value);
  return response?.isError === true ? null : response;
};
const directStructured = (value: unknown) => object(directResponse(value)?.structuredContent);
export const mcpResultData = (value: unknown): Record<string, unknown> | null => {
  const response = directResponse(value);
  if (!response) return null;

  const structured = object(response.structuredContent);
  if (structured) return structured;
  if (Array.isArray(response.content)) {
    for (const content of response.content) {
      const item = object(content);
      if (typeof item?.text !== "string") continue;
      const parsed = envelope(item.text);
      if (object(parsed)) return object(parsed);
    }
  }

  return response;
};
const directResult = (value: unknown) => {
  const response = directResponse(value);
  if (!response) return null;

  const structured = object(response.structuredContent);
  if (typeof structured?.result === "string") return structured.result;
  if (!Array.isArray(response.content)) return null;

  for (const content of response.content) {
    const item = object(content);
    if (typeof item?.text === "string") return item.text;
  }

  return null;
};
const serenaActivationMatchesRoot = (value: string, root: string) => {
  const firstLine = value.split("\n", 1)[0];
  const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^The project with name '[^'\\r\\n]+' at ${escapedRoot} is activated\\.$`)
    .test(firstLine);
};

const listedMemoryNames = (value: string | null) => {
  if (value === null) return null;

  try {
    const listing = object(JSON.parse(value));
    const names = listing?.memories;
    return Array.isArray(names) && names.every((name) => typeof name === "string") ? names : null;
  } catch {
    return null;
  }
};
type SerenaMcpSessionResolution =
  | { success: true; session: SerenaMcpSession }
  | { success: false; code: string };

const resolveSerenaMcpSession = async (
  call: McpToolCaller,
  listTools: McpToolDiscovery | undefined,
  signal?: AbortSignal,
): Promise<SerenaMcpSessionResolution> => {
  if (signal?.aborted) return { success: false, code: "aborted" };
  if (!listTools) {
    const legacy = createLegacySerenaMcpSession(call);
    return legacy.success
      ? { success: true, session: legacy.session }
      : { success: false, code: legacy.code };
  }

  let advertisedTools: unknown;
  try {
    advertisedTools = await listTools(MCP_TIMEOUT);
  } catch {
    throwIfAborted(signal);
    return { success: false, code: "serena_capability_discovery_failed" };
  }
  if (signal?.aborted) return { success: false, code: "aborted" };

  const created = createSerenaMcpSession({
    call,
    advertisedTools,
    initialization: listTools.initialization,
  });
  return created.success
    ? { success: true, session: created.session }
    : { success: false, code: created.code };
};

const safeSerenaToolCall = async (
  operation: () => Promise<unknown>,
  signal?: AbortSignal,
) => {
  throwIfAborted(signal);
  try {
    const result = await operation();
    throwIfAborted(signal);
    return result;
  } catch {
    throwIfAborted(signal);
    return null;
  }
};

const serenaFailure = (
  activated: boolean,
  instructionsLoaded: boolean,
  memoryListLoaded: boolean,
  blocking: string,
) => ({
  bootstrap: evaluateSerenaBootstrap({ activated, instructionsLoaded, memoryListLoaded }),
  blocking,
});

async function serena(
  root: string,
  deps: Required<IntegrationDependencies>,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  try {
    const setup = await deps.session("serena", async (call, listTools) => {
      const resolved = await resolveSerenaMcpSession(call, listTools, signal);
      if (!resolved.success) return serenaFailure(false, false, false, resolved.code);
      if (!resolved.session.capabilities.contextSupported) {
        return serenaFailure(false, false, false, "serena_protocol_unsupported");
      }

      const preparation = await resolved.session.prepare(MCP_TIMEOUT, signal);
      if (!preparation.success) {
        return serenaFailure(false, false, false, preparation.code);
      }

      const activation = directResult(await safeSerenaToolCall(
        () => resolved.session.activateProject(root, MCP_TIMEOUT, signal),
        signal,
      ));
      if (
        activation === null
        || !serenaActivationMatchesRoot(activation, root)
      ) return serenaFailure(false, preparation.instructionsLoaded, false, "serena_activation_failed");

      let instructionsLoaded = preparation.instructionsLoaded;
      if (!instructionsLoaded) {
        const instructions = directResult(await safeSerenaToolCall(
          () => resolved.session.initialInstructions(MCP_TIMEOUT, signal),
          signal,
        ));
        if (instructions === null) return serenaFailure(true, false, false, "serena_instructions_failed");
        instructionsLoaded = true;
      }

      const listing = directResult(await safeSerenaToolCall(
        () => resolved.session.listMemories(MCP_TIMEOUT, signal),
        signal,
      ));
      const names = listedMemoryNames(listing);
      if (!names) return serenaFailure(true, instructionsLoaded, false, "serena_memory_list_failed");

      const memories: Record<string, string | null | "failed"> = {};
      for (const name of STANDARD_MEMORIES) {
        if (!names.includes(name)) {
          memories[name] = null;
          continue;
        }

        const content = directResult(await safeSerenaToolCall(
          () => resolved.session.readMemory(name, MCP_TIMEOUT, signal),
          signal,
        ));
        memories[name] = text(content) || "failed";
      }

      return {
        bootstrap: evaluateSerenaBootstrap({
          activated: true,
          instructionsLoaded,
          memoryListLoaded: true,
          memories,
        }),
        blocking: null,
      };
    }, signal);

    throwIfAborted(signal);
    return setup ?? serenaFailure(false, false, false, "serena_activation_failed");
  } catch {
    throwIfAborted(signal);
    return serenaFailure(false, false, false, "serena_activation_failed");
  }
}

async function loadDurableKnowledge(
  request: { query: string; collection?: string; limit?: number },
  deps: Required<IntegrationDependencies>,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  try {
    const response = await deps.corpus.findKnowledge({
      query: request.query,
      collection: request.collection ?? "ima-knowledge",
      limit: request.limit ?? 20,
    }, signal);
    throwIfAborted(signal);
    if (!response.success) return { requested: true, status: "failed" as const, references: [] };

    const references = response.data
      .slice(0, request.limit ?? 20)
      .map(({ summary, score }) => ({ summary: sanitizeContextText(summary, 512), score }))
      .filter(({ summary }) => Boolean(summary));
    return references.length > 0
      ? { requested: true, status: "loaded" as const, references }
      : { requested: true, status: "empty" as const, references: [] };
  } catch {
    throwIfAborted(signal);
    return { requested: true, status: "failed" as const, references: [] };
  }
}

type PlaneSource = Extract<ContextSource, { type: "plane" }>;

const normalizePlaneResponse = (source: PlaneSource, value: unknown) => {
  const data = object(value);
  if (!data) return null;

  const canonical = `plane:${source.workspace}:${source.project}-${source.sequenceId}`;
  const identifier = `${source.project}-${source.sequenceId}`;
  const id = normalizeUuid(data.id);
  const projectId = normalizeUuid(data.projectId);
  const stateId = data.stateId === null ? null : normalizeUuid(data.stateId);
  const name = text(data.name);
  const description = data.description;
  if (
    !id
    || !projectId
    || data.reference !== canonical
    || data.workspace !== source.workspace
    || data.identifier !== identifier
    || data.sequenceId !== source.sequenceId
    || !name
    || typeof description !== "string"
    || (data.stateId !== null && stateId === null)
  ) return null;

  const content = JSON.stringify({ name, description, state: stateId, reference: canonical });
  if (Buffer.byteLength(content, "utf8") > PLANE_SOURCE_CONTENT_MAXIMUM_BYTES) return null;

  return {
    key: canonical,
    title: name,
    content,
    references: [`Plane:${source.workspace}:${identifier}`],
  };
};

async function sourcePayload(
  source: ContextSource,
  root: string,
  deps: Required<IntegrationDependencies>,
  signal?: AbortSignal,
  lifecycle?: LifecycleIntegrationDependencies,
  expectedPinnedLifecycle: LifecycleProviderPin | null = null,
): Promise<unknown> {
  throwIfAborted(signal);
  if (source.type === "text") {
    return { key: source.title, title: source.title, content: source.content, references: [] };
  }
  if (source.type === "jira") {
    const helper = join(deps.home(), ".agents", "skills", "mcp-atlassian", "scripts", "atlassian-api.mjs");
    const result = await deps.run("node", [helper, "jira:get", source.key], signal);
    throwIfAborted(signal);
    const data = object(result);
    return data
      ? {
        key: source.key,
        title: text(data.summary) || source.key,
        content: text(data.descriptionText) || text(data.summary),
        references: ["https://flccc.atlassian.net/browse/" + source.key],
      }
      : null;
  }
  if (source.type === "taskwarrior") {
    const result = await deps.run("task", ["rc.verbose=nothing", `project:${source.project}`, source.uuid, "export"], signal);
    throwIfAborted(signal);
    const resultObject = object(result);
    const tasks = Array.isArray(result) ? result : (Array.isArray(resultObject?.data) ? resultObject.data : []);
    const matches = tasks.filter((item) => object(item)?.uuid === source.uuid && object(item)?.project === source.project);
    const value = object(matches.length === 1 ? matches[0] : null);
    return value
      ? {
        key: source.uuid,
        title: text(value.description),
        content: JSON.stringify({
          description: value.description,
          status: value.status,
          tags: value.tags,
          depends: value.depends,
          annotations: value.annotations,
        }),
        references: [`Taskwarrior:${source.project}:${source.uuid}`],
      }
      : null;
  }
  if (source.type === "plane") {
    const canonical = `plane:${source.workspace}:${source.project}-${source.sequenceId}`;
    const helper = join(
      packageRoot,
      "skills",
      "plane-api",
      "scripts",
      "plane-api.mjs",
    );
    const response = object(await deps.run("node", [helper, "plane:get", canonical], signal));
    throwIfAborted(signal);
    return response?.success === true
      ? normalizePlaneResponse(source, response.data)
      : null;
  }
  if (source.type === "lifecycle") {
    const pinned = await readPinnedLifecycleSourceAnchor({
      lifecycleKey: source.key,
      cwd: root,
      supplied: lifecycle ?? deps,
      signal,
    });
    if (expectedPinnedLifecycle) {
      const verified = pinned.status === "verified" ? pinned : null;
      if (!verified || !sameLifecycleProviderPin(verified.pin, expectedPinnedLifecycle)) return null;
    }
    if (pinned.status === "verified") {
      return {
        key: source.key,
        title: `Lifecycle ${source.key}`,
        content: pinned.record.artifact,
        references: [
          `Lifecycle:${source.key}`,
          `LifecycleProvider:${pinned.record.provider}`,
          `LifecycleRecordKey:${pinned.record.recordKey}`,
        ],
      };
    }
    if (pinned.status !== "absent") return null;
    const recalled = await deps.corpus.recallInstitutional({
      lifecycleKey: source.key,
      limit: INSTITUTIONAL_RECALL_LIMIT,
    }, signal);
    throwIfAborted(signal);
    if (!recalled.success) return null;

    for (const summary of recalled.data) {
      const full = await deps.corpus.getInstitutional(summary.recordKey, signal);
      throwIfAborted(signal);
      if (!full.success) return null;
      const artifact = normalizeCorpusLifecycleRecord({
        lifecycleKey: source.key,
        record: full.data,
      });
      if (!artifact) continue;
      return {
        key: source.key,
        title: `Lifecycle ${source.key}`,
        content: artifact.content,
        references: [`Qdrant:${artifact.id}`, `QdrantRecordKey:${artifact.recordKey}`],
      };
    }
    return null;
  }
  if (source.type === "vestige") {
    try {
      const value = await deps.session("vestige", (call) => call(
        "memory",
        { action: "get", id: source.id },
        VESTIGE_TIMEOUT,
      ), signal);
      throwIfAborted(signal);
      const structured = directStructured(value);
      const content = text(object(structured?.node)?.content);
      return structured?.found === true && content
        ? { key: source.id, title: `Vestige ${source.id}`, content, references: [`Vestige:${source.id}`] }
        : null;
    } catch {
      throwIfAborted(signal);
      return null;
    }
  }
  if (source.type !== "file") return null;

  const lexical = resolve(root, source.path);
  if (!inside(root, lexical)) throw new Error("source_path_outside_project");
  const actual = await deps.canonical(lexical);
  throwIfAborted(signal);
  if (!inside(root, actual)) throw new Error("source_path_outside_project");
  const info = await deps.stat(actual);
  throwIfAborted(signal);
  if (!info.isFile()) throw new Error("source_file_unreadable");
  if (info.size > 256 * 1024) throw new Error("source_file_too_large");
  const content = await deps.read(actual);
  throwIfAborted(signal);
  if (content.includes("\0")) throw new Error("source_file_unreadable");
  return { key: source.path, title: source.path, content, references: [`File:${source.path}`] };
}

export async function coordinateContext(
  request: unknown,
  cwd: string,
  supplied?: LifecycleIntegrationDependencies,
  signal?: AbortSignal,
) {
  const valid = validateContextRequest(request);
  if (!valid.valid) return { status: "failed", error: valid.error };

  throwIfAborted(signal);
  const deps = depsFor(supplied);
  const root = await deps.canonical(cwd);
  throwIfAborted(signal);
  let expectedPinnedLifecycle: LifecycleProviderPin | null = null;
  if (valid.source.type === "lifecycle") {
    const pinned = await readPinnedLifecycleSourceAnchor({
      lifecycleKey: valid.source.key,
      cwd: root,
      supplied,
      signal,
    });
    throwIfAborted(signal);
    if (pinned.status === "verified") {
      expectedPinnedLifecycle = structuredClone(pinned.pin);
      if (pinned.record.provider !== "serena") {
        const source = normalizeSourcePayload({
          source: valid.source,
          payload: {
            key: valid.source.key,
            title: `Lifecycle ${valid.source.key}`,
            content: pinned.record.artifact,
            references: [
              `Lifecycle:${valid.source.key}`,
              `LifecycleProvider:${pinned.record.provider}`,
              `LifecycleRecordKey:${pinned.record.recordKey}`,
            ],
          },
        });
        return derivePhaseContext({
          cwd: root,
          serenaProjectPath: root,
          source,
          serena: evaluateSerenaBootstrap({
            activated: false,
            instructionsLoaded: false,
            memoryListLoaded: false,
          }),
          allowSerenaFailure: Boolean(source),
          diagnostics: [{
            code: "lifecycle_pinned_provider_context",
            stage: "lifecycle",
            message: "Lifecycle hydration used the pinned provider.",
          }],
        });
      }
    } else if (pinned.status !== "absent") {
      return derivePhaseContext({
        cwd: root,
        serenaProjectPath: root,
        source: null,
        serena: evaluateSerenaBootstrap({
          activated: false,
          instructionsLoaded: false,
          memoryListLoaded: false,
        }),
        diagnostics: [{
          code: "pinned_provider_unavailable",
          stage: "lifecycle",
          message: "Pinned lifecycle provider could not verify authoritative evidence.",
        }],
      });
    }
  }
  const setup = await serena(root, deps, signal);
  throwIfAborted(signal);
  if (setup.blocking) {
    try {
      const payload = await sourcePayload(
        valid.source,
        root,
        deps,
        signal,
        supplied,
        expectedPinnedLifecycle,
      );
      throwIfAborted(signal);
      const source = normalizeSourcePayload({ source: valid.source, payload });
      return derivePhaseContext({
        cwd: root,
        serenaProjectPath: root,
        source,
        serena: setup.bootstrap,
        allowSerenaFailure: Boolean(source),
        diagnostics: [{ code: setup.blocking, stage: "serena", message: "Serena bootstrap did not complete." }],
      });
    } catch (error) {
      throwIfAborted(signal);
      return derivePhaseContext({
        cwd: root,
        serenaProjectPath: root,
        source: null,
        serena: setup.bootstrap,
        diagnostics: [{ code: sourceErrorCode(error), stage: "source", message: "Source hydration failed." }],
      });
    }
  }

  try {
    const payload = await sourcePayload(
      valid.source,
      root,
      deps,
      signal,
      supplied,
      expectedPinnedLifecycle,
    );
    throwIfAborted(signal);
    const source = normalizeSourcePayload({ source: valid.source, payload });
    const durableKnowledge = valid.durableKnowledge
      ? await loadDurableKnowledge(valid.durableKnowledge, deps, signal)
      : undefined;
    throwIfAborted(signal);
    return derivePhaseContext({
      cwd: root,
      serenaProjectPath: root,
      source,
      serena: setup.bootstrap,
      durableKnowledge,
      diagnostics: source
        ? []
        : [{ code: "source_boundary_unavailable", stage: "source", message: "Source hydration did not return usable content." }],
    });
  } catch (error) {
    throwIfAborted(signal);
    return derivePhaseContext({
      cwd: root,
      serenaProjectPath: root,
      source: null,
      serena: setup.bootstrap,
      diagnostics: [{ code: sourceErrorCode(error), stage: "source", message: "Source hydration failed." }],
    });
  }
}

const coordinateQdrantLifecycle = async (
  request: unknown,
  supplied?: IntegrationDependencies,
  signal?: AbortSignal,
) => {
  const valid = validateLifecycleWriteRequest(request);
  if (!valid.valid) {
    return {
      status: "failed",
      artifactId: null,
      recordKey: null,
      error: valid.error,
    };
  }

  throwIfAborted(signal);
  const deps = depsFor(supplied);
  const preparation = prepareLifecycleArtifact(valid);
  const emptyRecall = evaluateLifecycleArtifact({
    artifact: null,
    lifecycleKey: valid.identity.lifecycleKey,
    nonce: "",
    type: valid.type,
    jiraKey: valid.identity.jiraKey,
    taskwarriorUuid: valid.identity.taskwarriorUuid,
    planeWorkspace: valid.identity.planeWorkspace,
    planeWorkItem: valid.identity.planeWorkItem,
  });
  const initialWrite = validateInitialLifecycleWriteRequest(valid);
  if (!initialWrite.valid) {
    return deriveLifecycleResult({
      type: valid.type,
      lifecycleKey: valid.identity.lifecycleKey,
      recordKey: null,
      receipt: { accepted: false, artifactId: null },
      recall: emptyRecall,
      error: initialWrite.code,
    });
  }
  if (!preparation.valid) {
    return deriveLifecycleResult({
      type: valid.type,
      lifecycleKey: valid.identity.lifecycleKey,
      recordKey: null,
      receipt: { accepted: false, artifactId: null },
      recall: emptyRecall,
      error: preparation.error.code,
    });
  }

  const { nonce, artifact, recordKey } = preparation.data;
  const verification = {
    lifecycleKey: valid.identity.lifecycleKey,
    nonce,
    type: valid.type,
    jiraKey: valid.identity.jiraKey,
    taskwarriorUuid: valid.identity.taskwarriorUuid,
    planeWorkspace: valid.identity.planeWorkspace,
    planeWorkItem: valid.identity.planeWorkItem,
  };
  let stored;
  try {
    stored = await storeInstitutionalManifest({
      record: {
        recordKey,
        project: valid.identity.project,
        site: "",
        repo: "ima-pi",
        lifecycleKey: valid.identity.lifecycleKey,
        phase: valid.type,
        summary: valid.summary,
        detail: artifact,
        sourceRefs: valid.identity.sourceRefs,
      },
      createdAt: deps.now().toISOString(),
      operations: deps.corpus,
      signal,
    });
    throwIfAborted(signal);
  } catch {
    throwIfAborted(signal);
    return deriveLifecycleResult({
      type: valid.type,
      lifecycleKey: valid.identity.lifecycleKey,
      recordKey: null,
      receipt: { accepted: false, artifactId: null },
      recall: emptyRecall,
      error: "corpus_store_failed",
    });
  }

  const receipt = stored.success
    ? validateLifecycleStoreReceipt(stored.data)
    : { accepted: false, artifactId: null };
  if (!stored.success || !receipt.accepted || !receipt.artifactId) {
    return deriveLifecycleResult({
      type: valid.type,
      lifecycleKey: valid.identity.lifecycleKey,
      recordKey: null,
      receipt,
      recall: emptyRecall,
      error: stored.success ? "corpus_receipt_invalid" : stored.error.code,
    });
  }

  let recalled;
  try {
    recalled = await deps.corpus.getInstitutional(recordKey, signal);
    throwIfAborted(signal);
  } catch {
    throwIfAborted(signal);
    return deriveLifecycleResult({
      type: valid.type,
      lifecycleKey: valid.identity.lifecycleKey,
      recordKey,
      receipt,
      recall: emptyRecall,
      error: "corpus_recall_failed",
    });
  }
  if (!recalled.success) {
    return deriveLifecycleResult({
      type: valid.type,
      lifecycleKey: valid.identity.lifecycleKey,
      recordKey,
      receipt,
      recall: emptyRecall,
      error: recalled.error.code,
    });
  }

  return deriveLifecycleResult({
    type: valid.type,
    lifecycleKey: valid.identity.lifecycleKey,
    recordKey,
    receipt,
    recall: evaluateLifecycleArtifact({ artifact: recalled.data.detail, ...verification }),
  });
};

const LIFECYCLE_REQUEST_FIELDS = ["type", "identity", "summary", "artifact", "provider", "pinAttemptId"] as const;

const lifecycleRequestEnvelope = (value: unknown): {
  request: ValidLifecycleRequest;
  provider: LifecycleProviderName | null;
  pinAttemptId: string | null;
} | null => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.some((key) => typeof key !== "string")
      || ![4, 5, 6].includes(keys.length)
      || !["type", "identity", "summary", "artifact"].every((key) => keys.includes(key))
      || keys.some((key) => !LIFECYCLE_REQUEST_FIELDS.includes(key as typeof LIFECYCLE_REQUEST_FIELDS[number]))
      || keys.some((key) => {
        const descriptor = descriptors[key as string];
        return !descriptor
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable
          || !Object.hasOwn(descriptor, "value");
      })
    ) return null;
    const request = validateLifecycleWriteRequest({
      type: descriptors.type.value,
      identity: descriptors.identity.value,
      summary: descriptors.summary.value,
      artifact: descriptors.artifact.value,
    });
    if (!request.valid) return null;
    const provider = Object.hasOwn(descriptors, "provider")
      ? normalizeLifecycleProvider(descriptors.provider.value)
      : null;
    const pinAttemptId = Object.hasOwn(descriptors, "pinAttemptId")
      && typeof descriptors.pinAttemptId.value === "string"
      ? descriptors.pinAttemptId.value.toLowerCase()
      : null;
    const validAttemptId = pinAttemptId === null || UUID_PATTERN.test(pinAttemptId);
    return Object.hasOwn(descriptors, "provider") && !provider
      || Object.hasOwn(descriptors, "pinAttemptId") && !validAttemptId
      || pinAttemptId !== null && !provider
      ? null
      : { request, provider, pinAttemptId };
  } catch {
    return null;
  }
};

type BookStackRecoveryEnvelope = {
  request: ValidLifecycleRequest;
  placement: LifecyclePlacement;
  attemptId: string;
};

const bookStackRecoveryEnvelope = (
  value: unknown,
): BookStackRecoveryEnvelope | null => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const fields = ["request", "placement", "attemptId"];
    if (
      keys.some((key) => typeof key !== "string")
      || keys.length !== fields.length
      || !fields.every((field) => keys.includes(field))
      || keys.some((key) => {
        const descriptor = descriptors[key as string];
        return !descriptor
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable
          || !Object.hasOwn(descriptor, "value");
      })
    ) return null;
    const request = validateLifecycleWriteRequest(descriptors.request.value);
    const placement = projectLifecyclePlacement(descriptors.placement.value);
    const attemptId = descriptors.attemptId.value;
    if (
      !request.valid
      || !placement
      || typeof attemptId !== "string"
      || !PIN_ATTEMPT_ID_PATTERN.test(attemptId)
      || !placementMatchesRequest(placement, request)
    ) return null;
    return { request, placement, attemptId: attemptId.toLowerCase() };
  } catch {
    return null;
  }
};

const lifecycleCode = (value: unknown, fallback: string) =>
  typeof value === "string" && /^[a-z][a-z0-9_:-]{0,127}$/.test(value)
    ? value
    : fallback;

const routedRecord = (input: {
  provider: LifecycleProviderName;
  value: unknown;
  reference: unknown;
  recordKey?: unknown;
  lifecycleKey?: unknown;
  phase?: unknown;
  summary?: unknown;
  artifact?: unknown;
  createdAt?: unknown;
}): RoutedLifecycleRecord | null => {
  const value = object(input.value);
  const artifactId = normalizeUuid(value?.artifactId);
  const recordKey = normalizeLifecycleRecordKey(input.recordKey ?? value?.recordKey);
  const lifecycleKey = text(input.lifecycleKey ?? value?.lifecycleKey);
  const phase = input.phase ?? value?.phase;
  const summaryValue = input.summary ?? value?.summary;
  const summary = typeof summaryValue === "string" ? summaryValue.trim() : "";
  const artifactValue = input.artifact ?? value?.artifact;
  const artifact = typeof artifactValue === "string" ? artifactValue : "";
  const reference = input.reference && typeof input.reference === "object"
    ? input.reference as Record<string, unknown>
    : null;
  const createdAtValue = input.createdAt ?? value?.createdAt;
  const createdAt = typeof createdAtValue === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(createdAtValue)
    && !Number.isNaN(Date.parse(createdAtValue))
    ? createdAtValue
    : null;
  if (
    !artifactId
    || !recordKey
    || recordKey !== (input.recordKey ?? value?.recordKey)
    || !lifecycleKey
    || typeof phase !== "string"
    || !LIFECYCLE_PHASE_SET.has(phase)
    || !summary
    || !artifact
    || !reference
  ) return null;
  return {
    provider: input.provider,
    artifactId,
    recordKey,
    lifecycleKey,
    phase: phase as LifecyclePhase,
    summary,
    artifact,
    reference,
    createdAt,
  };
};

const blockedPersist = (
  provider: LifecycleProviderName,
  value: unknown,
  writeState: "no-write" | "possible-write" = "possible-write",
): RoutedLifecyclePersistResult => ({
  status: "blocked",
  provider,
  code: lifecycleCode(object(value)?.code, "lifecycle_provider_operation_failed"),
  writeState,
});

const qdrantLifecycleAdapter = (
  corpus: QdrantCorpusClient,
): LifecycleRoutingAdapter => {
  const provider = createQdrantLifecycleProvider({ client: corpus });
  const persist = async (request: ValidLifecycleRequest, signal?: AbortSignal): Promise<RoutedLifecyclePersistResult> => {
    const result = await provider.persist(projectLifecyclePersistenceRequest(request), signal);
    if (result.status !== "verified") return blockedPersist("qdrant", result);
    const record = routedRecord({
      provider: "qdrant",
      value: result,
      reference: result.reference,
    });
    return record ? { status: "verified", record } : blockedPersist("qdrant", null);
  };
  const read = async (reference: Record<string, unknown>, signal?: AbortSignal): Promise<RoutedLifecyclePersistResult> => {
    const result = await provider.get(reference, signal);
    if (result.status !== "verified") return blockedPersist("qdrant", result, "no-write");
    const record = routedRecord({ provider: "qdrant", value: result, reference: result.reference });
    return record ? { status: "verified", record } : blockedPersist("qdrant", null, "no-write");
  };
  return {
    provider: "qdrant",
    persist,
    get: read,
    reconcile: async (reference, signal) => {
      const result = await provider.reconcile(reference, signal);
      if (result.status !== "verified") return blockedPersist("qdrant", result, "no-write");
      const record = routedRecord({ provider: "qdrant", value: result, reference: result.reference });
      return record ? { status: "verified", record } : blockedPersist("qdrant", null, "no-write");
    },
    recall: async (selection, signal) => {
      const result = await provider.recall({
        lifecycleKey: selection.lifecycleKey,
        ...(selection.phase ? { phase: selection.phase } : {}),
        limit: selection.limit,
      }, signal);
      if (!Array.isArray(result)) {
        return { status: "blocked", provider: "qdrant", code: lifecycleCode(result?.code, "lifecycle_provider_recall_failed") };
      }
      const records = result.map((item) => routedRecord({
        provider: "qdrant",
        value: item,
        reference: item.reference,
      }));
      return records.some((record) => record === null)
        ? { status: "blocked", provider: "qdrant", code: "lifecycle_provider_record_projection_invalid" }
        : { status: "verified", provider: "qdrant", records: records as RoutedLifecycleRecord[] };
    },
  };
};

const bookStackSourceReference = (request: ValidLifecycleRequest): string | null => {
  const identity = request.identity;
  const matches = identity.sourceRefs.filter((reference) => {
    if (identity.jiraKey) return new RegExp(`^jira:${identity.jiraKey}$`, "i").test(reference);
    if (identity.taskwarriorUuid) {
      return new RegExp(`^taskwarrior:${identity.taskwarriorProject}:${identity.taskwarriorUuid}$`, "i").test(reference);
    }
    if (identity.planeWorkspace && identity.planeWorkItem) {
      return new RegExp(`^plane:${identity.planeWorkspace}:${identity.planeWorkItem}$`, "i").test(reference);
    }
    return reference === `lifecycle:${identity.lifecycleKey}`;
  });
  return matches.length === 1 ? matches[0] : null;
};

const bookStackLifecycleProviderFor = (input: {
  environment: Record<string, string | undefined>;
  client?: BookStackLifecycleClient;
  confirmPlacement?: LifecycleRoutingOptions["confirmBookStackPlacement"];
  signal?: AbortSignal;
}) => {
  try {
    const client = input.client ?? createBookStackLifecycleClient({
      origin: resolveBookStackOrigin(input.environment),
      tokenId: input.environment.BOOKSTACK_TOKEN_ID ?? "",
      tokenSecret: input.environment.BOOKSTACK_TOKEN_SECRET ?? "",
      signal: input.signal,
    });
    return createBookStackLifecycleProvider({
      client,
      approvePlacement: async (preview) => {
        try {
          return await input.confirmPlacement?.(structuredClone(preview)) === true;
        } catch {
          return false;
        }
      },
    });
  } catch {
    return null;
  }
};

const bookStackLifecycleAdapter = (input: {
  environment: Record<string, string | undefined>;
  client?: BookStackLifecycleClient;
  confirmPlacement?: LifecycleRoutingOptions["confirmBookStackPlacement"];
  signal?: AbortSignal;
}): LifecycleRoutingAdapter | null => {
  const provider = bookStackLifecycleProviderFor(input);
  if (!provider) return null;
  const persistAtPlacement = async (
    request: ValidLifecycleRequest,
    placement: LifecyclePlacement,
    signal?: AbortSignal,
    placementWasReadOnly = true,
  ): Promise<RoutedLifecyclePersistResult> => {
    const result = await provider.persist({
      request: projectLifecyclePersistenceRequest(request),
      placement,
    }, signal);
    if (result.status !== "verified") {
      return blockedPersist(
        "bookstack",
        result,
        placementWasReadOnly && bookStackLifecycleResultIsNoWrite(result)
          ? "no-write"
          : "possible-write",
      );
    }
    const record = routedRecord({
      provider: "bookstack",
      value: result,
      reference: result.locator,
      lifecycleKey: request.identity.lifecycleKey,
      phase: request.type,
      summary: request.summary,
      artifact: result.artifact,
      createdAt: null,
    });
    return record ? { status: "verified", record } : blockedPersist("bookstack", null);
  };
  const persist = async (request: ValidLifecycleRequest, signal?: AbortSignal): Promise<RoutedLifecyclePersistResult> => {
    if (signal?.aborted) return blockedPersist("bookstack", { code: "aborted" }, "no-write");
    const sourceRef = bookStackSourceReference(request);
    if (!sourceRef) return blockedPersist("bookstack", { code: "bookstack_placement_invalid" }, "no-write");
    const location = {
      projectSlug: request.identity.project,
      sourceRef,
      lifecycleKey: request.identity.lifecycleKey,
    };
    const placement = await provider.ensurePlacement(location, signal);
    if (placement.status !== "verified") return blockedPersist("bookstack", placement);
    const placementWasReadOnly = placement.preview.creates.length === 0;
    if (signal?.aborted) {
      return blockedPersist(
        "bookstack",
        { code: "aborted" },
        placementWasReadOnly ? "no-write" : "possible-write",
      );
    }
    return persistAtPlacement(request, placement.placement, signal, placementWasReadOnly);
  };
  const persistPinned = async (
    request: ValidLifecycleRequest,
    initialReference: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<RoutedLifecyclePersistResult> => {
    if (signal?.aborted) return blockedPersist("bookstack", { code: "aborted" }, "no-write");
    const verifiedPlacement = projectLifecyclePlacement({
      projectSlug: initialReference.projectSlug,
      sourceRef: initialReference.sourceRef,
      lifecycleKey: initialReference.lifecycleKey,
      shelfId: initialReference.shelfId,
      shelfSlug: initialReference.shelfSlug,
      bookId: initialReference.bookId,
      bookSlug: initialReference.bookSlug,
      chapterId: initialReference.chapterId,
      chapterSlug: initialReference.chapterSlug,
    });
    if (!verifiedPlacement || !placementMatchesRequest(verifiedPlacement, request)) {
      return blockedPersist("bookstack", { code: "bookstack_placement_invalid" }, "no-write");
    }
    return persistAtPlacement(request, verifiedPlacement, signal);
  };
  const read = async (reference: Record<string, unknown>, signal?: AbortSignal): Promise<RoutedLifecyclePersistResult> => {
    if (signal?.aborted) return blockedPersist("bookstack", { code: "aborted" }, "no-write");
    const result = await provider.get(reference, signal);
    if (signal?.aborted) return blockedPersist("bookstack", { code: "aborted" }, "no-write");
    if (result.status !== "verified") return blockedPersist("bookstack", result, "no-write");
    const record = routedRecord({ provider: "bookstack", value: result, reference: result.locator, createdAt: null });
    return record ? { status: "verified", record } : blockedPersist("bookstack", null, "no-write");
  };
  return {
    provider: "bookstack",
    persist,
    persistPinned,
    get: read,
    reconcile: read,
    recall: async (selection, signal) => {
      if (signal?.aborted || !selection.reference) {
        return { status: "blocked", provider: "bookstack", code: signal?.aborted ? "aborted" : "pinned_provider_reference_missing" };
      }
      const initial = await provider.get(selection.reference, signal);
      if (signal?.aborted) {
        return { status: "blocked", provider: "bookstack", code: "aborted" };
      }
      if (initial.status !== "verified") {
        return { status: "blocked", provider: "bookstack", code: lifecycleCode(initial.code, "pinned_provider_failed") };
      }
      const result = await provider.recall({
        placement: projectBookStackRecoveryPlacement(initial.locator),
        lifecycleKey: selection.lifecycleKey,
        sourceRef: initial.locator.sourceRef,
        ...(selection.phase ? { phase: selection.phase } : {}),
      }, signal);
      if (signal?.aborted) {
        return { status: "blocked", provider: "bookstack", code: "aborted" };
      }
      if (!Array.isArray(result)) {
        return { status: "blocked", provider: "bookstack", code: lifecycleCode(result.code, "lifecycle_provider_recall_failed") };
      }
      if (result.length > selection.limit) {
        return { status: "blocked", provider: "bookstack", code: "lifecycle_provider_recall_overflow" };
      }
      const records = result.map((record) => routedRecord({
        provider: "bookstack",
        value: record,
        reference: record.locator,
        createdAt: null,
      }));
      return records.some((record) => record === null)
        ? { status: "blocked", provider: "bookstack", code: "lifecycle_provider_record_projection_invalid" }
        : { status: "verified", provider: "bookstack", records: records as RoutedLifecycleRecord[] };
    },
  };
};

const markdownLifecycleAdapter = (checkoutRoot: string): LifecycleRoutingAdapter => {
  const provider = createMarkdownLifecycleAdapter({ checkoutRoot });
  const persist = async (request: ValidLifecycleRequest, signal?: AbortSignal): Promise<RoutedLifecyclePersistResult> => {
    const prepared = prepareLifecycleArtifact(request);
    if (!prepared.valid) return blockedPersist("markdown", { code: prepared.error.code }, "no-write");
    const result = await provider.persist({
      schemaVersion: 1,
      phase: request.type,
      identity: request.identity,
      summary: request.summary,
      artifact: prepared.data.artifact,
      expectedHash: createHash("sha256").update(prepared.data.artifact, "utf8").digest("hex"),
    }, signal);
    if (result.status !== "verified") return blockedPersist("markdown", result);
    const record = routedRecord({
      provider: "markdown",
      value: result,
      reference: result.reference,
      recordKey: prepared.data.recordKey,
      createdAt: null,
    });
    return record ? { status: "verified", record } : blockedPersist("markdown", null);
  };
  const read = async (reference: Record<string, unknown>, signal?: AbortSignal): Promise<RoutedLifecyclePersistResult> => {
    const result = await provider.get(reference, signal);
    if (result.status !== "verified") return blockedPersist("markdown", result, "no-write");
    const recordKey = `${result.lifecycleKey}:${result.phase}:${createHash("sha256").update(result.artifact, "utf8").digest("hex").slice(0, 12)}`;
    const record = routedRecord({ provider: "markdown", value: result, reference: result.reference, recordKey, createdAt: null });
    return record ? { status: "verified", record } : blockedPersist("markdown", null, "no-write");
  };
  return {
    provider: "markdown",
    persist,
    get: read,
    reconcile: read,
    recall: async (selection, signal) => {
      const result = await provider.recall({
        lifecycleKey: selection.lifecycleKey,
        ...(selection.phase ? { phase: selection.phase } : {}),
        limit: selection.limit,
      }, signal);
      if (!Array.isArray(result)) {
        return { status: "blocked", provider: "markdown", code: lifecycleCode(result.code, "lifecycle_provider_recall_failed") };
      }
      const records = result.map((item) => {
        const recordKey = `${item.lifecycleKey}:${item.phase}:${createHash("sha256").update(item.artifact, "utf8").digest("hex").slice(0, 12)}`;
        return routedRecord({ provider: "markdown", value: item, reference: item.reference, recordKey, createdAt: null });
      });
      return records.some((record) => record === null)
        ? { status: "blocked", provider: "markdown", code: "lifecycle_provider_record_projection_invalid" }
        : { status: "verified", provider: "markdown", records: records as RoutedLifecycleRecord[] };
    },
  };
};

const serenaProject = async (
  checkoutRoot: string,
  deps: ReturnType<typeof depsFor>,
) => {
  try {
    const source = await deps.read(join(checkoutRoot, ".serena", "project.yml"));
    const document = parseDocument(source, { uniqueKeys: true, prettyErrors: false });
    const data = object(document.toJS({ maxAliasCount: 0 }));
    return document.errors.length === 0
      ? createSerenaLifecycleProject({ projectName: data?.project_name, projectPath: checkoutRoot })
      : null;
  } catch {
    return null;
  }
};

type SerenaLifecycleProviderResolution<Result> =
  | { success: true; result: Result }
  | { success: false; code: string };

const serenaLifecycleAdapter = (
  checkoutRoot: string,
  deps: ReturnType<typeof depsFor>,
): LifecycleRoutingAdapter => {
  const withProvider = async <Result>(
    signal: AbortSignal | undefined,
    operation: (provider: ReturnType<typeof createSerenaLifecycleProvider>) => Promise<Result>,
  ): Promise<SerenaLifecycleProviderResolution<Result>> => {
    const project = await serenaProject(checkoutRoot, deps);
    if (!project) return { success: false, code: "serena_project_unavailable" };
    if (signal?.aborted) return { success: false, code: "aborted" };

    try {
      const scoped = await deps.session("serena", async (call, listTools) => {
        const resolved = await resolveSerenaMcpSession(call, listTools, signal);
        if (!resolved.success) return resolved;
        if (!resolved.session.capabilities.lifecycleSupported) {
          return { success: false as const, code: "serena_protocol_unsupported" };
        }
        return {
          success: true as const,
          result: await operation(createSerenaLifecycleProvider({
            project,
            client: createSerenaLifecycleClient({
              call,
              project,
              mcpSession: resolved.session,
            }),
          })),
        };
      }, signal);
      return scoped ?? { success: false, code: "serena_project_unavailable" };
    } catch {
      throwIfAborted(signal);
      return { success: false, code: "serena_project_unavailable" };
    }
  };
  const persist = async (request: ValidLifecycleRequest, signal?: AbortSignal): Promise<RoutedLifecyclePersistResult> => {
    const scoped = await withProvider(
      signal,
      (provider) => provider.persist(projectLifecyclePersistenceRequest(request), signal),
    );
    if (!scoped.success) return blockedPersist("serena", { code: scoped.code }, "no-write");
    const result = scoped.result;
    if (result.status !== "verified") return blockedPersist("serena", result);
    const record = routedRecord({ provider: "serena", value: result, reference: result.reference });
    return record ? { status: "verified", record } : blockedPersist("serena", null);
  };
  const read = async (reference: Record<string, unknown>, signal?: AbortSignal): Promise<RoutedLifecyclePersistResult> => {
    const scoped = await withProvider(signal, (provider) => provider.get(reference, signal));
    if (!scoped.success) return blockedPersist("serena", { code: scoped.code }, "no-write");
    const result = scoped.result;
    if (result.status !== "verified") return blockedPersist("serena", result, "no-write");
    const record = routedRecord({ provider: "serena", value: result, reference: result.reference });
    return record ? { status: "verified", record } : blockedPersist("serena", null, "no-write");
  };
  return {
    provider: "serena",
    persist,
    get: read,
    reconcile: async (reference, signal) => {
      const scoped = await withProvider(signal, (provider) => provider.reconcile(reference, signal));
      if (!scoped.success) return blockedPersist("serena", { code: scoped.code }, "no-write");
      const result = scoped.result;
      if (result.status !== "verified") return blockedPersist("serena", result, "no-write");
      const record = routedRecord({ provider: "serena", value: result, reference: result.reference });
      return record ? { status: "verified", record } : blockedPersist("serena", null, "no-write");
    },
    recall: async (selection, signal) => {
      const scoped = await withProvider(signal, (provider) => provider.recall({
        lifecycleKey: selection.lifecycleKey,
        ...(selection.phase ? { phase: selection.phase } : {}),
        limit: selection.limit,
      }, signal));
      if (!scoped.success) return { status: "blocked", provider: "serena", code: scoped.code };
      const result = scoped.result;
      if (!Array.isArray(result)) {
        return { status: "blocked", provider: "serena", code: lifecycleCode(result.code, "lifecycle_provider_recall_failed") };
      }
      const records = result.map((item) => routedRecord({ provider: "serena", value: item, reference: item.reference }));
      return records.some((record) => record === null)
        ? { status: "blocked", provider: "serena", code: "lifecycle_provider_record_projection_invalid" }
        : { status: "verified", provider: "serena", records: records as RoutedLifecycleRecord[] };
    },
  };
};

const lifecycleRouting = (input: {
  checkoutRoot: string;
  dependencies: ReturnType<typeof depsFor>;
  bookStackLifecycleClient?: BookStackLifecycleClient;
  confirmBookStackPlacement?: LifecycleRoutingOptions["confirmBookStackPlacement"];
  environment?: Record<string, string | undefined>;
}) => {
  const bookstack = bookStackLifecycleAdapter({
    environment: input.environment ?? process.env,
    client: input.bookStackLifecycleClient,
    confirmPlacement: input.confirmBookStackPlacement,
  });
  return createLifecycleRouting([
    ...(bookstack ? [bookstack] : []),
    qdrantLifecycleAdapter(input.dependencies.corpus),
    serenaLifecycleAdapter(input.checkoutRoot, input.dependencies),
    markdownLifecycleAdapter(input.checkoutRoot),
  ]);
};

const lifecycleReadRouting = (input: {
  provider: LifecycleProviderName;
  checkoutRoot: string;
  dependencies: ReturnType<typeof depsFor>;
  bookStackLifecycleClient?: BookStackLifecycleClient;
  environment?: Record<string, string | undefined>;
  signal?: AbortSignal;
}): ReturnType<typeof createLifecycleRouting> => {
  const adapter = input.provider === "qdrant"
    ? qdrantLifecycleAdapter(input.dependencies.corpus)
    : input.provider === "bookstack"
      ? bookStackLifecycleAdapter({
        environment: input.environment ?? process.env,
        client: input.bookStackLifecycleClient,
        signal: input.signal,
      })
      : input.provider === "serena"
        ? serenaLifecycleAdapter(input.checkoutRoot, input.dependencies)
        : markdownLifecycleAdapter(input.checkoutRoot);
  return createLifecycleRouting(adapter ? [adapter] : []);
};

const lifecycleVerification = (request: ValidLifecycleRequest, artifact: string, nonce: string) =>
  evaluateLifecycleArtifact({
    artifact,
    lifecycleKey: request.identity.lifecycleKey,
    nonce,
    type: request.type,
    jiraKey: request.identity.jiraKey,
    taskwarriorUuid: request.identity.taskwarriorUuid,
    planeWorkspace: request.identity.planeWorkspace,
    planeWorkItem: request.identity.planeWorkItem,
  });

const matchesPreparedLifecycleRecord = (input: {
  request: ValidLifecycleRequest;
  prepared: { artifact: string; recordKey: string };
  record: RoutedLifecycleRecord;
}) => input.record.lifecycleKey === input.request.identity.lifecycleKey
  && input.record.phase === input.request.type
  && input.record.summary === input.request.summary
  && input.record.artifact === input.prepared.artifact
  && input.record.recordKey === input.prepared.recordKey;

const lifecycleRouteResult = (input: {
  request: ValidLifecycleRequest;
  prepared: { nonce: string; artifact: string; recordKey: string };
  provider: LifecycleProviderName;
  result: RoutedLifecyclePersistResult;
  error?: string;
}) => {
  const record = input.result.status === "verified" ? input.result.record : null;
  const exact = record
    && matchesPreparedLifecycleRecord({
      request: input.request,
      prepared: input.prepared,
      record,
    });
  const receipt = exact
    ? { accepted: true, artifactId: record.artifactId }
    : { accepted: false, artifactId: null };
  const recall = exact
    ? lifecycleVerification(input.request, record.artifact, input.prepared.nonce)
    : lifecycleVerification(input.request, "", "");
  const error = input.error
    ?? (input.result.status === "blocked"
      ? input.result.code
      : exact ? undefined : "lifecycle_provider_verification_failed");
  const lifecycleResult = deriveLifecycleResult({
    type: input.request.type,
    lifecycleKey: input.request.identity.lifecycleKey,
    recordKey: exact ? record.recordKey : null,
    receipt,
    recall,
    ...(error ? { error } : {}),
  });
  const unexpectedWarning = input.result.status === "verified" && !exact && record
    ? screenLifecycleContent({ summary: record.summary, artifact: record.artifact })
    : null;
  const unexpectedDiagnostic = unexpectedWarning && unexpectedWarning.tier === "warn"
    ? {
      reason: unexpectedWarning.findings.some(({ field }) => field === "summary")
        ? "record_summary_invalid" as const
        : unexpectedWarning.findings.some(({ category }) => category === "synthetic_bearer")
          ? "record_artifact_secret_bearer_placeholder" as const
          : unexpectedWarning.findings.some(({ category }) =>
            category === "credential_assignment" || category === "ambiguous_assignment")
            ? "record_artifact_secret_named" as const
            : "record_artifact_secret_bearer_value" as const,
      findings: unexpectedWarning.findings,
    }
    : undefined;
  const screeningDiagnostic = input.result.status === "blocked"
    ? input.result.diagnostic
    : unexpectedDiagnostic;
  const possibleWrite = input.result.status === "verified"
    ? !exact
    : input.result.writeState === "possible-write";
  return {
    ...lifecycleResult,
    provider: input.provider,
    ...(possibleWrite ? { writeState: "possible-write" as const } : {}),
    ...(screeningDiagnostic && lifecycleResult.error
      ? {
        error: {
          ...lifecycleResult.error,
          diagnostic: {
            stage: "provider" as const,
            code: "provider_content_screening_failed" as const,
            reason: screeningDiagnostic.reason,
            findings: screeningDiagnostic.findings,
          },
        },
      }
      : {}),
  };
};

const projectLifecyclePersistenceRequest = (request: ValidLifecycleRequest) => ({
  type: request.type,
  identity: {
    project: request.identity.project,
    lifecycleKey: request.identity.lifecycleKey,
    lifecycleRootMemoryId: request.identity.lifecycleRootMemoryId,
    taskwarriorProject: request.identity.taskwarriorProject,
    taskwarriorTask: request.identity.taskwarriorTask,
    taskwarriorUuid: request.identity.taskwarriorUuid,
    jiraKey: request.identity.jiraKey,
    ...(request.identity.planeWorkspace && request.identity.planeWorkItem
      ? {
        planeWorkspace: request.identity.planeWorkspace,
        planeWorkItem: request.identity.planeWorkItem,
      }
      : {}),
    sourceRefs: [...request.identity.sourceRefs],
    priorArtifactIds: [...request.identity.priorArtifactIds],
  },
  summary: request.summary,
  artifact: request.artifact,
});

const lifecycleRequestForRouting = (
  input: {
    request: ValidLifecycleRequest;
    provider: LifecycleProviderName | null;
    pinAttemptId: string | null;
  },
  provider = input.provider,
) => ({
  ...projectLifecyclePersistenceRequest(input.request),
  ...(provider ? { provider } : {}),
  ...(input.pinAttemptId ? { pinAttemptId: input.pinAttemptId } : {}),
});

const sameAuthorizedLifecyclePinAttempt = (
  state: LifecyclePinLoadResult,
  expected: LifecycleProviderPinAttempt,
) => state.status === "pending"
  && state.attempt.status === "authorized"
  && state.attempt.lifecycleKey === expected.lifecycleKey
  && state.attempt.provider === expected.provider
  && state.attempt.attemptId === expected.attemptId
  && state.attempt.startedAt === expected.startedAt;

const lifecyclePinStateFailureCode = (state: LifecyclePinLoadResult) => {
  if (["corrupt", "conflicting", "inaccessible"].includes(state.status)) {
    return `lifecycle_pin_store_${state.status}`;
  }
  return state.status === "pending" && state.attempt.status === "writing"
    ? "lifecycle_pin_write_unresolved"
    : "lifecycle_pin_attempt_conflict";
};

const failedLifecycleRoute = (input: {
  request: ValidLifecycleRequest;
  provider: LifecycleProviderName;
  code: string;
  recommendation?: LifecycleProviderRecommendation;
}) => ({
  ...lifecycleRouteResult({
    request: input.request,
    prepared: prepareLifecycleArtifact(input.request).valid
      ? prepareLifecycleArtifact(input.request).data
      : { nonce: "", artifact: "", recordKey: "" },
    provider: input.provider,
    result: { status: "blocked", provider: input.provider, code: input.code, writeState: "no-write" },
    error: input.code,
  }),
  ...(input.recommendation ? { recommendation: input.recommendation } : {}),
});

export async function coordinateLifecycle(
  requestValue: unknown,
  supplied?: LifecycleIntegrationDependencies,
  signal?: AbortSignal,
) {
  const screening = screenLifecycleContent(requestValue);
  const admitted = consumeLifecycleContentAdmission(
    supplied?.contentScreeningAdmission,
    "write",
  );
  if (screening.tier === "block") {
    return lifecycleContentScreeningFailure("lifecycle_content_blocked", screening);
  }
  if (screening.tier === "warn" && !admitted) {
    return lifecycleContentScreeningFailure("lifecycle_content_adjudication_required", screening);
  }

  const envelope = lifecycleRequestEnvelope(requestValue);
  if (!envelope) return coordinateQdrantLifecycle(requestValue, supplied, signal);
  if (!supplied?.cwd) {
    return coordinateQdrantLifecycle(projectLifecyclePersistenceRequest(envelope.request), supplied, signal);
  }
  if (signal?.aborted) signal.throwIfAborted();

  const dependencies = depsFor(supplied);
  const resolveProjectRoot = supplied.resolveProjectRoot ?? defaultResolveCycleProjectRoot;
  const root = await resolveProjectRoot(supplied.cwd).catch(() => null);
  if (!root || typeof root !== "string") {
    return failedLifecycleRoute({ request: envelope.request, provider: envelope.provider ?? "qdrant", code: "lifecycle_pin_store_inaccessible" });
  }
  const routing = supplied.routing ?? lifecycleRouting({
    checkoutRoot: root,
    dependencies,
    bookStackLifecycleClient: supplied.bookStackLifecycleClient,
    confirmBookStackPlacement: supplied.confirmBookStackPlacement,
    environment: supplied.environment,
  });
  const loadPin = loadLifecyclePinStateWith(resolveProjectRoot);
  const pinState = await loadPin(supplied.cwd, envelope.request.identity.lifecycleKey);
  if (pinState.status === "corrupt" || pinState.status === "conflicting" || pinState.status === "inaccessible") {
    return failedLifecycleRoute({ request: envelope.request, provider: envelope.provider ?? "qdrant", code: `lifecycle_pin_store_${pinState.status}` });
  }
  if (
    pinState.status === "absent"
    || pinState.status === "pending" && pinState.attempt.status === "authorized"
  ) {
    const initialWrite = validateInitialLifecycleWriteRequest(envelope.request);
    if (!initialWrite.valid) {
      return failedLifecycleRoute({
        request: envelope.request,
        provider: envelope.provider ?? "qdrant",
        code: initialWrite.code,
      });
    }
  }
  if (
    pinState.status === "pending"
    && envelope.provider === pinState.attempt.provider
    && envelope.pinAttemptId === pinState.attempt.attemptId
    && pinState.attempt.status === "authorized"
  ) {
    let historical: RoutedLifecycleRecallResult;
    try {
      historical = await qdrantLifecycleAdapter(dependencies.corpus).recall({
        lifecycleKey: envelope.request.identity.lifecycleKey,
        limit: LIFECYCLE_RECALL_LIMIT,
      }, signal);
      throwIfAborted(signal);
    } catch {
      throwIfAborted(signal);
      return failedLifecycleRoute({
        request: envelope.request,
        provider: pinState.attempt.provider,
        code: "lifecycle_provider_recall_failed",
      });
    }
    if (historical.status !== "verified") {
      return failedLifecycleRoute({
        request: envelope.request,
        provider: pinState.attempt.provider,
        code: historical.code,
      });
    }
    const recheckedPinState = await loadPin(supplied.cwd, envelope.request.identity.lifecycleKey);
    throwIfAborted(signal);
    if (!sameAuthorizedLifecyclePinAttempt(recheckedPinState, pinState.attempt)) {
      return failedLifecycleRoute({
        request: envelope.request,
        provider: pinState.attempt.provider,
        code: lifecyclePinStateFailureCode(recheckedPinState),
      });
    }
    if (historical.records.length > 0 && pinState.attempt.provider !== "qdrant") {
      return failedLifecycleRoute({ request: envelope.request, provider: "qdrant", code: "historical_qdrant_authority_conflict" });
    }
    const prepared = prepareLifecycleArtifact(envelope.request);
    if (!prepared.valid) {
      return failedLifecycleRoute({ request: envelope.request, provider: pinState.attempt.provider, code: prepared.error.code });
    }
    const writing = await markLifecyclePinAttemptWritingWith(resolveProjectRoot)(supplied.cwd, pinState.attempt);
    if (writing.status !== "writing") {
      return failedLifecycleRoute({ request: envelope.request, provider: pinState.attempt.provider, code: writing.code });
    }
    const result = await routeLifecyclePersistence({
      routing,
      provider: writing.attempt.provider,
      request: envelope.request,
      allowWarnings: Boolean(admitted),
      signal,
    });
    if (result.status !== "verified") {
      if (result.writeState === "no-write") {
        const abandoned = await abandonLifecyclePinAttemptWith(resolveProjectRoot)(
          supplied.cwd,
          writing.attempt,
        );
        if (abandoned.status !== "cleared") {
          return failedLifecycleRoute({
            request: envelope.request,
            provider: writing.attempt.provider,
            code: abandoned.code,
          });
        }
      }
      return lifecycleRouteResult({
        request: envelope.request,
        prepared: prepared.data,
        provider: writing.attempt.provider,
        result,
      });
    }
    if (!matchesPreparedLifecycleRecord({
      request: envelope.request,
      prepared: prepared.data,
      record: result.record,
    })) {
      return lifecycleRouteResult({ request: envelope.request, prepared: prepared.data, provider: writing.attempt.provider, result });
    }
    const pin = createLifecycleProviderPin({
      lifecycleKey: envelope.request.identity.lifecycleKey,
      provider: writing.attempt.provider,
      initialReference: result.record.reference,
      artifactId: result.record.artifactId,
      recordKey: result.record.recordKey,
      pinnedAt: writing.attempt.startedAt,
    });
    if (!pin) return failedLifecycleRoute({ request: envelope.request, provider: writing.attempt.provider, code: "lifecycle_pin_invalid" });
    const confirmed = await confirmLifecyclePinWith(resolveProjectRoot)(supplied.cwd, writing.attempt, pin);
    return confirmed.status === "pinned"
      ? lifecycleRouteResult({ request: envelope.request, prepared: prepared.data, provider: writing.attempt.provider, result })
      : failedLifecycleRoute({ request: envelope.request, provider: writing.attempt.provider, code: confirmed.code });
  }
  if (pinState.status === "pending") {
    return failedLifecycleRoute({ request: envelope.request, provider: pinState.attempt.provider, code: "lifecycle_pin_write_unresolved" });
  }
  if (pinState.status === "pinned") {
    const prepared = prepareLifecycleArtifact(envelope.request);
    if (!prepared.valid) {
      return failedLifecycleRoute({ request: envelope.request, provider: pinState.pin.provider, code: prepared.error.code });
    }
    if (envelope.provider && envelope.provider !== pinState.pin.provider) {
      return failedLifecycleRoute({ request: envelope.request, provider: pinState.pin.provider, code: "lifecycle_provider_pin_conflict" });
    }
    const result = await routePinnedLifecyclePersistence({
      routing,
      pin: pinState.pin,
      request: envelope.request,
      allowWarnings: Boolean(admitted),
      signal,
    });
    return lifecycleRouteResult({
      request: envelope.request,
      prepared: prepared.data,
      provider: pinState.pin.provider,
      result,
    });
  }

  const historical = await qdrantLifecycleAdapter(dependencies.corpus).recall({
    lifecycleKey: envelope.request.identity.lifecycleKey,
    limit: LIFECYCLE_RECALL_LIMIT,
  }, signal);
  const historicalQdrant = historical.status === "verified" && historical.records.length > 0;
  if (historicalQdrant && envelope.provider && envelope.provider !== "qdrant") {
    return failedLifecycleRoute({
      request: envelope.request,
      provider: "qdrant",
      code: "historical_qdrant_authority_conflict",
    });
  }
  const preferences = {
    ...(supplied.preferences ?? {}),
    ...(envelope.provider ? { session: envelope.provider } : {}),
  };
  const recommendationResult = historicalQdrant
    ? { ok: true as const, recommendation: lifecycleProviderRecommendation("qdrant", "historical-qdrant") }
    : resolveLifecycleProviderRecommendation(preferences);
  if (!recommendationResult.ok) {
    return failedLifecycleRoute({
      request: envelope.request,
      provider: envelope.provider ?? "qdrant",
      code: recommendationResult.code,
    });
  }
  const recommendation = recommendationResult.recommendation;
  const provider = historicalQdrant ? "qdrant" : envelope.provider ?? recommendation.provider;
  let confirmed = false;
  try {
    confirmed = await supplied.confirmProvider?.({ recommendation, provider }) === true;
  } catch {
    confirmed = false;
  }
  if (!confirmed) {
    return failedLifecycleRoute({
      request: envelope.request,
      provider,
      code: "lifecycle_provider_confirmation_required",
      recommendation,
    });
  }

  let now: string;
  try {
    const current = dependencies.now();
    if (!(current instanceof Date) || !Number.isFinite(current.getTime())) {
      return failedLifecycleRoute({ request: envelope.request, provider, code: "lifecycle_pin_time_invalid" });
    }
    now = current.toISOString();
  } catch {
    return failedLifecycleRoute({ request: envelope.request, provider, code: "lifecycle_pin_time_invalid" });
  }
  const attempt = createLifecycleProviderPinAttempt({
    lifecycleKey: envelope.request.identity.lifecycleKey,
    provider,
    attemptId: randomUUID(),
    startedAt: now,
  });
  if (!attempt) return failedLifecycleRoute({ request: envelope.request, provider, code: "lifecycle_pin_attempt_invalid" });
  const begin = await beginLifecyclePinWith(resolveProjectRoot)(supplied.cwd, attempt);
  if (begin.status === "pinned") {
    const prepared = prepareLifecycleArtifact(envelope.request);
    if (!prepared.valid) return failedLifecycleRoute({ request: envelope.request, provider: begin.pin.provider, code: prepared.error.code });
    const result = await routePinnedLifecyclePersistence({
      routing,
      pin: begin.pin,
      request: envelope.request,
      allowWarnings: Boolean(admitted),
      signal,
    });
    return lifecycleRouteResult({ request: envelope.request, prepared: prepared.data, provider: begin.pin.provider, result });
  }
  if (begin.status === "pending") {
    return failedLifecycleRoute({ request: envelope.request, provider: begin.attempt.provider, code: "lifecycle_pin_write_unresolved" });
  }
  if (begin.status === "blocked") return failedLifecycleRoute({ request: envelope.request, provider, code: begin.code });

  const prepared = prepareLifecycleArtifact(envelope.request);
  if (!prepared.valid) {
    await abandonLifecyclePinAttemptWith(resolveProjectRoot)(supplied.cwd, attempt);
    return failedLifecycleRoute({ request: envelope.request, provider, code: prepared.error.code });
  }
  const writing = await markLifecyclePinAttemptWritingWith(resolveProjectRoot)(supplied.cwd, attempt);
  if (writing.status !== "writing") {
    return failedLifecycleRoute({ request: envelope.request, provider, code: writing.code });
  }
  const writeAttempt = writing.attempt;
  const result = await routeLifecyclePersistence({
    routing,
    provider,
    request: envelope.request,
    allowWarnings: Boolean(admitted),
    signal,
  });
  if (result.status !== "verified") {
    if (result.writeState === "no-write") {
      const abandoned = await abandonLifecyclePinAttemptWith(resolveProjectRoot)(supplied.cwd, writeAttempt);
      if (abandoned.status !== "cleared") {
        return failedLifecycleRoute({ request: envelope.request, provider, code: abandoned.code });
      }
      const next = historicalQdrant
        ? undefined
        : recommendation.candidates.find((candidate) =>
          candidate !== provider && routing.adapters[candidate] !== undefined,
        );
      return failedLifecycleRoute({
        request: envelope.request,
        provider,
        code: result.code,
        ...(next ? { recommendation: lifecycleProviderRecommendation(next, recommendation.source) } : {}),
      });
    }
    return lifecycleRouteResult({ request: envelope.request, prepared: prepared.data, provider, result });
  }
  if (!matchesPreparedLifecycleRecord({
    request: envelope.request,
    prepared: prepared.data,
    record: result.record,
  })) {
    return lifecycleRouteResult({ request: envelope.request, prepared: prepared.data, provider, result });
  }
  const pin = createLifecycleProviderPin({
    lifecycleKey: envelope.request.identity.lifecycleKey,
    provider,
    initialReference: result.record.reference,
    artifactId: result.record.artifactId,
    recordKey: result.record.recordKey,
    pinnedAt: now,
  });
  if (!pin) return failedLifecycleRoute({ request: envelope.request, provider, code: "lifecycle_pin_invalid" });
  const confirmedPin = await confirmLifecyclePinWith(resolveProjectRoot)(supplied.cwd, writeAttempt, pin);
  if (confirmedPin.status !== "pinned") {
    return failedLifecycleRoute({ request: envelope.request, provider, code: confirmedPin.code });
  }
  return lifecycleRouteResult({ request: envelope.request, prepared: prepared.data, provider, result });
}

const invalidBookStackRecovery = (code: string) => ({
  schemaVersion: 1,
  status: "failed" as const,
  provider: "bookstack" as const,
  artifactId: null,
  recordKey: null,
  error: sanitizeLifecycleError(code, ""),
});

const bookStackRecoveryRouteResult = (input: {
  request: ValidLifecycleRequest;
  prepared: { nonce: string; artifact: string; recordKey: string };
  result: unknown;
  writeState: "no-write" | "possible-write";
}) => {
  const value = object(input.result);
  if (value?.status !== "verified") {
    return lifecycleRouteResult({
      request: input.request,
      prepared: input.prepared,
      provider: "bookstack",
      result: {
        status: "blocked",
        provider: "bookstack",
        code: lifecycleCode(value?.code, "bookstack_recovery_unresolved"),
        writeState: input.writeState,
      },
    });
  }
  const record = routedRecord({
    provider: "bookstack",
    value,
    reference: value.locator,
    lifecycleKey: input.request.identity.lifecycleKey,
    phase: input.request.type,
    summary: input.request.summary,
    artifact: value.artifact,
    createdAt: null,
  });
  return lifecycleRouteResult({
    request: input.request,
    prepared: input.prepared,
    provider: "bookstack",
    result: record
      ? { status: "verified", record }
      : {
        status: "blocked",
        provider: "bookstack",
        code: "lifecycle_provider_verification_failed",
        writeState: input.writeState,
      },
  });
};

const bookStackRecoveryAttemptMatches = (
  state: LifecyclePinLoadResult,
  attemptId: string,
  expected?: LifecycleProviderPinAttempt,
) => state.status === "pending"
  && state.attempt.provider === "bookstack"
  && state.attempt.status === "writing"
  && state.attempt.attemptId === attemptId
  && (!expected || sameLifecycleProviderPinAttempt(state.attempt, expected));

const bookStackRecoveryCheckpointMatchesDiscovery = (
  attempt: LifecycleProviderPinAttempt,
  discovery: BookStackRecoveryDiscovery,
) => {
  const checkpoint = attempt.recoveryCheckpoint;
  return checkpoint !== undefined
    && checkpoint.lifecycleKey === discovery.checkpoint.lifecycleKey
    && checkpoint.requestHash === discovery.checkpoint.requestHash
    && checkpoint.originFingerprint === discovery.checkpoint.originFingerprint
    && checkpoint.pageSlug === discovery.checkpoint.pageSlug;
};

const bookStackRecoveryAttemptFailure = (state: LifecyclePinLoadResult) => {
  if (["corrupt", "conflicting", "inaccessible"].includes(state.status)) {
    return `lifecycle_pin_store_${state.status}`;
  }
  if (state.status === "pending" && state.attempt.recoveryCheckpoint !== undefined) {
    return "lifecycle_pin_recovery_consumed";
  }
  return "lifecycle_pin_attempt_conflict";
};

export async function coordinateBookStackLifecycleRecovery(
  recoveryValue: unknown,
  supplied?: LifecycleIntegrationDependencies,
  signal?: AbortSignal,
) {
  const envelope = bookStackRecoveryEnvelope(recoveryValue);
  if (!envelope) return invalidBookStackRecovery("bookstack_recovery_request_invalid");
  if (!supplied?.cwd) {
    return failedLifecycleRoute({
      request: envelope.request,
      provider: "bookstack",
      code: "lifecycle_pin_store_inaccessible",
    });
  }
  throwIfAborted(signal);

  const initialWrite = validateInitialLifecycleWriteRequest(envelope.request);
  if (!initialWrite.valid) {
    return failedLifecycleRoute({
      request: envelope.request,
      provider: "bookstack",
      code: initialWrite.code,
    });
  }
  const prepared = prepareLifecycleArtifact(envelope.request);
  if (!prepared.valid) {
    return failedLifecycleRoute({
      request: envelope.request,
      provider: "bookstack",
      code: prepared.error.code,
    });
  }
  const resolveProjectRoot = supplied.resolveProjectRoot ?? defaultResolveCycleProjectRoot;
  const root = await resolveProjectRoot(supplied.cwd).catch(() => null);
  if (!root || typeof root !== "string") {
    return failedLifecycleRoute({
      request: envelope.request,
      provider: "bookstack",
      code: "lifecycle_pin_store_inaccessible",
    });
  }
  const loadPin = loadLifecyclePinStateWith(resolveProjectRoot);
  const pinState = await loadPin(supplied.cwd, envelope.request.identity.lifecycleKey);
  const attempt = pinState.status === "pending" ? pinState.attempt : null;
  if (!attempt || !bookStackRecoveryAttemptMatches(pinState, envelope.attemptId)) {
    return failedLifecycleRoute({
      request: envelope.request,
      provider: "bookstack",
      code: bookStackRecoveryAttemptFailure(pinState),
    });
  }
  const recoveryCheckpointConsumed = attempt.recoveryCheckpoint !== undefined;
  const provider = bookStackLifecycleProviderFor({
    environment: supplied.environment ?? process.env,
    client: supplied.bookStackLifecycleClient,
    signal,
  });
  if (!provider) {
    return failedLifecycleRoute({
      request: envelope.request,
      provider: "bookstack",
      code: "bookstack_unavailable",
    });
  }
  const recoveryInput = {
    request: projectLifecyclePersistenceRequest(envelope.request),
    placement: projectBookStackRecoveryPlacement(envelope.placement),
  };
  const discovered = await provider.discoverSameAttemptRecovery(recoveryInput, signal);
  throwIfAborted(signal);
  if (discovered.status !== "ready") {
    return failedLifecycleRoute({
      request: envelope.request,
      provider: "bookstack",
      code: discovered.code,
    });
  }
  if (
    recoveryCheckpointConsumed
    && (!discovered.existing || !bookStackRecoveryCheckpointMatchesDiscovery(attempt, discovered))
  ) {
    return failedLifecycleRoute({
      request: envelope.request,
      provider: "bookstack",
      code: "lifecycle_pin_recovery_consumed",
    });
  }
  if (!supplied.confirmBookStackRecovery) {
    return failedLifecycleRoute({
      request: envelope.request,
      provider: "bookstack",
      code: "bookstack_recovery_confirmation_required",
    });
  }
  let approved = false;
  try {
    approved = await supplied.confirmBookStackRecovery(bookStackRecoveryConfirmation({
      request: envelope.request,
      placement: envelope.placement,
      attempt,
      discovery: discovered,
    })) === true;
  } catch {
    approved = false;
  }
  if (!approved) {
    return failedLifecycleRoute({
      request: envelope.request,
      provider: "bookstack",
      code: "bookstack_recovery_declined",
    });
  }
  const recheckedPin = await loadPin(supplied.cwd, envelope.request.identity.lifecycleKey);
  throwIfAborted(signal);
  if (!bookStackRecoveryAttemptMatches(recheckedPin, envelope.attemptId, attempt)) {
    return failedLifecycleRoute({
      request: envelope.request,
      provider: "bookstack",
      code: bookStackRecoveryAttemptFailure(recheckedPin),
    });
  }
  const rechecked = await provider.discoverSameAttemptRecovery(recoveryInput, signal);
  throwIfAborted(signal);
  if (rechecked.status !== "ready") {
    return failedLifecycleRoute({
      request: envelope.request,
      provider: "bookstack",
      code: rechecked.code,
    });
  }
  if (
    recoveryCheckpointConsumed
    && (!rechecked.existing || !bookStackRecoveryCheckpointMatchesDiscovery(attempt, rechecked))
  ) {
    return failedLifecycleRoute({
      request: envelope.request,
      provider: "bookstack",
      code: "lifecycle_pin_recovery_consumed",
    });
  }
  if (!sameBookStackPageRecoveryCheckpoint(discovered.checkpoint, rechecked.checkpoint)) {
    return failedLifecycleRoute({
      request: envelope.request,
      provider: "bookstack",
      code: "bookstack_recovery_stale",
    });
  }
  if (rechecked.existing) {
    const pin = createLifecycleProviderPin({
      lifecycleKey: envelope.request.identity.lifecycleKey,
      provider: "bookstack",
      initialReference: rechecked.existing.locator,
      artifactId: rechecked.existing.artifactId,
      recordKey: rechecked.existing.recordKey,
      pinnedAt: attempt.startedAt,
    });
    if (!pin) {
      return failedLifecycleRoute({
        request: envelope.request,
        provider: "bookstack",
        code: "lifecycle_pin_invalid",
      });
    }
    const confirmed = await confirmLifecyclePinWith(resolveProjectRoot)(
      supplied.cwd,
      attempt,
      pin,
      true,
    );
    if (confirmed.status !== "pinned") {
      return failedLifecycleRoute({
        request: envelope.request,
        provider: "bookstack",
        code: confirmed.code,
      });
    }
    return bookStackRecoveryRouteResult({
      request: envelope.request,
      prepared: prepared.data,
      result: rechecked.existing,
      writeState: "no-write",
    });
  }

  if (recoveryCheckpointConsumed) {
    return failedLifecycleRoute({
      request: envelope.request,
      provider: "bookstack",
      code: "lifecycle_pin_recovery_consumed",
    });
  }

  const claimed = await claimLifecyclePinRecoveryWith(resolveProjectRoot)(
    supplied.cwd,
    attempt,
    rechecked.checkpoint,
  );
  if (claimed.status !== "claimed") {
    return failedLifecycleRoute({
      request: envelope.request,
      provider: "bookstack",
      code: claimed.code,
    });
  }
  const checkpoint = claimed.attempt.recoveryCheckpoint;
  if (!checkpoint) {
    return failedLifecycleRoute({
      request: envelope.request,
      provider: "bookstack",
      code: "lifecycle_pin_recovery_invalid",
    });
  }
  const persisted = await provider.persistSameAttemptRecovery({
    ...recoveryInput,
    checkpoint,
  }, signal);
  throwIfAborted(signal);
  if (persisted.status !== "verified") {
    return bookStackRecoveryRouteResult({
      request: envelope.request,
      prepared: prepared.data,
      result: persisted,
      writeState: "possible-write",
    });
  }
  const pin = createLifecycleProviderPin({
    lifecycleKey: envelope.request.identity.lifecycleKey,
    provider: "bookstack",
    initialReference: persisted.locator,
    artifactId: persisted.artifactId,
    recordKey: persisted.recordKey,
    pinnedAt: claimed.attempt.startedAt,
  });
  if (!pin) {
    return failedLifecycleRoute({
      request: envelope.request,
      provider: "bookstack",
      code: "lifecycle_pin_invalid",
    });
  }
  const confirmed = await confirmLifecyclePinWith(resolveProjectRoot)(
    supplied.cwd,
    claimed.attempt,
    pin,
    true,
  );
  if (confirmed.status !== "pinned") {
    return failedLifecycleRoute({
      request: envelope.request,
      provider: "bookstack",
      code: confirmed.code,
    });
  }
  return bookStackRecoveryRouteResult({
    request: envelope.request,
    prepared: prepared.data,
    result: persisted,
    writeState: "possible-write",
  });
}

const routedRecallRecord = (record: RoutedLifecycleRecord) => ({
  id: record.artifactId,
  recordKey: record.recordKey,
  lifecycleKey: record.lifecycleKey,
  phase: record.phase,
  summary: record.summary,
  content: record.artifact,
  detail: record.artifact,
  contentHash: createHash("sha256").update(record.artifact, "utf8").digest("hex"),
  ...(record.createdAt ? { createdAt: record.createdAt } : {}),
  provider: record.provider,
  reference: structuredClone(record.reference),
});

type PinnedLifecycleSourceAnchor =
  | { status: "verified"; pin: LifecycleProviderPin; record: RoutedLifecycleRecord }
  | { status: "absent" }
  | { status: "blocked" };

const samePinnedLifecycleSourceAuthority = async (input: {
  cwd: string;
  lifecycleKey: string;
  pin: LifecycleProviderPin;
  resolveProjectRoot: (cwd: string) => Promise<string>;
  signal?: AbortSignal;
}) => {
  try {
    const state = await loadLifecyclePinStateWith(input.resolveProjectRoot)(
      input.cwd,
      input.lifecycleKey,
    );
    throwIfAborted(input.signal);
    return state.status === "pinned" && sameLifecycleProviderPin(state.pin, input.pin);
  } catch {
    throwIfAborted(input.signal);
    return false;
  }
};

const readPinnedLifecycleSourceAnchor = async (input: {
  lifecycleKey: string;
  cwd: string;
  supplied?: LifecycleIntegrationDependencies;
  signal?: AbortSignal;
}): Promise<PinnedLifecycleSourceAnchor> => {
  const resolveProjectRoot = input.supplied?.resolveProjectRoot ?? defaultResolveCycleProjectRoot;
  let pinState: LifecyclePinLoadResult;
  try {
    pinState = await loadLifecyclePinStateWith(resolveProjectRoot)(input.cwd, input.lifecycleKey);
    throwIfAborted(input.signal);
  } catch {
    throwIfAborted(input.signal);
    return { status: "blocked" };
  }
  if (pinState.status === "absent") return { status: "absent" };
  if (pinState.status !== "pinned") return { status: "blocked" };

  const root = await resolveProjectRoot(input.cwd).catch(() => null);
  throwIfAborted(input.signal);
  if (!root || typeof root !== "string") return { status: "blocked" };
  const unchangedBeforeRead = await samePinnedLifecycleSourceAuthority({
    cwd: input.cwd,
    lifecycleKey: input.lifecycleKey,
    pin: pinState.pin,
    resolveProjectRoot,
    signal: input.signal,
  });
  if (!unchangedBeforeRead) return { status: "blocked" };

  const dependencies = depsFor(input.supplied);
  const routing = input.supplied?.routing ?? lifecycleReadRouting({
    provider: pinState.pin.provider,
    checkoutRoot: root,
    dependencies,
    bookStackLifecycleClient: input.supplied?.bookStackLifecycleClient,
    environment: input.supplied?.environment,
    signal: input.signal,
  });
  const anchor = await routePinnedLifecycleReference({
    routing,
    pin: structuredClone(pinState.pin),
    operation: "reconcile",
    signal: input.signal,
  });
  throwIfAborted(input.signal);
  if (anchor.status !== "verified") return { status: "blocked" };

  const unchangedAfterRead = await samePinnedLifecycleSourceAuthority({
    cwd: input.cwd,
    lifecycleKey: input.lifecycleKey,
    pin: pinState.pin,
    resolveProjectRoot,
    signal: input.signal,
  });
  if (!unchangedAfterRead) return { status: "blocked" };
  return {
    status: "verified",
    pin: structuredClone(pinState.pin),
    record: structuredClone(anchor.record),
  };
};

const recallPinnedLifecycle = async (input: {
  lifecycleKey: string;
  phase?: LifecyclePhase;
  cwd: string;
  supplied?: LifecycleIntegrationDependencies;
  signal?: AbortSignal;
}) => {
  const resolveProjectRoot = input.supplied?.resolveProjectRoot ?? defaultResolveCycleProjectRoot;
  const pinState = await loadLifecyclePinStateWith(resolveProjectRoot)(input.cwd, input.lifecycleKey);
  if (pinState.status !== "pinned") return pinState;
  const root = await resolveProjectRoot(input.cwd).catch(() => null);
  if (!root || typeof root !== "string") return { status: "inaccessible" as const };
  const dependencies = depsFor(input.supplied);
  const routing = input.supplied?.routing ?? lifecycleRouting({
    checkoutRoot: root,
    dependencies,
    bookStackLifecycleClient: input.supplied?.bookStackLifecycleClient,
    environment: input.supplied?.environment,
  });
  const result = await routePinnedLifecycleRecall({
    routing,
    pin: pinState.pin,
    lifecycleKey: input.lifecycleKey,
    ...(input.phase ? { phase: input.phase } : {}),
    limit: LIFECYCLE_RECALL_LIMIT,
    signal: input.signal,
  });
  return result.status === "verified"
    ? { status: "verified" as const, records: result.records }
    : { status: "blocked" as const };
};

export type LifecycleLineageResolution =
  | { status: "verified"; lineage: PinnedLifecycleLineage }
  | { status: "blocked"; code: string };

export const resolveLifecycleLineage = async (
  lifecycleKey: string,
  supplied?: LifecycleIntegrationDependencies,
  signal?: AbortSignal,
): Promise<LifecycleLineageResolution> => {
  const key = exactLifecycleReadKey(lifecycleKey);
  const cwd = supplied?.cwd;
  if (!key || typeof cwd !== "string" || !cwd) {
    return { status: "blocked", code: "lifecycle_lineage_unavailable" };
  }
  const resolveProjectRoot = supplied?.resolveProjectRoot ?? defaultResolveCycleProjectRoot;
  try {
    const root = await resolveProjectRoot(cwd);
    throwIfAborted(signal);
    if (!root || typeof root !== "string") {
      return { status: "blocked", code: "lifecycle_lineage_unavailable" };
    }
    const pinState = await loadLifecyclePinStateWith(resolveProjectRoot)(cwd, key);
    throwIfAborted(signal);
    if (pinState.status !== "pinned") {
      return {
        status: "blocked",
        code: pinState.status === "pending"
          ? "lifecycle_lineage_unresolved"
          : "lifecycle_lineage_unavailable",
      };
    }
    const authority = {
      kind: "pinned" as const,
      pin: structuredClone(pinState.pin),
    };
    const dependencies = depsFor(supplied);
    const routing = supplied?.routing ?? lifecycleReadRouting({
      provider: authority.pin.provider,
      checkoutRoot: root,
      dependencies,
      bookStackLifecycleClient: supplied?.bookStackLifecycleClient,
      environment: supplied?.environment,
      signal,
    });
    const resolved = await resolvePinnedLifecycleLineage({
      routing,
      pin: structuredClone(authority.pin),
      signal,
    });
    throwIfAborted(signal);
    if (resolved.status !== "verified") {
      return { status: "blocked", code: resolved.code };
    }
    const authorityUnchanged = await sameLifecycleReadAuthority({
      cwd,
      lifecycleKey: key,
      resolveProjectRoot,
      authority,
    });
    throwIfAborted(signal);
    if (!authorityUnchanged) {
      return { status: "blocked", code: "lifecycle_lineage_unavailable" };
    }
    return { status: "verified", lineage: structuredClone(resolved.lineage) };
  } catch {
    throwIfAborted(signal);
    return { status: "blocked", code: "lifecycle_lineage_unavailable" };
  }
};

type LifecycleReadAuthority =
  | { kind: "pinned"; pin: LifecycleProviderPin }
  | { kind: "historical-qdrant" };

type LifecycleReadDescriptor = {
  lifecycleKey: string;
  phase: LifecyclePhase;
  artifactId: string;
  recordKey: string;
  contentHash: string;
  summary: string;
  reference: LifecycleReadReference;
};

type LifecycleReadSetup = {
  root: string;
  authority: LifecycleReadAuthority;
  dependencies: ReturnType<typeof depsFor>;
  resolveProjectRoot: (cwd: string) => Promise<string>;
  routing: ReturnType<typeof createLifecycleRouting>;
};

type LifecycleReadFailureCode =
  | "lifecycle_read_authority_changed"
  | "lifecycle_read_authority_invalid"
  | "lifecycle_read_authority_pending"
  | "lifecycle_read_authority_unavailable"
  | "lifecycle_read_request_invalid"
  | "lifecycle_read_unavailable"
  | "lifecycle_read_verification_failed";

type LifecycleReadProviderDiagnosticCode =
  | "provider_access_denied"
  | "provider_adapter_unavailable"
  | "provider_operation_failed"
  | "provider_rate_limited"
  | "provider_response_invalid"
  | "provider_transport_failed"
  | "provider_unavailable"
  | "provider_verification_failed";

type LifecycleReadProviderDiagnosticReason =
  | "adapter_record_projection_invalid"
  | "pagination_invalid"
  | "pinned_reference_invalid"
  | "recall_envelope_invalid"
  | "record_artifact_missing"
  | "record_artifact_secret_bearer_placeholder"
  | "record_artifact_secret_bearer_value"
  | "record_artifact_secret_named"
  | "record_artifact_secret_private_key"
  | "record_artifact_too_large"
  | "record_artifact_utf8_invalid"
  | "record_created_at_invalid"
  | "record_identity_invalid"
  | "record_projection_invalid"
  | "record_reference_invalid"
  | "record_structure_invalid"
  | "record_summary_invalid"
  | "record_verification_failed"
  | "response_decode_invalid"
  | "response_too_large"
  | "http_failed"
  | "recall_overflow";

type LifecycleReadDiagnostic =
  | {
    stage: "provider";
    code: LifecycleReadProviderDiagnosticCode;
    step?: "authority" | "recall";
    phase?: LifecyclePhase;
    reason?: LifecycleReadProviderDiagnosticReason;
    findings?: readonly LifecycleContentFinding[];
  }
  | {
    stage: "verification";
    code:
      | "get_descriptor_mismatch"
      | "get_descriptor_projection_failed"
      | "get_record_verification_failed"
      | "get_reference_projection_failed";
  }
  | { stage: "runtime"; code: "unexpected_failure" };

type LifecycleReadRouteFailure = {
  code: LifecycleReadFailureCode;
  diagnostic?: LifecycleReadDiagnostic;
};

const LIFECYCLE_READ_ERROR_MESSAGES: Record<LifecycleReadFailureCode, string> = {
  lifecycle_read_authority_changed: "Lifecycle read authority changed before verification completed.",
  lifecycle_read_authority_invalid: "Lifecycle read authority cannot verify the requested record.",
  lifecycle_read_authority_pending: "Lifecycle read authority is pending and cannot be used.",
  lifecycle_read_authority_unavailable: "Lifecycle read authority is unavailable.",
  lifecycle_read_request_invalid: "Lifecycle read request is invalid.",
  lifecycle_read_unavailable: "Lifecycle read is unavailable.",
  lifecycle_read_verification_failed: "Lifecycle read verification failed.",
};

const lifecycleReadFailure = (
  code: LifecycleReadFailureCode,
  diagnostic?: LifecycleReadDiagnostic,
) => ({
  schemaVersion: 1,
  status: "failed" as const,
  error: {
    code,
    message: LIFECYCLE_READ_ERROR_MESSAGES[code],
    ...(diagnostic ? { diagnostic } : {}),
  },
});

const lifecycleReadProviderDiagnosticCode = (
  code: string | null,
): LifecycleReadProviderDiagnosticCode => {
  if (code === "bookstack_access_denied") return "provider_access_denied";
  if (code === "bookstack_rate_limited") return "provider_rate_limited";
  if (code === "bookstack_transport_failed") return "provider_transport_failed";
  if (["lifecycle_provider_unavailable", "pinned_provider_unavailable"].includes(code ?? "")) {
    return "provider_adapter_unavailable";
  }
  if ([
    "bookstack_response_invalid",
    "bookstack_response_too_large",
    "bookstack_pagination_invalid",
    "lifecycle_provider_recall_envelope_invalid",
    "lifecycle_provider_record_projection_invalid",
    "lifecycle_provider_response_invalid",
    "pinned_provider_response_invalid",
  ].includes(code ?? "")) return "provider_response_invalid";
  if ([
    "bookstack_identity_ambiguous",
    "bookstack_locator_invalid",
    "bookstack_locator_mismatch",
    "bookstack_markdown_missing",
    "bookstack_placement_conflict",
    "bookstack_placement_invalid",
    "bookstack_verification_failed",
    "lifecycle_provider_recall_overflow",
    "lifecycle_provider_recall_unverifiable",
    "lifecycle_provider_record_artifact_missing_invalid",
    "lifecycle_provider_record_artifact_secret_bearer_placeholder_invalid",
    "lifecycle_provider_record_artifact_secret_bearer_value_invalid",
    "lifecycle_provider_record_artifact_secret_named_invalid",
    "lifecycle_provider_record_artifact_secret_private_key_invalid",
    "lifecycle_provider_record_artifact_too_large_invalid",
    "lifecycle_provider_record_artifact_utf8_invalid",
    "lifecycle_provider_record_created_at_invalid",
    "lifecycle_provider_record_identity_invalid",
    "lifecycle_provider_record_reference_invalid",
    "lifecycle_provider_record_structure_invalid",
    "lifecycle_provider_record_summary_invalid",
    "lifecycle_provider_record_verification_failed",
  ].includes(code ?? "")) return "provider_verification_failed";
  if ([
    "bookstack_http_failed",
    "bookstack_recall_unavailable",
    "bookstack_unavailable",
    "lifecycle_provider_read_failed",
    "lifecycle_provider_recall_failed",
    "pinned_provider_failed",
  ].includes(code ?? "")) return "provider_unavailable";
  return "provider_operation_failed";
};

const lifecycleReadProviderDiagnosticReason = (
  code: string | null,
): LifecycleReadProviderDiagnosticReason | undefined => {
  if (code === "bookstack_http_failed") return "http_failed";
  if (code === "bookstack_pagination_invalid") return "pagination_invalid";
  if (code === "lifecycle_provider_recall_overflow") return "recall_overflow";
  if (code === "bookstack_response_invalid") return "response_decode_invalid";
  if (code === "bookstack_response_too_large") return "response_too_large";
  if (code === "lifecycle_provider_record_projection_invalid") return "adapter_record_projection_invalid";
  if (code === "lifecycle_provider_recall_envelope_invalid") return "recall_envelope_invalid";
  if (code === "lifecycle_provider_record_artifact_missing_invalid") return "record_artifact_missing";
  if (code === "lifecycle_provider_record_artifact_secret_bearer_placeholder_invalid") return "record_artifact_secret_bearer_placeholder";
  if (code === "lifecycle_provider_record_artifact_secret_bearer_value_invalid") return "record_artifact_secret_bearer_value";
  if (code === "lifecycle_provider_record_artifact_secret_named_invalid") return "record_artifact_secret_named";
  if (code === "lifecycle_provider_record_artifact_secret_private_key_invalid") return "record_artifact_secret_private_key";
  if (code === "lifecycle_provider_record_artifact_too_large_invalid") return "record_artifact_too_large";
  if (code === "lifecycle_provider_record_artifact_utf8_invalid") return "record_artifact_utf8_invalid";
  if (code === "lifecycle_provider_record_created_at_invalid") return "record_created_at_invalid";
  if (code === "lifecycle_provider_record_identity_invalid") return "record_identity_invalid";
  if (code === "lifecycle_provider_record_reference_invalid") return "record_reference_invalid";
  if (code === "lifecycle_provider_record_structure_invalid") return "record_structure_invalid";
  if (code === "lifecycle_provider_record_summary_invalid") return "record_summary_invalid";
  if (code === "lifecycle_provider_record_verification_failed") return "record_verification_failed";
  if (code === "lifecycle_provider_response_invalid") return "record_projection_invalid";
  if (code === "pinned_provider_response_invalid") return "pinned_reference_invalid";
  return undefined;
};

const lifecycleReadRouteFailure = (
  result: RoutedLifecycleRecallResult | RoutedLifecyclePersistResult,
): LifecycleReadRouteFailure => {
  if (result.status === "blocked" && result.code === "lifecycle_read_authority_invalid") {
    return { code: "lifecycle_read_authority_invalid" };
  }
  const routeCode = result.status === "blocked" ? result.code : null;
  const step = result.status === "blocked" && "readStep" in result
    ? result.readStep
    : routeCode === "lifecycle_provider_recall_overflow"
      ? "recall"
      : undefined;
  const phase = result.status === "blocked" && "readPhase" in result
    ? result.readPhase
    : undefined;
  const reason = lifecycleReadProviderDiagnosticReason(routeCode);
  const findings = result.status === "blocked"
    ? result.diagnostic?.findings
    : undefined;
  return {
    code: "lifecycle_read_unavailable",
    diagnostic: {
      stage: "provider",
      code: lifecycleReadProviderDiagnosticCode(routeCode),
      ...(step ? { step } : {}),
      ...(phase ? { phase } : {}),
      ...(reason ? { reason } : {}),
      ...(findings ? { findings } : {}),
    },
  };
};

const unexpectedLifecycleReadFailure = () => lifecycleReadFailure("lifecycle_read_unavailable", {
  stage: "runtime",
  code: "unexpected_failure",
});

const boundedLifecycleReadResult = <Result extends Record<string, unknown>>(
  result: Result,
): Result | ReturnType<typeof lifecycleReadFailure> => {
  try {
    return Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_LIFECYCLE_READ_OUTPUT_BYTES
      ? result
      : lifecycleReadFailure("lifecycle_read_verification_failed");
  } catch {
    return lifecycleReadFailure("lifecycle_read_verification_failed");
  }
};

const lifecycleReadDescriptor = (
  value: unknown,
  approvedWarningBindings?: readonly string[],
): LifecycleReadDescriptor | null => {
  const options = { approvedWarningBindings };
  const record = verifyRoutedLifecycleReadRecord(value, {}, options);
  if (!record) return null;
  const reference = lifecycleReadReferenceFor(record, options);
  const contentHash = createHash("sha256").update(record.artifact, "utf8").digest("hex");
  if (
    !reference
    || Buffer.byteLength(record.summary, "utf8") > MAX_LIFECYCLE_READ_SUMMARY_BYTES
    || Buffer.byteLength(record.artifact, "utf8") > MAX_LIFECYCLE_READ_ARTIFACT_BYTES
  ) return null;
  const descriptor = {
    lifecycleKey: record.lifecycleKey,
    phase: record.phase,
    artifactId: record.artifactId,
    recordKey: record.recordKey,
    contentHash,
    summary: record.summary,
    reference,
  };
  return lifecycleReadDescriptorRequest(descriptor) ? descriptor : null;
};

const lifecycleReadAuthorityFor = async (input: {
  cwd: string;
  lifecycleKey: string;
  resolveProjectRoot: (cwd: string) => Promise<string>;
}): Promise<LifecycleReadAuthority | "pending" | null> => {
  try {
    const state = await loadLifecyclePinStateWith(input.resolveProjectRoot)(
      input.cwd,
      input.lifecycleKey,
    );
    if (state.status === "absent") return { kind: "historical-qdrant" };
    if (state.status === "pending") return "pending";
    if (state.status !== "pinned") return null;
    return { kind: "pinned", pin: structuredClone(state.pin) };
  } catch {
    return null;
  }
};

const sameLifecycleReadAuthority = async (input: {
  cwd: string;
  lifecycleKey: string;
  resolveProjectRoot: (cwd: string) => Promise<string>;
  authority: LifecycleReadAuthority;
}) => {
  try {
    const state = await loadLifecyclePinStateWith(input.resolveProjectRoot)(
      input.cwd,
      input.lifecycleKey,
    );
    return input.authority.kind === "historical-qdrant"
      ? state.status === "absent"
      : state.status === "pinned"
        && sameLifecycleProviderPin(state.pin, input.authority.pin);
  } catch {
    return false;
  }
};

const lifecycleReadSetup = async (input: {
  lifecycleKey: string;
  supplied?: LifecycleIntegrationDependencies;
  signal?: AbortSignal;
}): Promise<LifecycleReadSetup | ReturnType<typeof lifecycleReadFailure>> => {
  const cwd = input.supplied?.cwd;
  if (typeof cwd !== "string" || !cwd) return lifecycleReadFailure("lifecycle_read_authority_unavailable");
  const resolveProjectRoot = input.supplied?.resolveProjectRoot ?? defaultResolveCycleProjectRoot;
  let root: string | null;
  try {
    root = await resolveProjectRoot(cwd);
  } catch {
    root = null;
  }
  throwIfAborted(input.signal);
  if (!root || typeof root !== "string") {
    return lifecycleReadFailure("lifecycle_read_authority_unavailable");
  }

  const authority = await lifecycleReadAuthorityFor({
    cwd,
    lifecycleKey: input.lifecycleKey,
    resolveProjectRoot,
  });
  throwIfAborted(input.signal);
  if (authority === "pending") return lifecycleReadFailure("lifecycle_read_authority_pending");
  if (!authority) return lifecycleReadFailure("lifecycle_read_authority_unavailable");

  const dependencies = depsFor(input.supplied);
  const provider = authority.kind === "pinned"
    ? authority.pin.provider
    : "qdrant";
  return {
    root,
    authority,
    dependencies,
    resolveProjectRoot,
    routing: input.supplied?.routing ?? lifecycleReadRouting({
      provider,
      checkoutRoot: root,
      dependencies,
      bookStackLifecycleClient: input.supplied?.bookStackLifecycleClient,
      environment: input.supplied?.environment,
      signal: input.signal,
    }),
  };
};

const lifecycleReadRecords = async (input: {
  request: LifecycleReadRecallRequest;
  setup: LifecycleReadSetup;
  approvedWarningBindings?: readonly string[];
  captureWarningBindings?: (warnings: readonly {
    binding: string;
    findings: readonly LifecycleContentFinding[];
  }[]) => void;
  signal?: AbortSignal;
}): Promise<{
  records: RoutedLifecycleRecord[] | null;
  failure: LifecycleReadRouteFailure | null;
}> => {
  const result = input.setup.authority.kind === "pinned"
    ? await routePinnedLifecycleRecall({
      routing: input.setup.routing,
      pin: input.setup.authority.pin,
      lifecycleKey: input.request.lifecycleKey,
      ...(input.request.phase ? { phase: input.request.phase } : {}),
      limit: MAX_LIFECYCLE_READ_RESULTS,
      approvedWarningBindings: input.approvedWarningBindings,
      captureWarningBindings: input.captureWarningBindings,
      signal: input.signal,
    })
    : await routeLifecycleRecall({
      routing: input.setup.routing,
      provider: "qdrant",
      lifecycleKey: input.request.lifecycleKey,
      ...(input.request.phase ? { phase: input.request.phase } : {}),
      limit: MAX_LIFECYCLE_READ_RESULTS,
      approvedWarningBindings: input.approvedWarningBindings,
      captureWarningBindings: input.captureWarningBindings,
      signal: input.signal,
    });
  throwIfAborted(input.signal);
  if (result.status !== "verified") {
    return { records: null, failure: lifecycleReadRouteFailure(result) };
  }

  const selected = result.records.filter((record) =>
    input.request.phase === undefined || record.phase === input.request.phase,
  );
  return selected.length <= MAX_LIFECYCLE_READ_RESULTS
    ? { records: selected.map((record) => structuredClone(record)), failure: null }
    : { records: null, failure: { code: "lifecycle_read_verification_failed" } };
};

const lifecycleReadSelectorDescriptor = async (input: {
  selector: LifecycleReadGetSelector;
  setup: LifecycleReadSetup;
  approvedWarningBindings?: readonly string[];
  captureWarningBindings?: (warnings: readonly {
    binding: string;
    findings: readonly LifecycleContentFinding[];
  }[]) => void;
  signal?: AbortSignal;
}): Promise<{
  descriptor: LifecycleReadDescriptor | null;
  failure: LifecycleReadRouteFailure | null;
}> => {
  const recalled = await lifecycleReadRecords({
    request: {
      lifecycleKey: input.selector.lifecycleKey,
      phase: input.selector.phase,
      limit: MAX_LIFECYCLE_READ_RESULTS,
    },
    setup: input.setup,
    approvedWarningBindings: input.approvedWarningBindings,
    captureWarningBindings: input.captureWarningBindings,
    signal: input.signal,
  });
  if (!recalled.records) return { descriptor: null, failure: recalled.failure };
  if (recalled.records.length >= MAX_LIFECYCLE_READ_RESULTS) {
    return { descriptor: null, failure: { code: "lifecycle_read_verification_failed" } };
  }
  const matches = recalled.records.filter((record) =>
    record.lifecycleKey === input.selector.lifecycleKey
    && record.phase === input.selector.phase
    && record.artifactId === input.selector.artifactId,
  );
  if (matches.length !== 1) {
    return { descriptor: null, failure: { code: "lifecycle_read_verification_failed" } };
  }
  const descriptor = lifecycleReadDescriptor(matches[0], input.approvedWarningBindings);
  return descriptor
    ? { descriptor, failure: null }
    : { descriptor: null, failure: { code: "lifecycle_read_verification_failed" } };
};

const orderedLifecycleReadDescriptors = (
  records: readonly RoutedLifecycleRecord[],
  approvedWarningBindings?: readonly string[],
): LifecycleReadDescriptor[] | null => {
  const ordered = [...records].sort((left, right) =>
    left.recordKey < right.recordKey ? -1 : left.recordKey > right.recordKey ? 1 : 0,
  );
  const descriptors = ordered.map((record) =>
    lifecycleReadDescriptor(record, approvedWarningBindings),
  );
  return descriptors.some((descriptor) => descriptor === null)
    ? null
    : descriptors as LifecycleReadDescriptor[];
};

const lifecycleReadNativeReference = async (input: {
  request: LifecycleReadGetRequest;
  setup: LifecycleReadSetup;
}): Promise<Record<string, unknown> | null> => {
  const provider = input.setup.authority.kind === "pinned"
    ? input.setup.authority.pin.provider
    : "qdrant";
  const serenaProjectFingerprint = provider === "serena"
    ? (await serenaProject(input.setup.root, input.setup.dependencies))?.fingerprint
    : undefined;
  return lifecycleReadNativeReferenceFor({
    provider,
    lifecycleKey: input.request.lifecycleKey,
    phase: input.request.phase,
    artifactId: input.request.artifactId,
    recordKey: input.request.recordKey,
    contentHash: input.request.contentHash,
    reference: input.request.reference,
    checkoutRoot: input.setup.root,
    ...(input.setup.authority.kind === "pinned"
      ? { initialReference: input.setup.authority.pin.initialReference }
      : {}),
    ...(serenaProjectFingerprint ? { serenaProjectFingerprint } : {}),
  });
};

export const coordinateLifecycleRecall = async (
  requestValue: unknown,
  supplied?: LifecycleIntegrationDependencies,
  signal?: AbortSignal,
) => {
  const request = lifecycleReadRecallRequest(requestValue);
  if (!request) return lifecycleReadFailure("lifecycle_read_request_invalid");
  const admission = consumeLifecycleContentAdmission(
    supplied?.contentScreeningAdmission,
    "read-recall",
  );
  try {
    throwIfAborted(signal);
    const setup = await lifecycleReadSetup({ lifecycleKey: request.lifecycleKey, supplied, signal });
    throwIfAborted(signal);
    if ("status" in setup) return setup;
    const cwd = supplied?.cwd;
    if (typeof cwd !== "string") return lifecycleReadFailure("lifecycle_read_authority_unavailable");
    const warningCandidates: {
      binding: string;
      findings: readonly LifecycleContentFinding[];
    }[] = [];
    const recalled = await lifecycleReadRecords({
      request,
      setup,
      approvedWarningBindings: admission?.approvedWarningBindings,
      captureWarningBindings: (warnings) => warningCandidates.push(...warnings),
      signal,
    });
    if (recalled.records === null) {
      const failure: LifecycleReadRouteFailure = recalled.failure ?? { code: "lifecycle_read_verification_failed" };
      if (!admission && warningCandidates.length > 0) {
        supplied?.captureContentWarning?.({
          kind: "read-recall",
          warnings: warningCandidates.map(({ binding, findings }) => ({
            binding,
            findings: [...findings],
          })),
        });
      }
      return lifecycleReadFailure(failure.code, failure.diagnostic);
    }
    const records = recalled.records;
    const authorityUnchanged = await sameLifecycleReadAuthority({
      cwd,
      lifecycleKey: request.lifecycleKey,
      resolveProjectRoot: setup.resolveProjectRoot,
      authority: setup.authority,
    });
    throwIfAborted(signal);
    if (!authorityUnchanged) return lifecycleReadFailure("lifecycle_read_authority_changed");
    if (records.length >= MAX_LIFECYCLE_READ_RESULTS) {
      return lifecycleReadFailure("lifecycle_read_verification_failed");
    }

    const results = orderedLifecycleReadDescriptors(
      records,
      admission?.approvedWarningBindings,
    );
    if (!results) return lifecycleReadFailure("lifecycle_read_verification_failed");
    return boundedLifecycleReadResult({
      schemaVersion: 1,
      status: "completed" as const,
      lifecycleKey: request.lifecycleKey,
      results: results.slice(0, request.limit),
    });
  } catch {
    throwIfAborted(signal);
    return unexpectedLifecycleReadFailure();
  }
};

export const coordinateLifecycleGet = async (
  requestValue: unknown,
  supplied?: LifecycleIntegrationDependencies,
  signal?: AbortSignal,
) => {
  const input = lifecycleReadGetRequest(requestValue);
  if (!input) return lifecycleReadFailure("lifecycle_read_request_invalid");
  const lifecycleKey = input.kind === "selector"
    ? input.selector.lifecycleKey
    : input.request.lifecycleKey;
  const admission = consumeLifecycleContentAdmission(
    supplied?.contentScreeningAdmission,
    "read-get",
  );
  try {
    throwIfAborted(signal);
    const setup = await lifecycleReadSetup({ lifecycleKey, supplied, signal });
    throwIfAborted(signal);
    if ("status" in setup) return setup;
    const cwd = supplied?.cwd;
    if (typeof cwd !== "string") return lifecycleReadFailure("lifecycle_read_authority_unavailable");
    const warningCandidates: {
      binding: string;
      findings: readonly LifecycleContentFinding[];
    }[] = [];
    const captureWarnings = () => {
      if (!admission && warningCandidates.length > 0) {
        supplied?.captureContentWarning?.({
          kind: "read-get",
          warnings: warningCandidates.map(({ binding, findings }) => ({
            binding,
            findings: [...findings],
          })),
        });
      }
    };
    let request: LifecycleReadGetRequest;
    if (input.kind === "descriptor") {
      request = input.request;
    } else {
      const selected = await lifecycleReadSelectorDescriptor({
        selector: input.selector,
        setup,
        approvedWarningBindings: admission?.approvedWarningBindings,
        captureWarningBindings: (warnings) => warningCandidates.push(...warnings),
        signal,
      });
      throwIfAborted(signal);
      if (!selected.descriptor) {
        const failure = selected.failure ?? { code: "lifecycle_read_verification_failed" };
        captureWarnings();
        return lifecycleReadFailure(failure.code, failure.diagnostic);
      }
      request = selected.descriptor;
    }
    const nativeReference = await lifecycleReadNativeReference({ request, setup });
    throwIfAborted(signal);
    if (!nativeReference) {
      return lifecycleReadFailure("lifecycle_read_verification_failed", {
        stage: "verification",
        code: "get_reference_projection_failed",
      });
    }
    const authorityUnchangedBeforeRead = await sameLifecycleReadAuthority({
      cwd,
      lifecycleKey: request.lifecycleKey,
      resolveProjectRoot: setup.resolveProjectRoot,
      authority: setup.authority,
    });
    throwIfAborted(signal);
    if (!authorityUnchangedBeforeRead) return lifecycleReadFailure("lifecycle_read_authority_changed");

    const read = setup.authority.kind === "pinned"
      ? await routePinnedLifecycleGet({
        routing: setup.routing,
        pin: setup.authority.pin,
        reference: nativeReference,
        approvedWarningBindings: admission?.approvedWarningBindings,
        captureWarningBindings: (warnings) => warningCandidates.push(...warnings),
        signal,
      })
      : await routeLifecycleGet({
        routing: setup.routing,
        provider: "qdrant",
        reference: nativeReference,
        approvedWarningBindings: admission?.approvedWarningBindings,
        captureWarningBindings: (warnings) => warningCandidates.push(...warnings),
        signal,
      });
    throwIfAborted(signal);
    if (read.status !== "verified") {
      const failure = lifecycleReadRouteFailure(read);
      captureWarnings();
      return lifecycleReadFailure(failure.code, failure.diagnostic);
    }
    const warningOptions = { approvedWarningBindings: admission?.approvedWarningBindings };
    const record = verifyRoutedLifecycleReadRecord(read.record, {
      lifecycleKey: request.lifecycleKey,
      phase: request.phase,
    }, warningOptions);
    if (!record) {
      return lifecycleReadFailure("lifecycle_read_verification_failed", {
        stage: "verification",
        code: "get_record_verification_failed",
      });
    }
    const descriptor = lifecycleReadDescriptor(
      record,
      admission?.approvedWarningBindings,
    );
    if (!descriptor) {
      return lifecycleReadFailure("lifecycle_read_verification_failed", {
        stage: "verification",
        code: "get_descriptor_projection_failed",
      });
    }
    if (
      descriptor.artifactId !== request.artifactId
      || descriptor.recordKey !== request.recordKey
      || descriptor.contentHash !== request.contentHash
      || !sameLifecycleReadReference(record, request.reference, warningOptions)
    ) {
      return lifecycleReadFailure("lifecycle_read_verification_failed", {
        stage: "verification",
        code: "get_descriptor_mismatch",
      });
    }
    const authorityUnchangedAfterRead = await sameLifecycleReadAuthority({
      cwd,
      lifecycleKey: request.lifecycleKey,
      resolveProjectRoot: setup.resolveProjectRoot,
      authority: setup.authority,
    });
    throwIfAborted(signal);
    if (!authorityUnchangedAfterRead) return lifecycleReadFailure("lifecycle_read_authority_changed");

    return boundedLifecycleReadResult({
      schemaVersion: 1,
      status: "completed" as const,
      ...descriptor,
      artifact: record.artifact,
    });
  } catch {
    throwIfAborted(signal);
    return unexpectedLifecycleReadFailure();
  }
};

export const recallLifecycle = async (
  query: string,
  cwd?: string,
  supplied?: LifecycleIntegrationDependencies,
  signal?: AbortSignal,
) => {
  const selection = lifecycleRecallQuery(query);
  if (!selection) return null;
  if (!cwd) return recallCorpusLifecycle(query, supplied?.corpus, signal);
  const pinned = await recallPinnedLifecycle({
    lifecycleKey: selection.lifecycleKey,
    phase: selection.phase as LifecyclePhase,
    cwd,
    supplied,
    signal,
  });
  if (pinned.status === "absent") return recallCorpusLifecycle(query, supplied?.corpus, signal);
  if (
    selection.phase === "plan"
    && pinned.status === "pending"
    && pinned.attempt.status === "authorized"
  ) {
    const attempt = { ...pinned.attempt };
    const recalled = await recallCorpusLifecycle(query, supplied?.corpus, signal);
    const resolveProjectRoot = supplied?.resolveProjectRoot ?? defaultResolveCycleProjectRoot;
    const rechecked = await loadLifecyclePinStateWith(resolveProjectRoot)(
      cwd,
      selection.lifecycleKey,
    );
    throwIfAborted(signal);
    return recalled && sameAuthorizedLifecyclePinAttempt(rechecked, attempt)
      ? recalled
      : null;
  }
  return pinned.status === "verified"
    ? { structuredContent: { results: pinned.records.map(routedRecallRecord) } }
    : null;
};

const CONTEXT_SOURCE_PARAMETERS = Type.Object({}, {
  oneOf: [
    Type.Object({ type: StringEnum(["jira"] as const, { description: "Source kind. Supply only the fields required for the selected kind." }), key: Type.String({ pattern: "^[A-Z][A-Z0-9]+-\\d+$", description: "Required for jira; extract the uppercase issue key from a Jira URL." }) }, { additionalProperties: false }),
    Type.Object({ type: StringEnum(["taskwarrior"] as const, { description: "Source kind. Supply only the fields required for the selected kind." }), project: Type.String({ pattern: "^[\\w.-]+$", description: "Required for taskwarrior." }), uuid: Type.String({ pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", description: "Required for taskwarrior." }) }, { additionalProperties: false }),
    Type.Object({
      type: StringEnum(["plane"] as const, { description: "Source kind. Supply only the fields required for the selected kind." }),
      workspace: Type.String({ maxLength: 1_024, pattern: "^[A-Za-z0-9][A-Za-z0-9._~-]*$", description: "Required Plane workspace identifier." }),
      project: Type.String({ maxLength: 1_024, pattern: "^[A-Z][A-Z0-9_]*$", description: "Required uppercase Plane project identifier." }),
      sequenceId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Required positive Plane work-item sequence ID." }),
    }, { additionalProperties: false }),
    Type.Object({ type: StringEnum(["file"] as const, { description: "Source kind. Supply only the fields required for the selected kind." }), path: Type.String({ minLength: 1, maxLength: 1_024, description: "Required for file; project-root-contained regular file path." }) }, { additionalProperties: false }),
    Type.Object({ type: StringEnum(["vestige"] as const, { description: "Source kind. Supply only the fields required for the selected kind." }), id: Type.String({ pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", description: "Required for vestige; memory UUID." }) }, { additionalProperties: false }),
    Type.Object({ type: StringEnum(["lifecycle"] as const, { description: "Source kind. Supply a validated lifecycle key." }), key: Type.String({ minLength: 1, maxLength: 512, pattern: "^[^\\r\\n]+$", description: "Required for lifecycle; a non-empty lifecycle key without line breaks." }) }, { additionalProperties: false }),
    Type.Object({ type: StringEnum(["reference"] as const, { description: "Source kind. Raw manual-phase source identifier, normalized before external access." }), value: Type.String({ minLength: 1, maxLength: 1_024, description: "Canonical colon identifier or accepted space-delimited alias." }) }, { additionalProperties: false }),
    Type.Object({ type: StringEnum(["text"] as const, { description: "Source kind. Supply only the fields required for the selected kind." }), title: Type.String({ minLength: 1, maxLength: 256, description: "Required for text." }), content: Type.String({ minLength: 1, maxLength: 64_000, description: "Required for text." }) }, { additionalProperties: false }),
  ],
  description: "Exactly one source: jira uses key; taskwarrior uses project and uuid; plane uses workspace, project, and sequenceId; file uses path; vestige uses id; lifecycle uses key; reference uses a canonical identifier or space alias; text uses title and content.",
});

const CONTEXT_DURABLE_KNOWLEDGE_PARAMETERS = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 2_000, description: "Read-only Qdrant query." }),
  collection: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Optional legacy collection; only ima-knowledge is supported." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum durable references." })),
}, { additionalProperties: false });

const CONTEXT_TOOL_PARAMETERS = Type.Object({
  source: CONTEXT_SOURCE_PARAMETERS,
  durableKnowledge: Type.Optional(CONTEXT_DURABLE_KNOWLEDGE_PARAMETERS),
}, { additionalProperties: false });

const CONTROL_SAFE_STRING_PATTERN = "^[^\\u0000-\\u001F\\u007F-\\u009F]*$";
const LIFECYCLE_IDENTITY_PARAMETERS = Type.Object({
  project: Type.String({ minLength: 1, maxLength: 256, pattern: CONTROL_SAFE_STRING_PATTERN }),
  lifecycleKey: Type.String({ minLength: 1, maxLength: 512, pattern: CONTROL_SAFE_STRING_PATTERN }),
  lifecycleRootMemoryId: Type.String({ maxLength: 512, pattern: CONTROL_SAFE_STRING_PATTERN }),
  taskwarriorProject: Type.String({ maxLength: 256, pattern: CONTROL_SAFE_STRING_PATTERN }),
  taskwarriorTask: Type.String({ maxLength: 256, pattern: CONTROL_SAFE_STRING_PATTERN }),
  taskwarriorUuid: Type.String({ maxLength: 128, pattern: CONTROL_SAFE_STRING_PATTERN }),
  jiraKey: Type.String({ maxLength: 128, pattern: CONTROL_SAFE_STRING_PATTERN }),
  planeWorkspace: Type.Optional(Type.Union([
    Type.Literal(""),
    Type.String({ maxLength: 128, pattern: PLANE_WORKSPACE_PATTERN.source }),
  ], { description: "Optional Plane workspace; supply only with planeWorkItem." })),
  planeWorkItem: Type.Optional(Type.Union([
    Type.Literal(""),
    Type.String({ maxLength: 128, pattern: PLANE_WORK_ITEM_PATTERN.source }),
  ], { description: "Optional Plane work item; supply only with planeWorkspace." })),
  sourceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 1_024, pattern: CONTROL_SAFE_STRING_PATTERN }), { maxItems: 64 }),
  priorArtifactIds: Type.Array(Type.String({ minLength: 1, maxLength: 1_024, pattern: CONTROL_SAFE_STRING_PATTERN }), { maxItems: 64 }),
}, { additionalProperties: false });

const LIFECYCLE_WRITE_TOOL_PARAMETERS = Type.Object({
  type: Type.String(),
  identity: LIFECYCLE_IDENTITY_PARAMETERS,
  summary: Type.String({ minLength: 1, maxLength: 2_000, pattern: CONTROL_SAFE_STRING_PATTERN, description: "Required approved one-line phase outcome; validated to 2,000 UTF-8 bytes without control characters." }),
  artifact: Type.String({ minLength: 1, maxLength: 128_000 }),
  provider: Type.Optional(Type.String({ pattern: "^(?:bookstack|qdrant|serena|markdown)$", description: "Optional user-confirmed provider for an unpinned lifecycle. A durable pin overrides this value." })),
  pinAttemptId: Type.Optional(Type.String({ pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89ab][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$", description: "Checkout-local pre-persistence authorization identifier from an interactive cycle start." })),
}, { additionalProperties: false });

const LIFECYCLE_CONTENT_ADJUDICATION_DECISION_PARAMETERS = Type.Object({
  finding: Type.String({
    pattern: PIN_ATTEMPT_ID_PATTERN.source,
    description: "Opaque finding handle supplied by the pending lifecycle warning.",
  }),
  decision: StringEnum([
    "continue_after_review",
    "reject",
  ] as const, { description: "Closed decision for one disclosed warning finding." }),
}, { additionalProperties: false });

const LIFECYCLE_CONTENT_ADJUDICATION_PARAMETERS = Type.Object({
  handle: Type.String({
    pattern: PIN_ATTEMPT_ID_PATTERN.source,
    description: "Opaque process-local lifecycle content adjudication handle.",
  }),
  decisions: Type.Array(LIFECYCLE_CONTENT_ADJUDICATION_DECISION_PARAMETERS, {
    minItems: 1,
    maxItems: MAX_LIFECYCLE_CONTENT_DECISIONS,
    description: "One explicit closed decision for every disclosed warning finding.",
  }),
}, { additionalProperties: false });

const LIFECYCLE_TOOL_PARAMETERS = Type.Object({}, {
  oneOf: [
    LIFECYCLE_WRITE_TOOL_PARAMETERS,
    Type.Object({
      contentAdjudication: LIFECYCLE_CONTENT_ADJUDICATION_PARAMETERS,
    }, { additionalProperties: false }),
  ],
});

const LIFECYCLE_READ_PHASE_PARAMETERS = StringEnum([
  "plan",
  "implementation",
  "test",
  "review",
  "resolution",
  "rereview",
  "document",
  "decision",
  "closeout",
] as const, { description: "Exact persisted lifecycle phase. document never expands to closeout in this public read surface." });

const LIFECYCLE_READ_REFERENCE_PARAMETERS = Type.Union([
  Type.Object({
    schemaVersion: Type.Literal(1),
    fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    nonce: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" }),
    contentHash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
  }, { additionalProperties: false }),
  Type.Object({
    schemaVersion: Type.Literal(1),
    fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    logicalId: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    requestHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    canonicalHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  }, { additionalProperties: false }),
  Type.Object({
    schemaVersion: Type.Literal(1),
    fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    checkoutFingerprint: Type.String({ pattern: "^[a-f0-9]{64}$", description: "Markdown checkout binding; never an absolute path." }),
    receiptHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  }, { additionalProperties: false }),
  Type.Object({
    schemaVersion: Type.Literal(1),
    fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    pageId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    originFingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    pageHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    revisionCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    updatedAt: Type.String({ minLength: 1, maxLength: 1_024, pattern: CONTROL_SAFE_STRING_PATTERN }),
  }, { additionalProperties: false }),
]);

const LIFECYCLE_RECALL_TOOL_PARAMETERS = Type.Object({
  lifecycleKey: Type.String({ minLength: 1, maxLength: 512, pattern: CONTROL_SAFE_STRING_PATTERN, description: "Exact lifecycle key. Provider and checkout are derived from trusted local authority." }),
  phase: Type.Optional(LIFECYCLE_READ_PHASE_PARAMETERS),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIFECYCLE_READ_RESULTS, description: "Maximum verified descriptors; defaults to 50." })),
}, { additionalProperties: false });

const LIFECYCLE_GET_SELECTOR_TOOL_PARAMETERS = Type.Object({
  lifecycleKey: Type.String({ minLength: 1, maxLength: 512, pattern: CONTROL_SAFE_STRING_PATTERN }),
  phase: LIFECYCLE_READ_PHASE_PARAMETERS,
  artifactId: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" }),
}, { additionalProperties: false });

const LIFECYCLE_GET_DESCRIPTOR_TOOL_PARAMETERS = Type.Object({
  lifecycleKey: Type.String({ minLength: 1, maxLength: 512, pattern: CONTROL_SAFE_STRING_PATTERN }),
  phase: LIFECYCLE_READ_PHASE_PARAMETERS,
  artifactId: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" }),
  recordKey: Type.String({ minLength: 1, maxLength: 512, pattern: CONTROL_SAFE_STRING_PATTERN }),
  contentHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  reference: LIFECYCLE_READ_REFERENCE_PARAMETERS,
  summary: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_LIFECYCLE_READ_SUMMARY_BYTES, pattern: CONTROL_SAFE_STRING_PATTERN })),
}, { additionalProperties: false });

const LIFECYCLE_GET_TOOL_PARAMETERS = Type.Object({
  lifecycleKey: Type.String({ minLength: 1, maxLength: 512, pattern: CONTROL_SAFE_STRING_PATTERN }),
  phase: LIFECYCLE_READ_PHASE_PARAMETERS,
  artifactId: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" }),
  recordKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512, pattern: CONTROL_SAFE_STRING_PATTERN })),
  contentHash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
  reference: Type.Optional(LIFECYCLE_READ_REFERENCE_PARAMETERS),
  summary: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_LIFECYCLE_READ_SUMMARY_BYTES, pattern: CONTROL_SAFE_STRING_PATTERN })),
}, {
  additionalProperties: false,
  oneOf: [
    LIFECYCLE_GET_SELECTOR_TOOL_PARAMETERS,
    LIFECYCLE_GET_DESCRIPTOR_TOOL_PARAMETERS,
  ],
});

const BOOKSTACK_LIFECYCLE_RECOVERY_PARAMETERS = Type.Object({
  request: Type.Object({
    type: Type.String(),
    identity: LIFECYCLE_IDENTITY_PARAMETERS,
    summary: Type.String({ minLength: 1, maxLength: 2_000, pattern: CONTROL_SAFE_STRING_PATTERN }),
    artifact: Type.String({ minLength: 1, maxLength: 128_000 }),
  }, { additionalProperties: false }),
  placement: Type.Object({
    projectSlug: Type.String({ minLength: 1, maxLength: 100, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
    sourceRef: Type.String({ minLength: 1, maxLength: 1_024, pattern: CONTROL_SAFE_STRING_PATTERN }),
    lifecycleKey: Type.String({ minLength: 1, maxLength: 512, pattern: CONTROL_SAFE_STRING_PATTERN }),
    shelfId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    shelfSlug: Type.Literal("lifecycle-artifacts"),
    bookId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    bookSlug: Type.String({ minLength: 1, maxLength: 100, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
    chapterId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    chapterSlug: Type.String({ minLength: 1, maxLength: 100, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
  }, { additionalProperties: false }),
  attemptId: Type.String({
    pattern: PIN_ATTEMPT_ID_PATTERN.source,
    description: "Exact checkout-local BookStack writing attempt ID. This recovery never selects a provider or creates containers.",
  }),
}, { additionalProperties: false });

const safeLifecycleToolIdentity = (value: unknown, prefix: string) => typeof value === "string"
  && value.length > 0
  && value.length <= 1_024
  && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  ? `${prefix}:${value}`
  : null;

const lifecycleContentOwner = (ctx: ExtensionContext) => {
  let sessionId: unknown;
  try {
    sessionId = ctx.sessionManager?.getSessionId?.();
  } catch {
    sessionId = undefined;
  }
  return safeLifecycleToolIdentity(sessionId, "session");
};

const lifecycleContentCheckout = (cwd: unknown) => {
  if (typeof cwd !== "string" || !cwd || /[\u0000-\u001f\u007f-\u009f]/.test(cwd)) return null;
  try {
    return safeLifecycleToolIdentity(resolve(cwd), "checkout");
  } catch {
    return null;
  }
};

const emptyLifecycleContentScreening: LifecycleContentScreening = {
  tier: "allow",
  findings: [],
};

const closedDataArray = (value: unknown, maximum: number): unknown[] | null => {
  try {
    if (!Array.isArray(value) || value.length > maximum) return null;
    const values: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) return null;
      values.push(descriptor.value);
    }
    return values;
  } catch {
    return null;
  }
};

const lifecycleContentAdjudicationEnvelope = (value: unknown): {
  handle: string;
  decisions: readonly { finding: string; decision: LifecycleContentDecision }[];
} | null => {
  const request = ownDataRecord(value, ["contentAdjudication"]);
  const adjudication = request && ownDataRecord(request.contentAdjudication, ["handle", "decisions"]);
  const handle = adjudication?.handle;
  const decisions = closedDataArray(adjudication?.decisions, MAX_LIFECYCLE_CONTENT_DECISIONS);
  if (typeof handle !== "string" || !PIN_ATTEMPT_ID_PATTERN.test(handle) || !decisions?.length) {
    return null;
  }
  const projected = decisions.map((decision) => ownDataRecord(decision, ["finding", "decision"]));
  if (projected.some((decision) => decision === null)) return null;
  const normalized = (projected as Record<string, unknown>[]).map((decision) => ({
    finding: typeof decision.finding === "string" ? decision.finding.toLowerCase() : "",
    decision: decision.decision,
  }));
  return normalized.every(({ finding, decision }) =>
    PIN_ATTEMPT_ID_PATTERN.test(finding)
    && (decision === "continue_after_review" || decision === "reject"),
  )
    ? {
      handle: handle.toLowerCase(),
      decisions: normalized as { finding: string; decision: LifecycleContentDecision }[],
    }
    : null;
};

const hasLifecycleContentAdjudication = (value: unknown) => {
  try {
    return Boolean(value && typeof value === "object" && Object.hasOwn(value, "contentAdjudication"));
  } catch {
    return true;
  }
};

const lifecycleContentAdjudicationCode = (status: string): LifecycleContentScreeningFailureCode => {
  if (status === "expired") return "lifecycle_content_adjudication_expired";
  if (status === "mismatch") return "lifecycle_content_adjudication_mismatch";
  if (status === "rejected") return "lifecycle_content_adjudication_declined";
  if (status === "invalid" || status === "missing") return "lifecycle_content_adjudication_invalid";
  return "lifecycle_content_adjudication_unavailable";
};

const createWarningDecisions = (input: readonly {
  binding?: string;
  findings: readonly LifecycleContentFinding[];
}[]): PendingLifecycleContentDecision[] => input.map(({ binding, findings }) => ({
  finding: randomUUID(),
  findings: findings.map((finding) => ({ ...finding })),
  ...(binding ? { binding } : {}),
}));

const pendingLifecycleContentOperation = (
  value: unknown,
): PendingLifecycleContentOperation | null => {
  const operation = ownDataRecord(
    value,
    ["kind", "request", "warningDecisions"],
    ["approvedWarningBindings"],
  );
  if (!operation) return null;
  const kind = operation.kind;
  if (kind !== "write" && kind !== "read-get" && kind !== "read-recall") return null;
  const decisions = closedDataArray(operation.warningDecisions, MAX_LIFECYCLE_CONTENT_DECISIONS);
  if (!decisions?.length) return null;
  const projected = decisions.map((entry) => ownDataRecord(entry, ["finding", "findings"], ["binding"]));
  if (projected.some((entry) => entry === null)) return null;
  const warningDecisions = (projected as Record<string, unknown>[]).map((entry) => {
    const finding = typeof entry.finding === "string" ? entry.finding.toLowerCase() : "";
    const findings = closedDataArray(entry.findings, 16);
    const binding = entry.binding;
    return {
      finding,
      findings: findings?.map((finding) => ownDataRecord(
        finding,
        ["category", "field", "index", "line", "column"],
      )) ?? [],
      ...(typeof binding === "string" ? { binding } : {}),
    };
  });
  if (
    warningDecisions.some(({ finding, findings, binding }) =>
      !PIN_ATTEMPT_ID_PATTERN.test(finding)
      || findings.length === 0
      || findings.some((item) => item === null)
      || binding !== undefined && !/^[a-f0-9]{64}$/.test(binding),
    )
    || new Set(warningDecisions.map(({ finding }) => finding)).size !== warningDecisions.length
  ) return null;
  const suppliedBindings = closedDataArray(
    operation.approvedWarningBindings,
    MAX_LIFECYCLE_CONTENT_DECISIONS,
  );
  const derivedBindings = warningDecisions.flatMap(({ binding }) => binding ? [binding] : []);
  if (kind === "write" && operation.approvedWarningBindings !== undefined) return null;
  if (
    kind !== "write"
    && (
      warningDecisions.some(({ binding }) => binding === undefined)
      || !suppliedBindings
      || suppliedBindings.length !== derivedBindings.length
      || new Set(suppliedBindings).size !== suppliedBindings.length
      || suppliedBindings.some((binding) => typeof binding !== "string" || !derivedBindings.includes(binding))
    )
  ) return null;
  return {
    kind,
    request: operation.request,
    warningDecisions: warningDecisions.map(({ finding, findings, binding }) => ({
      finding,
      findings: findings as LifecycleContentFinding[],
      ...(binding ? { binding } : {}),
    })),
    ...(kind === "write"
      ? {}
      : {
        approvedWarningBindings: derivedBindings,
      }),
  };
};

export const beginLifecycleContentAdjudication = (input: {
  ctx: ExtensionContext;
  operation: PendingLifecycleContentOperation;
  screening: LifecycleContentScreening;
}) => {
  const owner = lifecycleContentOwner(input.ctx);
  const checkout = lifecycleContentCheckout(input.ctx.cwd);
  if (!owner || !checkout) {
    return {
      status: "failed" as const,
      result: lifecycleContentScreeningFailure(
        "lifecycle_content_adjudication_unavailable",
        input.screening,
      ),
    };
  }
  const disclosedFindings = input.operation.warningDecisions.flatMap(({ findings }) => findings);
  if (disclosedFindings.length > MAX_LIFECYCLE_CONTENT_FINDINGS) {
    const finding = disclosedFindings[MAX_LIFECYCLE_CONTENT_FINDINGS];
    return {
      status: "failed" as const,
      result: lifecycleContentScreeningFailure("lifecycle_content_blocked", {
        tier: "block",
        findings: [{
          category: "finding_overflow",
          field: finding.field,
          index: finding.index,
          line: finding.line,
          column: finding.column,
        }],
      }),
    };
  }
  const pending = lifecycleContentAdjudicator.begin({
    owner,
    checkout,
    operation: input.operation,
  });
  if (pending.status !== "pending") {
    return {
      status: "failed" as const,
      result: lifecycleContentScreeningFailure(
        lifecycleContentAdjudicationCode(pending.status),
        input.screening,
      ),
    };
  }
  return {
    status: "pending" as const,
    result: lifecycleContentWarningResult({
      handle: pending.handle,
      warningDecisions: input.operation.warningDecisions,
    }),
  };
};

const admitLifecycleToolContent = (input: {
  request: unknown;
  ctx: ExtensionContext;
}) => {
  const screening = screenLifecycleContent(input.request);
  if (screening.tier === "block") {
    return {
      status: "failed" as const,
      result: lifecycleContentScreeningFailure("lifecycle_content_blocked", screening),
    };
  }
  if (screening.tier === "allow") return { status: "admitted" as const };
  return beginLifecycleContentAdjudication({
    ctx: input.ctx,
    operation: {
      kind: "write",
      request: input.request,
      warningDecisions: createWarningDecisions(
        screening.findings.map((finding) => ({ findings: [finding] })),
      ),
    },
    screening,
  });
};

export const continueLifecycleContentAdjudication = (input: {
  adjudication: {
    handle: string;
    decisions: readonly { finding: string; decision: LifecycleContentDecision }[];
  };
  ctx: ExtensionContext;
}) => {
  const owner = lifecycleContentOwner(input.ctx);
  const checkout = lifecycleContentCheckout(input.ctx.cwd);
  if (!owner || !checkout) {
    return {
      status: "failed" as const,
      result: lifecycleContentScreeningFailure(
        "lifecycle_content_adjudication_unavailable",
        emptyLifecycleContentScreening,
      ),
    };
  }
  const settled = lifecycleContentAdjudicator.claim({
    handle: input.adjudication.handle,
    owner,
    checkout,
  });
  if (settled.status !== "claimed") {
    return {
      status: "failed" as const,
      result: lifecycleContentScreeningFailure(
        lifecycleContentAdjudicationCode(settled.status),
        emptyLifecycleContentScreening,
      ),
    };
  }
  const operation = pendingLifecycleContentOperation(settled.operation);
  if (!operation) {
    return {
      status: "failed" as const,
      result: lifecycleContentScreeningFailure(
        "lifecycle_content_adjudication_invalid",
        emptyLifecycleContentScreening,
      ),
    };
  }
  const supplied = input.adjudication.decisions;
  const expectedFindings = new Set(operation.warningDecisions.map(({ finding }) => finding));
  const suppliedFindings = new Set(supplied.map(({ finding }) => finding));
  if (
    supplied.length !== operation.warningDecisions.length
    || suppliedFindings.size !== supplied.length
    || suppliedFindings.size !== expectedFindings.size
    || [...suppliedFindings].some((finding) => !expectedFindings.has(finding))
  ) {
    return {
      status: "failed" as const,
      result: lifecycleContentScreeningFailure(
        "lifecycle_content_adjudication_invalid",
        emptyLifecycleContentScreening,
      ),
    };
  }
  if (supplied.some(({ decision }) => decision === "reject")) {
    return {
      status: "failed" as const,
      result: lifecycleContentScreeningFailure(
        "lifecycle_content_adjudication_declined",
        emptyLifecycleContentScreening,
      ),
    };
  }
  if (operation.kind !== "write") {
    return {
      status: "read" as const,
      operation,
      admission: registerLifecycleContentAdmission({
        kind: operation.kind,
        approvedWarningBindings: operation.approvedWarningBindings,
      }),
    };
  }

  const screening = screenLifecycleContent(operation.request);
  if (screening.tier === "block") {
    return {
      status: "failed" as const,
      result: lifecycleContentScreeningFailure("lifecycle_content_blocked", screening),
    };
  }
  return {
    status: "write" as const,
    request: operation.request,
    admission: registerLifecycleContentAdmission({ kind: "write" }),
  };
};

export const dispatchLifecycleContentRead = async (input: {
  operation: PendingLifecycleContentOperation;
  ctx: ExtensionContext;
  admission: LifecycleContentAdmission;
  signal?: AbortSignal;
  supplied?: LifecycleIntegrationDependencies;
}) => {
  if (input.operation.kind !== "read-recall" && input.operation.kind !== "read-get") {
    return lifecycleContentScreeningFailure(
      "lifecycle_content_adjudication_invalid",
      emptyLifecycleContentScreening,
    );
  }
  const supplied = {
    ...(input.supplied ?? {}),
    cwd: input.ctx.cwd,
    contentScreeningAdmission: input.admission,
  };
  return input.operation.kind === "read-recall"
    ? coordinateLifecycleRecall(input.operation.request, supplied, input.signal)
    : coordinateLifecycleGet(input.operation.request, supplied, input.signal);
};

export default function integrations(pi: ExtensionAPI) {
  pi.registerTool({ name: "ima_context", label: "IMA context", description: "Build Serena-first project context from one typed source: jira/key, taskwarrior/project+uuid, plane/workspace+project+sequenceId, file/path, vestige/id, lifecycle/key, reference/value, or text/title+content. Reference accepts canonical taskwarrior:<project>:<uuid>, plane:<workspace>:PROJ-123, jira:<KEY>, lifecycle:<lifecycle-key>, and vestige:<UUID> forms plus space aliases. Optional durableKnowledge requires query and accepts the supported ima-knowledge collection and limit.", parameters: CONTEXT_TOOL_PARAMETERS, prepareArguments: prepareContextArguments, execute: async (_id, request, signal, _update, ctx) => ({ content: [{ type: "text", text: JSON.stringify(await coordinateContext(request, ctx.cwd, undefined, signal)) }], details: {} }) });
  pi.registerTool({ name: "ima_lifecycle", label: "IMA lifecycle", description: "Store and directly verify one lifecycle artifact through the selected provider. Warning adjudication resumes one exact owner-bound lifecycle operation through an opaque process-local handle.", parameters: LIFECYCLE_TOOL_PARAMETERS, execute: async (_id, request, signal, _update, ctx) => {
    const continuation = lifecycleContentAdjudicationEnvelope(request);
    if (hasLifecycleContentAdjudication(request) && !continuation) {
      const result = lifecycleContentScreeningFailure(
        "lifecycle_content_adjudication_invalid",
        emptyLifecycleContentScreening,
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    }

    let operationRequest = request;
    let admission: LifecycleContentAdmission | undefined;
    if (continuation) {
      const resumed = continueLifecycleContentAdjudication({ adjudication: continuation, ctx });
      if (resumed.status === "failed") {
        return {
          content: [{ type: "text", text: JSON.stringify(resumed.result) }],
          details: resumed.result,
        };
      }
      if (resumed.status === "read") {
        const result = await dispatchLifecycleContentRead({
          operation: resumed.operation,
          ctx,
          admission: resumed.admission,
          signal,
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      }
      operationRequest = resumed.request;
      admission = resumed.admission;
    } else {
      const initial = admitLifecycleToolContent({ request, ctx });
      if (initial.status !== "admitted") {
        return {
          content: [{ type: "text", text: JSON.stringify(initial.result) }],
          details: initial.result,
        };
      }
    }

    const interactive = ctx.mode === "tui" && ctx.hasUI && typeof ctx.ui.select === "function";
    const requestEnvelope = lifecycleRequestEnvelope(operationRequest);
    let authority: LifecyclePinLoadResult | null = null;
    if (requestEnvelope) {
      try {
        authority = await loadLifecyclePinStateWith(defaultResolveCycleProjectRoot)(
          ctx.cwd,
          requestEnvelope.request.identity.lifecycleKey,
        );
      } catch {
        authority = null;
      }
    }
    throwIfAborted(signal);
    const pinnedProvider = authority?.status === "pinned"
      ? authority.pin.provider
      : null;
    let routedRequest = requestEnvelope
      ? lifecycleRequestForRouting(requestEnvelope, requestEnvelope.provider ?? pinnedProvider)
      : operationRequest;
    if (interactive && requestEnvelope && authority?.status === "absent" && !requestEnvelope.provider) {
      const recommendation = resolveLifecycleProviderRecommendation();
      const selected = recommendation.ok
        ? normalizeLifecycleProvider(await ctx.ui.select("Select lifecycle provider", recommendation.recommendation.candidates))
        : null;
      if (!selected) {
        const result = {
          status: "failed",
          artifactId: null,
          recordKey: null,
          error: { code: "lifecycle_provider_selection_required", message: "Lifecycle integration failed: lifecycle_provider_selection_required." },
        };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      }
      routedRequest = lifecycleRequestForRouting(requestEnvelope, selected);
    }
    const confirmProvider = interactive && authority?.status !== "pinned"
      ? async ({ recommendation, provider }: { recommendation: LifecycleProviderRecommendation; provider: LifecycleProviderName }) => {
        const source = recommendation.source === "default" ? "built-in default" : `${recommendation.source} preference`;
        const sharing = provider === "bookstack"
          ? " BookStack shares lifecycle evidence with the configured organization content."
          : "";
        return ctx.ui.confirm("Confirm lifecycle provider", `Use ${provider} from ${source} for this lifecycle?${sharing}`);
      }
      : undefined;
    const confirmBookStackPlacement = interactive
      ? async (preview: any) => ctx.ui.confirm(
        "Approve BookStack lifecycle placement",
        typeof preview?.sharingImplications === "string"
          ? preview.sharingImplications
          : "Approve the shared BookStack lifecycle placement?",
      )
      : undefined;
    const result = await coordinateLifecycle(routedRequest, {
      cwd: ctx.cwd,
      confirmProvider,
      confirmBookStackPlacement,
      ...(admission ? { contentScreeningAdmission: admission } : {}),
    }, signal);
    return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
  } });
  pi.registerTool({
    name: "ima_lifecycle_recall",
    label: "Recall IMA lifecycle artifacts",
    description: "Read-only lifecycle recall. Returns at most 50 complete-identity descriptors from the checkout's pinned provider, or exact all-phase historical Qdrant authority when genuinely unpinned. It never selects a provider, writes, pins, falls back, or exposes native provider locations.",
    parameters: LIFECYCLE_RECALL_TOOL_PARAMETERS,
    execute: async (_id, request, signal, _update, ctx) => {
      let warning: {
        warnings: readonly {
          binding: string;
          findings: readonly LifecycleContentFinding[];
        }[];
      } | null = null;
      const result = await coordinateLifecycleRecall(request, {
        cwd: ctx.cwd,
        captureContentWarning: (input) => { warning = input; },
      }, signal);
      if (warning) {
        const pending = beginLifecycleContentAdjudication({
          ctx,
          operation: {
            kind: "read-recall",
            request,
            warningDecisions: createWarningDecisions(warning.warnings),
            approvedWarningBindings: warning.warnings.map(({ binding }) => binding),
          },
          screening: {
            tier: "warn",
            findings: warning.warnings.flatMap(({ findings }) => findings),
          },
        });
        return { content: [{ type: "text", text: JSON.stringify(pending.result) }], details: pending.result };
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
  pi.registerTool({
    name: "ima_lifecycle_get",
    label: "Get one IMA lifecycle artifact",
    description: "Read one complete verified lifecycle artifact by selector or saved descriptor. A selector contains lifecycleKey, phase, and artifactId; this tool freshly recalls that exact phase, requires one unambiguous non-saturated match, and projects its proof internally. A complete saved descriptor remains accepted and is verified unchanged. Provider, checkout, endpoint, and resource authority are derived internally. This tool never writes, pins, falls back, or returns partial content.",
    parameters: LIFECYCLE_GET_TOOL_PARAMETERS,
    execute: async (_id, request, signal, _update, ctx) => {
      let warning: {
        warnings: readonly {
          binding: string;
          findings: readonly LifecycleContentFinding[];
        }[];
      } | null = null;
      const result = await coordinateLifecycleGet(request, {
        cwd: ctx.cwd,
        captureContentWarning: (input) => { warning = input; },
      }, signal);
      if (warning) {
        const pending = beginLifecycleContentAdjudication({
          ctx,
          operation: {
            kind: "read-get",
            request,
            warningDecisions: createWarningDecisions(warning.warnings),
            approvedWarningBindings: warning.warnings.map(({ binding }) => binding),
          },
          screening: {
            tier: "warn",
            findings: warning.warnings.flatMap(({ findings }) => findings),
          },
        });
        return { content: [{ type: "text", text: JSON.stringify(pending.result) }], details: pending.result };
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
  pi.registerTool({
    name: "ima_bookstack_lifecycle_recover",
    label: "Recover BookStack lifecycle write",
    description: "TUI-confirmed recovery for one exact checkout-local BookStack writing attempt. It verifies complete stable discovery, may issue at most one page POST, and never selects a provider, provisions containers, falls back, or retries a consumed checkpoint.",
    parameters: BOOKSTACK_LIFECYCLE_RECOVERY_PARAMETERS,
    execute: async (_id, request, signal, _update, ctx) => {
      const interactive = ctx.mode === "tui"
        && ctx.hasUI
        && typeof ctx.ui.confirm === "function";
      const confirmBookStackRecovery = interactive
        ? async (input: BookStackRecoveryConfirmation) => ctx.ui.confirm(
          "Confirm one-time BookStack lifecycle recovery",
          renderBookStackRecoveryConfirmation(input),
        )
        : undefined;
      const result = await coordinateBookStackLifecycleRecovery(request, {
        cwd: ctx.cwd,
        confirmBookStackRecovery,
      }, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
