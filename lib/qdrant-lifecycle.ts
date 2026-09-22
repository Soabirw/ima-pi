import {
  deriveRecordId,
  isCorpusErrorCode,
  storeInstitutionalManifest,
  type CorpusErrorCode,
} from "./qdrant-corpus.ts";
import { normalizeInstitutionalManifest } from "./qdrant-corpus-manifest.ts";
import {
  prepareLifecycleArtifact,
  validateLifecycleRequest,
  type ValidLifecycleRequest,
} from "./ima-lifecycle.ts";
import {
  QDRANT_LIFECYCLE_PROVIDER,
  QDRANT_LIFECYCLE_REPOSITORY,
  QDRANT_LIFECYCLE_SITE,
  projectQdrantLifecycleRequest,
  projectQdrantLifecycleReference,
  projectQdrantLifecycleSelection,
  verifyQdrantLifecycleRecord,
  type QdrantLifecycleReference,
  type QdrantLifecycleVerifiedRecord,
} from "./qdrant-lifecycle-record.ts";
import type { QdrantCorpusClient } from "./qdrant-http.ts";

export type QdrantLifecycleFailureCode = CorpusErrorCode
  | "invalid_lifecycle_request"
  | "invalid_lifecycle_summary"
  | "lifecycle_artifact_embeds_prior_artifact"
  | "lifecycle_artifact_too_large"
  | "qdrant_receipt_invalid"
  | "qdrant_reference_invalid"
  | "qdrant_selection_invalid"
  | "qdrant_time_invalid"
  | "qdrant_verification_failed"
  | "qdrant_recall_unverifiable"
  | "lifecycle_provider_recall_overflow";

export type QdrantLifecycleBlockedResult = {
  provider: "qdrant";
  status: "blocked";
  code: QdrantLifecycleFailureCode;
  reference?: QdrantLifecycleReference;
};

export type QdrantLifecycleVerifiedResult = {
  provider: "qdrant";
  status: "verified";
  disposition: "stored" | "unchanged";
  artifactId: string;
  recordKey: string;
  contentHash: string;
  lifecycleKey: string;
  phase: QdrantLifecycleVerifiedRecord["phase"];
  nonce: string;
  project: string;
  summary: string;
  artifact: string;
  sourceRefs: string[];
  createdAt: string;
  storageSchemaVersion: 1 | 2;
  sourceId: string;
  reference: QdrantLifecycleReference;
};

export type QdrantLifecycleProvider = {
  persist: (
    request: unknown,
    signal?: AbortSignal,
  ) => Promise<QdrantLifecycleVerifiedResult | QdrantLifecycleBlockedResult>;
  get: (
    reference: unknown,
    signal?: AbortSignal,
  ) => Promise<QdrantLifecycleVerifiedResult | QdrantLifecycleBlockedResult>;
  recall: (
    selection: unknown,
    signal?: AbortSignal,
  ) => Promise<QdrantLifecycleVerifiedResult[] | QdrantLifecycleBlockedResult>;
  reconcile: (
    reference: unknown,
    signal?: AbortSignal,
  ) => Promise<QdrantLifecycleVerifiedResult | QdrantLifecycleBlockedResult>;
};

const LIFECYCLE_FAILURE_CODES = new Set<QdrantLifecycleFailureCode>([
  "invalid_lifecycle_request",
  "invalid_lifecycle_summary",
  "lifecycle_artifact_embeds_prior_artifact",
  "lifecycle_artifact_too_large",
]);

const blocked = (
  code: QdrantLifecycleFailureCode,
  reference?: QdrantLifecycleReference,
): QdrantLifecycleBlockedResult => ({
  provider: QDRANT_LIFECYCLE_PROVIDER,
  status: "blocked",
  code,
  ...(reference ? { reference: { ...reference } } : {}),
});

const isAborted = (signal?: AbortSignal) => signal?.aborted === true;

const corpusCode = (
  value: unknown,
  fallback: QdrantLifecycleFailureCode,
): QdrantLifecycleFailureCode =>
  typeof value === "string" && isCorpusErrorCode(value) ? value : fallback;

const lifecycleRecallCode = (code: QdrantLifecycleFailureCode): QdrantLifecycleFailureCode =>
  code === "lifecycle_scroll_non_terminal"
    ? "lifecycle_provider_recall_overflow"
    : code;

