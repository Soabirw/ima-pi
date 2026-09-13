import { acquireNativeFileLock, type NativeFileLease } from "./ima-agent-session-lock.ts";
import {
  prepareLifecycleArtifact,
  validateLifecycleWriteRequest,
  type LifecycleIdentity,
  type LifecyclePhase,
  type ValidLifecycleRequest,
} from "./ima-lifecycle.ts";
import {
  MAX_SERENA_LIFECYCLE_MEMORY_BYTES,
  MAX_SERENA_LIFECYCLE_MEMORY_CHARACTERS,
  MAX_SERENA_LIFECYCLE_RECALL_LIMIT,
  createSerenaLifecycleRecord,
  isSerenaLifecycleMemoryName,
  normalizeSerenaLifecycleProject,
  projectSerenaLifecycleProject,
  projectSerenaLifecycleReference,
  projectSerenaLifecycleRequest,
  projectSerenaLifecycleSelection,
  serenaLifecycleMemoryName,
  serenaLifecycleNamespacePrefix,
  verifySerenaLifecycleRecord,
  type SerenaLifecycleProject,
  type SerenaLifecycleReference,
  type SerenaLifecycleVerifiedRecord,
} from "./serena-lifecycle-record.ts";
import {
  MAX_SERENA_LIFECYCLE_MEMORY_NAME_BYTES,
  type SerenaLifecycleClient,
  type SerenaLifecycleClientFailureCode,
} from "./serena-lifecycle-client.ts";
import { utf8ByteLength } from "./qdrant-corpus.ts";

export type SerenaLifecycleFailureCode = SerenaLifecycleClientFailureCode
  | "invalid_lifecycle_request"
  | "invalid_lifecycle_summary"
  | "lifecycle_artifact_embeds_prior_artifact"
  | "lifecycle_artifact_too_large"
  | "closeout_document_phase_forbidden"
  | "serena_lease_release_failed"
  | "serena_lease_unavailable"
  | "serena_record_invalid"
  | "serena_record_not_found"
  | "serena_recall_unverifiable"
  | "serena_reference_invalid"
  | "serena_selection_invalid"
  | "serena_target_conflict"
  | "serena_target_unverifiable"
  | "serena_time_invalid"
  | "serena_verification_failed";

export type SerenaLifecycleBlockedResult = {
  provider: "serena";
  status: "blocked";
  code: SerenaLifecycleFailureCode;
  reference?: SerenaLifecycleReference;
};

export type SerenaLifecycleVerifiedResult = {
  provider: "serena";
  status: "verified";
  disposition: "stored" | "unchanged";
  artifactId: string;
  logicalId: string;
  memoryName: string;
  recordKey: string;
  contentHash: string;
  requestHash: string;
  canonicalHash: string;
  lifecycleKey: string;
  phase: LifecyclePhase;
  nonce: string;
  project: string;
  serenaProjectName: string;
  projectFingerprint: string;
  summary: string;
  artifact: string;
  sourceRefs: string[];
  identity: LifecycleIdentity;
  createdAt: string;
  storageSchemaVersion: 1;
  sourceId: string;
  reference: SerenaLifecycleReference;
};

export type SerenaLifecycleProvider = {
  persist: (
    request: unknown,
    signal?: AbortSignal,
  ) => Promise<SerenaLifecycleVerifiedResult | SerenaLifecycleBlockedResult>;
  get: (
    reference: unknown,
    signal?: AbortSignal,
  ) => Promise<SerenaLifecycleVerifiedResult | SerenaLifecycleBlockedResult>;
  recall: (
    selection: unknown,
    signal?: AbortSignal,
  ) => Promise<SerenaLifecycleVerifiedResult[] | SerenaLifecycleBlockedResult>;
  reconcile: (
    reference: unknown,
    signal?: AbortSignal,
  ) => Promise<SerenaLifecycleVerifiedResult | SerenaLifecycleBlockedResult>;
};

export type SerenaLifecycleProjectLease = Pick<NativeFileLease, "release">;
export type SerenaLifecycleLeaseAcquirer = (
  project: SerenaLifecycleProject,
) => Promise<SerenaLifecycleProjectLease | null>;

type ObservedClientResult<Data> =
  | { success: true; data: Data }
  | { success: false; code: SerenaLifecycleClientFailureCode };

