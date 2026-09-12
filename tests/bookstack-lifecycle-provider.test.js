import assert from "node:assert/strict";
import test from "node:test";
import { createBookStackLifecycleProvider } from "../lib/bookstack-lifecycle.ts";
import { recoveryDescriptor } from "../lib/bookstack-lifecycle-recovery.ts";

const sourceRef = "taskwarrior:shared-dev-memory:cc4755dd-67bf-49a6-8e2d-6563d080dde1";
const identity = {
  project: "shared-dev-memory",
  lifecycleKey: "shared-dev-memory:manual:test",
  lifecycleRootMemoryId: "root",
  taskwarriorProject: "shared-dev-memory",
  taskwarriorTask: "T13",
  taskwarriorUuid: "cc4755dd-67bf-49a6-8e2d-6563d080dde1",
  jiraKey: "",
  sourceRefs: [sourceRef],
  priorArtifactIds: [],
};
const placement = {
  projectSlug: "shared-dev-memory",
  sourceRef,
  lifecycleKey: identity.lifecycleKey,
  shelfId: 1,
  shelfSlug: "lifecycle-artifacts",
  bookId: 2,
  bookSlug: "shared-dev-memory",
  chapterId: 3,
  chapterSlug: "taskwarrior-cc4755dd-67bf-49a6-8e2d-6563d080dde1",
};
const request = { type: "plan", identity, summary: "Approved plan", artifact: "# Plan\n\nApproved." };

const createClient = (options = {}) => {
  const shelf = { id: 1, name: "Lifecycle", slug: "lifecycle-artifacts", books: [2] };
  const book = { id: 2, name: "Shared", slug: "shared-dev-memory" };
  const chapter = { id: 3, name: placement.chapterSlug, slug: placement.chapterSlug, bookId: 2 };
  const pages = [];
  let creates = 0;
  let nextPageId = 42;
  let reads = 0;
  return {
    origin: options.origin ?? "https://bookstack.example",
    listPages: async () => pages.map((page) => ({ ...page })),
    readShelf: async () => ({ ...shelf, books: [...shelf.books] }),
    readBook: async () => ({ ...book }),
    readChapter: async () => ({ ...chapter }),
    readPage: async (id) => {
      reads += 1;
      return { ...pages.find((page) => page.id === id) };
    },
    createPage: async (name, chapterId, markdown) => {
      creates += 1;
      const page = {
        id: nextPageId++,
        name,
        slug: options.pageSlug ?? name,
        bookId: 2,
        chapterId,
        markdown,
        revisionCount: 1,
        updatedAt: "2026-09-11T00:00:00Z",
        creatorId: 7,
        updaterId: 8,
      };
      pages.push(page);
      if (options.loseCreateResponse) throw new Error("socket token=secret");
      return { ...page };
    },
    movePage: () => { pages[0].chapterId = 99; },
    duplicateCanonicalPage: () => {
      pages.push({ ...pages[0], id: nextPageId++ });
    },
    alterPage: (change) => Object.assign(pages[0], change),
    detachBook: () => { shelf.books = []; },
    creates: () => creates,
    pageIds: () => pages.map((page) => page.id),
    reads: () => reads,
  };
};

const createPlacementClient = () => {
  const shelves = [];
  const books = [];
  const chapters = [];
  const calls = { approvals: 0, creates: 0, updates: 0, reads: 0 };
  return {
    origin: "https://bookstack.example",
    listShelves: async () => shelves.map(({ books: _books, ...shelf }) => ({ ...shelf })),
    listBooks: async () => books.map((book) => ({ ...book })),
    listChapters: async () => chapters.map((chapter) => ({ ...chapter })),
    readShelf: async (id) => { calls.reads += 1; return structuredClone(shelves.find((item) => item.id === id)); },
    readBook: async (id) => { calls.reads += 1; return structuredClone(books.find((item) => item.id === id)); },
    readChapter: async (id) => { calls.reads += 1; return structuredClone(chapters.find((item) => item.id === id)); },
    createShelf: async (name) => { calls.creates += 1; const shelf = { id: 1, name, slug: name, books: [] }; shelves.push(shelf); return structuredClone(shelf); },
    createBook: async (name) => { calls.creates += 1; const book = { id: 2, name, slug: name }; books.push(book); return structuredClone(book); },
    createChapter: async (name, bookId) => { calls.creates += 1; const chapter = { id: 3, name, slug: name, bookId }; chapters.push(chapter); return structuredClone(chapter); },
    replaceShelfBooks: async ({ shelfId, expectedBooks }) => { calls.updates += 1; shelves[0].books = [...expectedBooks]; return structuredClone(shelves.find((item) => item.id === shelfId)); },
    calls,
  };
};

