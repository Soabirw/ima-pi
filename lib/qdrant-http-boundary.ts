import {
  classifyTransportError,
  corpusFailure,
  INSTITUTIONAL_COLLECTION,
  isRetriablePreSend,
  utf8ByteLength,
  type CorpusErrorCode,
  type CorpusFailureCause,
  type CorpusFailureOperation,
  type CorpusResult,
} from "./qdrant-corpus.ts";

export const DEFAULT_QDRANT_URL = "http://127.0.0.1:6333";
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
export const MAX_HTTP_RESPONSE_BYTES = 256 * 1024;

const MAX_REQUEST_ATTEMPTS = 2;
const COLLECTION_NAME = /^[A-Za-z0-9_-]{1,255}$/;
const SNAPSHOT_NAME = /^[A-Za-z0-9._-]{1,255}$/;
const textDecoder = new TextDecoder();

export type JsonObject = Record<string, unknown>;
export type Fetcher = typeof globalThis.fetch;
export type ResponseData = { status: number; body: unknown };
export type CorpusEndpoints = { qdrantUrl: string; ollamaUrl: string };
export type QdrantHttpDependencies = {
  fetch?: Fetcher;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxAttempts?: number;
};

export const success = <Data>(data: Data) => ({ success: true as const, data });
const failure = corpusFailure;
export const object = (value: unknown): JsonObject | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
export const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
export const aborted = (signal?: AbortSignal) => signal?.aborted === true;
export const collectionName = (value: unknown) => typeof value === "string" && COLLECTION_NAME.test(value) ? value : "";

const endpoint = (value: unknown, fallback: string): string | null => {
  const candidate = typeof value === "string" && value.trim() ? value.trim() : fallback;
  try {
    const parsed = new URL(candidate);
    return ["http:", "https:"].includes(parsed.protocol)
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash
      && (parsed.pathname === "/" || parsed.pathname === "")
      ? parsed.toString().replace(/\/$/, "")
      : null;
  } catch {
    return null;
  }
};

export const resolveCorpusEndpoint = (value: unknown, fallback: string) => endpoint(value, fallback);

export function resolveCorpusEndpoints(
  env: Record<string, string | undefined> = process.env,
): CorpusResult<CorpusEndpoints> {
  const qdrantUrl = resolveCorpusEndpoint(env.IMA_QDRANT_URL, DEFAULT_QDRANT_URL);
  if (!qdrantUrl) {
    return failure("qdrant_unavailable", {
      operation: "endpoint_configuration",
      cause: "invalid_configuration",
    });
  }
  const ollamaUrl = resolveCorpusEndpoint(env.IMA_OLLAMA_URL, DEFAULT_OLLAMA_URL);
  return ollamaUrl
    ? success({ qdrantUrl, ollamaUrl })
    : failure("ollama_unavailable", {
      operation: "endpoint_configuration",
      cause: "invalid_configuration",
    });
}

const url = (base: string, path: string) => new URL(`${base}/${path.replace(/^\//, "")}`).toString();

const boundedText = async (response: Response, maximum: number): Promise<string | null> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) return null;
  if (!response.body) {
    const value = await response.text();
    return utf8ByteLength(value) <= maximum ? value : null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) return null;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return textDecoder.decode(joined);
};

const diagnosticFailure = (
  code: CorpusErrorCode,
  operation: CorpusFailureOperation | undefined,
  cause: CorpusFailureCause,
  httpStatus?: number,
) => operation
  ? failure(code, {
    operation,
    cause,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  })
  : failure(code);

const validHttpStatus = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599;

export const requestJson = async (input: {
  fetcher: Fetcher;
  endpoint: string;
  path: string;
  method?: string;
  body?: unknown;
  timeoutMs: number;
  maximumResponseBytes: number;
  signal?: AbortSignal;
  unavailableCode: CorpusErrorCode;
  operation?: CorpusFailureOperation;
  maxAttempts?: number;
}): Promise<CorpusResult<ResponseData>> => {
  if (aborted(input.signal)) return failure("aborted");
  const attempts = input.maxAttempts === MAX_REQUEST_ATTEMPTS ? MAX_REQUEST_ATTEMPTS : 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const timeout = AbortSignal.timeout(input.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await input.fetcher(url(input.endpoint, input.path), {
        method: input.method ?? "GET",
        headers: input.body === undefined ? undefined : { "content-type": "application/json" },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal,
      });
    } catch (error) {
      if (aborted(input.signal)) return failure("aborted");
      if (timeout.aborted) return diagnosticFailure(input.unavailableCode, input.operation, "timeout");
      const cause = classifyTransportError(error);
      if (attempt === 0 && attempts === MAX_REQUEST_ATTEMPTS && isRetriablePreSend(cause)) {
        continue;
      }
      return diagnosticFailure(input.unavailableCode, input.operation, cause);
    }

    if (aborted(input.signal)) return failure("aborted");
    if (timeout.aborted) return diagnosticFailure(input.unavailableCode, input.operation, "timeout");
    if (!response.ok) return success({ status: response.status, body: null });

    let body: string | null;
    try {
      body = await boundedText(response, input.maximumResponseBytes);
    } catch (error) {
      if (aborted(input.signal)) return failure("aborted");
      return timeout.aborted
        ? diagnosticFailure(input.unavailableCode, input.operation, "timeout")
        : diagnosticFailure(input.unavailableCode, input.operation, classifyTransportError(error));
    }

    if (aborted(input.signal)) return failure("aborted");
    if (timeout.aborted) return diagnosticFailure(input.unavailableCode, input.operation, "timeout");
    if (body === null) return diagnosticFailure("response_invalid", input.operation, "invalid_response");
    try {
      return success({ status: response.status, body: body ? JSON.parse(body) : null });
    } catch {
      return diagnosticFailure("response_invalid", input.operation, "invalid_response");
    }
  }

  return diagnosticFailure(input.unavailableCode, input.operation, "transport_other");
};