type ObservedWriteResult =
  | {
    success: true;
    dispatch: "dispatched";
    settlement: "settled";
  }
  | {
    success: false;
    code: SerenaLifecycleClientFailureCode;
    dispatch: "not_dispatched";
    settlement: "not_dispatched";
  }
  | {
    success: false;
    code: SerenaLifecycleClientFailureCode;
    dispatch: "dispatched";
    settlement: "unknown";
  };

type LeaseWriteResult = {
  result: SerenaLifecycleBlockedResult | undefined;
  dispatch: "not_dispatched" | "dispatched";
  settlement: "not_dispatched" | "settled" | "unknown";
};

type PersistWithLeaseOutcome = {
  result: SerenaLifecycleVerifiedResult | SerenaLifecycleBlockedResult;
  release: "release" | "retain";
};

type PreparedTarget = {
  request: ValidLifecycleRequest;
  memoryName: string;
};

type LeaseClient = {
  activate: (signal?: AbortSignal) => Promise<SerenaLifecycleProject | SerenaLifecycleBlockedResult>;
  list: (signal?: AbortSignal) => Promise<string[] | SerenaLifecycleBlockedResult>;
  read: (memoryName: string, signal?: AbortSignal) => Promise<string | SerenaLifecycleBlockedResult>;
  write: (memoryName: string, content: string, signal?: AbortSignal) => Promise<LeaseWriteResult>;
};

const LIFECYCLE_FAILURE_CODES = new Set<SerenaLifecycleFailureCode>([
  "invalid_lifecycle_request",
  "invalid_lifecycle_summary",
  "lifecycle_artifact_embeds_prior_artifact",
  "lifecycle_artifact_too_large",
  "closeout_document_phase_forbidden",
]);
const CLIENT_FAILURE_CODES = new Set<SerenaLifecycleClientFailureCode>([
  "aborted",
  "serena_memory_listing_unverifiable",
  "serena_memory_read_unavailable",
  "serena_memory_read_unverifiable",
  "serena_memory_write_unknown",
  "serena_project_mismatch",
  "serena_project_unavailable",
  "serena_protocol_unsupported",
]);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

const ownDataRecord = (
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> | null => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string")
      || keys.length !== fields.length
      || !fields.every((field) => keys.includes(field))
    ) return null;

    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => {
      const descriptor = descriptors[key as string];
      return !descriptor
        || descriptor.get
        || descriptor.set
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, "value");
    })) return null;
    return Object.fromEntries(keys.map((key) => [key, descriptors[key as string].value]));
  } catch {
    return null;
  }
};

const ownDataArray = (value: unknown, maximum: number): unknown[] | null => {
  try {
    if (!Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = descriptors.length?.value;
    if (
      !Number.isSafeInteger(length)
      || length < 0
      || length > maximum
      || keys.length !== length + 1
      || keys.some((key) => typeof key !== "string")
      || keys.some((key) => key !== "length" && !/^\d+$/.test(key as string))
      || !descriptors.length
      || descriptors.length.get
      || descriptors.length.set
      || !Object.hasOwn(descriptors.length, "value")
    ) return null;

    const entries: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor
        || descriptor.get
        || descriptor.set
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, "value")
      ) return null;
      entries.push(descriptor.value);
    }
    return entries;
  } catch {
    return null;
  }
};

const detachedProject = (project: SerenaLifecycleProject): SerenaLifecycleProject => ({
  schemaVersion: 1,
  provider: "serena",
  projectName: project.projectName,
  projectPath: project.projectPath,
  fingerprint: project.fingerprint,
});

const detachedIdentity = (identity: LifecycleIdentity): LifecycleIdentity => ({
  project: identity.project,
  lifecycleKey: identity.lifecycleKey,
  lifecycleRootMemoryId: identity.lifecycleRootMemoryId,
  taskwarriorProject: identity.taskwarriorProject,
  taskwarriorTask: identity.taskwarriorTask,
  taskwarriorUuid: identity.taskwarriorUuid,
  jiraKey: identity.jiraKey,
  ...(identity.planeWorkspace && identity.planeWorkItem
    ? {
      planeWorkspace: identity.planeWorkspace,
      planeWorkItem: identity.planeWorkItem,
    }
    : {}),
  sourceRefs: [...identity.sourceRefs],
  priorArtifactIds: [...identity.priorArtifactIds],
});

