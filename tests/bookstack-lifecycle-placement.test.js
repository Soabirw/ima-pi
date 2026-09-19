import assert from "node:assert/strict";
import test from "node:test";
import { ensurePlacement, planPlacement } from "../lib/bookstack-lifecycle-placement.ts";

const source = {
  projectSlug: "shared-dev-memory",
  sourceRef: "taskwarrior:shared-dev-memory:cc4755dd-67bf-49a6-8e2d-6563d080dde1",
  lifecycleKey: "shared-dev-memory:manual:test",
};

const createClient = (initial = {}) => {
  const shelves = structuredClone(initial.shelves ?? []);
  const books = structuredClone(initial.books ?? []);
  const chapters = structuredClone(initial.chapters ?? []);
  let writes = 0;
  let membershipWrites = 0;
  return {
    origin: "https://bookstack.example",
    listShelves: async () => shelves.map(({ books: _books, ...shelf }) => shelf),
    listBooks: async () => books,
    listChapters: async () => chapters,
    readShelf: async (id) => structuredClone(shelves.find((value) => value.id === id)),
    readBook: async (id) => structuredClone(books.find((value) => value.id === id)),
    readChapter: async (id) => structuredClone(chapters.find((value) => value.id === id)),
    createShelf: async (name) => {
      writes += 1;
      const shelf = { id: 1, name, slug: name, books: [] };
      shelves.push(shelf);
      return structuredClone(shelf);
    },
    createBook: async (name) => {
      writes += 1;
      const book = { id: books.length + 2, name, slug: name };
      books.push(book);
      return structuredClone(book);
    },
    createChapter: async (name, bookId) => {
      writes += 1;
      const chapter = { id: chapters.length + 10, name, slug: name, bookId };
      chapters.push(chapter);
      return structuredClone(chapter);
    },
    replaceShelfBooks: async ({ shelfId, expectedBooks }) => {
      writes += 1;
      membershipWrites += 1;
      shelves.find((value) => value.id === shelfId).books = [...expectedBooks];
      return structuredClone(shelves.find((value) => value.id === shelfId));
    },
    mutateShelf: (bookIds) => { shelves[0].books = [...bookIds]; },
    writes: () => writes,
    membershipWrites: () => membershipWrites,
  };
};

test("preview uses authoritative shelf detail and rejection creates nothing", async () => {
  const fake = createClient();
  const preview = await planPlacement(fake, source);
  assert.deepEqual(preview.creates, ["shelf", "book", "chapter"]);
  assert.deepEqual(preview.shelf.membershipBefore, []);
  assert.deepEqual(preview.shelf.membershipAfter, ["new-project-book"]);
  assert.equal(preview.book.slug, "shared-dev-memory");
  const result = await ensurePlacement({ client: fake, placement: source, approve: () => false });
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "bookstack_approval_declined");
  assert.equal(fake.writes(), 0);
});

test("one literal approval provisions and verifies the project-selected hierarchy", async () => {
  const fake = createClient();
  const result = await ensurePlacement({ client: fake, placement: source, approve: () => true });
  assert.equal(result.status, "verified");
  assert.equal(result.placement.projectSlug, "shared-dev-memory");
  assert.equal(result.placement.shelfSlug, "lifecycle-artifacts");
  assert.equal(result.placement.bookSlug, "shared-dev-memory");
  assert.equal(result.placement.chapterSlug, "taskwarrior-cc4755dd-67bf-49a6-8e2d-6563d080dde1");
  assert.equal(fake.writes(), 4);
});

test("same chapter selector can coexist in different project books", async () => {
  const chapterSlug = "taskwarrior-cc4755dd-67bf-49a6-8e2d-6563d080dde1";
  const fake = createClient({
    shelves: [{ id: 1, name: "Lifecycle", slug: "lifecycle-artifacts", books: [2, 3] }],
    books: [
      { id: 2, name: "Other", slug: "other-project" },
      { id: 3, name: "Shared", slug: "shared-dev-memory" },
    ],
    chapters: [
      { id: 10, name: chapterSlug, slug: chapterSlug, bookId: 2 },
      { id: 11, name: chapterSlug, slug: chapterSlug, bookId: 3 },
    ],
  });
  const preview = await planPlacement(fake, source);
  assert.equal(preview.book.id, 3);
  assert.equal(preview.chapter.id, 11);
  assert.deepEqual(preview.creates, []);
});