test("public ensurePlacement distinguishes absent and valid recovery dispatch", async () => {
  const normalClient = createPlacementClient();
  const normal = createBookStackLifecycleProvider({
    client: normalClient,
    approvePlacement: () => { normalClient.calls.approvals += 1; return true; },
  });
  const normalResult = await normal.ensurePlacement({
    projectSlug: placement.projectSlug,
    sourceRef,
    lifecycleKey: identity.lifecycleKey,
  });
  assert.equal(normalResult.status, "verified");
  assert.equal(normalClient.calls.approvals, 1);
  assert.equal(normalClient.calls.creates, 3);
  assert.equal(normalClient.calls.updates, 1);

  const recoveryClient = createPlacementClient();
  const shelf = { id: 7, name: "Lifecycle", slug: "lifecycle-artifacts", books: [] };
  recoveryClient.listShelves = async () => [{ id: shelf.id, name: shelf.name, slug: shelf.slug }];
  recoveryClient.readShelf = async (id) => { recoveryClient.calls.reads += 1; return id === shelf.id ? structuredClone(shelf) : undefined; };
  const recovery = recoveryDescriptor({
    origin: recoveryClient.origin,
    operation: "create_shelf",
    projectSlug: placement.projectSlug,
    sourceRef,
    lifecycleKey: identity.lifecycleKey,
    intendedSlug: "lifecycle-artifacts",
    shelfId: null,
    shelfSlug: "lifecycle-artifacts",
    bookId: null,
    bookSlug: placement.projectSlug,
    chapterId: null,
    chapterSlug: placement.chapterSlug,
    pageId: null,
    membershipBefore: [],
    membershipAfter: ["new-project-book"],
    artifactId: "",
    recordKey: "",
    contentHash: "",
    pageHash: "",
  });
  const recovered = await createBookStackLifecycleProvider({
    client: recoveryClient,
    approvePlacement: () => { recoveryClient.calls.approvals += 1; return true; },
  }).ensurePlacement({
    projectSlug: placement.projectSlug,
    sourceRef,
    lifecycleKey: identity.lifecycleKey,
    recovery: JSON.parse(JSON.stringify(recovery)),
  });
  assert.equal(recovered.status, "blocked");
  assert.equal(recovered.code, "bookstack_recovery_reconciled");
  assert.equal(recoveryClient.calls.reads, 1);
  assert.equal(recoveryClient.calls.creates, 0);
  assert.equal(recoveryClient.calls.updates, 0);
  assert.equal(recoveryClient.calls.approvals, 0);
});

test("provider verifies hierarchy and full evidence, then makes identical retries unchanged", async () => {
  const fake = createClient();
  const provider = createBookStackLifecycleProvider({ client: fake });
  const first = await provider.persist({ request, placement });
  assert.equal(first.status, "verified");
  assert.equal(first.disposition, "stored");
  assert.equal(first.sourceId, "bookstack:lifecycle:42");
  assert.equal(first.locator.originFingerprint, first.originFingerprint);
  assert.equal(first.locator.revisionCount, 1);

  const second = await provider.persist({ request, placement });
  assert.equal(second.status, "verified");
  assert.equal(second.disposition, "unchanged");
  assert.equal(fake.creates(), 1);
  assert.equal((await provider.get(JSON.parse(JSON.stringify(first.locator)))).status, "verified");
});

test("same artifact identity with changed summary conflicts without another POST", async () => {
  const fake = createClient();
  const provider = createBookStackLifecycleProvider({ client: fake });
  const first = await provider.persist({ request, placement });
  const result = await provider.persist({
    request: { ...request, summary: "Changed summary" },
    placement,
  });
  assert.equal(first.status, "verified");
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "bookstack_verification_failed");
  assert.equal(fake.creates(), 1);
});

test("TEST-005 moved canonical pages block retries without duplicate POSTs", async () => {
  for (const movedPage of [
    { chapterId: 99 },
    { bookId: 98, chapterId: 99 },
  ]) {
    const fake = createClient();
    const provider = createBookStackLifecycleProvider({ client: fake });
    const first = await provider.persist({ request, placement });
    const writesBeforeRetry = fake.creates();
    fake.alterPage(movedPage);
    const retry = await provider.persist({ request, placement });
    assert.equal(first.status, "verified");
    assert.equal(retry.status, "blocked");
    assert.equal(retry.code, "bookstack_placement_conflict");
    assert.equal(fake.creates(), writesBeforeRetry);
  }
});

