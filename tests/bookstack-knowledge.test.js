import assert from "node:assert/strict";
import test from "node:test";
import { stream as streamAnthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { Check } from "typebox/value";
import {
  MAX_BOOKSTACK_PAGE_URL_BYTES,
  buildFrontmatterEnvelope,
  buildPermalink,
  detectUpdateConflict,
  normalizeSearchResults,
  parseBookStackPage,
  parseBookStackPageUrl,
  parseSourceId,
  validateSearchFilters,
} from "../lib/bookstack-knowledge.ts";
import {
  createBookStackKnowledgeClient,
  createBookStackSearchClient,
  resolveBookStackKnowledgeOrigin,
} from "../lib/bookstack-knowledge-clients.ts";
import { registerBookStackKnowledgeTools } from "../extensions/bookstack-knowledge.ts";

const environment = {
  CLOUDFLARE_ACCOUNT_ID: "account-id",
  CLOUDFLARE_API_MEMORY: "cloudflare-secret",
  BOOKSTACK_BASE_URL: "https://bookstack.example",
  BOOKSTACK_TOKEN_ID: "bookstack-id",
  BOOKSTACK_TOKEN_SECRET: "bookstack-secret",
  BOOKSTACK_LIFECYCLE_BOOK_ID: "63",
  BOOKSTACK_KNOWLEDGE_BOOK_ID: "64",
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

const page = (overrides = {}) => ({
  id: 42,
  name: "A page",
  book_id: 63,
  created_by: 7,
  updated_by: 8,
  revision_count: 3,
  updated_at: "2026-09-11T00:00:00.000000Z",
  markdown: "# Current page",
  ...overrides,
});

const registeredTools = (dependencies = {}) => {
  const tools = [];
  registerBookStackKnowledgeTools({ registerTool: (tool) => tools.push(tool) }, dependencies);
  return new Map(tools.map((tool) => [tool.name, tool]));
};

const resolverOrigin = "https://bookstack.example";
const resolverTargetUrl = (bookSlug = "synthetic-book", pageSlug = "synthetic-page") =>
  `${resolverOrigin}/books/${encodeURIComponent(bookSlug)}/page/${encodeURIComponent(pageSlug)}`;

const resolverPage = (overrides = {}) => ({
  id: 701,
  name: "Synthetic resolved page",
  book_id: 702,
  created_by: 703,
  updated_by: 704,
  revision_count: 5,
  updated_at: "2026-09-12T00:00:00.000000Z",
  markdown: "# Synthetic resolved page",
  slug: "synthetic-page",
  draft: false,
  ...overrides,
});

const resolverListEntry = (overrides = {}) => ({
  id: 701,
  book_id: 702,
  slug: "synthetic-page",
  book_slug: "synthetic-book",
  draft: false,
  ...overrides,
});

const resolverBookListEntry = (overrides = {}) => ({
  id: 702,
  slug: "synthetic-book",
  ...overrides,
});

const resolverBook = (overrides = {}) => ({
  id: 702,
  slug: "synthetic-book",
  ...overrides,
});

const resolverContentPage = (overrides = {}) => ({
  id: 701,
  book_id: 702,
  chapter_id: null,
  slug: "synthetic-page",
  draft: false,
  ...overrides,
});

const resolverBookWithContents = (contents, overrides = {}) => ({
  id: 702,
  slug: "synthetic-book",
  contents,
  ...overrides,
});

const resolverClient = (fetch, options = {}) => createBookStackKnowledgeClient({
  origin: resolverOrigin,
  tokenId: "synthetic-token-id",
  tokenSecret: "synthetic-token-secret",
  fetch,
  ...options,
});

test("pure BookStack rules validate filters, provenance IDs, envelopes, and conflicts", () => {
  assert.deepEqual(validateSearchFilters({ corpus: "lifecycle", project: "shared-dev-memory" }), {
    corpus: "lifecycle",
    project: "shared-dev-memory",
  });
  assert.throws(() => validateSearchFilters({ unknown: "value" }), /bookstack_filter_name_invalid/);
  assert.throws(() => validateSearchFilters({ folder: "value" }), /bookstack_filter_name_invalid/);
  assert.throws(() => validateSearchFilters({ project: "x".repeat(65) }), /bookstack_filter_value_invalid/);
  assert.equal(parseSourceId("bookstack:shared-dev-memory:42"), 42);
  assert.throws(() => parseSourceId("bookstack:shared-dev-memory:0"), /bookstack_source_id_invalid/);
  assert.equal(buildPermalink("https://bookstack.example", 42), "https://bookstack.example/link/42");
  assert.throws(() => buildPermalink("https://user:secret@bookstack.example", 42), /bookstack_origin_invalid/);

  const envelope = buildFrontmatterEnvelope({
    corpus: "lifecycle",
    project: "shared-dev-memory",
    artifactType: "plan",
    lifecycleKey: "shared-dev-memory:manual:test",
    markdown: "# Body",
  });
  assert.match(envelope, /^---\nschema: ima-memory\/v1\nproject: shared-dev-memory\nartifact_type: plan\nlifecycle_key: shared-dev-memory:manual:test\n---\n# Body$/);
  assert.throws(() => buildFrontmatterEnvelope({ corpus: "lifecycle", project: "project", artifactType: "plan", markdown: "# Body" }), /bookstack_lifecycle_key_required/);
  assert.equal(detectUpdateConflict(page({ revisionCount: 3, updatedAt: "now" }), 3, "now"), false);
  assert.equal(detectUpdateConflict(page({ revisionCount: 3, updatedAt: "now" }), 4, "now"), true);
});

test("search normalizes only bounded valid shared-memory candidates", () => {
  const results = normalizeSearchResults({
    result: {
      chunks: [
        {
          text: "x".repeat(2_500),
          score: 0.9,
          item: {
            metadata: {
              source_id: "bookstack:shared-dev-memory:42",
              corpus: "lifecycle",
              project: "shared-dev-memory",
              artifact_type: "plan",
            },
          },
        },
      ],
    },
  }, "https://bookstack.example");
  assert.equal(results.length, 1);
  assert.equal(results[0].canonical_url, "https://bookstack.example/link/42");
  assert.equal(results[0].excerpt.endsWith("…"), true);
  assert.throws(() => normalizeSearchResults({ success: false }, "https://bookstack.example"), /cloudflare_response_invalid/);
  assert.throws(() => normalizeSearchResults({
    result: { chunks: [{ text: "not returned", score: 0.1, item: { metadata: { source_id: "other:42" } } }] },
  }, "https://bookstack.example"), /cloudflare_response_invalid/);
});

test("Cloudflare search uses the fixed private endpoint, messages, filters, and redirect denial", async () => {
  const calls = [];
  const client = createBookStackSearchClient({
    accountId: "account-id",
    token: "cloudflare-secret",
    bookStackOrigin: "https://bookstack.example",
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return json({ result: { chunks: [] } });
    },
  });
  assert.deepEqual(await client.search({ query: "find plan", filters: { corpus: "lifecycle" } }), []);
  assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/accounts/account-id/ai-search/instances/ima-memory-search/search");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.authorization, "Bearer cloudflare-secret");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    messages: [{ role: "user", content: "find plan" }],
    ai_search_options: { retrieval: { filters: { corpus: "lifecycle" } } },
  });
  await assert.rejects(createBookStackSearchClient({
    accountId: "account-id",
    token: "cloudflare-secret",
    bookStackOrigin: "https://bookstack.example",
    fetch: async () => json({}, 401),
  }).search({ query: "find plan", filters: {} }), /cloudflare_access_denied/);
});

