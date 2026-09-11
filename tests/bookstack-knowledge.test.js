import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import {
  buildFrontmatterEnvelope,
  buildPermalink,
  detectUpdateConflict,
  normalizeSearchResults,
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
