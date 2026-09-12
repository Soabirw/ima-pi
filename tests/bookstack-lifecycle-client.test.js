import assert from "node:assert/strict";
import test from "node:test";
import { createBookStackLifecycleClient } from "../lib/bookstack-lifecycle-client.ts";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});
const resource = (overrides = {}) => ({ id: 1, name: "item", slug: "item", ...overrides });
const clientWith = (fetch) => createBookStackLifecycleClient({
  origin: "https://bookstack.example",
  tokenId: "id",
  tokenSecret: "secret",
  fetch,
});

test("client uses bounded paths and verifies ordered shelf membership", async () => {
  const calls = [];
  let shelfBooks = [2];
  const client = clientWith(async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("shelves/1") && options.method === "PUT") {
      shelfBooks = JSON.parse(options.body).books;
      return json(resource({ name: "Lifecycle", slug: "lifecycle-artifacts", books: shelfBooks }));
    }
    if (String(url).includes("shelves/1")) {
      return json(resource({ name: "Lifecycle", slug: "lifecycle-artifacts", books: shelfBooks }));
    }
    if (String(url).includes("shelves?")) {
      return json({ data: [resource({ name: "Lifecycle", slug: "lifecycle-artifacts" })], total: 1 });
    }
    return json(resource());
  });
  assert.equal((await client.listShelves())[0].slug, "lifecycle-artifacts");
  await client.replaceShelfBooks({ shelfId: 1, shelfName: "Lifecycle", expectedBooks: [2, 3] });
  assert.match(calls[0].url, /\/api\/shelves\?count=500&offset=0$/);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.authorization, "Token id:secret");
  assert.deepEqual(shelfBooks, [2, 3]);
});

test("generic decoding accepts documented unrelated resources and user ID shapes", async () => {
  const client = clientWith(async () => json({ data: [
    resource({ id: 1, slug: "Mixed-Case-Book" }),
    resource({ id: 2, slug: "direct-page", chapter_id: null, created_by: { id: 7 }, updated_by: 8 }),
  ], total: 2 }));
  const pages = await client.listPages();
  assert.equal(pages[0].slug, "Mixed-Case-Book");
  assert.equal(pages[1].chapterId, undefined);
  assert.equal(pages[1].creatorId, 7);
  assert.equal(pages[1].updaterId, 8);
});

test("pagination requires one stable exact total and rejects incomplete authority", async () => {
  const cases = [
    { name: "missing total", pages: [{ data: [] }] },
    { name: "premature short page", pages: [{ data: [resource()], total: 2 }] },
    { name: "total overflow", pages: [{ data: [], total: 10_001 }] },
    { name: "oversized batch", pages: [{ data: Array.from({ length: 501 }, (_, index) => resource({ id: index + 1 })), total: 501 }] },
    { name: "duplicate ids", pages: [{ data: [resource(), resource()], total: 2 }] },
    {
      name: "changing total",
      pages: [
        { data: Array.from({ length: 500 }, (_, index) => resource({ id: index + 1 })), total: 501 },
        { data: [resource({ id: 501 })], total: 500 },
      ],
    },
  ];
  for (const scenario of cases) {
    let call = 0;
    const client = clientWith(async () => json(scenario.pages[call++] ?? scenario.pages.at(-1)));
    await assert.rejects(client.listBooks(), /bookstack_pagination_invalid/, scenario.name);
  }
});

test("pagination accepts exact 500-entry and 10,000-entry boundaries", async () => {
  for (const total of [500, 10_000]) {
    const client = clientWith(async (url) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      const count = Math.min(500, total - offset);
      return json({
        data: Array.from({ length: count }, (_, index) => resource({ id: offset + index + 1 })),
        total,
      });
    });
    assert.equal((await client.listBooks()).length, total);
  }
});

test("client rejects oversized responses and retains a validated ID on malformed create responses", async () => {
  const oversized = clientWith(async () => new Response("x".repeat(5 * 1024 * 1024), {
    headers: { "content-type": "application/json" },
  }));
  await assert.rejects(oversized.listBooks(), /bookstack_response_too_large/);

  const malformed = clientWith(async () => json({ id: 42, name: "created-without-slug" }));
  await assert.rejects(malformed.createBook("project"), (error) => {
    assert.equal(error.message, "bookstack_response_invalid");
    assert.equal(error.knownResourceId, 42);
    return true;
  });
});