test("BookStack client reads, writes, and rejects redirect, oversized, and malformed responses", async () => {
  const calls = [];
  const client = createBookStackKnowledgeClient({
    origin: "https://bookstack.example",
    tokenId: "bookstack-id",
    tokenSecret: "bookstack-secret",
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return json(page());
    },
  });
  assert.equal((await client.readPage(42)).title, "A page");
  await client.createPage({ title: "Created", bookId: 63, markdown: "# Body" });
  await client.updatePage({ pageId: 42, title: "Updated", bookId: 63, markdown: "# Body" });
  assert.deepEqual(calls.map((call) => call.options.method ?? "GET"), ["GET", "POST", "PUT"]);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.authorization, "Token bookstack-id:bookstack-secret");
  assert.throws(() => resolveBookStackKnowledgeOrigin({ ...environment, BOOKSTACK_ORIGIN: "https://other.example" }), /bookstack_origin_conflict/);
  await assert.rejects(createBookStackKnowledgeClient({
    origin: "https://bookstack.example", tokenId: "bookstack-id", tokenSecret: "bookstack-secret",
    fetch: async () => json({}, 403),
  }).readPage(42), /bookstack_access_denied/);
  await assert.rejects(createBookStackKnowledgeClient({
    origin: "https://bookstack.example", tokenId: "bookstack-id", tokenSecret: "bookstack-secret",
    fetch: async () => new Response("x".repeat(600_000), { headers: { "content-type": "application/json" } }),
  }).readPage(42), /bookstack_response_too_large/);
});

