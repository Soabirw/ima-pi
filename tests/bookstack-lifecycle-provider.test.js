import assert from "node:assert/strict";
import test from "node:test";
import { createBookStackLifecycleProvider } from "../lib/bookstack-lifecycle.ts";
import { createLifecycleRecord, digestBookStackValue } from "../lib/bookstack-lifecycle-record.ts";
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
  const pages = (options.pages ?? []).map((page) => ({ ...page }));
  let creates = 0;
  let nextPageId = 42;
  let reads = 0;
  let lists = 0;
  return {
    origin: options.origin ?? "https://bookstack.example",
    listPages: async () => {
      lists += 1;
      return pages.map((page) => ({ ...page }));
    },
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
    lists: () => lists,
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

test("ordinary persistence treats target-named noncanonical drafts as conflicts", async () => {
  const record = createLifecycleRecord({ request, placement });
  const title = `${record.phase}-${record.artifactId}`;
  const targetDraft = { id: 9, name: title, slug: "" };
  const canonical = {
    id: 10,
    name: title,
    slug: title,
    bookId: placement.bookId,
    chapterId: placement.chapterId,
    markdown: record.pageMarkdown,
    revisionCount: 1,
    updatedAt: "2026-09-11T00:00:00Z",
    creatorId: 7,
    updaterId: 8,
  };
  const scenarios = [
    {
      name: "target draft",
      pages: [targetDraft],
      expected: { status: "blocked", creates: 0, reads: 0 },
    },
    {
      name: "target draft plus canonical",
      pages: [targetDraft, canonical],
      expected: { status: "blocked", creates: 0, reads: 0 },
    },
    {
      name: "unrelated draft",
      pages: [{ id: 9, name: "Unrelated draft", slug: "" }],
      expected: { status: "verified", creates: 1, reads: 1 },
    },
    {
      name: "absent target",
      pages: [],
      expected: { status: "verified", creates: 1, reads: 1 },
    },
  ];

  for (const scenario of scenarios) {
    const fake = createClient({ pages: scenario.pages });
    const provider = createBookStackLifecycleProvider({ client: fake });
    const result = await provider.persist({ request, placement });
    assert.equal(result.status, scenario.expected.status, scenario.name);
    if (result.status === "blocked") {
      assert.equal(result.code, "bookstack_identity_ambiguous", scenario.name);
    } else {
      assert.equal(result.disposition, "stored", scenario.name);
    }
    assert.equal(fake.creates(), scenario.expected.creates, scenario.name);
    assert.equal(fake.reads(), scenario.expected.reads, scenario.name);
    assert.equal(fake.lists(), 1, scenario.name);
  }
});

test("same-attempt recovery preserves empty-slug discovery entries and cannot repeat a checkpointed POST", async () => {
  const fake = createClient({ origin: "https://BOOKSTACK.example/" });
  const listPages = fake.listPages;
  fake.listPages = async () => [
    { id: 9, name: "Unrelated draft", slug: "" },
    ...(await listPages()),
  ];
  const provider = createBookStackLifecycleProvider({ client: fake });
  const discovered = await provider.discoverSameAttemptRecovery({ request, placement });
  assert.equal(discovered.status, "ready");
  if (discovered.status !== "ready") return;
  assert.equal(discovered.origin, "https://bookstack.example");
  assert.equal(discovered.pageCount, 1);
  assert.equal(discovered.existing, null);

  const stored = await provider.persistSameAttemptRecovery({
    request,
    placement,
    checkpoint: discovered.checkpoint,
  });
  assert.equal(stored.status, "verified");
  assert.equal(fake.creates(), 1);

  const repeated = await provider.persistSameAttemptRecovery({
    request,
    placement,
    checkpoint: discovered.checkpoint,
  });
  assert.equal(repeated.status, "blocked");
  assert.equal(repeated.code, "bookstack_recovery_stale");
  assert.equal(fake.creates(), 1);
});

test("same-attempt recovery returns an exact existing artifact without a POST", async () => {
  const fake = createClient();
  const provider = createBookStackLifecycleProvider({ client: fake });
  const stored = await provider.persist({ request, placement });
  assert.equal(stored.status, "verified");
  const discovered = await provider.discoverSameAttemptRecovery({ request, placement });
  assert.equal(discovered.status, "ready");
  if (discovered.status !== "ready") return;
  assert.ok(discovered.existing);
  const recovered = await provider.persistSameAttemptRecovery({
    request,
    placement,
    checkpoint: discovered.checkpoint,
  });
  assert.equal(recovered.status, "verified");
  assert.equal(recovered.disposition, "unchanged");
  assert.equal(fake.creates(), 1);
});

test("TEST-004 checkpointed recovery accepts a one-LF-normalized existing page without a POST", async () => {
  const record = createLifecycleRecord({ request, placement });
  assert.equal(record.pageMarkdown.endsWith("\n"), true);
  const actualMarkdown = record.pageMarkdown.slice(0, -1);
  assert.equal(actualMarkdown.endsWith("\n"), false);
  const actualPageHash = digestBookStackValue(actualMarkdown);
  const fake = createClient({
    pages: [{
      id: 1796,
      name: `${record.phase}-${record.artifactId}`,
      slug: `${record.phase}-${record.artifactId}`,
      bookId: placement.bookId,
      chapterId: placement.chapterId,
      markdown: actualMarkdown,
      revisionCount: 1,
      updatedAt: "2026-09-11T00:00:00Z",
      creatorId: 7,
      updaterId: 8,
    }],
  });
  const provider = createBookStackLifecycleProvider({ client: fake });
  const discovered = await provider.discoverSameAttemptRecovery({ request, placement });
  assert.equal(discovered.status, "ready");
  if (discovered.status !== "ready") return;
  assert.ok(discovered.existing);
  assert.equal(discovered.existing.artifactId, record.artifactId);
  assert.equal(discovered.existing.recordKey, record.recordKey);
  assert.equal(discovered.existing.contentHash, record.contentHash);
  assert.equal(discovered.existing.artifact, record.artifact);
  assert.equal(discovered.existing.locator.pageHash, actualPageHash);
  assert.notEqual(discovered.existing.locator.pageHash, digestBookStackValue(record.pageMarkdown));

  const recovered = await provider.persistSameAttemptRecovery({
    request,
    placement,
    checkpoint: discovered.checkpoint,
  });
  assert.equal(recovered.status, "verified");
  if (recovered.status !== "verified") return;
  assert.equal(recovered.disposition, "unchanged");
  assert.equal(recovered.locator.pageId, 1796);
  assert.equal(recovered.locator.pageHash, actualPageHash);
  assert.equal(recovered.artifactId, record.artifactId);
  assert.equal(recovered.recordKey, record.recordKey);
  assert.equal(recovered.contentHash, record.contentHash);
  assert.equal(recovered.artifact, record.artifact);
  assert.equal(fake.creates(), 0);

  const readBack = await provider.get(recovered.locator);
  assert.equal(readBack.status, "verified");
  if (readBack.status !== "verified") return;
  assert.equal(readBack.locator.pageHash, actualPageHash);
  assert.equal(fake.creates(), 0);
});

test("same-attempt recovery binds its checkpoint to the request, placement, and origin before a POST", async () => {
  const scenarios = [
    {
      name: "request",
      change: () => ({ request: { ...request, summary: "Changed after discovery" }, placement }),
    },
    {
      name: "placement",
      change: () => ({ request, placement: { ...placement, shelfId: 4 } }),
    },
    {
      name: "origin",
      change: (fake) => {
        fake.origin = "https://other-bookstack.example";
        return { request, placement };
      },
    },
  ];

  for (const scenario of scenarios) {
    const fake = createClient();
    const provider = createBookStackLifecycleProvider({ client: fake });
    const discovered = await provider.discoverSameAttemptRecovery({ request, placement });
    assert.equal(discovered.status, "ready", scenario.name);
    if (discovered.status !== "ready") continue;

    const result = await provider.persistSameAttemptRecovery({
      ...scenario.change(fake),
      checkpoint: discovered.checkpoint,
    });
    assert.equal(result.status, "blocked", scenario.name);
    assert.equal(fake.creates(), 0, scenario.name);
  }
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

test("TEST-004 legacy reconciliation accepts the permitted omitted terminal LF and retains actual-byte proof", async () => {
  const record = createLifecycleRecord({ request, placement });
  const actualMarkdown = record.pageMarkdown.slice(0, -1);
  const actualPageHash = digestBookStackValue(actualMarkdown);
  const fake = createClient({ loseCreateResponse: true });
  const failed = await createBookStackLifecycleProvider({ client: fake }).persist({ request, placement });
  assert.equal(failed.status, "blocked");
  assert.equal(failed.code, "bookstack_write_unknown");
  assert.ok(failed.recovery);
  fake.alterPage({ markdown: actualMarkdown });

  const recovered = await createBookStackLifecycleProvider({ client: fake })
    .reconcile(JSON.parse(JSON.stringify(failed.recovery)));
  assert.equal(recovered.status, "verified");
  if (recovered.status !== "verified") return;
  assert.equal(recovered.artifactId, record.artifactId);
  assert.equal(recovered.recordKey, record.recordKey);
  assert.equal(recovered.contentHash, record.contentHash);
  assert.equal(recovered.artifact, record.artifact);
  const canonicalPageHash = digestBookStackValue(record.pageMarkdown);
  assert.equal(failed.recovery.pageHash, canonicalPageHash);
  assert.equal(recovered.locator.pageHash, actualPageHash);
  assert.notEqual(recovered.locator.pageHash, canonicalPageHash);

  const actualHashRecovered = await createBookStackLifecycleProvider({ client: fake })
    .reconcile(JSON.parse(JSON.stringify({ ...failed.recovery, pageHash: actualPageHash })));
  assert.equal(actualHashRecovered.status, "verified");
  if (actualHashRecovered.status !== "verified") return;
  assert.equal(actualHashRecovered.locator.pageHash, actualPageHash);

  const arbitraryHash = "f".repeat(64);
  assert.notEqual(arbitraryHash, actualPageHash);
  assert.notEqual(arbitraryHash, canonicalPageHash);
  const mismatched = await createBookStackLifecycleProvider({ client: fake })
    .reconcile(JSON.parse(JSON.stringify({ ...failed.recovery, pageHash: arbitraryHash })));
  assert.equal(mismatched.status, "blocked");
  assert.equal(mismatched.code, "bookstack_recovery_unresolved");
  assert.equal(fake.creates(), 1);
});

test("TEST-004 legacy canonical hash never bypasses page identity, content, or placement checks", async () => {
  const record = createLifecycleRecord({ request, placement });
  const actualMarkdown = record.pageMarkdown.slice(0, -1);
  const scenarios = [
    {
      name: "page identity",
      change: { slug: `other-${record.artifactId}` },
      expectedCode: "bookstack_recovery_unresolved",
    },
    {
      name: "placement",
      change: { chapterId: 99 },
      expectedCode: "bookstack_recovery_unresolved",
    },
    {
      name: "content",
      change: { markdown: actualMarkdown.replace("Approved.", "Changed.") },
      expectedCode: "bookstack_verification_failed",
    },
  ];

  for (const scenario of scenarios) {
    const fake = createClient({ loseCreateResponse: true });
    const failed = await createBookStackLifecycleProvider({ client: fake }).persist({ request, placement });
    assert.equal(failed.status, "blocked", scenario.name);
    assert.equal(failed.code, "bookstack_write_unknown", scenario.name);
    assert.ok(failed.recovery, scenario.name);
    assert.equal(failed.recovery.pageHash, digestBookStackValue(record.pageMarkdown), scenario.name);
    fake.alterPage({ markdown: actualMarkdown, ...scenario.change });

    const result = await createBookStackLifecycleProvider({ client: fake })
      .reconcile(JSON.parse(JSON.stringify(failed.recovery)));
    assert.equal(result.status, "blocked", scenario.name);
    assert.equal(result.code, scenario.expectedCode, scenario.name);
    assert.equal(fake.creates(), 1, scenario.name);
  }
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

test("persists current documentation through the canonical document phase", async () => {
  const fake = createClient();
  const provider = createBookStackLifecycleProvider({ client: fake });
  const document = await provider.persist({
    request: {
      ...request,
      type: "document",
      summary: "READY: current BookStack documentation evidence is canonical.",
      artifact: "# Documentation\n\nREADY: canonical documentation evidence.",
    },
    placement,
  });

  assert.equal(document.status, "verified");
  if (document.status !== "verified") return;
  assert.equal(document.phase, "document");
  assert.match(document.artifact, /phase=document/);
  assert.equal(fake.creates(), 1);
});

test("rejects new closeout writes that carry document-phase evidence before BookStack writes", async () => {
  const fake = createClient();
  const provider = createBookStackLifecycleProvider({ client: fake });
  const result = await provider.persist({
    request: {
      ...request,
      type: "closeout",
      summary: "Historical-shaped documentation must not create a new closeout record.",
      artifact: "# Documentation\n\n<!-- ima-cycle outcome: phase=document; outcome=READY -->",
    },
    placement,
  });

  assert.equal(result.status, "blocked");
  assert.equal(fake.creates(), 0);
});
