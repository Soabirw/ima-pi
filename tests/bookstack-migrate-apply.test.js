import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBookStackPages,
  buildBookStackCatalog,
} from "../lib/bookstack-migrate-apply.ts";
import { createBookStackClient } from "../lib/bookstack-migrate-client.ts";
import { sourceHash, targetPage } from "../lib/bookstack-migrate-source.ts";

const page = (path) => {
  const body = `# ${path}\n`;
  return targetPage({
    kind: "knowledge",
    sourceOrigin: "filesystem",
    sourceId: `filesystem:${path}`,
    project: "ima-rag",
    artifactType: "knowledge",
    sourceRefs: [`path:${path}`],
    createdAt: "2026-09-10T00:00:00.000Z",
    author: "legacy-unknown",
    body,
    sourceHash: sourceHash(body),
    path,
  });
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

// This is a test-only quota model, not evidence of a deployed BookStack quota.
const SYNTHETIC_QUOTA = Object.freeze({
  maximumStartsPerWindow: 1,
  windowMs: 1_100,
});
const EXISTING_PAGE_COUNT = 1_566;

const syntheticQuotaViolations = (starts, quota) => starts.flatMap((startedAt, index) => {
  const startsInWindow = starts
    .slice(0, index)
    .filter((priorStartedAt) => startedAt - priorStartedAt < quota.windowMs);
  return startsInWindow.length >= quota.maximumStartsPerWindow
    ? [{ startedAt, startsInWindow }]
    : [];
});

const assertWithinSyntheticQuota = (starts, quota) => {
  if (syntheticQuotaViolations(starts, quota).length > 0) {
    throw new Error("synthetic_quota_exceeded");
  }
};

const matchingExistingPage = (index) => {
  const path = `archive/repeat/page-${String(index).padStart(4, "0")}.md`;
  const body = `# Existing page ${index}\n`;
  return targetPage({
    kind: "knowledge",
    sourceOrigin: "filesystem",
    sourceId: `filesystem:${path}`,
    project: "ima-rag",
    artifactType: "knowledge",
    sourceRefs: [`path:${path}`],
    createdAt: "2026-09-10T00:00:00.000Z",
    author: "legacy-unknown",
    body,
    sourceHash: sourceHash(body),
    path,
  });
};

const fakeClient = ({ failPage } = {}) => {
  const calls = { shelves: 0, shelfReads: 0, books: 0, chapters: 0, pages: 0, shelfWrites: 0, bookCreates: 0, chapterCreates: 0, pageCreates: 0, order: [] };
  let id = 10;
  const stored = new Map();
  const client = {
    listShelves: async () => { calls.shelves += 1; return [
      { id: 1, name: "Lifecycle Artifacts" },
      { id: 2, name: "Institutional Knowledge" },
    ]; },
    readShelf: async (shelfId) => { calls.shelfReads += 1; return { id: shelfId, name: shelfId === 1 ? "Lifecycle Artifacts" : "Institutional Knowledge", books: [] }; },
    listBooks: async () => { calls.books += 1; return []; },
    listChapters: async () => { calls.chapters += 1; return []; },
    listPages: async () => { calls.pages += 1; return []; },
    createBook: async (name) => { calls.bookCreates += 1; calls.order.push("book"); return { id: id++, name }; },
    replaceShelfBooks: async () => { calls.shelfWrites += 1; calls.order.push("shelf"); },
    createChapter: async (name, bookId) => { calls.chapterCreates += 1; calls.order.push("chapter"); return { id: id++, name, book_id: bookId }; },
    createPage: async (name, chapterId, markdown) => {
      calls.pageCreates += 1;
      calls.order.push("page");
      if (failPage) throw new Error(failPage);
      const created = { id: id++, name, chapter_id: chapterId, markdown };
      stored.set(created.id, created);
      return created;
    },
    readPage: async (pageId) => stored.get(pageId),
  };
  return { client, calls };
};

const existingPageClient = (target, markdown) => {
  const calls = { pageReads: 0, writes: 0 };
  const unexpectedWrite = async () => {
    calls.writes += 1;
    throw new Error("unexpected_write");
  };
  return {
    calls,
    client: {
      listShelves: async () => [
        { id: 1, name: "Lifecycle Artifacts" },
        { id: 2, name: "Institutional Knowledge" },
      ],
      readShelf: async (id) => ({
        id,
        name: id === 1 ? "Lifecycle Artifacts" : "Institutional Knowledge",
        books: id === 2 ? [{ id: 10 }] : [],
      }),
      listBooks: async () => [{ id: 10, name: target.bookName }],
      listChapters: async () => [{ id: 20, name: target.chapterName, book_id: 10 }],
      listPages: async () => [{ id: 30, name: target.pageName, chapter_id: 20 }],
      readPage: async (id) => {
        calls.pageReads += 1;
        return { id, name: target.pageName, chapter_id: 20, markdown };
      },
      createBook: unexpectedWrite,
      replaceShelfBooks: unexpectedWrite,
      createChapter: unexpectedWrite,
      createPage: unexpectedWrite,
    },
  };
};

test("apply scans the catalog once and reuses hierarchy and shelf membership in memory", async () => {
  const { client, calls } = fakeClient();
  const catalog = await buildBookStackCatalog(client);
  const outcomes = await applyBookStackPages({
    client,
    catalog,
    pages: [page("guides/one.md"), page("guides/two.md")],
  });

  assert.deepEqual(outcomes.map(({ status }) => status), ["created", "created"]);
  assert.deepEqual(
    [calls.shelves, calls.shelfReads, calls.books, calls.chapters, calls.pages],
    [1, 2, 1, 1, 1],
  );
  assert.equal(calls.bookCreates, 1);
  assert.equal(calls.chapterCreates, 1);
  assert.equal(calls.shelfWrites, 1);
  assert.deepEqual(calls.order.slice(0, 3), ["book", "shelf", "chapter"]);
});

test("a systemic failure trips the breaker and marks remaining pages without more writes", async () => {
  const { client, calls } = fakeClient({ failPage: "bookstack_http_429" });
  const catalog = await buildBookStackCatalog(client);
  const outcomes = await applyBookStackPages({
    client,
    catalog,
    pages: [page("one/a.md"), page("two/b.md"), page("three/c.md")],
  });

  assert.deepEqual(outcomes.map(({ code }) => code), [
    "bookstack_http_429",
    "apply_not_attempted",
    "apply_not_attempted",
  ]);
  assert.equal(calls.pageCreates, 1);
});

test("an item identity conflict is recorded while later pages continue", async () => {
  const { client, calls } = fakeClient();
  client.listBooks = async () => {
    calls.books += 1;
    return [{ id: 3, name: "one" }, { id: 4, name: "one" }];
  };
  const catalog = await buildBookStackCatalog(client);
  const outcomes = await applyBookStackPages({
    client,
    catalog,
    pages: [page("one/a.md"), page("two/b.md")],
  });

  assert.equal(outcomes[0].status, "failed");
  assert.equal(outcomes[0].code, "bookstack_identity_ambiguous");
  assert.equal(outcomes[1].status, "created");
  assert.equal(calls.pageCreates, 1);
});

test("preserves matching body/hash integrity and records edited existing Pages as conflicts", async () => {
  const target = page("archive/repeat/existing.md");
  assert.equal(target.sourceHash, sourceHash(target.body));

  const matching = existingPageClient(target, target.markdown.replace(/\n+$/, ""));
  const matchingCatalog = await buildBookStackCatalog(matching.client);
  const matchingOutcomes = await applyBookStackPages({
    client: matching.client,
    catalog: matchingCatalog,
    pages: [target],
  });
  assert.deepEqual(matchingOutcomes, [{
    sourceId: target.sourceId,
    sourceHash: target.sourceHash,
    status: "unchanged",
    targetId: 30,
  }]);
  assert.equal(matching.calls.writes, 0);

  const editedMarkdown = `${target.markdown.slice(0, -target.body.length)}# Human edit\n`;
  const edited = existingPageClient(target, editedMarkdown);
  const editedCatalog = await buildBookStackCatalog(edited.client);
  const editedOutcomes = await applyBookStackPages({
    client: edited.client,
    catalog: editedCatalog,
    pages: [target],
  });
  assert.deepEqual(editedOutcomes, [{
    sourceId: target.sourceId,
    sourceHash: target.sourceHash,
    status: "conflict",
    targetId: 30,
  }]);
  assert.equal(edited.calls.writes, 0);
});

test("does not replay an ambiguous Page write after a transport failure", async () => {
  const { client, calls } = fakeClient({ failPage: "bookstack_transport_failed" });
  const catalog = await buildBookStackCatalog(client);
  const outcomes = await applyBookStackPages({
    client,
    catalog,
    pages: [page("one/a.md"), page("two/b.md")],
  });

  assert.deepEqual(outcomes.map(({ code }) => code), [
    "bookstack_transport_failed",
    "apply_not_attempted",
  ]);
  assert.equal(calls.pageCreates, 1);
});

test("the synthetic quota detector independently rejects an over-budget start sequence", () => {
  assert.throws(() => assertWithinSyntheticQuota(
    [0, SYNTHETIC_QUOTA.windowMs - 1],
    SYNTHETIC_QUOTA,
  ), /synthetic_quota_exceeded/);
});

test("keeps 1,566 matching existing Pages unchanged under the explicit synthetic quota model", async () => {
  const pages = Array.from({ length: EXISTING_PAGE_COUNT }, (_, index) => matchingExistingPage(index));
  const pageById = new Map(pages.map((target, index) => [10_000 + index, target]));
  let current = 0;
  let writes = 0;
  const starts = [];
  const client = createBookStackClient({
    origin: "https://bookstack.example",
    tokenId: "test-id",
    tokenSecret: "synthetic-token-secret",
    requestIntervalMs: SYNTHETIC_QUOTA.windowMs,
    now: () => current,
    wait: async (milliseconds) => { current += milliseconds; },
    fetch: async (url, options = {}) => {
      starts.push(current);
      assertWithinSyntheticQuota(starts, SYNTHETIC_QUOTA);
      if (options.method && options.method !== "GET") {
        writes += 1;
        throw new Error("synthetic_write_disallowed");
      }

      const request = new URL(url);
      if (request.pathname === "/api/shelves") {
        return json({ data: [
          { id: 1, name: "Lifecycle Artifacts" },
          { id: 2, name: "Institutional Knowledge" },
        ] });
      }
      if (request.pathname === "/api/shelves/1") {
        return json({ id: 1, name: "Lifecycle Artifacts", books: [] });
      }
      if (request.pathname === "/api/shelves/2") {
        return json({ id: 2, name: "Institutional Knowledge", books: [{ id: 10 }] });
      }
      if (request.pathname === "/api/books") return json({ data: [{ id: 10, name: "archive" }] });
      if (request.pathname === "/api/chapters") return json({ data: [{ id: 20, name: "repeat", book_id: 10 }] });
      if (request.pathname === "/api/pages") {
        const offset = Number(request.searchParams.get("offset"));
        return json({
          data: pages.slice(offset, offset + 500).map((target, index) => ({
            id: 10_000 + offset + index,
            name: target.pageName,
            chapter_id: 20,
          })),
        });
      }
      const pageMatch = request.pathname.match(/^\/api\/pages\/(\d+)$/);
      if (pageMatch) {
        const id = Number(pageMatch[1]);
        const target = pageById.get(id);
        if (!target) throw new Error("synthetic_page_missing");
        return json({ id, name: target.pageName, chapter_id: 20, markdown: target.markdown });
      }
      throw new Error("synthetic_unexpected_request");
    },
  });

  const catalog = await buildBookStackCatalog(client);
  const outcomes = await applyBookStackPages({ client, catalog, pages });
  const violations = syntheticQuotaViolations(starts, SYNTHETIC_QUOTA);

  assert.equal(outcomes.length, EXISTING_PAGE_COUNT);
  assert.equal(outcomes.every(({ status }) => status === "unchanged"), true);
  assert.equal(writes, 0);
  assert.deepEqual(violations, []);
  assert.equal(starts.length, 1_575);
  assert.equal(current, (starts.length - 1) * SYNTHETIC_QUOTA.windowMs);
});