test("BookStack tools expose strict schemas and authoritative provenance without secret output", async () => {
  const search = { search: async () => [{ source_id: "bookstack:shared-dev-memory:42", canonical_url: "https://bookstack.example/link/42", excerpt: "excerpt", score: 0.9, corpus: "lifecycle", project: "shared-dev-memory", artifact_type: "plan" }] };
  const knowledgePage = {
    id: 42,
    title: "A page",
    bookId: 63,
    creatorId: 7,
    updaterId: 8,
    revisionCount: 3,
    updatedAt: "2026-09-11T00:00:00.000000Z",
    markdown: "# Current page",
  };
  const knowledge = {
    origin: "https://bookstack.example",
    permalink: (id) => `https://bookstack.example/link/${id}`,
    readPage: async () => knowledgePage,
    createPage: async () => ({ ...knowledgePage, id: 43 }),
    updatePage: async () => knowledgePage,
  };
  const tools = registeredTools({
    environment,
    createSearchClient: () => search,
    createKnowledgeClient: () => knowledge,
  });
  const searchTool = tools.get("ima_bookstack_search");
  const readTool = tools.get("ima_bookstack_read");
  const writeTool = tools.get("ima_bookstack_write");
  assert.equal(Check(searchTool.parameters, { query: "plans", filters: { corpus: "lifecycle" } }), true);
  assert.equal(Check(searchTool.parameters, { query: "plans", filters: { unknown: "no" } }), false);
  assert.equal(Check(readTool.parameters, { sourceId: "bookstack:shared-dev-memory:42", extra: true }), false);
  assert.equal(Check(writeTool.parameters, { corpus: "lifecycle", project: "shared-dev-memory", artifactType: "plan", lifecycleKey: "life", title: "Title", markdown: "# Body" }), true);

  const searchResult = await searchTool.execute("search", { query: "plans", filters: { corpus: "lifecycle" } });
  assert.equal(JSON.parse(searchResult.content[0].text).results[0].source_id, "bookstack:shared-dev-memory:42");
  const readResult = await readTool.execute("read", { sourceId: "bookstack:shared-dev-memory:42" });
  assert.deepEqual(JSON.parse(readResult.content[0].text), {
    source_id: "bookstack:shared-dev-memory:42",
    canonical_url: "https://bookstack.example/link/42",
    title: "A page",
    book_id: 63,
    page_id: 42,
    creator_id: 7,
    updater_id: 8,
    revision_count: 3,
    updated_at: "2026-09-11T00:00:00.000000Z",
    content: "# Current page",
  });
});

test("write rereads, verifies optimistic concurrency, and confirms a revision advance", async () => {
  const current = {
    id: 42,
    title: "A page",
    bookId: 63,
    creatorId: 7,
    updaterId: 8,
    revisionCount: 3,
    updatedAt: "2026-09-11T00:00:00.000000Z",
    markdown: "# Previous",
  };
  const verified = { ...current, revisionCount: 4, updatedAt: "2026-09-11T00:01:00.000000Z" };
  const calls = [];
  const knowledge = {
    origin: "https://bookstack.example",
    permalink: (id) => `https://bookstack.example/link/${id}`,
    readPage: async () => {
      calls.push("read");
      return calls.filter((call) => call === "read").length === 1 ? current : verified;
    },
    createPage: async () => current,
    updatePage: async (input) => {
      calls.push("update");
      assert.match(input.markdown, /^---\nschema: ima-memory\/v1/);
      return verified;
    },
  };
  const tools = registeredTools({
    environment,
    createSearchClient: () => ({ search: async () => [] }),
    createKnowledgeClient: () => knowledge,
  });
  const result = await tools.get("ima_bookstack_write").execute("write", {
    corpus: "lifecycle",
    project: "shared-dev-memory",
    artifactType: "plan",
    lifecycleKey: "life",
    title: "Title",
    markdown: "# Body",
    sourceId: "bookstack:shared-dev-memory:42",
    expectedRevisionCount: 3,
    expectedUpdatedAt: "2026-09-11T00:00:00.000000Z",
  });
  assert.deepEqual(calls, ["read", "update", "read"]);
  assert.equal(JSON.parse(result.content[0].text).action, "updated");
});

test("write fails closed for missing concurrency proof and secret-shaped errors", async () => {
  const conflicting = {
    origin: "https://bookstack.example",
    permalink: (id) => `https://bookstack.example/link/${id}`,
    readPage: async () => page(),
    createPage: async () => page(),
    updatePage: async () => page(),
  };
  const tools = registeredTools({
    environment,
    createSearchClient: () => ({ search: async () => { throw new Error("Bearer cloudflare-secret"); } }),
    createKnowledgeClient: () => conflicting,
  });
  const write = tools.get("ima_bookstack_write");
  await assert.rejects(write.execute("write", {
    corpus: "lifecycle", project: "shared-dev-memory", artifactType: "plan", lifecycleKey: "life", title: "Title", markdown: "# Body",
    sourceId: "bookstack:shared-dev-memory:42",
  }), /bookstack_update_fields_required/);
  await assert.rejects(tools.get("ima_bookstack_search").execute("search", { query: "plans" }), (error) => {
    assert.equal(error.message, "bookstack_operation_failed");
    assert.doesNotMatch(error.message, /secret/i);
    return true;
  });
});