test("known partial creation is retained and reconciled without writes", async () => {
  const failedClient = createClient();
  failedClient.createShelf = async () => {
    const error = new Error("bookstack_response_invalid");
    error.knownResourceId = 7;
    throw error;
  };
  const failed = await ensurePlacement({
    client: failedClient,
    placement: source,
    approve: () => true,
  });
  assert.equal(failed.status, "blocked");
  assert.equal(failed.recovery.operation, "create_shelf");
  assert.equal(failed.recovery.shelfId, 7);

  const recoveryClient = createClient({
    shelves: [{ id: 7, name: "Lifecycle", slug: "lifecycle-artifacts", books: [] }],
  });
  const recovered = await ensurePlacement({
    client: recoveryClient,
    placement: source,
    recovery: JSON.parse(JSON.stringify(failed.recovery)),
  });
  assert.equal(recovered.code, "bookstack_recovery_reconciled");
  assert.equal(recoveryClient.writes(), 0);
});

test("omitted existing Shelf membership blocks before approval or writes", async () => {
  const fake = createClient({
    shelves: [{ id: 1, name: "Lifecycle", slug: "lifecycle-artifacts", books: [9] }],
  });
  fake.readShelf = async () => ({ id: 1, name: "Lifecycle", slug: "lifecycle-artifacts" });
  const result = await ensurePlacement({ client: fake, placement: source, approve: () => true });
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "bookstack_shelf_membership_invalid");
  assert.equal(fake.writes(), 0);
});

test("omitted pre-PUT membership blocks the replacement while explicit empty membership remains valid", async () => {
  const fake = createClient({
    shelves: [{ id: 1, name: "Lifecycle", slug: "lifecycle-artifacts", books: [] }],
  });
  const readShelf = fake.readShelf;
  let shelfReads = 0;
  fake.readShelf = async (id) => {
    shelfReads += 1;
    if (shelfReads === 4) return { id: 1, name: "Lifecycle", slug: "lifecycle-artifacts" };
    return readShelf(id);
  };
  const result = await ensurePlacement({ client: fake, placement: source, approve: () => true });
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "bookstack_shelf_membership_invalid");
  assert.equal(fake.membershipWrites(), 0);
  assert.equal(fake.writes(), 1);

  const explicitEmpty = await ensurePlacement({
    client: createClient({ shelves: [{ id: 1, name: "Lifecycle", slug: "lifecycle-artifacts", books: [] }] }),
    placement: source,
    approve: () => true,
  });
  assert.equal(explicitEmpty.status, "verified");
});

