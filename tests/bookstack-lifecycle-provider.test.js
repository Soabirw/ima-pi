import assert from "node:assert/strict";
import test from "node:test";
import {
  bookStackLifecycleResultIsNoWrite,
  createBookStackLifecycleProvider,
} from "../lib/bookstack-lifecycle.ts";
import { createLifecycleRecord, digestBookStackValue } from "../lib/bookstack-lifecycle-record.ts";
import { createBookStackLifecycleClient } from "../lib/bookstack-lifecycle-client.ts";
import { recoveryDescriptor } from "../lib/bookstack-lifecycle-recovery.ts";
import {
  createBookStackLifecycleJsonRequester,
  createBookStackLifecycleRequestScheduler,
} from "../lib/bookstack-lifecycle-requests.ts";

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
  let hierarchyReads = 0;
  return {
    origin: options.origin ?? "https://bookstack.example",
    listPages: async () => {
      lists += 1;
      return pages.map((page) => ({ ...page }));
    },
    readShelf: async () => {
      hierarchyReads += 1;
      return { ...shelf, books: [...shelf.books] };
    },
    readBook: async () => {
      hierarchyReads += 1;
      return { ...book };
    },
    readChapter: async () => {
      hierarchyReads += 1;
      return { ...chapter };
    },
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
    hierarchyReads: () => hierarchyReads,
  };
};

const pageForLifecycleRecord = (id, record, chapterId = placement.chapterId) => ({
  id,
  name: `${record.phase}-${record.artifactId}`,
  slug: `${record.phase}-${record.artifactId}`,
  bookId: placement.bookId,
  chapterId,
  markdown: record.pageMarkdown,
  revisionCount: 1,
  updatedAt: "2026-09-11T00:00:00Z",
  creatorId: 7,
  updaterId: 8,
});

const continuationRecord = (phase, rootArtifactId, label) => createLifecycleRecord({
  request: {
    ...request,
    type: phase,
    identity: {
      ...identity,
      lifecycleRootMemoryId: rootArtifactId,
      priorArtifactIds: [...identity.priorArtifactIds, rootArtifactId],
    },
    summary: `${phase} lifecycle evidence ${label}.`,
    artifact: `# ${phase}\n\nLifecycle evidence ${label}.`,
  },
  placement,
});

const recallInput = (phase) => ({
  placement: structuredClone(placement),
  lifecycleKey: identity.lifecycleKey,
  sourceRef,
  ...(phase === undefined ? {} : { phase }),
});

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

test("TEST-006 BookStack recall accepts the exact placement projection and rejects locators or mismatched evidence", async () => {
  const fake = createClient();
  const provider = createBookStackLifecycleProvider({ client: fake });
  const stored = await provider.persist({ request, placement });
  assert.equal(stored.status, "verified");
  if (stored.status !== "verified") return;
  const writesBeforeRecall = fake.creates();
  const pinned = await provider.get(structuredClone(stored.locator));
  assert.equal(pinned.status, "verified");
  if (pinned.status !== "verified") return;
  assert.equal(pinned.artifactId, stored.artifactId);
  assert.equal(pinned.recordKey, stored.recordKey);
  assert.deepEqual(pinned.locator, stored.locator);

  const recalled = await provider.recall({
    placement: structuredClone(placement),
    lifecycleKey: identity.lifecycleKey,
    sourceRef,
  });
  assert.equal(Array.isArray(recalled), true);
  if (!Array.isArray(recalled)) return;
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].artifactId, stored.artifactId);
  assert.equal(recalled[0].recordKey, stored.recordKey);
  assert.equal(recalled[0].artifact, stored.artifact);

  const locatorAsPlacement = await provider.recall({
    placement: structuredClone(pinned.locator),
    lifecycleKey: identity.lifecycleKey,
    sourceRef,
  });
  assert.equal(Array.isArray(locatorAsPlacement), false);
  if (Array.isArray(locatorAsPlacement)) return;
  assert.equal(locatorAsPlacement.status, "blocked");
  assert.equal(locatorAsPlacement.code, "bookstack_placement_invalid");

  fake.alterPage({ markdown: stored.artifact });
  const mismatchedEvidence = await provider.recall({
    placement: structuredClone(placement),
    lifecycleKey: identity.lifecycleKey,
    sourceRef,
  });
  assert.equal(Array.isArray(mismatchedEvidence), false);
  if (Array.isArray(mismatchedEvidence)) return;
  assert.equal(mismatchedEvidence.status, "blocked");
  assert.equal(mismatchedEvidence.code, "bookstack_verification_failed");
  assert.equal(fake.creates(), writesBeforeRecall);
});