test("page URL parsing accepts configured BookStack URLs and rejects hostile forms", () => {
  assert.deepEqual(parseBookStackPageUrl(resolverTargetUrl("synthetic-book", "Café"), resolverOrigin), {
    bookSlug: "synthetic-book",
    pageSlug: "Café",
  });

  const hostileUrls = [
    "http://bookstack.example/books/synthetic-book/page/synthetic-page",
    "https://untrusted.example/books/synthetic-book/page/synthetic-page",
    "https://bookstack.example@untrusted.example/books/synthetic-book/page/synthetic-page",
    "https://bookstack.example/books/synthetic-book/page/synthetic-page?next=untrusted",
    "https://bookstack.example/books/synthetic-book/page/synthetic-page#fragment",
    "https://bookstack.example/books/synthetic-book/page/synthetic%2Fpage",
    "https://bookstack.example/books/%2e%2e/page/synthetic-page",
    "https://bookstack.example/books/synthetic-book/page/synthetic%",
    resolverTargetUrl("synthetic-book", "x".repeat(2_049)),
  ];
  for (const value of hostileUrls) {
    assert.throws(() => parseBookStackPageUrl(value, resolverOrigin), /bookstack_url_invalid/);
  }
  assert.throws(
    () => parseBookStackPageUrl(resolverTargetUrl(), "https://bookstack.example/not-a-root-origin"),
    /bookstack_origin_invalid/,
  );
});

test("URL resolution rejects hostile targets before its HTTP boundary", async () => {
  const calls = [];
  const client = resolverClient(async (url, options) => {
    calls.push({ request: new URL(String(url)), options });
    return json({ total: 0, data: [] });
  });
  const hostileUrls = [
    "https://untrusted.example/books/synthetic-book/page/synthetic-page",
    "https://bookstack.example/books/synthetic-book/page/synthetic-page?next=untrusted",
    "https://bookstack.example/books/synthetic-book/page/synthetic%2Fpage",
    "https://bookstack.example/books/synthetic-book/page/synthetic-page#fragment",
    "https://bookstack.example/books/synthetic-book/page/synthetic%",
  ];

  for (const value of hostileUrls) {
    await assert.rejects(client.readPageByUrl(value), /bookstack_url_invalid/);
  }
  assert.equal(calls.length, 0);
});

test("URL resolution encodes its slug filter and returns the verified identity", async () => {
  const calls = [];
  const target = { bookSlug: "synthetic-book", pageSlug: "Café" };
  const client = resolverClient(async (url, options) => {
    const request = new URL(String(url));
    calls.push({ request, options });
    if (request.pathname === "/api/pages") {
      return json({
        total: 1,
        data: [resolverListEntry({ slug: target.pageSlug, book_slug: target.bookSlug })],
      });
    }
    if (request.pathname === "/api/pages/701") {
      return json(resolverPage({
        slug: target.pageSlug,
        created_by: { id: 703 },
        updated_by: 704,
      }));
    }
    if (request.pathname === "/api/books/702") return json(resolverBook({ slug: target.bookSlug }));
    throw new Error("unexpected_resolver_request");
  });

  const result = await client.readPageByUrl(resolverTargetUrl(target.bookSlug, target.pageSlug));

  assert.deepEqual(result, {
    id: 701,
    title: "Synthetic resolved page",
    bookId: 702,
    creatorId: 703,
    updaterId: 704,
    revisionCount: 5,
    updatedAt: "2026-09-12T00:00:00.000000Z",
    markdown: "# Synthetic resolved page",
    slug: "Café",
    draft: false,
  });
  assert.deepEqual(calls.map(({ request }) => request.pathname), [
    "/api/pages",
    "/api/pages/701",
    "/api/books/702",
  ]);
  assert.equal(calls[0].request.search, "?filter%5Bslug%5D=Caf%C3%A9&count=500&offset=0&sort=id");
  assert.equal(calls[0].request.searchParams.get("filter[slug]"), "Café");
  assert.equal(calls[0].request.searchParams.get("count"), "500");
  assert.equal(calls[0].request.searchParams.get("offset"), "0");
  assert.equal(calls[0].request.searchParams.get("sort"), "id");
  for (const { options } of calls) assert.equal(options.redirect, "error");
});

