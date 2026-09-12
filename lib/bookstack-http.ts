export type Fetcher = typeof globalThis.fetch;
export type FailurePrefix = "cloudflare" | "bookstack";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 120_000;
export const MAX_SEARCH_RESPONSE_BYTES = 256_000;
export const MAX_BOOKSTACK_RESPONSE_BYTES = 512_000;
export const MAX_LIFECYCLE_RESPONSE_BYTES = 4 * 1024 * 1024;

const validResponseBound = (value: number | undefined) => {
  const maxResponseBytes = value ?? MAX_BOOKSTACK_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_LIFECYCLE_RESPONSE_BYTES) {
    throw new Error("bookstack_response_limit_invalid");
  }
  return maxResponseBytes;
};

export const validSecret = (value: string | undefined, code: string) => {
  if (!value || /[\r\n]/.test(value)) throw new Error(code);
  return value;
};

export const validTimeout = (value: number | undefined) => {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("bookstack_timeout_invalid");
  }
  return timeoutMs;
};

export const normalizeHttpsOrigin = (value: string | undefined) => {
  const origin = value?.trim();
  if (!origin) throw new Error("bookstack_base_url_required");
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("bookstack_origin_invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("bookstack_origin_invalid");
  }
  return url.origin;
};

const boundedResponseText = async (
  response: Response,
  maxBytes: number,
  failurePrefix: FailurePrefix,
) => {
  const contentLength = response.headers.get("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
    throw new Error(`${failurePrefix}_response_too_large`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${failurePrefix}_response_invalid`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`${failurePrefix}_response_too_large`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && error.message === `${failurePrefix}_response_too_large`) throw error;
    throw new Error(`${failurePrefix}_response_invalid`);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
};

export const requestJson = async (input: {
  fetcher: Fetcher;
  url: URL;
  init: RequestInit;
  signal?: AbortSignal;
  timeoutMs: number;
  maxResponseBytes: number;
  failurePrefix: FailurePrefix;
}) => {
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs)])
    : AbortSignal.timeout(input.timeoutMs);
  let response: Response;
  try {
    response = await input.fetcher(input.url, { ...input.init, redirect: "error", signal });
  } catch {
    throw new Error(`${input.failurePrefix}_transport_failed`);
  }
  if (response.status === 401 || response.status === 403) throw new Error(`${input.failurePrefix}_access_denied`);
  if (!response.ok) throw new Error(`${input.failurePrefix}_http_failed`);
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
    throw new Error(`${input.failurePrefix}_response_invalid`);
  }
  const text = await boundedResponseText(response, input.maxResponseBytes, input.failurePrefix);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${input.failurePrefix}_response_invalid`);
  }
};

export type BookStackHttpClientInput = {
  origin: string;
  tokenId: string;
  tokenSecret: string;
  fetch?: Fetcher;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

export const createBookStackHttpClient = (input: BookStackHttpClientInput) => {
  const origin = normalizeHttpsOrigin(input.origin);
  const tokenId = validSecret(input.tokenId, "bookstack_token_id_required");
  const tokenSecret = validSecret(input.tokenSecret, "bookstack_token_secret_required");
  const fetcher = input.fetch ?? globalThis.fetch;
  const timeoutMs = validTimeout(input.timeoutMs);
  const maxResponseBytes = validResponseBound(input.maxResponseBytes);

  const request = (path: string, init: RequestInit = {}, query?: URLSearchParams) => {
    if (!/^[a-z]+(?:\/[1-9]\d*)?$/.test(path)) throw new Error("bookstack_path_invalid");
    const url = new URL(`/api/${path}`, `${origin}/`);
    if (query) url.search = query.toString();
    return requestJson({
      fetcher,
      url,
      signal: input.signal,
      timeoutMs,
      maxResponseBytes,
      failurePrefix: "bookstack",
      init: {
        ...init,
        headers: {
          accept: "application/json",
          authorization: `Token ${tokenId}:${tokenSecret}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
      },
    });
  };

  return { origin, request };
};