test("BookStack recall accepts only a strict optional phase selector", async () => {
  const plan = createLifecycleRecord({ request, placement });
  const implementation = continuationRecord("implementation", plan.artifactId, "strict-phase");
  const fake = createClient({ pages: [
    pageForLifecycleRecord(61, plan),
    pageForLifecycleRecord(62, implementation),
  ] });
  const provider = createBookStackLifecycleProvider({ client: fake });
  const before = {
    hierarchy: fake.hierarchyReads(),
    lists: fake.lists(),
    reads: fake.reads(),
  };

  for (const invalid of [
    { ...recallInput("plan"), phase: "not-a-lifecycle-phase" },
    { ...recallInput("plan"), phase: ["plan"] },
    { ...recallInput("plan"), phase: undefined },
    { ...recallInput("plan"), extra: true },
  ]) {
    const result = await provider.recall(invalid);
    assert.equal(Array.isArray(result), false);
    if (Array.isArray(result)) continue;
    assert.equal(result.code, "bookstack_placement_invalid");
  }
  assert.equal(fake.hierarchyReads(), before.hierarchy);
  assert.equal(fake.lists(), before.lists);
  assert.equal(fake.reads(), before.reads);

  const selected = await provider.recall(recallInput("implementation"));
  assert.equal(Array.isArray(selected), true);
  if (!Array.isArray(selected)) return;
  assert.deepEqual(selected.map(({ phase }) => phase), ["implementation"]);

  const all = await provider.recall(recallInput());
  assert.equal(Array.isArray(all), true);
  if (Array.isArray(all)) assert.deepEqual(all.map(({ phase }) => phase), ["plan", "implementation"]);
});

test("BookStack recall fully verifies phase candidates with exactly 3 + L + N requests", async () => {
  const plan = createLifecycleRecord({ request, placement });
  const implementation = continuationRecord("implementation", plan.artifactId, "request-count");
  const fake = createClient({ pages: [
    pageForLifecycleRecord(71, plan),
    pageForLifecycleRecord(72, implementation),
    pageForLifecycleRecord(73, plan, 99),
  ] });
  const provider = createBookStackLifecycleProvider({ client: fake });
  const requestedPageIds = [];
  const readPage = fake.readPage;
  fake.readPage = async (id) => {
    requestedPageIds.push(id);
    return readPage(id);
  };
  const before = {
    hierarchy: fake.hierarchyReads(),
    lists: fake.lists(),
    reads: fake.reads(),
  };

  const result = await provider.recall(recallInput("implementation"));
  assert.equal(Array.isArray(result), true);
  if (!Array.isArray(result)) return;
  assert.deepEqual(result.map(({ phase }) => phase), ["implementation"]);
  assert.deepEqual(requestedPageIds, [71, 72]);

  const hierarchyRequests = fake.hierarchyReads() - before.hierarchy;
  const listRequests = fake.lists() - before.lists;
  const candidateReads = fake.reads() - before.reads;
  const L = 1;
  const N = 2;
  assert.equal(hierarchyRequests, 3);
  assert.equal(listRequests, L);
  assert.equal(candidateReads, N);
  assert.equal(hierarchyRequests + listRequests + candidateReads, 3 + L + N);
});

test("BookStack recall reads phase candidates sequentially before filtering", async () => {
  const plan = createLifecycleRecord({ request, placement });
  const implementation = continuationRecord("implementation", plan.artifactId, "sequential");
  const fake = createClient({ pages: [
    pageForLifecycleRecord(81, plan),
    pageForLifecycleRecord(82, implementation),
  ] });
  const provider = createBookStackLifecycleProvider({ client: fake });
  const readIds = [];
  let firstReadStarted;
  const firstRead = new Promise((resolve) => { firstReadStarted = resolve; });
  let releaseFirstRead;
  const release = new Promise((resolve) => { releaseFirstRead = resolve; });
  const readPage = fake.readPage;
  fake.readPage = async (id) => {
    readIds.push(id);
    if (id === 81) {
      firstReadStarted();
      await release;
    }
    return readPage(id);
  };

  const pending = provider.recall(recallInput("implementation"));
  await firstRead;
  assert.deepEqual(readIds, [81]);
  releaseFirstRead();
  const result = await pending;
  assert.equal(Array.isArray(result), true);
  if (Array.isArray(result)) assert.deepEqual(result.map(({ phase }) => phase), ["implementation"]);
  assert.deepEqual(readIds, [81, 82]);
});