test("multiple canonical page candidates block without fallback writes", async () => {
  const fake = createClient();
  const provider = createBookStackLifecycleProvider({ client: fake });
  const first = await provider.persist({ request, placement });
  fake.duplicateCanonicalPage();
  const pageIds = fake.pageIds();
  assert.equal(pageIds.length, 2);
  assert.equal(new Set(pageIds).size, pageIds.length);
  const retry = await provider.persist({ request, placement });
  assert.equal(first.status, "verified");
  assert.equal(retry.status, "blocked");
  assert.equal(retry.code, "bookstack_identity_ambiguous");
  assert.equal(fake.creates(), 1);
});

test("actual hierarchy changes block established evidence without recreation", async () => {
  for (const alter of [
    (fake) => fake.movePage(),
    (fake) => fake.detachBook(),
    (fake) => fake.alterPage({ slug: "moved-page" }),
  ]) {
    const fake = createClient();
    const provider = createBookStackLifecycleProvider({ client: fake });
    const stored = await provider.persist({ request, placement });
    alter(fake);
    const result = await provider.get(stored.locator);
    assert.equal(result.status, "blocked");
    assert.equal(fake.creates(), 1);
  }
});

test("invalid caller placement blocks before page writes", async () => {
  const fake = createClient();
  const provider = createBookStackLifecycleProvider({ client: fake });
  const result = await provider.persist({
    request,
    placement: { ...placement, sourceRef: "taskwarrior:other:cc4755dd-67bf-49a6-8e2d-6563d080dde1" },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "bookstack_placement_invalid");
  assert.equal(fake.creates(), 0);
});

test("unknown POST outcome returns sanitized proof and reconciles read-only", async () => {
  const fake = createClient({ loseCreateResponse: true });
  const provider = createBookStackLifecycleProvider({ client: fake });
  const failed = await provider.persist({ request, placement });
  assert.equal(failed.status, "blocked");
  assert.equal(failed.code, "bookstack_write_unknown");
  assert.equal(failed.recovery.operation, "create_page");
  assert.doesNotMatch(JSON.stringify(failed), /socket|secret/);
  assert.equal(fake.creates(), 1);

  const recovered = await createBookStackLifecycleProvider({ client: fake })
    .reconcile(JSON.parse(JSON.stringify(failed.recovery)));
  assert.equal(recovered.status, "verified");
  assert.equal(fake.creates(), 1);
});

test("recovery and read-back require the canonical authoritative page slug", async () => {
  const fake = createClient({ pageSlug: "plan-suffixed" });
  const provider = createBookStackLifecycleProvider({ client: fake });
  const failed = await provider.persist({ request, placement });
  const recovered = await provider.reconcile(failed.recovery);
  assert.equal(recovered.status, "blocked");
  assert.equal(recovered.code, "bookstack_recovery_unresolved");
  assert.equal(fake.creates(), 1);
});

test("malformed locators fail closed before reads", async () => {
  for (const locator of [null, undefined, "locator", [], {}, { originFingerprint: "x" }]) {
    const fake = createClient();
    const result = await createBookStackLifecycleProvider({ client: fake }).get(locator);
    assert.equal(result.code, "bookstack_locator_invalid");
    assert.equal(fake.reads(), 0);
  }
});

test("public discovery sanitizes injected error text", async () => {
  const client = {
    ...createClient(),
    listShelves: async () => { throw new Error("token=super-secret"); },
    listBooks: async () => [],
    listChapters: async () => [],
  };
  const result = await createBookStackLifecycleProvider({ client }).planPlacement({
    projectSlug: placement.projectSlug,
    sourceRef,
    lifecycleKey: identity.lifecycleKey,
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "bookstack_placement_unavailable");
  assert.equal(result.category, "unavailable");
  assert.doesNotMatch(JSON.stringify(result), /secret|token=/);
});

test("unexpected suffixed page slug retains a complete recovery descriptor", async () => {
  const fake = createClient({ pageSlug: "plan-suffixed" });
  const provider = createBookStackLifecycleProvider({ client: fake });
  const result = await provider.persist({ request, placement });
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "bookstack_slug_unexpected");
  assert.equal(result.recovery.pageId, 42);
  assert.equal(result.recovery.chapterSlug, placement.chapterSlug);
  assert.equal(fake.creates(), 1);
});

test("own malformed recovery blocks persist before reads, approval, or writes", async () => {
  for (const recovery of [undefined, null, false, 0, "", [], {}, { operation: "create_page" }]) {
    const fake = createClient();
    const provider = createBookStackLifecycleProvider({ client: fake });
    const result = await provider.persist({ request, placement, recovery });
    assert.equal(result.status, "blocked");
    assert.equal(result.code, "bookstack_recovery_unresolved");
    assert.equal(result.recovery, null);
    assert.equal(fake.reads(), 0);
    assert.equal(fake.creates(), 0);
  }
});

test("own malformed recovery blocks public placement before client or approval calls", async () => {
  for (const recovery of [undefined, null, false, 0, "", [], {}, { operation: "create_shelf" }]) {
    let clientCalls = 0;
    let approvals = 0;
    const client = {
      origin: "https://bookstack.example",
      listShelves: async () => { clientCalls += 1; return []; },
      listBooks: async () => { clientCalls += 1; return []; },
      listChapters: async () => { clientCalls += 1; return []; },
    };
    const provider = createBookStackLifecycleProvider({
      client,
      approvePlacement: () => { approvals += 1; return true; },
    });
    const result = await provider.ensurePlacement({
      projectSlug: placement.projectSlug,
      sourceRef,
      lifecycleKey: identity.lifecycleKey,
      recovery,
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.code, "bookstack_recovery_unresolved");
    assert.equal(result.recovery, null);
    assert.equal(clientCalls, 0);
    assert.equal(approvals, 0);
  }
});

test("recovery-bound persist rejects a changed request without effects", async () => {
  const fake = createClient({ loseCreateResponse: true });
  const provider = createBookStackLifecycleProvider({ client: fake });
  const failed = await provider.persist({ request, placement });
  const readsBefore = fake.reads();
  const result = await provider.persist({
    request: { ...request, summary: "Changed after the lost response" },
    placement,
    recovery: failed.recovery,
  });
  assert.equal(result.code, "bookstack_recovery_unresolved");
  assert.equal(fake.reads(), readsBefore);
  assert.equal(fake.creates(), 1);
});

test("get snapshots a valid locator before an awaited page read", async () => {
  const fake = createClient();
  const provider = createBookStackLifecycleProvider({ client: fake });
  const stored = await provider.persist({ request, placement });
  const originalReadPage = fake.readPage;
  const requestedIds = [];
  let releasePage;
  let pageReadStarted;
  const pageReadStartedPromise = new Promise((resolve) => { pageReadStarted = resolve; });
  fake.readPage = async (id) => {
    requestedIds.push(id);
    pageReadStarted();
    await new Promise((resolve) => { releasePage = resolve; });
    return originalReadPage(id);
  };
  const locator = structuredClone(stored.locator);
  const pending = provider.get(locator);
  await pageReadStartedPromise;
  locator.pageId = 999;
  locator.chapterSlug = "other-chapter";
  locator.contentHash = "f".repeat(64);
  releasePage();
  const result = await pending;
  assert.equal(result.status, "verified");
  assert.deepEqual(requestedIds, [stored.locator.pageId]);
  assert.equal(result.locator.chapterSlug, stored.locator.chapterSlug);
  assert.equal(result.locator.contentHash, stored.locator.contentHash);
});

test("locators with structural, domain, or hostile-object changes fail closed before reads", async () => {
  const fake = createClient();
  const provider = createBookStackLifecycleProvider({ client: fake });
  const stored = await provider.persist({ request, placement });
  const invalidLocators = [
    (() => { const value = structuredClone(stored.locator); delete value.updatedAt; return value; })(),
    { ...stored.locator, extra: true },
    { ...stored.locator, pageId: 0 },
    { ...stored.locator, pageSlug: "plan-not-a-uuid" },
    { ...stored.locator, updatedAt: "x".repeat(1_025) },
    { ...stored.locator, contentHash: [stored.locator.contentHash] },
    { ...stored.locator, pageHash: { toString: 0 } },
    new Proxy(stored.locator, { ownKeys: () => { throw new Error("getter-like trap"); } }),
  ];
  const readsBefore = fake.reads();
  for (const locator of invalidLocators) {
    const result = await provider.get(locator);
    assert.equal(result.code, "bookstack_locator_invalid");
  }
  assert.equal(fake.reads(), readsBefore);
});
