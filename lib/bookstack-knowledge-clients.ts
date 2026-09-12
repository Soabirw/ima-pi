import {
  MAX_BOOKSTACK_RESPONSE_BYTES,
  MAX_SEARCH_RESPONSE_BYTES,
  createBookStackHttpClient,
  normalizeHttpsOrigin,
  requestJson,
  validSecret,
  validTimeout,
  type Fetcher,
} from "./bookstack-http.ts";
import {
  buildPermalink,
  normalizeSearchResults,
  parseBookStackPage,
  type BookStackPage,
  type BookStackSearchFilters,
} from "./bookstack-knowledge.ts";

const CLOUDFLARE_ORIGIN = "https://api.cloudflare.com";
const SEARCH_INSTANCE_NAME = "ima-memory-search";

type Environment = Record<string, string | undefined>;

const validAccountId = (value: string | undefined) => {
  if (!value || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("cloudflare_account_id_invalid");
  return value;
};

export function resolveBookStackKnowledgeOrigin(environment: Environment): string {
  const baseUrl = environment.BOOKSTACK_BASE_URL?.trim();
  const legacyOrigin = environment.BOOKSTACK_ORIGIN?.trim();
  if (!baseUrl && !legacyOrigin) throw new Error("bookstack_base_url_required");
  const primary = baseUrl ? normalizeHttpsOrigin(baseUrl) : null;
  const legacy = legacyOrigin ? normalizeHttpsOrigin(legacyOrigin) : null;
  if (primary && legacy && primary !== legacy) throw new Error("bookstack_origin_conflict");
  return primary ?? legacy!;
}

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
  const bookStackOrigin = normalizeHttpsOrigin(input.bookStackOrigin);
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
      const result = await requestJson({
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
            ai_search_options: { retrieval: { filters: input.filters } },
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
  const http = createBookStackHttpClient({
    ...input,
    maxResponseBytes: MAX_BOOKSTACK_RESPONSE_BYTES,
  });
  const page = async (path: string, expectedId?: number, init?: RequestInit) =>
    parseBookStackPage(await http.request(path, init), expectedId);

  return {
    origin: http.origin,
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
      return buildPermalink(http.origin, pageId);
    },
  };
}
