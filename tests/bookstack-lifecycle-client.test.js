import assert from "node:assert/strict";
import test from "node:test";
import { createBookStackLifecycleClient } from "../lib/bookstack-lifecycle-client.ts";
import { createBookStackLifecycleRequestScheduler } from "../lib/bookstack-lifecycle-requests.ts";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});
const resource = (overrides = {}) => ({ id: 1, name: "item", slug: "item", ...overrides });
const immediateScheduler = {
  schedule: ({ start }) => Promise.resolve().then(start),
};
const clientWith = (fetch, requestScheduler = immediateScheduler) => createBookStackLifecycleClient({
  origin: "https://bookstack.example",
  tokenId: "id",
  tokenSecret: "secret",
  fetch,
  requestScheduler,
});
const virtualClock = (initial = 0) => {
  let current = initial;
  const waits = [];
  return {
    now: () => current,
    wait: async (milliseconds, signal) => {
      waits.push({ milliseconds, signal });
      current += milliseconds;
    },
    get time() { return current; },
    waits,
  };
};
const schedulerFor = (clock) => createBookStackLifecycleRequestScheduler({
  now: clock.now,
  wait: clock.wait,
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
  assert.match(calls[0].url, /\/api\/shelves\?count=500&offset=0&sort=%2Bid$/);
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

test("page-list discovery preserves unrelated empty slugs across pagination while strict reads and creates reject them", async () => {
  const offsets = [];
  const listed = clientWith(async (url) => {
    const offset = Number(new URL(url).searchParams.get("offset"));
    offsets.push(offset);
    return json(offset === 0
      ? {
        data: Array.from({ length: 500 }, (_, index) => resource({
          id: index + 1,
          slug: index < 2 ? "" : `unrelated-${index + 1}`,
        })),
        total: 502,
      }
      : {
        data: [
          resource({ id: 501, slug: "canonical-page", chapter_id: 3 }),
          resource({ id: 502, slug: "" }),
        ],
        total: 502,
      });
  });
  const pages = await listed.listPages();
  assert.deepEqual(offsets, [0, 500]);
  assert.equal(pages.length, 502);
  assert.equal(pages[0].slug, "");
  assert.equal(pages[1].slug, "");
  assert.equal(pages[500].slug, "canonical-page");
  assert.equal(pages[501].slug, "");

  const strict = clientWith(async () => json(resource({ slug: "" })));
  await assert.rejects(strict.readPage(1), /bookstack_response_invalid/);
  await assert.rejects(strict.createPage("page", 1, "# Page"), /bookstack_response_invalid/);

  const nonPageList = clientWith(async () => json({
    data: [resource({ slug: "" })],
    total: 1,
  }));
  await assert.rejects(nonPageList.listBooks(), /bookstack_response_invalid/);
});

test("non-page lists reject empty slugs at nonzero indexes and later pagination", async () => {
  const lists = [
    ["shelves", (client) => client.listShelves()],
    ["books", (client) => client.listBooks()],
    ["chapters", (client) => client.listChapters()],
  ];
  for (const [name, list] of lists) {
    const nonzero = clientWith(async () => json({
      data: [resource({ id: 1 }), resource({ id: 2, slug: "" })],
      total: 2,
    }));
    await assert.rejects(list(nonzero), /bookstack_response_invalid/, `${name} nonzero index`);

    const offsets = [];
    const laterPage = clientWith(async (url) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      offsets.push(offset);
      return json(offset === 0
        ? {
          data: Array.from({ length: 500 }, (_, index) => resource({
            id: index + 1,
            slug: `valid-${index + 1}`,
          })),
          total: 502,
        }
        : {
          data: [resource({ id: 501 }), resource({ id: 502, slug: "" })],
          total: 502,
        });
    });
    await assert.rejects(list(laterPage), /bookstack_response_invalid/, `${name} later pagination`);
    assert.deepEqual(offsets, [0, 500], `${name} later pagination`);
  }
});

test("pagination rejects incomplete, malformed, shrinking, and unordered authority", async () => {
  const batch = (firstId = 1) => Array.from(
    { length: 500 },
    (_, index) => resource({ id: firstId + index }),
  );
  const cases = [
    { name: "missing total", pages: [{ data: [] }] },
    { name: "premature short page", pages: [{ data: [resource()], total: 2 }] },
    { name: "total overflow", pages: [{ data: [], total: 10_001 }] },
    { name: "oversized batch", pages: [{ data: Array.from({ length: 501 }, (_, index) => resource({ id: index + 1 })), total: 501 }] },
    {
      name: "malformed resource",
      pages: [{ data: [resource({ id: 0 })], total: 1 }],
      expectedError: /bookstack_response_invalid/,
    },
    { name: "duplicate IDs", pages: [{ data: [resource(), resource()], total: 2 }] },
    { name: "descending IDs in one batch", pages: [{ data: [resource({ id: 2 }), resource({ id: 1 })], total: 2 }] },
    {
      name: "overlapping IDs across batches",
      pages: [
        { data: batch(), total: 502 },
        { data: [resource({ id: 500 }), resource({ id: 502 })], total: 502 },
      ],
    },
    {
      name: "reordered IDs across batches",
      pages: [
        { data: batch(2), total: 502 },
        { data: [resource({ id: 1 }), resource({ id: 502 })], total: 502 },
      ],
    },
    {
      name: "incomplete page after growth",
      pages: [
        { data: batch(), total: 501 },
        { data: [resource({ id: 501 })], total: 502 },
      ],
    },
    {
      name: "shrinking total",
      pages: [
        { data: batch(), total: 501 },
        { data: [resource({ id: 501 })], total: 500 },
      ],
    },
  ];
  for (const scenario of cases) {
    let call = 0;
    const client = clientWith(async () => json(scenario.pages[call++] ?? scenario.pages.at(-1)));
    await assert.rejects(
      client.listBooks(),
      scenario.expectedError ?? /bookstack_pagination_invalid/,
      scenario.name,
    );
  }
});

test("pagination accepts concurrent append-only growth under explicit ID ordering", async () => {
  const offsets = [];
  const client = clientWith(async (url) => {
    const parsed = new URL(url);
    const offset = Number(parsed.searchParams.get("offset"));
    offsets.push(offset);
    assert.equal(parsed.searchParams.get("sort"), "+id");
    return json(offset === 0
      ? {
        data: Array.from({ length: 500 }, (_, index) => resource({ id: index + 1 })),
        total: 501,
      }
      : {
        data: [resource({ id: 501 }), resource({ id: 502 })],
        total: 502,
      });
  });
  assert.equal((await client.listPages()).length, 502);
  assert.deepEqual(offsets, [0, 500]);
});

test("pagination accepts strictly ascending ID gaps across batches", async () => {
  const offsets = [];
  const client = clientWith(async (url) => {
    const offset = Number(new URL(url).searchParams.get("offset"));
    offsets.push(offset);
    return json(offset === 0
      ? {
        data: Array.from({ length: 500 }, (_, index) => resource({ id: index + 1 })),
        total: 502,
      }
      : {
        data: [resource({ id: 502 }), resource({ id: 1_000 })],
        total: 502,
      });
  });
  const pages = await client.listBooks();
  assert.equal(pages.length, 502);
  assert.deepEqual(pages.slice(-2).map((page) => page.id), [502, 1_000]);
  assert.deepEqual(offsets, [0, 500]);
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

test("pagination retries only the failed offset through the lifecycle lane", async () => {
  const clock = virtualClock();
  const calls = [];
  let laterAttempts = 0;
  const client = clientWith(async (url) => {
    const offset = Number(new URL(url).searchParams.get("offset"));
    calls.push({ offset, at: clock.time });
    if (offset === 500) {
      laterAttempts += 1;
      if (laterAttempts === 1) return new Response("retry", { status: 503 });
    }
    return json({
      total: 501,
      data: offset === 0
        ? Array.from({ length: 500 }, (_, index) => resource({ id: index + 1 }))
        : [resource({ id: 501 })],
    });
  }, schedulerFor(clock));

  const pages = await client.listPages();

  assert.equal(pages.length, 501);
  assert.deepEqual(calls, [
    { offset: 0, at: 0 },
    { offset: 500, at: 1_100 },
    { offset: 500, at: 2_200 },
  ]);
});

test("lost POSTs and failed PUTs make one write attempt while verification reads may retry", async () => {
  const postClock = virtualClock();
  let postCalls = 0;
  const lostPost = clientWith(async () => {
    postCalls += 1;
    const error = new Error("lost synthetic POST response");
    error.code = "ECONNRESET";
    throw error;
  }, schedulerFor(postClock));
  await assert.rejects(lostPost.createPage("Page", 1, "# Page"), /bookstack_transport_failed/);
  assert.equal(postCalls, 1);

  const putClock = virtualClock();
  const failedPutCalls = [];
  const failedPut = clientWith(async (_url, init = {}) => {
    failedPutCalls.push({ method: init.method ?? "GET", at: putClock.time });
    return new Response("upstream", { status: 503 });
  }, schedulerFor(putClock));
  await assert.rejects(
    failedPut.replaceShelfBooks({ shelfId: 1, shelfName: "Lifecycle", expectedBooks: [2] }),
    /bookstack_http_failed/,
  );
  assert.deepEqual(failedPutCalls, [{ method: "PUT", at: 0 }]);

  const verificationClock = virtualClock();
  const verificationCalls = [];
  let readBackAttempts = 0;
  const verified = clientWith(async (_url, init = {}) => {
    const method = init.method ?? "GET";
    verificationCalls.push({ method, at: verificationClock.time });
    if (method === "PUT") {
      return json(resource({ id: 1, name: "Lifecycle", slug: "lifecycle-artifacts", books: [2] }));
    }
    readBackAttempts += 1;
    return readBackAttempts === 1
      ? new Response("retry", { status: 503 })
      : json(resource({ id: 1, name: "Lifecycle", slug: "lifecycle-artifacts", books: [2] }));
  }, schedulerFor(verificationClock));

  await verified.replaceShelfBooks({ shelfId: 1, shelfName: "Lifecycle", expectedBooks: [2] });
  assert.deepEqual(verificationCalls, [
    { method: "PUT", at: 0 },
    { method: "GET", at: 1_100 },
    { method: "GET", at: 2_200 },
  ]);
});