const lifecycleCode = (value: unknown): QdrantLifecycleFailureCode =>
  typeof value === "string" && LIFECYCLE_FAILURE_CODES.has(value as QdrantLifecycleFailureCode)
    ? value as QdrantLifecycleFailureCode
    : "invalid_lifecycle_request";

type ObservedCorpusResult =
  | { success: true; data: unknown }
  | { success: false; code: QdrantLifecycleFailureCode };

const observedCorpusResult = (
  value: unknown,
  fallback: QdrantLifecycleFailureCode,
): ObservedCorpusResult | null => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.some((key) => typeof key !== "string")
      || keys.length !== 2
      || !keys.includes("success")
      || keys.some((key) => !["success", "data", "error"].includes(key as string))
      || keys.some((key) => {
        const descriptor = descriptors[key as string];
        return !descriptor
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable
          || !Object.hasOwn(descriptor, "value");
      })
    ) return null;
    if (descriptors.success.value === true && Object.hasOwn(descriptors, "data")) {
      return { success: true, data: descriptors.data.value };
    }
    if (descriptors.success.value !== false || !Object.hasOwn(descriptors, "error")) return null;

    const error = descriptors.error.value;
    if (!error || typeof error !== "object" || Array.isArray(error)) return null;
    const code = Object.getOwnPropertyDescriptor(error, "code");
    if (!code || code.get || code.set || !Object.hasOwn(code, "value")) return null;
    return { success: false, code: corpusCode(code.value, fallback) };
  } catch {
    return null;
  }
};

const detachedDataArray = (value: unknown, maximum: number): unknown[] | null => {
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
      if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        return null;
      }
      entries.push(descriptor.value);
    }
    return entries;
  } catch {
    return null;
  }
};

const detachedRequest = (value: ValidLifecycleRequest): ValidLifecycleRequest => ({
  valid: true,
  type: value.type,
  identity: {
    project: value.identity.project,
    lifecycleKey: value.identity.lifecycleKey,
    lifecycleRootMemoryId: value.identity.lifecycleRootMemoryId,
    taskwarriorProject: value.identity.taskwarriorProject,
    taskwarriorTask: value.identity.taskwarriorTask,
    taskwarriorUuid: value.identity.taskwarriorUuid,
    jiraKey: value.identity.jiraKey,
    ...(value.identity.planeWorkspace && value.identity.planeWorkItem
      ? {
        planeWorkspace: value.identity.planeWorkspace,
        planeWorkItem: value.identity.planeWorkItem,
      }
      : {}),
    sourceRefs: [...value.identity.sourceRefs],
    priorArtifactIds: [...value.identity.priorArtifactIds],
  },
  summary: value.summary,
  artifact: value.artifact,
});

const lifecycleRequestInput = (value: ValidLifecycleRequest) => ({
  type: value.type,
  identity: {
    project: value.identity.project,
    lifecycleKey: value.identity.lifecycleKey,
    lifecycleRootMemoryId: value.identity.lifecycleRootMemoryId,
    taskwarriorProject: value.identity.taskwarriorProject,
    taskwarriorTask: value.identity.taskwarriorTask,
    taskwarriorUuid: value.identity.taskwarriorUuid,
    jiraKey: value.identity.jiraKey,
    ...(value.identity.planeWorkspace && value.identity.planeWorkItem
      ? {
        planeWorkspace: value.identity.planeWorkspace,
        planeWorkItem: value.identity.planeWorkItem,
      }
      : {}),
    sourceRefs: [...value.identity.sourceRefs],
    priorArtifactIds: [...value.identity.priorArtifactIds],
  },
  summary: value.summary,
  artifact: value.artifact,
});

