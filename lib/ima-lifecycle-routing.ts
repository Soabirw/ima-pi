import {
  normalizeLifecycleRecordKey,
  type LifecyclePhase,
  type ValidLifecycleRequest,
} from "./ima-lifecycle.ts";
import {
  projectLifecycleProviderPin,
  projectLifecycleProviderReference,
  type LifecycleProviderPin,
} from "./ima-lifecycle-pin.ts";
import {
  normalizeLifecycleProvider,
  type LifecycleProviderName,
} from "./ima-lifecycle-selection.ts";

export type LifecycleRouteWriteState = "no-write" | "possible-write";

export type RoutedLifecycleRecord = {
  provider: LifecycleProviderName;
  artifactId: string;
  recordKey: string;
  lifecycleKey: string;
  phase: LifecyclePhase;
  summary: string;
  artifact: string;
  reference: Record<string, unknown>;
  createdAt: string | null;
};

export type RoutedLifecyclePersistResult =
  | { status: "verified"; record: RoutedLifecycleRecord }
  | { status: "blocked"; provider: LifecycleProviderName; code: string; writeState: LifecycleRouteWriteState };

export type RoutedLifecycleRecallResult =
  | { status: "verified"; provider: LifecycleProviderName; records: RoutedLifecycleRecord[] }
  | { status: "blocked"; provider: LifecycleProviderName; code: string };

export type LifecycleRoutingAdapter = {
  provider: LifecycleProviderName;
  persist: (
    request: ValidLifecycleRequest,
    signal?: AbortSignal,
  ) => Promise<RoutedLifecyclePersistResult>;
  persistPinned?: (
    request: ValidLifecycleRequest,
    initialReference: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<RoutedLifecyclePersistResult>;
  recall: (
    selection: {
      lifecycleKey: string;
      phase?: LifecyclePhase;
      limit: number;
      reference?: Record<string, unknown>;
    },
    signal?: AbortSignal,
  ) => Promise<RoutedLifecycleRecallResult>;
  get?: (
    reference: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<RoutedLifecyclePersistResult>;
  reconcile?: (
    reference: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<RoutedLifecyclePersistResult>;
};

export type LifecycleRouting = {
  adapters: Partial<Record<LifecycleProviderName, LifecycleRoutingAdapter>>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SAFE_CODE = /^[a-z][a-z0-9_:-]{0,127}$/;
const ROUTED_LIFECYCLE_RECORD_FIELDS = [
  "provider",
  "artifactId",
  "recordKey",
  "lifecycleKey",
  "phase",
  "summary",
  "artifact",
  "reference",
  "createdAt",
] as const;

const ownDataRecord = (value: unknown): Record<string, unknown> | null => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => typeof key !== "string") || keys.some((key) => {
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
    if (!Array.isArray(value) || value.length > maximum) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length !== value.length + 1
      || keys.some((key) => typeof key !== "string")
      || keys.some((key) => key !== "length" && !/^\d+$/.test(key as string))
      || descriptors.length?.get
      || descriptors.length?.set
    ) return null;
    const entries: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) return null;
      entries.push(descriptor.value);
    }
    return entries;
  } catch {
    return null;
  }
};

const safeCode = (value: unknown, fallback: string) =>
  typeof value === "string" && SAFE_CODE.test(value) ? value : fallback;

const exactText = (value: unknown, maximum: number): string | null =>
  typeof value === "string"
  && value === value.trim()
  && value.length > 0
  && value.length <= maximum
  && Buffer.byteLength(value, "utf8") <= maximum
  && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
    ? value
    : null;

export const projectRoutedLifecycleRecord = (
  value: unknown,
  expectedProvider?: LifecycleProviderName,
): RoutedLifecycleRecord | null => {
  const record = ownDataRecord(value);
  if (!record) return null;
  const keys = Object.keys(record);
  if (
    keys.length !== ROUTED_LIFECYCLE_RECORD_FIELDS.length
    || !ROUTED_LIFECYCLE_RECORD_FIELDS.every((field) => Object.hasOwn(record, field))
    || keys.some((field) => !ROUTED_LIFECYCLE_RECORD_FIELDS.includes(
      field as (typeof ROUTED_LIFECYCLE_RECORD_FIELDS)[number],
    ))
  ) return null;
  const provider = normalizeLifecycleProvider(record.provider);
  const artifactId = exactText(record.artifactId, 36);
  const recordKey = normalizeLifecycleRecordKey(record.recordKey);
  const lifecycleKey = exactText(record.lifecycleKey, 512);
  const phase = record.phase as LifecyclePhase;
  const summary = exactText(record.summary, 2_000);
  const artifact = typeof record.artifact === "string" && record.artifact.length > 0
    && record.artifact.length <= 160_000
    ? record.artifact
    : null;
  const reference = provider
    ? projectLifecycleProviderReference(provider, record.reference)
    : null;
  const createdAt = record.createdAt === null
    ? null
    : exactText(record.createdAt, 64);
  if (
    !provider
    || expectedProvider && provider !== expectedProvider
    || !artifactId
    || !UUID.test(artifactId)
    || !recordKey
    || recordKey !== record.recordKey
    || !lifecycleKey
    || typeof phase !== "string"
    || !["plan", "implementation", "test", "review", "resolution", "rereview", "document", "decision", "closeout"].includes(phase)
    || !summary
    || !artifact
    || !reference
    || createdAt !== null && (!TIMESTAMP.test(createdAt) || Number.isNaN(Date.parse(createdAt)))
  ) return null;
  return {
    provider,
    artifactId: artifactId.toLowerCase(),
    recordKey,
    lifecycleKey,
    phase,
    summary,
    artifact,
    reference,
    createdAt,
  };
};