export const bodyOrFailure = (
  response: CorpusResult<ResponseData>,
  code: CorpusErrorCode,
  operation?: CorpusFailureOperation,
) => {
  if (!response.success) return response;
  if (response.data.status >= 200 && response.data.status < 300) return success(response.data.body);
  return validHttpStatus(response.data.status)
    ? diagnosticFailure(code, operation, "http_status", response.data.status)
    : diagnosticFailure(code, operation, "invalid_response");
};

const snapshotName = (value: unknown) =>
  typeof value === "string" && SNAPSHOT_NAME.test(value) ? value : "";

const snapshotDataField = (value: unknown, key: string): unknown => {
  try {
    const source = object(value);
    const descriptor = source && Object.getOwnPropertyDescriptor(source, key);
    return descriptor
      && !descriptor.get
      && !descriptor.set
      && Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
};

const snapshotValues = (value: unknown): unknown[] | null => {
  try {
    if (!Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = descriptors.length?.value;
    if (
      !Number.isSafeInteger(length)
      || length < 0
      || keys.length !== length + 1
      || keys.some((key) => typeof key !== "string")
      || keys.some((key) => key !== "length" && !/^\d+$/.test(key as string))
      || !descriptors.length
      || descriptors.length.get
      || descriptors.length.set
      || !Object.hasOwn(descriptors.length, "value")
    ) return null;
    const snapshots: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor
        || descriptor.get
        || descriptor.set
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, "value")
      ) {
        return null;
      }
      snapshots.push(descriptor.value);
    }
    return snapshots;
  } catch {
    return null;
  }
};

const snapshotNames = (value: unknown): string[] | null => {
  const snapshots = snapshotValues(snapshotDataField(value, "result"));
  if (!snapshots) return null;
  const names: string[] = [];
  for (const candidate of snapshots) {
    const name = snapshotName(snapshotDataField(candidate, "name"));
    if (!name || names.includes(name)) return null;
    names.push(name);
  }
  return names;
};

export async function createInstitutionalSnapshot(
  supplied: QdrantHttpDependencies = {},
  signal?: AbortSignal,
): Promise<CorpusResult<{ name: string }>> {
  const endpoints = resolveCorpusEndpoints(supplied.env ?? process.env);
  if (!endpoints.success) return endpoints;

  const response = bodyOrFailure(await requestJson({
    fetcher: supplied.fetch ?? globalThis.fetch,
    endpoint: endpoints.data.qdrantUrl,
    path: `collections/${encodeURIComponent(INSTITUTIONAL_COLLECTION)}/snapshots`,
    method: "POST",
    timeoutMs: supplied.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    maximumResponseBytes: supplied.maxResponseBytes ?? MAX_HTTP_RESPONSE_BYTES,
    maxAttempts: supplied.maxAttempts ?? MAX_REQUEST_ATTEMPTS,
    signal,
    unavailableCode: "qdrant_unavailable",
    operation: "institutional_collection",
  }), "qdrant_unavailable", "institutional_collection");
  if (!response.success) return response;

  const name = snapshotName(snapshotDataField(
    snapshotDataField(response.data, "result"),
    "name",
  ));
  return name ? success({ name }) : failure("response_invalid", {
    operation: "institutional_collection",
    cause: "invalid_response",
  });
}

export async function createVerifiedInstitutionalSnapshot(
  supplied: QdrantHttpDependencies = {},
  signal?: AbortSignal,
): Promise<CorpusResult<{ name: string }>> {
  const endpoints = resolveCorpusEndpoints(supplied.env ?? process.env);
  if (!endpoints.success) return endpoints;

  const fetcher = supplied.fetch ?? globalThis.fetch;
  const timeoutMs = supplied.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const maximumResponseBytes = supplied.maxResponseBytes ?? MAX_HTTP_RESPONSE_BYTES;
  const path = `collections/${encodeURIComponent(INSTITUTIONAL_COLLECTION)}/snapshots`;
  const created = bodyOrFailure(await requestJson({
    fetcher,
    endpoint: endpoints.data.qdrantUrl,
    path,
    method: "POST",
    timeoutMs,
    maximumResponseBytes,
    maxAttempts: 1,
    signal,
    unavailableCode: "qdrant_unavailable",
    operation: "institutional_collection",
  }), "qdrant_unavailable", "institutional_collection");
  if (!created.success) return created;

  const name = snapshotName(snapshotDataField(
    snapshotDataField(created.data, "result"),
    "name",
  ));
  if (!name) {
    return failure("response_invalid", {
      operation: "institutional_collection",
      cause: "invalid_response",
    });
  }

  const listed = bodyOrFailure(await requestJson({
    fetcher,
    endpoint: endpoints.data.qdrantUrl,
    path,
    timeoutMs,
    maximumResponseBytes,
    maxAttempts: 1,
    signal,
    unavailableCode: "qdrant_unavailable",
    operation: "institutional_collection",
  }), "qdrant_unavailable", "institutional_collection");
  if (!listed.success) return listed;

  const names = snapshotNames(listed.data);
  return names?.filter((candidate) => candidate === name).length === 1
    ? success({ name })
    : failure("response_invalid", {
      operation: "institutional_collection",
      cause: "invalid_response",
    });
}
