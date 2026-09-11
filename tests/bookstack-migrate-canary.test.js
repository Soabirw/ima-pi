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
  const calls = [];
  try {
    const run = await createBookStackArtifactRun(projectRoot);
    await writeBookStackInventory(run, [target]);
    const report = buildBookStackMigrationReport({
      runId: run.runId,
      specHash: "a".repeat(64),
      sourceFingerprint: "b".repeat(64),
      outcomes: [{ sourceId: target.sourceId, sourceHash: target.sourceHash, status: "created", targetId: 42 }],
    });
    const artifact = await writeImmutableArtifact(run, "canary-report.json", serializeBookStackMigrationReport(report));
    const result = await cleanupBookStackMigration({
      projectRoot,
      reportPath: artifact.path,
      bookStack: {
        origin: "https://bookstack.example",
        tokenId: "id",
        tokenSecret: "secret",
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
