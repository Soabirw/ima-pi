import assert from "node:assert/strict";
import test from "node:test";
import { createBookStackLifecycleProvider } from "../lib/bookstack-lifecycle.ts";
import {
  projectRecoveryDescriptor,
  recoveryDescriptor,
} from "../lib/bookstack-lifecycle-recovery.ts";

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

const sharedClient = (origin = "https://bookstack.example") => {
  const pages = [];
  let nextPageId = 42;
  let reads = 0;
  return {
    origin,
    listPages: async () => pages.map((page) => ({ ...page })),
    readShelf: async () => ({ id: 1, name: "Lifecycle", slug: "lifecycle-artifacts", books: [2] }),
    readBook: async () => ({ id: 2, name: "Shared", slug: "shared-dev-memory" }),
    readChapter: async () => ({ id: 3, name: placement.chapterSlug, slug: placement.chapterSlug, bookId: 2 }),
    readPage: async (id) => {
      reads += 1;
      return { ...pages.find((page) => page.id === id) };
    },
    createPage: async (name, chapterId, markdown) => {
      const page = {
        id: nextPageId++,
        name,
        slug: name,
        bookId: 2,
        chapterId,
        markdown,
        revisionCount: 1,
        updatedAt: "2026-09-11T00:00:00Z",
      };
      pages.push(page);
      return { ...page };
    },
    changeRevision: () => {
      pages[0].revisionCount = 2;
      pages[0].updatedAt = "2026-09-11T00:01:00Z";
    },
    reads: () => reads,
  };
};

test("fresh providers recall exact verified evidence from serialized placement", async () => {
  const client = sharedClient();
  const firstProvider = createBookStackLifecycleProvider({ client });
  const persisted = await firstProvider.persist({ request, placement });
  assert.equal(persisted.status, "verified");

  const fresh = createBookStackLifecycleProvider({ client });
  const recalled = await fresh.recall({ placement, lifecycleKey: identity.lifecycleKey, sourceRef });
  assert.equal(Array.isArray(recalled), true);
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].artifactId, persisted.artifactId);
});

test("recall isolates valid lifecycle attempts sharing one source chapter", async () => {
  const client = sharedClient();
  const provider = createBookStackLifecycleProvider({ client });
  const first = await provider.persist({ request, placement });
  const nextKey = "shared-dev-memory:manual:other";
  const secondIdentity = { ...identity, lifecycleKey: nextKey };
  const secondPlacement = { ...placement, lifecycleKey: nextKey };
  const second = await provider.persist({
    request: { ...request, identity: secondIdentity },
    placement: secondPlacement,
  });
  assert.equal(first.status, "verified");
  assert.equal(second.status, "verified");
  const recalled = await provider.recall({ placement, lifecycleKey: identity.lifecycleKey, sourceRef });
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].artifactId, first.artifactId);
});

test("locators bind origin and revision proof", async () => {
  const client = sharedClient();
  const provider = createBookStackLifecycleProvider({ client });
  const stored = await provider.persist({ request, placement });
  const otherClient = sharedClient("https://other.example");
  const beforeReads = otherClient.reads();
  const wrongOrigin = await createBookStackLifecycleProvider({ client: otherClient }).get(stored.locator);
  assert.equal(wrongOrigin.code, "bookstack_locator_invalid");
  assert.equal(otherClient.reads(), beforeReads);

  client.changeRevision();
  const changed = await provider.get(stored.locator);
  assert.equal(changed.status, "blocked");
  assert.equal(changed.code, "bookstack_locator_mismatch");
});

test("reconciliation does not recreate missing evidence or accept incomplete proof", async () => {
  const client = sharedClient();
  const provider = createBookStackLifecycleProvider({ client });
  const recovery = recoveryDescriptor({
    origin: client.origin,
    operation: "create_page",
    projectSlug: placement.projectSlug,
    sourceRef: placement.sourceRef,
    lifecycleKey: placement.lifecycleKey,
    intendedSlug: "plan-00000000-0000-5000-8000-000000000000",
    shelfId: placement.shelfId,
    shelfSlug: placement.shelfSlug,
    bookId: placement.bookId,
    bookSlug: placement.bookSlug,
    chapterId: placement.chapterId,
    chapterSlug: placement.chapterSlug,
    pageId: null,
    membershipBefore: [],
    membershipAfter: [],
    artifactId: "00000000-0000-5000-8000-000000000000",
    recordKey: `${placement.lifecycleKey}:plan:${"a".repeat(12)}`,
    contentHash: "a".repeat(64),
    pageHash: "b".repeat(64),
  });
  const result = await provider.reconcile(recovery);
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "bookstack_recovery_unresolved");
  assert.equal(client.reads(), 0);
});

test("recovery projection rejects coercible proof values without throwing", () => {
  const valid = recoveryDescriptor({
    origin: "https://bookstack.example",
    operation: "create_page",
    projectSlug: placement.projectSlug,
    sourceRef: placement.sourceRef,
    lifecycleKey: placement.lifecycleKey,
    intendedSlug: "plan-00000000-0000-5000-8000-000000000000",
    shelfId: placement.shelfId,
    shelfSlug: placement.shelfSlug,
    bookId: placement.bookId,
    bookSlug: placement.bookSlug,
    chapterId: placement.chapterId,
    chapterSlug: placement.chapterSlug,
    pageId: null,
    membershipBefore: [],
    membershipAfter: [],
    artifactId: "00000000-0000-5000-8000-000000000000",
    recordKey: `${placement.lifecycleKey}:plan:${"a".repeat(12)}`,
    contentHash: "a".repeat(64),
    pageHash: "b".repeat(64),
  });
  for (const proof of [["a".repeat(64)], { toString: () => "a".repeat(64) }, { toString: 0 }]) {
    assert.doesNotThrow(() => projectRecoveryDescriptor({ ...valid, contentHash: proof }));
    assert.equal(projectRecoveryDescriptor({ ...valid, contentHash: proof }), null);
  }
});

test("recovery projection rejects invalid operation relationships and accessors", () => {
  const valid = recoveryDescriptor({
    origin: "https://bookstack.example",
    operation: "create_page",
    projectSlug: placement.projectSlug,
    sourceRef: placement.sourceRef,
    lifecycleKey: placement.lifecycleKey,
    intendedSlug: "plan-00000000-0000-5000-8000-000000000000",
    shelfId: placement.shelfId,
    shelfSlug: placement.shelfSlug,
    bookId: placement.bookId,
    bookSlug: placement.bookSlug,
    chapterId: placement.chapterId,
    chapterSlug: placement.chapterSlug,
    pageId: null,
    membershipBefore: [],
    membershipAfter: [],
    artifactId: "00000000-0000-5000-8000-000000000000",
    recordKey: `${placement.lifecycleKey}:plan:${"a".repeat(12)}`,
    contentHash: "a".repeat(64),
    pageHash: "b".repeat(64),
  });
  assert.deepEqual(projectRecoveryDescriptor(valid), valid);
  assert.equal(projectRecoveryDescriptor({ ...valid, membershipBefore: [placement.bookId] }), null);
  assert.equal(projectRecoveryDescriptor({ ...valid, extra: true }), null);
  const accessor = { ...valid };
  Object.defineProperty(accessor, "pageHash", { get: () => "b".repeat(64), enumerable: true });
  assert.equal(projectRecoveryDescriptor(accessor), null);
});
