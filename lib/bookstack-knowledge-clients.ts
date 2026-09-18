import {
  DEFAULT_TIMEOUT_MS,
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
  parseBookStackBook,
  parseBookStackBookListEntry,
  parseBookStackBookWithContents,
  parseBookStackPage,
  parseBookStackPageIdentity,
  parseBookStackPageListEntry,
  parseBookStackPageUrl,
  selectBookStackBookCandidate,
  selectBookStackContentPage,
  selectBookStackPageCandidate,
  type BookStackBook,
  type BookStackPage,
  type BookStackPageIdentity,
  type BookStackPageListEntry,
  type BookStackPageUrl,
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

const LIST_PAGE_SIZE = 500;
const MAX_LIST_ENTRIES = 10_000;
const MAX_LIST_REQUESTS = MAX_LIST_ENTRIES / LIST_PAGE_SIZE;

type KnowledgeHttpClient = ReturnType<typeof createBookStackHttpClient>;
type ResolvedPageCandidate = Pick<BookStackPageIdentity, "id" | "bookId" | "slug" | "draft">;

const pagePath = (pageId: number) => `pages/${encodeURIComponent(String(pageId))}`;
const bookPath = (bookId: number) => `books/${encodeURIComponent(String(bookId))}`;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const parseListResponse = (value: unknown) => {
  if (!isPlainObject(value)) throw new Error("bookstack_response_invalid");
  const total = value.total;
  const data = value.data;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0 || total > MAX_LIST_ENTRIES
    || !Array.isArray(data) || data.length > LIST_PAGE_SIZE) {
    throw new Error("bookstack_pagination_invalid");
  }
  return { total, data };
};

const completeBookStackList = async <Entry extends { id: number }>(input: {
  request: (offset: number) => Promise<unknown>;
  parseEntry: (value: unknown) => Entry;
}): Promise<Entry[]> => {
  const entries: Entry[] = [];
  const ids = new Set<number>();
  let expectedTotal: number | null = null;

  for (let requestNumber = 0; requestNumber < MAX_LIST_REQUESTS; requestNumber += 1) {
    const offset = requestNumber * LIST_PAGE_SIZE;
    const response = parseListResponse(await input.request(offset));
    if (expectedTotal === null) {
      expectedTotal = response.total;
    } else if (response.total !== expectedTotal) {
      throw new Error("bookstack_pagination_invalid");
    }

    const expectedBatchSize = Math.min(LIST_PAGE_SIZE, response.total - offset);
    if (offset > response.total || response.data.length !== expectedBatchSize) {
      throw new Error("bookstack_pagination_invalid");
    }
    for (const value of response.data) {
      const entry = input.parseEntry(value);
      if (ids.has(entry.id)) throw new Error("bookstack_pagination_invalid");
      ids.add(entry.id);
      entries.push(entry);
    }
    if (entries.length !== offset + expectedBatchSize || entries.length > response.total) {
      throw new Error("bookstack_pagination_invalid");
    }
    if (entries.length === response.total) return entries;
  }
  throw new Error("bookstack_pagination_invalid");
};

const filteredPages = (http: KnowledgeHttpClient, pageSlug: string) => completeBookStackList({
  request: (offset) => http.request("pages", {}, new URLSearchParams({
    "filter[slug]": pageSlug,
    count: String(LIST_PAGE_SIZE),
    offset: String(offset),
    sort: "id",
  })),
  parseEntry: (value): BookStackPageListEntry => parseBookStackPageListEntry(value, pageSlug),
});

const listedBooks = (http: KnowledgeHttpClient) => completeBookStackList({
  request: (offset) => http.request("books", {}, new URLSearchParams({
    count: String(LIST_PAGE_SIZE),
    offset: String(offset),
    sort: "id",
  })),
  parseEntry: parseBookStackBookListEntry,
});

const operationSignal = (signal: AbortSignal | undefined) => signal
  ? AbortSignal.any([signal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)])
  : AbortSignal.timeout(DEFAULT_TIMEOUT_MS);

const verifiedPage = (
  page: BookStackPageIdentity,
  target: BookStackPageUrl,
  candidate: ResolvedPageCandidate,
) => {
  if (candidate.draft || page.draft || page.id !== candidate.id || page.bookId !== candidate.bookId
    || page.slug !== candidate.slug || page.slug !== target.pageSlug) {
    throw new Error("bookstack_identity_invalid");
  }
  return page;
};

const verifiedBook = (book: BookStackBook, expectedId: number, expectedSlug: string) => {
  if (book.id !== expectedId || book.slug !== expectedSlug) {
    throw new Error("bookstack_identity_invalid");
  }
  return book;
};

const missingPage = (): never => {
  throw new Error("bookstack_page_not_found");
};

const readResolvedPage = async (http: KnowledgeHttpClient, pageId: number) =>
  parseBookStackPageIdentity(await http.request(pagePath(pageId)), pageId);

const readResolvedBook = async (http: KnowledgeHttpClient, bookId: number) =>
  parseBookStackBook(await http.request(bookPath(bookId)), bookId);

const readResolvedBookWithContents = async (http: KnowledgeHttpClient, bookId: number) =>
  parseBookStackBookWithContents(await http.request(bookPath(bookId)), bookId);

const directResolvedPage = async (
  http: KnowledgeHttpClient,
  target: BookStackPageUrl,
  candidate: BookStackPageListEntry,
) => {
  if (candidate.bookSlug !== target.bookSlug) throw new Error("bookstack_identity_invalid");
  const page = verifiedPage(await readResolvedPage(http, candidate.id), target, candidate);
  verifiedBook(await readResolvedBook(http, candidate.bookId), candidate.bookId, target.bookSlug);
  return page;
};

const fallbackResolvedPage = async (http: KnowledgeHttpClient, target: BookStackPageUrl) => {
  const bookCandidate = selectBookStackBookCandidate(await listedBooks(http), target.bookSlug);
  if (!bookCandidate) return missingPage();

  const book = await readResolvedBookWithContents(http, bookCandidate.id);
  verifiedBook(book, bookCandidate.id, target.bookSlug);
  const pageCandidate = selectBookStackContentPage(book.pages, target.pageSlug);
  if (!pageCandidate) return missingPage();

  const page = verifiedPage(await readResolvedPage(http, pageCandidate.id), target, pageCandidate);
  if (page.bookId !== book.id || pageCandidate.bookId !== book.id) {
    throw new Error("bookstack_identity_invalid");
  }
  return page;
};

export function createBookStackKnowledgeClient(input: BookStackKnowledgeClientInput) {
  const http = createBookStackHttpClient({
    ...input,
    maxResponseBytes: MAX_BOOKSTACK_RESPONSE_BYTES,
  });
  const page = async (path: string, expectedId?: number, init?: RequestInit) =>
    parseBookStackPage(await http.request(path, init), expectedId);
  const resolutionHttp = () => createBookStackHttpClient({
    ...input,
    signal: operationSignal(input.signal),
    maxResponseBytes: MAX_BOOKSTACK_RESPONSE_BYTES,
  });

  return {
    origin: http.origin,
    async readPage(pageId: number): Promise<BookStackPage> {
      return page(pagePath(pageId), pageId);
    },
    async readPageByUrl(value: unknown): Promise<BookStackPageIdentity> {
      const target = parseBookStackPageUrl(value, http.origin);
      const resolver = resolutionHttp();
      const candidate = selectBookStackPageCandidate(await filteredPages(resolver, target.pageSlug), target);
      if (candidate) return directResolvedPage(resolver, target, candidate);
      return fallbackResolvedPage(resolver, target);
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
