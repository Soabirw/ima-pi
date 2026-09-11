import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBookStackPages,
  buildBookStackCatalog,
} from "../lib/bookstack-migrate-apply.ts";
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