test("read tool requires exactly one target and keeps source-ID output compatible", async () => {
  const calls = [];
  const knowledgePage = {
    id: 42,
    title: "A page",
    bookId: 63,
    creatorId: 7,
    updaterId: 8,
    revisionCount: 3,
    updatedAt: "2026-09-11T00:00:00.000000Z",
    markdown: "# Current page",
    slug: "synthetic-page",
    draft: false,
  };
  const knowledge = {
    origin: resolverOrigin,
    permalink: (id) => `${resolverOrigin}/link/${id}`,
    readPage: async (id) => {
      calls.push({ kind: "source", value: id });
      return knowledgePage;
    },
    readPageByUrl: async (value) => {
      calls.push({ kind: "url", value });
      return knowledgePage;
    },
    createPage: async () => knowledgePage,
    updatePage: async () => knowledgePage,
  };
  const tools = registeredTools({
    environment,
    createSearchClient: () => ({ search: async () => [] }),
    createKnowledgeClient: () => knowledge,
  });
  const read = tools.get("ima_bookstack_read");
  const sourceId = "bookstack:shared-dev-memory:42";
  const url = resolverTargetUrl();
  const expected = {
    source_id: sourceId,
    canonical_url: `${resolverOrigin}/link/42`,
    title: "A page",
    book_id: 63,
    page_id: 42,
    creator_id: 7,
    updater_id: 8,
    revision_count: 3,
    updated_at: "2026-09-11T00:00:00.000000Z",
    content: "# Current page",
  };

  assert.equal(Check(read.parameters, { sourceId }), true);
  assert.equal(Check(read.parameters, { url }), true);
  assert.equal(Check(read.parameters, { sourceId, url }), false);
  assert.equal(Check(read.parameters, {}), false);
  assert.equal(Check(read.parameters, { url, unexpected: true }), false);
  assert.equal(Check(read.parameters, { sourceId: 42 }), false);
  assert.equal(Check(read.parameters, { url: 42 }), false);
  assert.equal(Check(read.parameters, { sourceId: "x".repeat(129) }), false);
  assert.equal(Check(read.parameters, { url: "x".repeat(MAX_BOOKSTACK_PAGE_URL_BYTES + 1) }), false);

  const sourceResult = await read.execute("source", { sourceId });
  const urlResult = await read.execute("url", { url });
  assert.deepEqual(JSON.parse(sourceResult.content[0].text), expected);
  assert.deepEqual(JSON.parse(urlResult.content[0].text), expected);
  assert.deepEqual(calls, [
    { kind: "source", value: 42 },
    { kind: "url", value: url },
  ]);

  for (const request of [
    {},
    { sourceId, url },
    { sourceId, unexpected: true },
    [],
  ]) {
    await assert.rejects(read.execute("invalid", request), /bookstack_read_input_invalid/);
  }
  assert.equal(calls.length, 2);
});

test("read tool rejects invalid target values before its HTTP boundary", async () => {
  let fetchCalls = 0;
  const read = registeredTools({
    environment,
    createSearchClient: () => ({ search: async () => [] }),
    createKnowledgeClient: (input) => createBookStackKnowledgeClient({
      ...input,
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("unexpected_network");
      },
    }),
  }).get("ima_bookstack_read");

  const invalidRequests = [
    [{ sourceId: 42 }, /bookstack_source_id_invalid/],
    [{ sourceId: "x".repeat(129) }, /bookstack_source_id_invalid/],
    [{ url: 42 }, /bookstack_url_invalid/],
    [{ url: resolverTargetUrl("synthetic-book", "x".repeat(MAX_BOOKSTACK_PAGE_URL_BYTES + 1)) }, /bookstack_url_invalid/],
  ];
  for (const [request, error] of invalidRequests) {
    await assert.rejects(read.execute("invalid-value", request), error);
  }
  assert.equal(fetchCalls, 0);
});

test("Anthropic serialization exposes both bounded BookStack read targets", async () => {
  const read = registeredTools().get("ima_bookstack_read");
  let payload;
  let transportCalls = 0;
  const providerStream = streamAnthropicMessages({
    id: "synthetic-anthropic",
    name: "Synthetic Anthropic",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://not-used.example",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  }, {
    messages: [{ role: "user", content: "serialize", timestamp: 0 }],
    tools: [read],
  }, {
    client: {
      messages: {
        create: () => {
          transportCalls += 1;
          throw new Error("unexpected_network");
        },
      },
    },
    onPayload: (value) => {
      payload = value;
      throw new Error("stop_after_serialization");
    },
  });

  const result = await providerStream.result();
  assert.equal(result.stopReason, "error");
  assert.equal(transportCalls, 0);
  assert.ok(payload);
  const schema = payload.tools.find((tool) => tool.name === "ima_bookstack_read").input_schema;
  assert.equal(schema.type, "object");
  assert.deepEqual(Object.keys(schema.properties).sort(), ["sourceId", "url"]);
  assert.deepEqual(schema.required, []);
  assert.deepEqual(
    {
      type: schema.properties.sourceId.type,
      minLength: schema.properties.sourceId.minLength,
      maxLength: schema.properties.sourceId.maxLength,
    },
    { type: "string", minLength: 1, maxLength: 128 },
  );
  assert.deepEqual(
    {
      type: schema.properties.url.type,
      minLength: schema.properties.url.minLength,
      maxLength: schema.properties.url.maxLength,
    },
    { type: "string", minLength: 1, maxLength: MAX_BOOKSTACK_PAGE_URL_BYTES },
  );
  assert.match(schema.properties.sourceId.description, /mutually exclusive with url/i);
  assert.match(schema.properties.url.description, /mutually exclusive with sourceId/i);
});