test("BookStack recall observes cancellation boundaries without returning partial evidence", async () => {
  const plan = createLifecycleRecord({ request, placement });
  const implementation = continuationRecord("implementation", plan.artifactId, "cancellation");
  const preAborted = new AbortController();
  preAborted.abort(new Error("recall cancelled before start"));
  const untouched = createClient({ pages: [
    pageForLifecycleRecord(91, plan),
    pageForLifecycleRecord(92, implementation),
  ] });
  const untouchedResult = await createBookStackLifecycleProvider({ client: untouched })
    .recall(recallInput(), preAborted.signal);
  assert.equal(Array.isArray(untouchedResult), false);
  assert.equal(untouched.hierarchyReads(), 0);
  assert.equal(untouched.lists(), 0);
  assert.equal(untouched.reads(), 0);

  const controller = new AbortController();
  const fake = createClient({ pages: [
    pageForLifecycleRecord(93, plan),
    pageForLifecycleRecord(94, implementation),
  ] });
  const readIds = [];
  const readPage = fake.readPage;
  fake.readPage = async (id) => {
    readIds.push(id);
    const page = await readPage(id);
    if (id === 93) controller.abort(new Error("recall cancelled after one candidate"));
    return page;
  };

  const result = await createBookStackLifecycleProvider({ client: fake })
    .recall(recallInput(), controller.signal);
  assert.equal(Array.isArray(result), false);
  if (Array.isArray(result)) return;
  assert.equal(result.status, "blocked");
  assert.equal(result.category, "unavailable");
  assert.equal(Object.hasOwn(result, "artifact"), false);
  assert.deepEqual(readIds, [93]);
});

test("BookStack recall rejects embedded placement conflicts before filtering without partial evidence", async () => {
  const plan = createLifecycleRecord({ request, placement });
  const conflictingSource = "taskwarrior:other-memory:dd4755dd-67bf-49a6-8e2d-6563d080dde1";
  const conflictingPlacement = {
    projectSlug: "other-memory",
    sourceRef: conflictingSource,
    lifecycleKey: "other-memory:manual:test",
    shelfId: 11,
    shelfSlug: "lifecycle-artifacts",
    bookId: 12,
    bookSlug: "other-memory",
    chapterId: 13,
    chapterSlug: "taskwarrior-dd4755dd-67bf-49a6-8e2d-6563d080dde1",
  };
  const conflictingRecord = createLifecycleRecord({
    request: {
      type: "plan",
      identity: {
        project: "other-memory",
        lifecycleKey: conflictingPlacement.lifecycleKey,
        lifecycleRootMemoryId: "root",
        taskwarriorProject: "other-memory",
        taskwarriorTask: "T14",
        taskwarriorUuid: "dd4755dd-67bf-49a6-8e2d-6563d080dde1",
        jiraKey: "",
        sourceRefs: [conflictingSource],
        priorArtifactIds: [],
      },
      summary: "Conflicting physical placement evidence.",
      artifact: "# Plan\n\nConflicting physical placement evidence.",
    },
    placement: conflictingPlacement,
  });
  const scenarios = [
    {
      name: "selected conflict",
      pages: [pageForLifecycleRecord(101, conflictingRecord)],
      phase: "plan",
      expectedReadIds: [101],
    },
    {
      name: "nonselected conflict",
      pages: [pageForLifecycleRecord(102, conflictingRecord)],
      phase: "implementation",
      expectedReadIds: [102],
    },
    {
      name: "conflict after valid candidate",
      pages: [
        pageForLifecycleRecord(103, plan),
        pageForLifecycleRecord(104, conflictingRecord),
      ],
      phase: "plan",
      expectedReadIds: [103, 104],
    },
  ];

  for (const scenario of scenarios) {
    const fake = createClient({ pages: scenario.pages });
    const provider = createBookStackLifecycleProvider({ client: fake });
    const readIds = [];
    const readPage = fake.readPage;
    fake.readPage = async (id) => {
      readIds.push(id);
      return readPage(id);
    };
    const result = await provider.recall(recallInput(scenario.phase));
    assert.equal(Array.isArray(result), false, scenario.name);
    if (Array.isArray(result)) continue;
    assert.equal(result.status, "blocked", scenario.name);
    assert.equal(result.code, "bookstack_verification_failed", scenario.name);
    assert.equal(Object.hasOwn(result, "artifact"), false, scenario.name);
    assert.deepEqual(readIds, scenario.expectedReadIds, scenario.name);
    assert.equal(fake.hierarchyReads(), 3, scenario.name);
    assert.equal(fake.lists(), 1, scenario.name);
    assert.equal(fake.reads(), scenario.expectedReadIds.length, scenario.name);
  }
});