const projectRequest = (
  value: unknown,
): { request: ValidLifecycleRequest } | { code: QdrantLifecycleFailureCode } => {
  try {
    const projected = projectQdrantLifecycleRequest(value);
    if (!projected) return { code: "invalid_lifecycle_request" };

    const request = validateLifecycleRequest(projected);
    return request.valid
      ? { request: detachedRequest(request) }
      : { code: lifecycleCode(request.error.code) };
  } catch {
    return { code: "invalid_lifecycle_request" };
  }
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

const receiptDisposition = (
  value: unknown,
  recordKey: string,
): "stored" | "unchanged" | null => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string")
      || keys.length !== 3
      || !["status", "id", "recordKey"].every((key) => keys.includes(key))
      || keys.some((key) => {
        const descriptor = descriptors[key as string];
        return !descriptor
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable
          || !Object.hasOwn(descriptor, "value");
      })
    ) return null;
    const expectedId = deriveRecordId(recordKey);
    if (!expectedId.success || descriptors.id.value !== expectedId.data || descriptors.recordKey.value !== recordKey) {
      return null;
    }
    return descriptors.status.value === "stored" || descriptors.status.value === "unchanged"
      ? descriptors.status.value
      : null;
  } catch {
    return null;
  }
};

const lifecycleCorpusRecord = (
  request: ValidLifecycleRequest,
  preparation: { nonce: string; artifact: string; recordKey: string },
) => ({
  recordKey: preparation.recordKey,
  project: request.identity.project,
  site: QDRANT_LIFECYCLE_SITE,
  repo: QDRANT_LIFECYCLE_REPOSITORY,
  lifecycleKey: request.identity.lifecycleKey,
  phase: request.type,
  summary: request.summary,
  detail: preparation.artifact,
  sourceRefs: [...request.identity.sourceRefs],
});

const recoveryReference = (input: {
  request: ValidLifecycleRequest;
  preparation: { nonce: string; artifact: string; recordKey: string };
  createdAt: string;
}): QdrantLifecycleReference | null => {
  const record = normalizeInstitutionalManifest(
    lifecycleCorpusRecord(input.request, input.preparation),
    input.createdAt,
  );
  if (!record.success) return null;
  return projectQdrantLifecycleReference({
    schemaVersion: 1,
    provider: QDRANT_LIFECYCLE_PROVIDER,
    artifactId: record.data.id,
    recordKey: record.data.recordKey,
    contentHash: record.data.payload.content_hash,
    lifecycleKey: input.request.identity.lifecycleKey,
    phase: input.request.type,
    nonce: input.preparation.nonce,
  });
};

const verifiedResult = (
  record: QdrantLifecycleVerifiedRecord,
  disposition: "stored" | "unchanged",
): QdrantLifecycleVerifiedResult => ({
  provider: QDRANT_LIFECYCLE_PROVIDER,
  status: "verified",
  disposition,
  artifactId: record.artifactId,
  recordKey: record.recordKey,
  contentHash: record.contentHash,
  lifecycleKey: record.lifecycleKey,
  phase: record.phase,
  nonce: record.nonce,
  project: record.project,
  summary: record.summary,
  artifact: record.artifact,
  sourceRefs: [...record.sourceRefs],
  createdAt: record.createdAt,
  storageSchemaVersion: record.storageSchemaVersion,
  sourceId: `qdrant:lifecycle:${record.artifactId}`,
  reference: { ...record.reference },
});