test("BookStack page parsing accepts numeric and nested user IDs", () => {
  const numericUsers = parseBookStackPage(resolverPage({ created_by: 703, updated_by: 704 }));
  const nestedUsers = parseBookStackPage(resolverPage({
    created_by: { id: 703 },
    updated_by: { id: 704 },
  }));

  assert.deepEqual(
    { creatorId: numericUsers.creatorId, updaterId: numericUsers.updaterId },
    { creatorId: 703, updaterId: 704 },
  );
  assert.deepEqual(
    { creatorId: nestedUsers.creatorId, updaterId: nestedUsers.updaterId },
    { creatorId: 703, updaterId: 704 },
  );
});

test("URL resolution completes filtered pagination to select a later exact same-slug candidate", async () => {
  const entries = Array.from({ length: 501 }, (_, index) => index === 500
    ? resolverListEntry()
    : resolverListEntry({
      id: index + 1,
      book_id: index + 1_000,
      book_slug: "other-synthetic-book",
    }));
  const calls = [];
  const client = resolverClient(async (url, options) => {
    const request = new URL(String(url));
    calls.push({ request, options });
    if (request.pathname === "/api/pages") {
      const offset = Number(request.searchParams.get("offset"));
      return json({ total: entries.length, data: entries.slice(offset, offset + 500) });
    }
    if (request.pathname === "/api/pages/701") return json(resolverPage());
    if (request.pathname === "/api/books/702") return json(resolverBook());
    throw new Error("unexpected_resolver_request");
  });

  const result = await client.readPageByUrl(resolverTargetUrl());

  assert.equal(result.id, 701);
  assert.deepEqual(calls.map(({ request }) => request.pathname), [
    "/api/pages",
    "/api/pages",
    "/api/pages/701",
    "/api/books/702",
  ]);
  assert.deepEqual(calls.slice(0, 2).map(({ request }) => ({
    slug: request.searchParams.get("filter[slug]"),
    count: request.searchParams.get("count"),
    offset: request.searchParams.get("offset"),
    sort: request.searchParams.get("sort"),
  })), [
    { slug: "synthetic-page", count: "500", offset: "0", sort: "id" },
    { slug: "synthetic-page", count: "500", offset: "500", sort: "id" },
  ]);
  assert.equal(calls.some(({ request }) => request.pathname === "/api/books"), false);
});

test("URL resolution rejects ambiguous and draft filtered targets without fallback", async (t) => {
  const scenarios = [
    {
      name: "duplicate exact target",
      data: [resolverListEntry(), resolverListEntry({ id: 702 })],
      code: "bookstack_identity_ambiguous",
    },
    {
      name: "draft exact target",
      data: [resolverListEntry({ draft: true })],
      code: "bookstack_page_draft",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const calls = [];
      const client = resolverClient(async (url, options) => {
        const request = new URL(String(url));
        calls.push({ request, options });
        if (request.pathname !== "/api/pages") throw new Error("unexpected_fallback_request");
        return json({ total: scenario.data.length, data: scenario.data });
      });

      await assert.rejects(client.readPageByUrl(resolverTargetUrl()), new RegExp(scenario.code));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].request.pathname, "/api/pages");
      assert.equal(calls[0].request.searchParams.get("filter[slug]"), "synthetic-page");
    });
  }
});

test("URL resolution rejects invalid filtered pagination before fallback", async (t) => {
  const firstBatch = Array.from({ length: 500 }, (_, index) => resolverListEntry({
    id: index + 1,
    book_id: index + 1_000,
    book_slug: "other-synthetic-book",
  }));
  const scenarios = [
    {
      name: "malformed entry",
      responses: [{ total: 1, data: [{}] }],
      code: "bookstack_response_invalid",
    },
    {
      name: "incomplete page",
      responses: [{ total: 1, data: [] }],
      code: "bookstack_pagination_invalid",
    },
    {
      name: "changing total",
      responses: [
        { total: 501, data: firstBatch },
        { total: 502, data: [resolverListEntry({ id: 501, book_id: 1_501, book_slug: "other-synthetic-book" })] },
      ],
      code: "bookstack_pagination_invalid",
    },
    {
      name: "duplicate ID",
      responses: [
        { total: 501, data: firstBatch },
        { total: 501, data: [firstBatch[0]] },
      ],
      code: "bookstack_pagination_invalid",
    },
    {
      name: "total above filtered bound",
      responses: [{ total: 10_001, data: [] }],
      code: "bookstack_pagination_invalid",
    },
    {
      name: "batch above filtered bound",
      responses: [{ total: 501, data: Array.from({ length: 501 }, () => ({})) }],
      code: "bookstack_pagination_invalid",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const calls = [];
      const client = resolverClient(async (url, options) => {
        const request = new URL(String(url));
        calls.push({ request, options });
        if (request.pathname !== "/api/pages") throw new Error("unexpected_fallback_request");
        const response = scenario.responses[calls.length - 1];
        if (!response) throw new Error("unexpected_filtered_request");
        return json(response);
      });

      await assert.rejects(client.readPageByUrl(resolverTargetUrl()), new RegExp(scenario.code));
      assert.equal(calls.every(({ request }) => (
        request.pathname === "/api/pages" && request.searchParams.has("filter[slug]")
      )), true);
    });
  }
});