test("BookStack recall filters a physically valid sibling lifecycle record", async () => {
  const plan = createLifecycleRecord({ request, placement });
  const siblingPlacement = {
    ...placement,
    lifecycleKey: "shared-dev-memory:manual:sibling",
  };
  const sibling = createLifecycleRecord({
    request: {
      ...request,
      identity: {
        ...identity,
        lifecycleKey: siblingPlacement.lifecycleKey,
      },
      summary: "Sibling lifecycle evidence remains physically valid.",
      artifact: "# Plan\n\nSibling lifecycle evidence remains physically valid.",
    },
    placement: siblingPlacement,
  });
  const fake = createClient({ pages: [
    pageForLifecycleRecord(111, plan),
    pageForLifecycleRecord(112, sibling),
  ] });
  const result = await createBookStackLifecycleProvider({ client: fake })
    .recall(recallInput("plan"));
  assert.equal(Array.isArray(result), true);
  if (!Array.isArray(result)) return;
  assert.deepEqual(result.map(({ lifecycleKey }) => lifecycleKey), [identity.lifecycleKey]);
  assert.equal(fake.hierarchyReads(), 3);
  assert.equal(fake.lists(), 1);
  assert.equal(fake.reads(), 2);
});

test("BookStack recall skips unmanaged same-chapter migration pages and preserves pinned evidence", async () => {
  const plan = createLifecycleRecord({ request, placement });
  const fake = createClient({ pages: [
    {
      id: 121,
      name: "Unrelated empty-slug draft",
      slug: "",
      bookId: placement.bookId,
      chapterId: placement.chapterId,
    },
    {
      id: 122,
      name: "Migrated project notes",
      slug: "migrated-project-notes",
      bookId: placement.bookId,
      chapterId: placement.chapterId,
    },
    {
      id: 123,
      name: "Legacy plan template",
      slug: "plan-not-a-lifecycle-artifact",
      bookId: placement.bookId,
      chapterId: placement.chapterId,
    },
    pageForLifecycleRecord(124, plan),
  ] });
  const provider = createBookStackLifecycleProvider({ client: fake });
  const readIds = [];
  const readPage = fake.readPage;
  fake.readPage = async (id) => {
    readIds.push(id);
    return readPage(id);
  };

  const recalled = await provider.recall(recallInput("plan"));
  assert.equal(Array.isArray(recalled), true);
  if (!Array.isArray(recalled)) return;
  assert.deepEqual(recalled.map(({ artifactId }) => artifactId), [plan.artifactId]);
  assert.deepEqual(readIds, [124]);
  assert.equal(fake.hierarchyReads(), 3);
  assert.equal(fake.lists(), 1);

  const pinned = await provider.get(structuredClone(recalled[0].locator));
  assert.equal(pinned.status, "verified");
  if (pinned.status !== "verified") return;
  assert.equal(pinned.artifactId, plan.artifactId);
  assert.deepEqual(pinned.locator, recalled[0].locator);
  assert.deepEqual(readIds, [124, 124]);
  assert.equal(fake.creates(), 0);
});