export const projectRoutedLifecyclePersistResult = (
  value: unknown,
  expectedProvider?: LifecycleProviderName,
): RoutedLifecyclePersistResult | null => {
  const result = ownDataRecord(value);
  if (!result || typeof result.status !== "string") return null;
  if (result.status === "verified" && Object.keys(result).length === 2) {
    const record = projectRoutedLifecycleRecord(result.record, expectedProvider);
    return record ? { status: "verified", record } : null;
  }
  if (result.status === "blocked" && Object.keys(result).length === 4) {
    const provider = normalizeLifecycleProvider(result.provider);
    const writeState = result.writeState;
    if (!provider || expectedProvider && provider !== expectedProvider) return null;
    if (writeState !== "no-write" && writeState !== "possible-write") return null;
    return {
      status: "blocked",
      provider,
      code: safeCode(result.code, "lifecycle_provider_operation_failed"),
      writeState,
    };
  }
  return null;
};

export const projectRoutedLifecycleRecallResult = (
  value: unknown,
  expectedProvider?: LifecycleProviderName,
): RoutedLifecycleRecallResult | null => {
  const result = ownDataRecord(value);
  if (!result || typeof result.status !== "string") return null;
  if (result.status === "blocked" && Object.keys(result).length === 3) {
    const provider = normalizeLifecycleProvider(result.provider);
    return provider && (!expectedProvider || provider === expectedProvider)
      ? { status: "blocked", provider, code: safeCode(result.code, "lifecycle_provider_recall_failed") }
      : null;
  }
  if (result.status !== "verified" || Object.keys(result).length !== 3) return null;
  const provider = normalizeLifecycleProvider(result.provider);
  const records = ownDataArray(result.records, 20);
  if (!provider || expectedProvider && provider !== expectedProvider || !records) return null;
  const projected = records.map((record) => projectRoutedLifecycleRecord(record, provider));
  if (projected.some((record) => record === null)) return null;
  const verified = projected as RoutedLifecycleRecord[];
  const artifactIds = new Set(verified.map((record) => record.artifactId));
  const recordKeys = new Set(verified.map((record) => record.recordKey));
  return artifactIds.size === verified.length && recordKeys.size === verified.length
    ? { status: "verified", provider, records: verified }
    : null;
};

export const createLifecycleRouting = (
  adapters: readonly LifecycleRoutingAdapter[],
): LifecycleRouting => {
  const selected: Partial<Record<LifecycleProviderName, LifecycleRoutingAdapter>> = {};
  for (const adapter of adapters) {
    const provider = normalizeLifecycleProvider(adapter?.provider);
    if (!provider || selected[provider]) continue;
    selected[provider] = adapter;
  }
  return { adapters: selected };
};

const adapterFor = (
  routing: LifecycleRouting,
  provider: LifecycleProviderName,
) => routing.adapters[provider] ?? null;

const blockedPersist = (
  provider: LifecycleProviderName,
  code: string,
  writeState: LifecycleRouteWriteState = "possible-write",
): RoutedLifecyclePersistResult => ({ status: "blocked", provider, code, writeState });

const sameProviderReference = (
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) => {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
};

const verifiedPinnedInitialReference = (input: {
  pin: LifecycleProviderPin;
  expectedReference: Record<string, unknown>;
  record: RoutedLifecycleRecord;
}): Record<string, unknown> | null => {
  const reference = projectLifecycleProviderReference(
    input.pin.provider,
    input.record.reference,
  );
  if (
    !reference
    || input.record.provider !== input.pin.provider
    || input.record.lifecycleKey !== input.pin.lifecycleKey
    || input.record.artifactId !== input.pin.artifactId
    || input.record.recordKey !== input.pin.recordKey
    || !sameProviderReference(input.expectedReference, reference)
  ) return null;
  return reference;
};

export const routeLifecyclePersistence = async (input: {
  routing: LifecycleRouting;
  provider: LifecycleProviderName;
  request: ValidLifecycleRequest;
  signal?: AbortSignal;
}): Promise<RoutedLifecyclePersistResult> => {
  const adapter = adapterFor(input.routing, input.provider);
  if (!adapter) return blockedPersist(input.provider, "lifecycle_provider_unavailable", "no-write");
  try {
    const result = projectRoutedLifecyclePersistResult(
      await adapter.persist(input.request, input.signal),
      input.provider,
    );
    return result ?? blockedPersist(input.provider, "lifecycle_provider_response_invalid");
  } catch {
    return blockedPersist(input.provider, "lifecycle_provider_operation_failed");
  }
};