test("TEST-006 reused Shelf detail reads fail without invented creation recovery", async () => {
  const chapterSlug = "taskwarrior-cc4755dd-67bf-49a6-8e2d-6563d080dde1";
  const reused = createClient({
    shelves: [{ id: 1, name: "Lifecycle", slug: "lifecycle-artifacts", books: [2] }],
    books: [{ id: 2, name: "Shared", slug: "shared-dev-memory" }],
    chapters: [{ id: 10, name: chapterSlug, slug: chapterSlug, bookId: 2 }],
  });
  const readShelf = reused.readShelf;
  let shelfReads = 0;
  reused.readShelf = async (id) => {
    shelfReads += 1;
    if (shelfReads === 3) throw new Error("token=secret");
    return readShelf(id);
  };
  const result = await ensurePlacement({ client: reused, placement: source, approve: () => true });
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "bookstack_placement_unavailable");
  assert.equal(result.recovery, null);
  assert.equal(shelfReads, 3);
  assert.equal(reused.writes(), 0);
  assert.equal(reused.membershipWrites(), 0);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test("new Shelf detail read failures retain creation recovery", async () => {
  const created = createClient();
  created.readShelf = async () => { throw new Error("token=secret"); };
  const result = await ensurePlacement({ client: created, placement: source, approve: () => true });
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "bookstack_placement_unavailable");
  assert.equal(result.recovery.operation, "create_shelf");
  assert.equal(result.recovery.shelfId, 1);
  assert.deepEqual(result.recovery.membershipBefore, []);
  assert.deepEqual(result.recovery.membershipAfter, ["new-project-book"]);
  assert.equal(created.writes(), 1);
  assert.equal(created.membershipWrites(), 0);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test("reused Book read failures are bounded while created Book read failures retain valid recovery", async () => {
  const reused = createClient({
    shelves: [{ id: 1, name: "Lifecycle", slug: "lifecycle-artifacts", books: [2] }],
    books: [{ id: 2, name: "Shared", slug: "shared-dev-memory" }],
  });
  reused.readBook = async () => { throw new Error("token=secret"); };
  const reusedResult = await ensurePlacement({ client: reused, placement: source, approve: () => true });
  assert.equal(reusedResult.status, "blocked");
  assert.equal(reusedResult.recovery, null);
  assert.equal(reused.writes(), 0);
  assert.doesNotMatch(JSON.stringify(reusedResult), /secret/);

  const created = createClient();
  created.readBook = async () => { throw new Error("bookstack_response_invalid"); };
  const createdResult = await ensurePlacement({ client: created, placement: source, approve: () => true });
  assert.equal(createdResult.status, "blocked");
  assert.equal(createdResult.recovery.operation, "create_book");
  assert.equal(createdResult.recovery.bookId, 2);
  assert.deepEqual(createdResult.recovery.membershipAfter, [2]);
});

test("existing attached books retain ordered membership while adding a missing chapter", async () => {
  const chapterSlug = "taskwarrior-cc4755dd-67bf-49a6-8e2d-6563d080dde1";
  const fake = createClient({
    shelves: [{ id: 1, name: "Lifecycle", slug: "lifecycle-artifacts", books: [2] }],
    books: [{ id: 2, name: "Shared", slug: "shared-dev-memory" }],
    chapters: [],
  });
  const result = await ensurePlacement({ client: fake, placement: source, approve: () => true });
  assert.equal(result.status, "verified");
  assert.equal(result.placement.chapterSlug, chapterSlug);
  assert.equal(fake.writes(), 1);
});

test("stale membership, unrelated existing books, and nonliteral approval write nothing", async () => {
  const unrelated = createClient({
    shelves: [{ id: 1, name: "Lifecycle", slug: "lifecycle-artifacts", books: [] }],
    books: [{ id: 2, name: "Shared", slug: "shared-dev-memory" }],
  });
  await assert.rejects(planPlacement(unrelated, source), /bookstack_placement_conflict/);
  assert.equal(unrelated.writes(), 0);

  const stale = createClient({
    shelves: [{ id: 1, name: "Lifecycle", slug: "lifecycle-artifacts", books: [] }],
  });
  const staleResult = await ensurePlacement({
    client: stale,
    placement: source,
    approve: () => {
      stale.mutateShelf([99]);
      return true;
    },
  });
  assert.equal(staleResult.code, "bookstack_approval_stale");
  assert.equal(stale.writes(), 0);

  for (const approve of [() => "yes", () => { throw new Error("token=secret"); }]) {
    const fake = createClient();
    const result = await ensurePlacement({ client: fake, placement: source, approve });
    assert.equal(result.code, "bookstack_approval_declined");
    assert.equal(fake.writes(), 0);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  }
});

test("placement discovery issues hierarchy lists sequentially", async () => {
  let releaseShelves;
  let shelvesStarted;
  const shelfStarted = new Promise((resolve) => { shelvesStarted = resolve; });
  const shelfRelease = new Promise((resolve) => { releaseShelves = resolve; });
  const calls = [];
  const client = createClient();
  client.listShelves = async () => {
    calls.push("shelves");
    shelvesStarted();
    await shelfRelease;
    return [];
  };
  client.listBooks = async () => {
    calls.push("books");
    return [];
  };
  client.listChapters = async () => {
    calls.push("chapters");
    return [];
  };

  const pending = planPlacement(client, source);
  await shelfStarted;
  assert.deepEqual(calls, ["shelves"]);
  releaseShelves();
  const preview = await pending;

  assert.deepEqual(calls, ["shelves", "books", "chapters"]);
  assert.deepEqual(preview.creates, ["shelf", "book", "chapter"]);
});

test("a blocked placement list prevents later list, approval, and write work", async () => {
  const calls = [];
  let approvals = 0;
  const client = {
    origin: "https://bookstack.example",
    listShelves: async () => {
      calls.push("shelves");
      return [];
    },
    listBooks: async () => {
      calls.push("books");
      throw new Error("bookstack_rate_limited");
    },
    listChapters: async () => {
      calls.push("chapters");
      return [];
    },
    createShelf: async () => { calls.push("create-shelf"); },
  };

  const result = await ensurePlacement({
    client,
    placement: source,
    approve: () => {
      approvals += 1;
      return true;
    },
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "bookstack_rate_limited");
  assert.equal(result.category, "unavailable");
  assert.deepEqual(calls, ["shelves", "books"]);
  assert.equal(approvals, 0);
});