const detachedRequest = (request: ValidLifecycleRequest): ValidLifecycleRequest => ({
  valid: true,
  type: request.type,
  identity: detachedIdentity(request.identity),
  summary: request.summary,
  artifact: request.artifact,
});

const lifecycleRequestInput = (request: ValidLifecycleRequest) => ({
  type: request.type,
  identity: detachedIdentity(request.identity),
  summary: request.summary,
  artifact: request.artifact,
});

const detachedReference = (reference: SerenaLifecycleReference): SerenaLifecycleReference => ({
  schemaVersion: 1,
  provider: "serena",
  projectFingerprint: reference.projectFingerprint,
  memoryName: reference.memoryName,
  artifactId: reference.artifactId,
  logicalId: reference.logicalId,
  recordKey: reference.recordKey,
  contentHash: reference.contentHash,
  requestHash: reference.requestHash,
  canonicalHash: reference.canonicalHash,
  lifecycleKey: reference.lifecycleKey,
  phase: reference.phase,
  nonce: reference.nonce,
});

const sameProject = (left: SerenaLifecycleProject, right: SerenaLifecycleProject) =>
  left.projectName === right.projectName
  && left.projectPath === right.projectPath
  && left.fingerprint === right.fingerprint;

const sameArray = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const sameRequest = (left: ValidLifecycleRequest, right: ValidLifecycleRequest) =>
  left.type === right.type
  && left.summary === right.summary
  && left.artifact === right.artifact
  && left.identity.project === right.identity.project
  && left.identity.lifecycleKey === right.identity.lifecycleKey
  && left.identity.lifecycleRootMemoryId === right.identity.lifecycleRootMemoryId
  && left.identity.taskwarriorProject === right.identity.taskwarriorProject
  && left.identity.taskwarriorTask === right.identity.taskwarriorTask
  && left.identity.taskwarriorUuid === right.identity.taskwarriorUuid
  && left.identity.jiraKey === right.identity.jiraKey
  && left.identity.planeWorkspace === right.identity.planeWorkspace
  && left.identity.planeWorkItem === right.identity.planeWorkItem
  && sameArray(left.identity.sourceRefs, right.identity.sourceRefs)
  && sameArray(left.identity.priorArtifactIds, right.identity.priorArtifactIds);

const blocked = (
  code: SerenaLifecycleFailureCode,
  reference?: SerenaLifecycleReference,
): SerenaLifecycleBlockedResult => ({
  provider: "serena",
  status: "blocked",
  code,
  ...(reference ? { reference: detachedReference(reference) } : {}),
});

const isAborted = (signal?: AbortSignal) => signal?.aborted === true;

const lifecycleFailureCode = (value: unknown): SerenaLifecycleFailureCode =>
  typeof value === "string" && LIFECYCLE_FAILURE_CODES.has(value as SerenaLifecycleFailureCode)
    ? value as SerenaLifecycleFailureCode
    : "invalid_lifecycle_request";

const clientFailureCode = (value: unknown): SerenaLifecycleClientFailureCode | null =>
  typeof value === "string" && CLIENT_FAILURE_CODES.has(value as SerenaLifecycleClientFailureCode)
    ? value as SerenaLifecycleClientFailureCode
    : null;

const observedClientResult = <Data>(
  value: unknown,
  project: (value: unknown) => Data | null,
): ObservedClientResult<Data> | null => {
  const result = ownDataRecord(value, ["success", "data"])
    ?? ownDataRecord(value, ["success", "code"]);
  if (!result) return null;
  if (result.success === true && Object.hasOwn(result, "data")) {
    const data = project(result.data);
    return data === null ? null : { success: true, data };
  }
  const code = result.success === false ? clientFailureCode(result.code) : null;
  return code ? { success: false, code } : null;
};

const observedProject = (value: unknown): SerenaLifecycleProject | null =>
  projectSerenaLifecycleProject(value);

