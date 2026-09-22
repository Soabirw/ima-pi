import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBookStackArtifactRun, writeBookStackInventory, writeImmutableArtifact } from "../lib/bookstack-migrate-artifacts.ts";
import { selectBookStackCanaryPages } from "../lib/bookstack-migrate-canary.ts";
import { cleanupBookStackMigration } from "../lib/bookstack-migrate.ts";
import { buildBookStackMigrationReport, serializeBookStackMigrationReport } from "../lib/bookstack-migrate-report.ts";
import { sourceHash, targetPage } from "../lib/bookstack-migrate-source.ts";

const page = (index, shelfName, bookName, chapterName) => ({
  sourceId: `source:${String(index).padStart(2, "0")}`,
  sourceHash: String(index).padStart(64, "0"),
  shelfName,
  bookName,
  chapterName,
  pageName: `page-${index}`,
});

const virtualBookStackTiming = () => {
  let current = 0;
  return {
    now: () => current,
    wait: async (milliseconds) => { current += milliseconds; },
  };
};

const cleanupFixture = async (projectRoot, reportName = "canary-report.json") => {
  const body = "# canary\n";
  const target = targetPage({
    kind: "knowledge",
    sourceOrigin: "filesystem",
    sourceId: "filesystem:guides/canary.md",
    project: "ima-rag",
    artifactType: "knowledge",
    sourceRefs: ["path:guides/canary.md"],
    createdAt: "2026-09-10T00:00:00.000Z",
    author: "legacy-unknown",
    body,
    sourceHash: sourceHash(body),
    path: "guides/canary.md",
  });
  const run = await createBookStackArtifactRun(projectRoot);
  await writeBookStackInventory(run, [target]);
  const report = buildBookStackMigrationReport({
    runId: run.runId,
    specHash: "a".repeat(64),
    sourceFingerprint: "b".repeat(64),
    outcomes: [{ sourceId: target.sourceId, sourceHash: target.sourceHash, status: "created", targetId: 42 }],
  });
  const artifact = await writeImmutableArtifact(run, reportName, serializeBookStackMigrationReport(report));
  return { artifact, run, target };
};

test("canary deterministically caps real records and covers both shelves and distinct hierarchies", () => {
  const pages = Array.from({ length: 14 }, (_, index) => page(
    index,
    index < 7 ? "Lifecycle Artifacts" : "Institutional Knowledge",
    `book-${index}`,
    `chapter-${index}`,
  ));
  const selected = selectBookStackCanaryPages([...pages].reverse());
  assert.equal(selected.length, 10);
  assert.deepEqual(selected, selectBookStackCanaryPages(pages));
  assert.deepEqual(new Set(selected.map(({ shelfName }) => shelfName)), new Set([
    "Lifecycle Artifacts",
    "Institutional Knowledge",
  ]));
  assert.equal(new Set(selected.map(({ shelfName, bookName, chapterName }) =>
    `${shelfName}/${bookName}/${chapterName}`)).size, selected.length);

  const sameHierarchy = Array.from({ length: 12 }, (_, index) => page(
    index,
    "Lifecycle Artifacts",
    "one-book",
    "one-chapter",
  ));
  assert.equal(selectBookStackCanaryPages(sameHierarchy).length, 10);
});

test("canary rejects unbounded limits", () => {
  assert.throws(() => selectBookStackCanaryPages([], 11), /canary_limit_invalid/);
  assert.throws(() => selectBookStackCanaryPages([], 0), /canary_limit_invalid/);
});

test("canary reports use the existing hash-guarded Page cleanup", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "ima-bookstack-canary-cleanup-"));
  const calls = [];
  try {
    const { artifact, target } = await cleanupFixture(projectRoot);
    const result = await cleanupBookStackMigration({
      projectRoot,
      reportPath: artifact.path,
      bookStack: {
        origin: "https://bookstack.example",
        tokenId: "id",
        tokenSecret: "secret",
        ...virtualBookStackTiming(),
        fetch: async (url, options = {}) => {
          calls.push(options.method ?? "GET");
          if (options.method === "DELETE") return new Response(null, { status: 204 });
          return new Response(JSON.stringify({ id: 42, name: target.pageName, markdown: target.markdown }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    });
    assert.deepEqual(result.deleted, [42]);
    assert.deepEqual(calls, ["GET", "DELETE"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("cleanup preserves inventory hash and source-body guards without deletion", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "ima-bookstack-canary-integrity-"));
  try {
    const { artifact, run, target } = await cleanupFixture(projectRoot);
    const mismatched = buildBookStackMigrationReport({
      runId: run.runId,
      specHash: "a".repeat(64),
      sourceFingerprint: "b".repeat(64),
      outcomes: [{ sourceId: target.sourceId, sourceHash: "f".repeat(64), status: "created", targetId: 42 }],
    });
    const mismatchedArtifact = await writeImmutableArtifact(
      run,
      "final-report.json",
      serializeBookStackMigrationReport(mismatched),
    );
    let hashFetches = 0;
    await assert.rejects(cleanupBookStackMigration({
      projectRoot,
      reportPath: mismatchedArtifact.path,
      bookStack: {
        origin: "https://bookstack.example",
        tokenId: "test-id",
        tokenSecret: "synthetic-token-secret",
        ...virtualBookStackTiming(),
        fetch: async () => {
          hashFetches += 1;
          throw new Error("unexpected_fetch");
        },
      },
    }), /cleanup_inventory_invalid/);
    assert.equal(hashFetches, 0);

    const calls = [];
    const editedMarkdown = `${target.markdown.slice(0, -target.body.length)}# Human edit\n`;
    await assert.rejects(cleanupBookStackMigration({
      projectRoot,
      reportPath: artifact.path,
      bookStack: {
        origin: "https://bookstack.example",
        tokenId: "test-id",
        tokenSecret: "synthetic-token-secret",
        ...virtualBookStackTiming(),
        fetch: async (_url, options = {}) => {
          calls.push(options.method ?? "GET");
          return new Response(JSON.stringify({
            id: 42,
            name: target.pageName,
            markdown: editedMarkdown,
          }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    }), /cleanup_page_human_edited/);
    assert.deepEqual(calls, ["GET"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("cleanup combines operation and client cancellation signals before request issue", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "ima-bookstack-canary-cancellation-"));
  try {
    const { artifact } = await cleanupFixture(projectRoot);
    for (const cancelledBy of ["operation", "client"]) {
      const operation = new AbortController();
      const client = new AbortController();
      if (cancelledBy === "operation") operation.abort();
      else client.abort();
      let fetches = 0;
      await assert.rejects(cleanupBookStackMigration({
        projectRoot,
        reportPath: artifact.path,
        signal: operation.signal,
        bookStack: {
          origin: "https://bookstack.example",
          tokenId: "test-id",
          tokenSecret: "synthetic-token-secret",
          ...virtualBookStackTiming(),
          signal: client.signal,
          fetch: async () => {
            fetches += 1;
            throw new Error("unexpected_fetch");
          },
        },
      }), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "bookstack_transport_failed");
        assert.doesNotMatch(error.message, /synthetic-token-secret/);
        return true;
      });
      assert.equal(fetches, 0, `${cancelledBy} cancellation must stop before fetch`);
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