export const createQdrantLifecycleProvider = (input: {
  client: QdrantCorpusClient;
  now?: () => Date;
}): QdrantLifecycleProvider => {
  const client = input.client;
  const now = input.now ?? (() => new Date());

  const get = async (
    value: unknown,
    signal?: AbortSignal,
  ): Promise<QdrantLifecycleVerifiedResult | QdrantLifecycleBlockedResult> => {
    const reference = projectQdrantLifecycleReference(value);
    if (!reference) return blocked("qdrant_reference_invalid");
    if (isAborted(signal)) return blocked("aborted");

    let recalled;
    try {
      recalled = await client.getInstitutional(reference.recordKey, signal);
    } catch {
      return isAborted(signal) ? blocked("aborted") : blocked("qdrant_unavailable");
    }
    if (isAborted(signal)) return blocked("aborted");
    const result = observedCorpusResult(recalled, "qdrant_unavailable");
    if (!result) return blocked("qdrant_unavailable");
    if (!result.success) return blocked(result.code);

    const verified = verifyQdrantLifecycleRecord({ record: result.data, reference });
    if (!verified) return blocked("qdrant_verification_failed");
    if (isAborted(signal)) return blocked("aborted");
    return verifiedResult(verified, "unchanged");
  };

  const persist = async (
    value: unknown,
    signal?: AbortSignal,
  ): Promise<QdrantLifecycleVerifiedResult | QdrantLifecycleBlockedResult> => {
    const projected = projectRequest(value);
    if ("code" in projected) return blocked(projected.code);
    const request = projected.request;
    if (isAborted(signal)) return blocked("aborted");

    const preparation = prepareLifecycleArtifact(request);
    if (!preparation.valid) return blocked(lifecycleCode(preparation.error.code));
    if (isAborted(signal)) return blocked("aborted");

    const createdAt = timestamp(now);
    if (!createdAt) return blocked("qdrant_time_invalid");
    if (isAborted(signal)) return blocked("aborted");

    const reference = recoveryReference({
      request,
      preparation: preparation.data,
      createdAt,
    });
    if (!reference) return blocked("qdrant_verification_failed");
    if (isAborted(signal)) return blocked("aborted");

    let stored;
    try {
      stored = await storeInstitutionalManifest({
        record: lifecycleCorpusRecord(request, preparation.data),
        createdAt,
        operations: client,
        signal,
      });
    } catch {
      return isAborted(signal) ? blocked("aborted", reference) : blocked("store_failed", reference);
    }
    if (isAborted(signal)) return blocked("aborted", reference);
    const storeResult = observedCorpusResult(stored, "store_failed");
    if (!storeResult) return blocked("store_failed", reference);
    if (!storeResult.success) return blocked(storeResult.code, reference);

    const disposition = receiptDisposition(storeResult.data, preparation.data.recordKey);
    if (!disposition) return blocked("qdrant_receipt_invalid", reference);
    if (isAborted(signal)) return blocked("aborted", reference);

    let recalled;
    try {
      recalled = await client.getInstitutional(preparation.data.recordKey, signal);
    } catch {
      return isAborted(signal) ? blocked("aborted", reference) : blocked("qdrant_unavailable", reference);
    }
    if (isAborted(signal)) return blocked("aborted", reference);
    const readResult = observedCorpusResult(recalled, "qdrant_unavailable");
    if (!readResult) return blocked("qdrant_unavailable", reference);
    if (!readResult.success) return blocked(readResult.code, reference);

    const verified = verifyQdrantLifecycleRecord({
      record: readResult.data,
      reference,
      request: lifecycleRequestInput(request),
    });
    if (!verified) return blocked("qdrant_verification_failed", reference);
    if (isAborted(signal)) return blocked("aborted", reference);
    return verifiedResult(verified, disposition);
  };

  const recall = async (
    value: unknown,
    signal?: AbortSignal,
  ): Promise<QdrantLifecycleVerifiedResult[] | QdrantLifecycleBlockedResult> => {
    const selection = projectQdrantLifecycleSelection(value);
    if (!selection) return blocked("qdrant_selection_invalid");
    if (isAborted(signal)) return blocked("aborted");

    let recalled;
    try {
      recalled = await client.recallLifecycleInstitutional(selection, signal);
    } catch {
      return isAborted(signal) ? blocked("aborted") : blocked("query_failed");
    }
    if (isAborted(signal)) return blocked("aborted");
    const recallResult = observedCorpusResult(recalled, "query_failed");
    if (!recallResult) return blocked("query_failed");
    if (!recallResult.success) return blocked(lifecycleRecallCode(recallResult.code));
    const recalledRecords = detachedDataArray(recallResult.data, selection.limit);
    if (!recalledRecords) return blocked("qdrant_recall_unverifiable");

    const records: QdrantLifecycleVerifiedResult[] = [];
    const artifactIds = new Set<string>();
    const recordKeys = new Set<string>();
    for (const record of recalledRecords) {
      if (isAborted(signal)) return blocked("aborted");
      const verified = verifyQdrantLifecycleRecord({ record, selection });
      if (
        !verified
        || artifactIds.has(verified.artifactId)
        || recordKeys.has(verified.recordKey)
      ) return blocked("qdrant_recall_unverifiable");
      artifactIds.add(verified.artifactId);
      recordKeys.add(verified.recordKey);
      records.push(verifiedResult(verified, "unchanged"));
    }
    if (isAborted(signal)) return blocked("aborted");
    return records;
  };

  const reconcile = async (
    value: unknown,
    signal?: AbortSignal,
  ): Promise<QdrantLifecycleVerifiedResult | QdrantLifecycleBlockedResult> => get(value, signal);

  return { persist, get, recall, reconcile };
};
