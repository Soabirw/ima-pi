import {
  buildPermalink,
  normalizeSearchResults,
  parseBookStackPage,
  type BookStackPage,
  type BookStackSearchFilters,
} from "./bookstack-knowledge.ts";

const CLOUDFLARE_ORIGIN = "https://api.cloudflare.com";
const SEARCH_INSTANCE_NAME = "ima-memory-search";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_SEARCH_RESPONSE_BYTES = 256_000;
const MAX_BOOKSTACK_RESPONSE_BYTES = 512_000;

type Fetcher = typeof globalThis.fetch;
type Environment = Record<string, string | undefined>;

const validSecret = (value: string | undefined, code: string) => {
  if (!value || /[\r\n]/.test(value)) throw new Error(code);
  return value;
};

const validAccountId = (value: string | undefined) => {
  if (!value || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("cloudflare_account_id_invalid");
  return value;
};

const validTimeout = (value: number | undefined) => {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("bookstack_timeout_invalid");
  }
  return timeoutMs;
};

const normalizedOrigin = (value: string | undefined) => {
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

export function resolveBookStackKnowledgeOrigin(environment: Environment): string {
  const baseUrl = environment.BOOKSTACK_BASE_URL?.trim();
  const legacyOrigin = environment.BOOKSTACK_ORIGIN?.trim();
  if (!baseUrl && !legacyOrigin) throw new Error("bookstack_base_url_required");
  const primary = baseUrl ? normalizedOrigin(baseUrl) : null;
  const legacy = legacyOrigin ? normalizedOrigin(legacyOrigin) : null;
  if (primary && legacy && primary !== legacy) throw new Error("bookstack_origin_conflict");
  return primary ?? legacy!;
}

const boundedResponseText = async (response: Response, maxBytes: number, failurePrefix: "cloudflare" | "bookstack") => {
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

const responseJson = async (
  response: Response,
  maxBytes: number,
  failurePrefix: "cloudflare" | "bookstack",
) => {
  if (response.status === 401 || response.status === 403) throw new Error(`${failurePrefix}_access_denied`);
  if (!response.ok) throw new Error(`${failurePrefix}_http_failed`);
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
    throw new Error(`${failurePrefix}_response_invalid`);
  }
  const text = await boundedResponseText(response, maxBytes, failurePrefix);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${failurePrefix}_response_invalid`);
  }
};

const request = async (input: {
  fetcher: Fetcher;
  url: URL;
  init: RequestInit;
  signal?: AbortSignal;
  timeoutMs: number;
  maxResponseBytes: number;
  failurePrefix: "cloudflare" | "bookstack";
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
  return responseJson(response, input.maxResponseBytes, input.failurePrefix);
};

export type BookStackSearchClientInput = {
  accountId: string;
  token: string;
  bookStackOrigin: string;
  fetch?: Fetcher;
  timeoutMs?: number;
};

export function createBookStackSearchClient(input: BookStackSearchClientInput) {
  const accountId = validAccountId(input.accountId);
  const token = validSecret(input.token, "cloudflare_token_required");
  const bookStackOrigin = normalizedOrigin(input.bookStackOrigin);
  const fetcher = input.fetch ?? globalThis.fetch;
  const timeoutMs = validTimeout(input.timeoutMs);
  const path = [
    "accounts",
    encodeURIComponent(accountId),
    "ai-search",
    "instances",
    encodeURIComponent(SEARCH_INSTANCE_NAME),
    "search",
  ].join("/");
  const url = new URL(`/client/v4/${path}`, CLOUDFLARE_ORIGIN);

  return {
    async search(input: { query: string; filters: BookStackSearchFilters; signal?: AbortSignal }) {
      const result = await request({
        fetcher,
        url,
        signal: input.signal,
        timeoutMs,
        maxResponseBytes: MAX_SEARCH_RESPONSE_BYTES,
        failurePrefix: "cloudflare",
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            messages: [{ role: "user", content: input.query }],
            ai_search_options: {
              retrieval: { filters: input.filters },
            },
          }),
        },
      });
      return normalizeSearchResults(result, bookStackOrigin);
    },
  };
}

export type BookStackKnowledgeClientInput = {
  origin: string;
  tokenId: string;
  tokenSecret: string;
  fetch?: Fetcher;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const pagePath = (pageId: number) => `pages/${encodeURIComponent(String(pageId))}`;

export function createBookStackKnowledgeClient(input: BookStackKnowledgeClientInput) {
  const origin = normalizedOrigin(input.origin);
  const tokenId = validSecret(input.tokenId, "bookstack_token_id_required");
  const tokenSecret = validSecret(input.tokenSecret, "bookstack_token_secret_required");
  const fetcher = input.fetch ?? globalThis.fetch;
  const timeoutMs = validTimeout(input.timeoutMs);
  const apiUrl = (path: string) => new URL(`/api/${path}`, `${origin}/`);
  const read = async (path: string, init: RequestInit = {}) => request({
    fetcher,
    url: apiUrl(path),
    signal: input.signal,
    timeoutMs,
    maxResponseBytes: MAX_BOOKSTACK_RESPONSE_BYTES,
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
  const page = async (path: string, expectedId?: number, init?: RequestInit) =>
    parseBookStackPage(await read(path, init), expectedId);

  return {
    origin,
    async readPage(pageId: number): Promise<BookStackPage> {
      return page(pagePath(pageId), pageId);
    },
    async createPage(input: { title: string; bookId: number; markdown: string }): Promise<BookStackPage> {
      return page("pages", undefined, {
        method: "POST",
        body: JSON.stringify({ name: input.title, book_id: input.bookId, markdown: input.markdown }),
      });
    },
    async updatePage(input: { pageId: number; title: string; bookId: number; markdown: string }): Promise<BookStackPage> {
      return page(pagePath(input.pageId), input.pageId, {
        method: "PUT",
        body: JSON.stringify({ name: input.title, book_id: input.bookId, markdown: input.markdown }),
      });
    },
    permalink(pageId: number) {
      return buildPermalink(origin, pageId);
    },
  };
}