test("BookStack recall treats canonical names as candidates before selected-phase filtering", async () => {
  const plan = createLifecycleRecord({ request, placement });
  const implementation = continuationRecord("implementation", plan.artifactId, "selected-before-name-verification");
  const review = continuationRecord("review", plan.artifactId, "canonical-name-verification");
  const scenarios = [
    { name: "canonical name plus empty slug", slug: "" },
    { name: "canonical name plus noncanonical slug", slug: "migrated-review-evidence" },
  ];

  for (const scenario of scenarios) {
    const fake = createClient({ pages: [
      pageForLifecycleRecord(125, plan),
      pageForLifecycleRecord(126, implementation),
      { ...pageForLifecycleRecord(127, review), slug: scenario.slug },
    ] });
    const readIds = [];
    const readPage = fake.readPage;
    fake.readPage = async (id) => {
      readIds.push(id);
      return readPage(id);
    };

    const result = await createBookStackLifecycleProvider({ client: fake })
      .recall(recallInput("implementation"));
    assert.equal(Array.isArray(result), false, scenario.name);
    if (Array.isArray(result)) continue;
    assert.equal(result.status, "blocked", scenario.name);
    assert.equal(result.code, "bookstack_verification_failed", scenario.name);
    assert.equal(result.category, "unverifiable", scenario.name);
    assert.equal(result.recovery, null, scenario.name);
    assert.equal(Object.hasOwn(result, "artifact"), false, scenario.name);
    assert.deepEqual(readIds, [125, 126, 127], scenario.name);
    assert.equal(fake.hierarchyReads(), 3, scenario.name);
    assert.equal(fake.lists(), 1, scenario.name);
    assert.equal(fake.reads(), 3, scenario.name);
    assert.equal(fake.creates(), 0, scenario.name);
  }
});