test("URL resolution fails closed without fallback for HTTP boundary failures", async (t) => {
  const scenarios = [
    { name: "authorization denial", reply: () => json({}, 401), code: "bookstack_access_denied" },
    { name: "HTTP failure", reply: () => json({}, 500), code: "bookstack_http_failed" },
    {
      name: "redirect response",
      reply: () => new Response("", {
        status: 302,
        headers: { "content-type": "application/json", location: "https://untrusted.example" },
      }),
      code: "bookstack_http_failed",
    },
    { name: "rate limit", reply: () => json({}, 429), code: "bookstack_http_failed" },
    {
      name: "transport failure",
      reply: () => { throw new Error("synthetic_transport_failure"); },
      code: "bookstack_transport_failed",
    },
    {
      name: "malformed JSON",
      reply: () => new Response("{", { headers: { "content-type": "application/json" } }),
      code: "bookstack_response_invalid",
    },
    {
      name: "oversized response",
      reply: () => new Response("x".repeat(600_000), { headers: { "content-type": "application/json" } }),
      code: "bookstack_response_too_large",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const calls = [];
      const client = resolverClient(async (url, options) => {
        calls.push({ request: new URL(String(url)), options });
        return scenario.reply();
      });

      await assert.rejects(client.readPageByUrl(resolverTargetUrl()), new RegExp(scenario.code));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].request.pathname, "/api/pages");
      assert.equal(calls[0].request.searchParams.has("filter[slug]"), true);
      assert.equal(calls[0].options.redirect, "error");
    });
  }
});

test("URL resolution fails closed when the caller signal is already cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  const calls = [];
  const client = resolverClient(async (url, options) => {
    calls.push({ request: new URL(String(url)), options });
    assert.equal(options.signal?.aborted, true);
    throw new Error("synthetic_cancellation");
  }, { signal: controller.signal });

  await assert.rejects(client.readPageByUrl(resolverTargetUrl()), /bookstack_transport_failed/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.pathname, "/api/pages");
});

test("URL resolution fails closed when the injectable HTTP timeout aborts", async () => {
  const calls = [];
  const client = resolverClient((url, options) => {
    calls.push({ request: new URL(String(url)), options });
    const signal = options.signal;
    return new Promise((_resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("synthetic_timeout"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new Error("synthetic_timeout")), { once: true });
    });
  }, { timeoutMs: 1 });

  await assert.rejects(client.readPageByUrl(resolverTargetUrl()), /bookstack_transport_failed/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.pathname, "/api/pages");
});

test("URL resolution verifies authoritative page and book IDs and slugs without fallback", async (t) => {
  const scenarios = [
    {
      name: "page ID",
      page: { id: 801 },
      code: "bookstack_response_invalid",
      paths: ["/api/pages", "/api/pages/701"],
    },
    {
      name: "page book ID",
      page: { book_id: 801 },
      code: "bookstack_identity_invalid",
      paths: ["/api/pages", "/api/pages/701"],
    },
    {
      name: "page slug",
      page: { slug: "different-synthetic-page" },
      code: "bookstack_identity_invalid",
      paths: ["/api/pages", "/api/pages/701"],
    },
    {
      name: "book ID",
      book: { id: 801 },
      code: "bookstack_response_invalid",
      paths: ["/api/pages", "/api/pages/701", "/api/books/702"],
    },
    {
      name: "book slug",
      book: { slug: "different-synthetic-book" },
      code: "bookstack_identity_invalid",
      paths: ["/api/pages", "/api/pages/701", "/api/books/702"],
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const calls = [];
      const client = resolverClient(async (url, options) => {
        const request = new URL(String(url));
        calls.push({ request, options });
        if (request.pathname === "/api/pages") {
          return json({ total: 1, data: [resolverListEntry()] });
        }
        if (request.pathname === "/api/pages/701") return json(resolverPage(scenario.page));
        if (request.pathname === "/api/books/702") return json(resolverBook(scenario.book));
        throw new Error("unexpected_fallback_request");
      });

      await assert.rejects(client.readPageByUrl(resolverTargetUrl()), new RegExp(scenario.code));
      assert.deepEqual(calls.map(({ request }) => request.pathname), scenario.paths);
      assert.equal(calls.some(({ request }) => request.pathname === "/api/books"), false);
      assert.equal(calls.filter(({ request }) => request.pathname === "/api/pages").every(({ request }) => (
        request.searchParams.has("filter[slug]")
      )), true);
    });
  }
});