const observedNames = (value: unknown): string[] | null => {
  const values = ownDataArray(value, 10_000);
  if (!values) return null;
  const names = values.map((entry) => typeof entry === "string"
    && utf8ByteLength(entry) <= MAX_SERENA_LIFECYCLE_MEMORY_NAME_BYTES
    && !CONTROL_CHARACTER.test(entry)
    ? entry
    : null);
  if (names.some((name) => name === null)) return null;
  const result = names as string[];
  return new Set(result).size === result.length ? [...result] : null;
};

const observedContent = (value: unknown): string | null =>
  typeof value === "string"
  && value.length <= MAX_SERENA_LIFECYCLE_MEMORY_CHARACTERS
  && utf8ByteLength(value) <= MAX_SERENA_LIFECYCLE_MEMORY_BYTES
  ? value
  : null;

const observedWriteResult = (value: unknown): ObservedWriteResult | null => {
  const successResult = ownDataRecord(value, ["success", "data", "dispatch", "settlement"]);
  if (
    successResult
    && successResult.success === true
    && successResult.data === undefined
    && successResult.dispatch === "dispatched"
    && successResult.settlement === "settled"
  ) return {
    success: true,
    dispatch: "dispatched",
    settlement: "settled",
  };

  const failureResult = ownDataRecord(value, ["success", "code", "dispatch", "settlement"]);
  const code = failureResult && failureResult.success === false
    ? clientFailureCode(failureResult.code)
    : null;
  if (!failureResult || !code) return null;
  if (
    failureResult.dispatch === "not_dispatched"
    && failureResult.settlement === "not_dispatched"
  ) return {
    success: false,
    code,
    dispatch: "not_dispatched",
    settlement: "not_dispatched",
  };
  if (
    failureResult.dispatch === "dispatched"
    && failureResult.settlement === "unknown"
  ) return {
    success: false,
    code,
    dispatch: "dispatched",
    settlement: "unknown",
  };
  return null;
};

const snapshotRequest = (
  value: unknown,
): { request: ValidLifecycleRequest } | { code: SerenaLifecycleFailureCode } => {
  try {
    const projected = projectSerenaLifecycleRequest(value);
    if (!projected) return { code: "invalid_lifecycle_request" };
    const request = validateLifecycleWriteRequest(projected);
    return request.valid
      ? { request: detachedRequest(request) }
      : { code: lifecycleFailureCode(request.error.code) };
  } catch {
    return { code: "invalid_lifecycle_request" };
  }
};

const preparedTarget = (request: ValidLifecycleRequest): PreparedTarget | null => {
  const prepared = prepareLifecycleArtifact(request);
  if (!prepared.valid) return null;
  const memoryName = serenaLifecycleMemoryName({
    lifecycleKey: request.identity.lifecycleKey,
    phase: request.type,
    artifactId: prepared.data.nonce,
  });
  return memoryName ? { request: detachedRequest(request), memoryName } : null;
};

const timestamp = (now: () => Date): string | null => {
  try {
    const value = now();
    return value instanceof Date && Number.isFinite(value.getTime())
      ? value.toISOString()
      : null;
  } catch {
    return null;
  }
};

const resultFor = (
  record: SerenaLifecycleVerifiedRecord,
  disposition: "stored" | "unchanged",
): SerenaLifecycleVerifiedResult => ({
  provider: "serena",
  status: "verified",
  disposition,
  artifactId: record.artifactId,
  logicalId: record.logicalId,
  memoryName: record.memoryName,
  recordKey: record.recordKey,
  contentHash: record.contentHash,
  requestHash: record.requestHash,
  canonicalHash: record.canonicalHash,
  lifecycleKey: record.lifecycleKey,
  phase: record.phase,
  nonce: record.nonce,
  project: record.identity.project,
  serenaProjectName: record.project.projectName,
  projectFingerprint: record.project.fingerprint,
  summary: record.summary,
  artifact: record.artifact,
  sourceRefs: [...record.identity.sourceRefs],
  identity: detachedIdentity(record.identity),
  createdAt: record.createdAt,
  storageSchemaVersion: 1,
  sourceId: `serena:lifecycle:${record.memoryName}`,
  reference: detachedReference(record.reference),
});

export const acquireSerenaLifecycleProjectLease: SerenaLifecycleLeaseAcquirer = async (project) =>
  acquireNativeFileLock({
    directory: project.projectPath,
    targetName: `serena-lifecycle-${project.fingerprint}`,
  });