test("BookStack recall fails closed on canonical-looking candidates with safe failure categories", async () => {
  const plan = createLifecycleRecord({ request, placement });
  const canonicalSlug = "plan-00000000-0000-5000-8000-000000000000";
  const scenarios = [
    {
      name: "malformed canonical page",
      page: {
        id: 131,
        name: canonicalSlug,
        slug: canonicalSlug,
        bookId: placement.bookId,
        chapterId: placement.chapterId,
        markdown: "Malformed migration body token=verification-secret",
        revisionCount: 1,
        updatedAt: "2026-09-11T00:00:00Z",
        creatorId: 7,
        updaterId: 8,
      },
      expectedCode: "bookstack_verification_failed",
      expectedCategory: "unverifiable",
    },
    {
      name: "conflicting canonical page",
      page: pageForLifecycleRecord(132, plan),
      read: (page) => ({ ...page, chapterId: 99 }),
      expectedCode: "bookstack_placement_conflict",
      expectedCategory: "conflict",
    },
    {
      name: "canonical page transport failure",
      page: pageForLifecycleRecord(133, plan),
      error: new Error("socket token=transport-secret"),
      expectedCode: "bookstack_recall_unavailable",
      expectedCategory: "unavailable",
    },
  ];

  for (const scenario of scenarios) {
    const fake = createClient({ pages: [scenario.page] });
    const readIds = [];
    const readPage = fake.readPage;
    fake.readPage = async (id) => {
      readIds.push(id);
      if (scenario.error) throw scenario.error;
      const page = await readPage(id);
      return scenario.read ? scenario.read(page) : page;
    };

    const result = await createBookStackLifecycleProvider({ client: fake })
      .recall(recallInput("implementation"));
    assert.equal(Array.isArray(result), false, scenario.name);
    if (Array.isArray(result)) continue;
    assert.equal(result.status, "blocked", scenario.name);
    assert.equal(result.code, scenario.expectedCode, scenario.name);
    assert.equal(result.category, scenario.expectedCategory, scenario.name);
    assert.equal(result.recovery, null, scenario.name);
    assert.equal(Object.hasOwn(result, "artifact"), false, scenario.name);
    assert.doesNotMatch(JSON.stringify(result), /token=|verification-secret|transport-secret/, scenario.name);
    assert.deepEqual(readIds, [scenario.page.id], scenario.name);
    assert.equal(fake.hierarchyReads(), 3, scenario.name);
    assert.equal(fake.lists(), 1, scenario.name);
    assert.equal(fake.creates(), 0, scenario.name);
  }
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

test("failed page discovery does not issue a lifecycle-page POST", async () => {
  const fake = createClient();
  fake.listPages = async () => { throw new Error("bookstack_pagination_invalid"); };
  const result = await createBookStackLifecycleProvider({ client: fake }).persist({ request, placement });
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "bookstack_pagination_invalid");
  assert.equal(fake.creates(), 0);
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

test("a blocked hierarchy read prevents all later hierarchy, discovery, and page work", async () => {
  const fake = createClient();
  const calls = [];
  fake.readShelf = async () => {
    calls.push("shelf");
    throw new Error("bookstack_rate_limited");
  };
  fake.readBook = async () => {
    calls.push("book");
    return { id: placement.bookId, name: "Shared", slug: placement.bookSlug };
  };
  fake.readChapter = async () => {
    calls.push("chapter");
    return { id: placement.chapterId, name: placement.chapterSlug, slug: placement.chapterSlug, bookId: placement.bookId };
  };
  fake.listPages = async () => {
    calls.push("pages");
    return [];
  };

  const result = await createBookStackLifecycleProvider({ client: fake }).persist({ request, placement });

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "bookstack_rate_limited");
  assert.equal(result.category, "unavailable");
  assert.deepEqual(calls, ["shelf"]);
  assert.equal(fake.creates(), 0);
});

test("a pre-dispatch page POST failure has no recovery proof or implicit write replay", async () => {
  const controller = new AbortController();
  controller.abort();
  const scheduler = createBookStackLifecycleRequestScheduler({
    now: () => 0,
    wait: async () => undefined,
  });
  const requester = createBookStackLifecycleJsonRequester(scheduler);
  let createCalls = 0;
  let fetchCalls = 0;
  const fake = createClient();
  fake.createPage = async () => {
    createCalls += 1;
    return requester({
      fetcher: async () => {
        fetchCalls += 1;
        return new Response("must not dispatch", { status: 500 });
      },
      url: new URL("https://bookstack.example/api/pages"),
      init: { method: "POST" },
      signal: controller.signal,
      timeoutMs: 60_000,
      maxResponseBytes: 4 * 1024 * 1024,
      failurePrefix: "bookstack",
    });
  };

  const result = await createBookStackLifecycleProvider({ client: fake }).persist({ request, placement });

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "bookstack_transport_failed");
  assert.equal(result.recovery, null);
  assert.equal(bookStackLifecycleResultIsNoWrite(result), true);
  assert.equal(createCalls, 1);
  assert.equal(fetchCalls, 0);
  assert.equal(fake.creates(), 0);
});

test("eight concurrent provider recalls share one paced lifecycle request lane", async () => {
  let current = 0;
  const starts = [];
  const scheduler = createBookStackLifecycleRequestScheduler({
    now: () => current,
    wait: async (milliseconds) => { current += milliseconds; },
  });
  const record = createLifecycleRecord({ request, placement });
  const page = {
    id: 42,
    name: `${record.phase}-${record.artifactId}`,
    slug: `${record.phase}-${record.artifactId}`,
    book_id: placement.bookId,
    chapter_id: placement.chapterId,
    markdown: record.pageMarkdown,
    revision_count: 1,
    updated_at: "2026-09-11T00:00:00Z",
    created_by: { id: 7 },
    updated_by: { id: 8 },
  };
  const client = createBookStackLifecycleClient({
    origin: "https://bookstack.example",
    tokenId: "test-id",
    tokenSecret: "test-secret",
    requestScheduler: scheduler,
    fetch: async (url, init = {}) => {
      const parsed = new URL(String(url));
      starts.push({ at: current, pathname: parsed.pathname, method: init.method ?? "GET" });
      if (parsed.pathname === "/api/shelves/1") {
        return new Response(JSON.stringify({
          id: placement.shelfId,
          name: "Lifecycle",
          slug: placement.shelfSlug,
          books: [placement.bookId],
        }), { headers: { "content-type": "application/json" } });
      }
      if (parsed.pathname === "/api/books/2") {
        return new Response(JSON.stringify({
          id: placement.bookId,
          name: "Shared",
          slug: placement.bookSlug,
        }), { headers: { "content-type": "application/json" } });
      }
      if (parsed.pathname === "/api/chapters/3") {
        return new Response(JSON.stringify({
          id: placement.chapterId,
          name: placement.chapterSlug,
          slug: placement.chapterSlug,
          book_id: placement.bookId,
        }), { headers: { "content-type": "application/json" } });
      }
      if (parsed.pathname === "/api/pages") {
        return new Response(JSON.stringify({ data: [page], total: 1 }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (parsed.pathname === "/api/pages/42") {
        return new Response(JSON.stringify(page), { headers: { "content-type": "application/json" } });
      }
      throw new Error("unexpected_provider_recall_request");
    },
  });

  const results = await Promise.all(Array.from(
    { length: 8 },
    () => createBookStackLifecycleProvider({ client }).recall(recallInput()),
  ));

  assert.equal(results.every((result) => Array.isArray(result) && result.length === 1), true);
  assert.equal(starts.length, 40);
  assert.deepEqual(
    starts.map(({ at }) => at),
    Array.from({ length: 40 }, (_unused, index) => index * 1_100),
  );
  assert.equal(starts.every(({ method }) => method === "GET"), true);
});