export const routePinnedLifecyclePersistence = async (input: {
  routing: LifecycleRouting;
  pin: unknown;
  request: ValidLifecycleRequest;
  signal?: AbortSignal;
}): Promise<RoutedLifecyclePersistResult> => {
  const pin = projectLifecycleProviderPin(input.pin);
  if (!pin || pin.lifecycleKey !== input.request.identity.lifecycleKey) {
    return blockedPersist("qdrant", "lifecycle_pin_invalid", "no-write");
  }
  const adapter = adapterFor(input.routing, pin.provider);
  const verify = adapter?.reconcile ?? adapter?.get;
  if (!adapter || !verify) {
    return blockedPersist(pin.provider, "pinned_provider_unavailable", "no-write");
  }
  const expectedReference = projectLifecycleProviderReference(
    pin.provider,
    pin.initialReference,
  );
  const referenceForVerification = expectedReference
    ? projectLifecycleProviderReference(pin.provider, expectedReference)
    : null;
  if (!expectedReference || !referenceForVerification) {
    return blockedPersist(pin.provider, "lifecycle_pin_invalid", "no-write");
  }
  let verified: RoutedLifecyclePersistResult;
  try {
    verified = projectRoutedLifecyclePersistResult(
      await verify(referenceForVerification, input.signal),
      pin.provider,
    ) ?? blockedPersist(pin.provider, "pinned_provider_response_invalid", "no-write");
  } catch {
    verified = blockedPersist(pin.provider, "pinned_provider_failed", "no-write");
  }
  if (verified.status !== "verified") return verified;
  const initialReference = verifiedPinnedInitialReference({
    pin,
    expectedReference,
    record: verified.record,
  });
  if (!initialReference) {
    return blockedPersist(pin.provider, "pinned_provider_response_invalid", "no-write");
  }
  if (typeof adapter.persistPinned === "function") {
    try {
      const result = projectRoutedLifecyclePersistResult(
        await adapter.persistPinned(input.request, initialReference, input.signal),
        pin.provider,
      );
      return result ?? blockedPersist(pin.provider, "lifecycle_provider_response_invalid");
    } catch {
      return blockedPersist(pin.provider, "lifecycle_provider_operation_failed");
    }
  }
  return routeLifecyclePersistence({
    routing: input.routing,
    provider: pin.provider,
    request: input.request,
    signal: input.signal,
  });
};

export const routePinnedLifecycleRecall = async (input: {
  routing: LifecycleRouting;
  pin: unknown;
  lifecycleKey: string;
  phase?: LifecyclePhase;
  limit: number;
  signal?: AbortSignal;
}): Promise<RoutedLifecycleRecallResult> => {
  const pin = projectLifecycleProviderPin(input.pin);
  if (!pin || pin.lifecycleKey !== input.lifecycleKey) {
    return { status: "blocked", provider: "qdrant", code: "lifecycle_pin_invalid" };
  }
  const adapter = adapterFor(input.routing, pin.provider);
  const verify = adapter?.reconcile ?? adapter?.get;
  if (!adapter || !verify) {
    return { status: "blocked", provider: pin.provider, code: "pinned_provider_unavailable" };
  }
  try {
    const verified = projectRoutedLifecyclePersistResult(
      await verify(pin.initialReference, input.signal),
      pin.provider,
    );
    if (!verified || verified.status !== "verified") {
      return { status: "blocked", provider: pin.provider, code: "pinned_provider_unavailable" };
    }
    const result = projectRoutedLifecycleRecallResult(
      await adapter.recall({
        lifecycleKey: input.lifecycleKey,
        ...(input.phase ? { phase: input.phase } : {}),
        limit: input.limit,
        reference: pin.initialReference,
      }, input.signal),
      pin.provider,
    );
    return result ?? {
      status: "blocked",
      provider: pin.provider,
      code: "pinned_provider_response_invalid",
    };
  } catch {
    return { status: "blocked", provider: pin.provider, code: "pinned_provider_failed" };
  }
};

export const routePinnedLifecycleReference = async (input: {
  routing: LifecycleRouting;
  pin: unknown;
  operation: "get" | "reconcile";
  signal?: AbortSignal;
}): Promise<RoutedLifecyclePersistResult> => {
  const pin = projectLifecycleProviderPin(input.pin);
  if (!pin) return blockedPersist("qdrant", "lifecycle_pin_invalid", "no-write");
  const adapter = adapterFor(input.routing, pin.provider);
  const operation = adapter?.[input.operation];
  if (!adapter || typeof operation !== "function") {
    return blockedPersist(pin.provider, "pinned_provider_unavailable", "no-write");
  }
  try {
    const result = projectRoutedLifecyclePersistResult(
      await operation(pin.initialReference, input.signal),
      pin.provider,
    );
    return result ?? blockedPersist(pin.provider, "pinned_provider_response_invalid", "no-write");
  } catch {
    return blockedPersist(pin.provider, "pinned_provider_failed", "no-write");
  }
};