export const createSerenaLifecycleProvider = (input: {
  client: SerenaLifecycleClient;
  project: unknown;
  now?: () => Date;
  acquireLease?: SerenaLifecycleLeaseAcquirer;
}): SerenaLifecycleProvider => {
  const project = normalizeSerenaLifecycleProject(input.project);
  const client = input.client;
  const now = input.now ?? (() => new Date());
  const acquireLease = input.acquireLease ?? acquireSerenaLifecycleProjectLease;

  const activate = async (
    signal?: AbortSignal,
  ): Promise<SerenaLifecycleProject | SerenaLifecycleBlockedResult> => {
    if (!project) return blocked("serena_project_mismatch");
    if (isAborted(signal)) return blocked("aborted");

    let response: unknown;
    try {
      response = await client.activate(detachedProject(project), signal);
    } catch {
      return blocked("serena_project_unavailable");
    }
    if (isAborted(signal)) return blocked("aborted");
    const observed = observedClientResult(response, observedProject);
    if (!observed) return blocked("serena_project_unavailable");
    if (!observed.success) return blocked(observed.code);
    return sameProject(observed.data, project)
      ? detachedProject(project)
      : blocked("serena_project_mismatch");
  };

  const list = async (
    signal?: AbortSignal,
  ): Promise<string[] | SerenaLifecycleBlockedResult> => {
    if (isAborted(signal)) return blocked("aborted");
    let response: unknown;
    try {
      response = await client.listMemoryNames(signal);
    } catch {
      return blocked("serena_memory_listing_unverifiable");
    }
    if (isAborted(signal)) return blocked("aborted");
    const observed = observedClientResult(response, observedNames);
    if (!observed) return blocked("serena_memory_listing_unverifiable");
    return observed.success ? observed.data : blocked(observed.code);
  };

  const read = async (
    memoryName: string,
    signal?: AbortSignal,
  ): Promise<string | SerenaLifecycleBlockedResult> => {
    if (isAborted(signal)) return blocked("aborted");
    let response: unknown;
    try {
      response = await client.readMemory(memoryName, signal);
    } catch {
      return blocked("serena_memory_read_unavailable");
    }
    if (isAborted(signal)) return blocked("aborted");
    const observed = observedClientResult(response, observedContent);
    if (!observed) return blocked("serena_memory_read_unverifiable");
    return observed.success ? observed.data : blocked(observed.code);
  };

  const write = async (
    memoryName: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<LeaseWriteResult> => {
    if (isAborted(signal)) {
      return {
        result: blocked("aborted"),
        dispatch: "not_dispatched",
        settlement: "not_dispatched",
      };
    }

    let response: unknown;
    try {
      response = await client.writeMemory({ memoryName, content }, signal);
    } catch {
      return {
        result: blocked(isAborted(signal) ? "aborted" : "serena_memory_write_unknown"),
        dispatch: "dispatched",
        settlement: "unknown",
      };
    }

    const observed = observedWriteResult(response);
    if (!observed) {
      return {
        result: blocked(isAborted(signal) ? "aborted" : "serena_memory_write_unknown"),
        dispatch: "dispatched",
        settlement: "unknown",
      };
    }
    if (observed.success) {
      return {
        result: isAborted(signal) ? blocked("aborted") : undefined,
        dispatch: observed.dispatch,
        settlement: observed.settlement,
      };
    }
    return {
      result: blocked(isAborted(signal) ? "aborted" : observed.code),
      dispatch: observed.dispatch,
      settlement: observed.settlement,
    };
  };

  const get = async (
    value: unknown,
    signal?: AbortSignal,
  ): Promise<SerenaLifecycleVerifiedResult | SerenaLifecycleBlockedResult> => {
    const reference = projectSerenaLifecycleReference(value);
    if (!reference || !project || reference.projectFingerprint !== project.fingerprint) {
      return blocked("serena_reference_invalid");
    }
    if (isAborted(signal)) return blocked("aborted");

    const active = await activate(signal);
    if ("status" in active) return active;
    const names = await list(signal);
    if (!Array.isArray(names)) return names;
    const candidates = names.filter((name) => name === reference.memoryName);
    if (candidates.length === 0) return blocked("serena_record_not_found");
    if (candidates.length !== 1) return blocked("serena_target_unverifiable");

    const content = await read(reference.memoryName, signal);
    if (typeof content !== "string") return content;
    const record = verifySerenaLifecycleRecord({
      content,
      project: detachedProject(active),
      reference: detachedReference(reference),
    });
    return record
      ? resultFor(record, "unchanged")
      : blocked("serena_verification_failed", reference);
  };

  const recall = async (
    value: unknown,
    signal?: AbortSignal,
  ): Promise<SerenaLifecycleVerifiedResult[] | SerenaLifecycleBlockedResult> => {
    const selection = projectSerenaLifecycleSelection(value);
    if (!selection) return blocked("serena_selection_invalid");
    if (!project || isAborted(signal)) return blocked(isAborted(signal) ? "aborted" : "serena_project_mismatch");

    const active = await activate(signal);
    if ("status" in active) return active;
    const names = await list(signal);
    if (!Array.isArray(names)) return names;
    const namespacePrefix = serenaLifecycleNamespacePrefix(selection.lifecycleKey);
    if (!namespacePrefix) return blocked("serena_selection_invalid");

    const matching = names.filter((name) => name.startsWith(namespacePrefix));
    if (matching.some((name) => !isSerenaLifecycleMemoryName(name))) {
      return blocked("serena_recall_unverifiable");
    }
    const selected = selection.phase === undefined
      ? matching
      : matching.filter((name) => name.startsWith(`${namespacePrefix}${selection.phase}-`));
    if (selected.length > selection.limit || selected.length > MAX_SERENA_LIFECYCLE_RECALL_LIMIT) {
      return blocked("serena_recall_unverifiable");
    }

    const records: SerenaLifecycleVerifiedResult[] = [];
    const memoryNames = new Set<string>();
    const artifactIds = new Set<string>();
    const logicalIds = new Set<string>();
    const recordKeys = new Set<string>();
    for (const memoryName of [...selected].sort()) {
      if (isAborted(signal)) return blocked("aborted");
      const content = await read(memoryName, signal);
      if (typeof content !== "string") {
        return content.code === "aborted"
          ? content
          : blocked("serena_recall_unverifiable");
      }
      const record = verifySerenaLifecycleRecord({
        content,
        project: detachedProject(active),
        selection,
      });
      if (
        !record
        || record.memoryName !== memoryName
        || memoryNames.has(record.memoryName)
        || artifactIds.has(record.artifactId)
        || logicalIds.has(record.logicalId)
        || recordKeys.has(record.recordKey)
      ) return blocked("serena_recall_unverifiable");

      memoryNames.add(record.memoryName);
      artifactIds.add(record.artifactId);
      logicalIds.add(record.logicalId);
      recordKeys.add(record.recordKey);
      records.push(resultFor(record, "unchanged"));
    }
    return records;
  };

  const persist = async (
    value: unknown,
    signal?: AbortSignal,
  ): Promise<SerenaLifecycleVerifiedResult | SerenaLifecycleBlockedResult> => {
    const snapshot = snapshotRequest(value);
    if ("code" in snapshot) return blocked(snapshot.code);
    if (!project) return blocked("serena_project_mismatch");
    if (isAborted(signal)) return blocked("aborted");

    const target = preparedTarget(snapshot.request);
    if (!target) return blocked("serena_record_invalid");

    let lease: SerenaLifecycleProjectLease | null;
    try {
      lease = await acquireLease(detachedProject(project));
    } catch {
      return blocked("serena_lease_unavailable");
    }
    if (!lease || typeof lease.release !== "function") return blocked("serena_lease_unavailable");

    let outcome: PersistWithLeaseOutcome;
    try {
      outcome = await persistWithLease({
        client: { activate, list, read, write },
        project,
        request: target.request,
        memoryName: target.memoryName,
        now,
        signal,
      });
    } catch {
      outcome = {
        result: blocked("serena_verification_failed"),
        release: "retain",
      };
    }
    if (outcome.release === "retain") return outcome.result;

    const reference = outcome.result.reference;
    try {
      await lease.release();
    } catch {
      return blocked("serena_lease_release_failed", reference);
    }
    return isAborted(signal)
      ? blocked("aborted", reference)
      : outcome.result;
  };

  const reconcile = async (
    value: unknown,
    signal?: AbortSignal,
  ): Promise<SerenaLifecycleVerifiedResult | SerenaLifecycleBlockedResult> => get(value, signal);

  return { persist, get, recall, reconcile };
};

const persistWithLease = async (input: {
  client: LeaseClient;
  project: SerenaLifecycleProject;
  request: ValidLifecycleRequest;
  memoryName: string;
  now: () => Date;
  signal?: AbortSignal;
}): Promise<PersistWithLeaseOutcome> => {
  if (isAborted(input.signal)) {
    return { result: blocked("aborted"), release: "release" };
  }
  const active = await input.client.activate(input.signal);
  if ("status" in active) return { result: active, release: "release" };
  const names = await input.client.list(input.signal);
  if (!Array.isArray(names)) return { result: names, release: "release" };

  const candidates = names.filter((name) => name === input.memoryName);
  if (candidates.length > 1) {
    return { result: blocked("serena_target_unverifiable"), release: "release" };
  }
  if (candidates.length === 1) {
    const content = await input.client.read(input.memoryName, input.signal);
    if (typeof content !== "string") return { result: content, release: "release" };
    const record = verifySerenaLifecycleRecord({
      content,
      project: detachedProject(active),
    });
    if (!record || record.memoryName !== input.memoryName) {
      return { result: blocked("serena_target_unverifiable"), release: "release" };
    }
    return {
      result: sameRequest(record.request, input.request)
        ? resultFor(record, "unchanged")
        : blocked("serena_target_conflict"),
      release: "release",
    };
  }

  const createdAt = timestamp(input.now);
  if (!createdAt) return { result: blocked("serena_time_invalid"), release: "release" };
  const prepared = createSerenaLifecycleRecord({
    request: lifecycleRequestInput(input.request),
    project: detachedProject(input.project),
    createdAt,
  });
  if (!prepared || prepared.memoryName !== input.memoryName) {
    return { result: blocked("serena_record_invalid"), release: "release" };
  }
  if (isAborted(input.signal)) {
    return { result: blocked("aborted", prepared.reference), release: "release" };
  }

  let written: LeaseWriteResult;
  try {
    written = await input.client.write(prepared.memoryName, prepared.serialized, input.signal);
  } catch {
    return {
      result: blocked("serena_memory_write_unknown", prepared.reference),
      release: "retain",
    };
  }
  if (written.result === undefined) {
    if (written.dispatch !== "dispatched" || written.settlement !== "settled") {
      return {
        result: blocked("serena_memory_write_unknown", prepared.reference),
        release: "retain",
      };
    }
  } else {
    const provenPreDispatchFailure = written.dispatch === "not_dispatched"
      && written.settlement === "not_dispatched";
    const uncertainDispatch = written.dispatch === "dispatched"
      && written.settlement === "unknown";
    const settledAbort = written.result.code === "aborted"
      && written.dispatch === "dispatched"
      && written.settlement === "settled";
    if (!provenPreDispatchFailure && !uncertainDispatch && !settledAbort) {
      return {
        result: blocked("serena_memory_write_unknown", prepared.reference),
        release: "retain",
      };
    }
    return {
      result: written.result.code === "aborted"
        ? blocked("aborted", prepared.reference)
        : blocked("serena_memory_write_unknown", prepared.reference),
      release: uncertainDispatch ? "retain" : "release",
    };
  }
  if (isAborted(input.signal)) {
    return { result: blocked("aborted", prepared.reference), release: "release" };
  }

  const content = await input.client.read(prepared.memoryName, input.signal);
  if (typeof content !== "string") {
    return {
      result: content.code === "aborted"
        ? blocked("aborted", prepared.reference)
        : blocked("serena_verification_failed", prepared.reference),
      release: "release",
    };
  }
  const record = verifySerenaLifecycleRecord({
    content,
    project: detachedProject(active),
    reference: detachedReference(prepared.reference),
    request: lifecycleRequestInput(input.request),
  });
  return {
    result: record && content === prepared.serialized
      ? resultFor(record, "stored")
      : blocked("serena_verification_failed", prepared.reference),
    release: "release",
  };
};