test("URL resolution uses guarded book-first fallback for direct and chapter content pages", async (t) => {
  const scenarios = [
    {
      name: "direct page",
      contents: [{ type: "page", ...resolverContentPage() }],
    },
    {
      name: "chapter page",
      contents: [{
        type: "chapter",
        id: 703,
        book_id: 702,
        slug: "synthetic-chapter",
        pages: [resolverContentPage({ chapter_id: 703 })],
      }],
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const calls = [];
      const client = resolverClient(async (url, options) => {
        const request = new URL(String(url));
        calls.push({ request, options });
        if (request.pathname === "/api/pages") return json({ total: 0, data: [] });
        if (request.pathname === "/api/books") return json({ total: 1, data: [resolverBookListEntry()] });
        if (request.pathname === "/api/books/702") return json(resolverBookWithContents(scenario.contents));
        if (request.pathname === "/api/pages/701") return json(resolverPage());
        throw new Error("unexpected_resolver_request");
      });

      const result = await client.readPageByUrl(resolverTargetUrl());

      assert.equal(result.id, 701);
      assert.deepEqual(calls.map(({ request }) => request.pathname), [
        "/api/pages",
        "/api/books",
        "/api/books/702",
        "/api/pages/701",
      ]);
      assert.deepEqual({
        slug: calls[0].request.searchParams.get("filter[slug]"),
        count: calls[0].request.searchParams.get("count"),
        offset: calls[0].request.searchParams.get("offset"),
        sort: calls[0].request.searchParams.get("sort"),
      }, { slug: "synthetic-page", count: "500", offset: "0", sort: "id" });
      assert.deepEqual({
        count: calls[1].request.searchParams.get("count"),
        offset: calls[1].request.searchParams.get("offset"),
        sort: calls[1].request.searchParams.get("sort"),
      }, { count: "500", offset: "0", sort: "id" });
      assert.equal(calls.some(({ request }) => (
        request.pathname === "/api/pages" && !request.searchParams.has("filter[slug]")
      )), false);
    });
  }
});

test("URL resolution starts book-first fallback only after a complete zero-target filtered result", async () => {
  const crossBookEntries = Array.from({ length: 501 }, (_, index) => resolverListEntry({
    id: index + 1,
    book_id: index + 1_000,
    book_slug: "other-synthetic-book",
  }));
  const calls = [];
  const client = resolverClient(async (url, options) => {
    const request = new URL(String(url));
    calls.push({ request, options });
    if (request.pathname === "/api/pages") {
      const offset = Number(request.searchParams.get("offset"));
      return json({ total: crossBookEntries.length, data: crossBookEntries.slice(offset, offset + 500) });
    }
    if (request.pathname === "/api/books") return json({ total: 1, data: [resolverBookListEntry()] });
    if (request.pathname === "/api/books/702") {
      return json(resolverBookWithContents([{ type: "page", ...resolverContentPage() }]));
    }
    if (request.pathname === "/api/pages/701") return json(resolverPage());
    throw new Error("unexpected_resolver_request");
  });

  const result = await client.readPageByUrl(resolverTargetUrl());

  assert.equal(result.id, 701);
  assert.deepEqual(calls.map(({ request }) => request.pathname), [
    "/api/pages",
    "/api/pages",
    "/api/books",
    "/api/books/702",
    "/api/pages/701",
  ]);
  assert.deepEqual(calls.slice(0, 2).map(({ request }) => request.searchParams.get("offset")), ["0", "500"]);
  assert.equal(calls[2].request.pathname, "/api/books");
  assert.equal(calls.filter(({ request }) => request.pathname === "/api/pages").every(({ request }) => (
    request.searchParams.has("filter[slug]")
  )), true);
});

test("URL resolution rejects a draft fallback candidate without a page scan", async () => {
  const calls = [];
  const client = resolverClient(async (url, options) => {
    const request = new URL(String(url));
    calls.push({ request, options });
    if (request.pathname === "/api/pages") return json({ total: 0, data: [] });
    if (request.pathname === "/api/books") return json({ total: 1, data: [resolverBookListEntry()] });
    if (request.pathname === "/api/books/702") {
      return json(resolverBookWithContents([{ type: "page", ...resolverContentPage({ draft: true }) }]));
    }
    throw new Error("unexpected_page_scan");
  });

  await assert.rejects(client.readPageByUrl(resolverTargetUrl()), /bookstack_page_draft/);
  assert.deepEqual(calls.map(({ request }) => request.pathname), [
    "/api/pages",
    "/api/books",
    "/api/books/702",
  ]);
  assert.equal(calls.some(({ request }) => (
    request.pathname === "/api/pages" && !request.searchParams.has("filter[slug]")
  )), false);
});
