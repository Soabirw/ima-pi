import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { applyBookStackMigration, dryRunBookStackMigration } from "../lib/bookstack-migrate.ts";
import { MAX_ARTIFACT_BYTES, readBookStackInventory } from "../lib/bookstack-migrate-artifacts.ts";
import {
  normalizeInstitutionalManifest,
  normalizeInstitutionalRecord,
} from "../lib/qdrant-corpus.ts";

const lifecycleInput = (recordKey, detail) => ({
  recordKey,
  project: "ima-pi",
  site: "",
  repo: "ima-pi",
  lifecycleKey: "ima-pi:plane:ima:SKYNET-149",
  phase: "plan",
  summary: "Approved plan",
  detail,
  sourceRefs: ["plane:ima:SKYNET-149"],
});

const fixturePoints = () => {
  const v1 = normalizeInstitutionalRecord(
    lifecycleInput("ima-pi:plane:ima:SKYNET-149:plan:111111111111", "# v1\n"),
    "2026-09-10T00:00:00.000Z",
  );
  const v2 = normalizeInstitutionalManifest(
    lifecycleInput("ima-pi:plane:ima:SKYNET-149:plan:222222222222", "# v2\n"),
    "2026-09-10T00:00:00.000Z",
  );
  assert.equal(v1.success, true);
  assert.equal(v2.success, true);
  return [
    { id: v1.data.id, payload: v1.data.payload },
    { id: v2.data.id, payload: v2.data.payload },
    ...v2.data.chunks.map((chunk) => ({ id: chunk.id, payload: chunk.payload })),
    { id: "bad-v1", payload: { schema_version: 1 } },
    {
      id: "orphan-chunk",
      payload: {
        schema_version: 2,
        record_kind: "detail_chunk",
        parent_record_key: "orphan-record",
      },
    },
    { id: v1.data.id, payload: v1.data.payload },
    { id: "unknown", payload: { schema_version: 3 } },
  ];
};

const readArtifact = async (projectRoot, artifactPath) => JSON.parse(
  await readFile(join(projectRoot, artifactPath), "utf8"),
);

test("dry-run writes a deterministic itemized report for mixed source outcomes", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "ima-bookstack-dry-run-"));
  const knowledgeRoot = join(projectRoot, "knowledge");
  const specPath = join(projectRoot, "migration.json");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    result: { points: fixturePoints(), next_page_offset: null },
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    await mkdir(join(knowledgeRoot, "guides"), { recursive: true });
    await writeFile(join(knowledgeRoot, "guides", "intro.md"), "# Intro\n", "utf8");
    await writeFile(join(knowledgeRoot, "top-level.md"), "# Top level\n", "utf8");
    await writeFile(specPath, `${JSON.stringify({
      schemaVersion: 1,
      lifecycle: {
        collection: "ima-lifecycle",
        qdrantOrigin: "https://qdrant.example.test",
        shelfName: "Lifecycle Artifacts",
      },
      knowledge: { root: knowledgeRoot, shelfName: "Institutional Knowledge" },
    }, null, 2)}\n`, "utf8");

    const first = await dryRunBookStackMigration({ projectRoot, specPath });
    const second = await dryRunBookStackMigration({ projectRoot, specPath });
    const inventoryPath = first.run.directory.replace(`${projectRoot}/`, "") + "/inventory.json";
    const inventory = await readArtifact(projectRoot, inventoryPath);
    const pages = await readBookStackInventory(projectRoot, inventoryPath);
    const quarantine = await readArtifact(projectRoot, first.run.directory.replace(`${projectRoot}/`, "") + "/quarantine.json");

    assert.equal(first.report.summary.unverified, 3);
    assert.equal(first.report.summary.quarantined, 5);
    assert.equal(inventory.artifactType, "bookstack-inventory");
    assert.deepEqual(pages.map((page) => page.sourceId).sort(), [
      "filesystem:guides/intro.md",
      `qdrant:${fixturePoints()[0].id}`,
      `qdrant:${fixturePoints()[1].id}`,
    ].sort());
    assert.deepEqual(quarantine.map(({ code }) => code).sort(), [
      "knowledge_path_invalid",
      "qdrant_chunk_orphaned",
      "qdrant_record_duplicate",
      "qdrant_schema_unsupported",
      "qdrant_v1_invalid",
    ].sort());
    assert.equal(first.report.sourceFingerprint, second.report.sourceFingerprint);
    assert.deepEqual(first.report.outcomes.map((outcome) => outcome.sourceId), second.report.outcomes.map((outcome) => outcome.sourceId));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("apply accepts an itemized dry-run with only quarantined outcomes", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "ima-bookstack-apply-quarantine-"));
  const knowledgeRoot = join(projectRoot, "knowledge");
  const specPath = join(projectRoot, "migration.json");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    result: { points: [{ id: "bad-v1", payload: { schema_version: 1 } }], next_page_offset: null },
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    await mkdir(knowledgeRoot, { recursive: true });
    await writeFile(join(knowledgeRoot, "top-level.md"), "# Ineligible\n", "utf8");
    await writeFile(specPath, `${JSON.stringify({
      schemaVersion: 1,
      lifecycle: {
        collection: "ima-lifecycle",
        qdrantOrigin: "https://qdrant.example.test",
        shelfName: "Lifecycle Artifacts",
      },
      knowledge: { root: knowledgeRoot, shelfName: "Institutional Knowledge" },
    }, null, 2)}\n`, "utf8");

    const dryRun = await dryRunBookStackMigration({ projectRoot, specPath });
    const applied = await applyBookStackMigration({
      projectRoot,
      dryRunReportPath: dryRun.artifact.path,
      bookStack: {
        origin: "https://bookstack.example.test",
        tokenId: "test-id",
        tokenSecret: "test-secret",
        fetch: async () => new Response(JSON.stringify({
          data: [
            { id: 1, name: "Lifecycle Artifacts" },
            { id: 2, name: "Institutional Knowledge" },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } }),
      },
    });

    assert.deepEqual(applied.report.summary, {
      created: 0, unchanged: 0, conflict: 0, quarantined: 2, failed: 0, unverified: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("dry-run persists large inventories as bounded collection parts", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "ima-bookstack-dry-run-large-"));
  const knowledgeRoot = join(projectRoot, "knowledge");
  const specPath = join(projectRoot, "migration.json");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    result: { points: fixturePoints().slice(0, 1), next_page_offset: null },
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    await mkdir(join(knowledgeRoot, "guides"), { recursive: true });
    await Promise.all(Array.from({ length: 30 }, (_, index) => writeFile(
      join(knowledgeRoot, "guides", `guide-${index}.md`),
      `# Guide ${index}\n${"x".repeat(20_000)}`,
      "utf8",
    )));
    await writeFile(specPath, `${JSON.stringify({
      schemaVersion: 1,
      lifecycle: {
        collection: "ima-lifecycle",
        qdrantOrigin: "https://qdrant.example.test",
        shelfName: "Lifecycle Artifacts",
      },
      knowledge: { root: knowledgeRoot, shelfName: "Institutional Knowledge" },
    }, null, 2)}\n`, "utf8");

    const result = await dryRunBookStackMigration({ projectRoot, specPath });
    const inventoryPath = result.run.directory.replace(`${projectRoot}/`, "") + "/inventory.json";
    const inventory = await readArtifact(projectRoot, inventoryPath);

    assert.ok(inventory.parts.length > 1);
    for (const part of inventory.parts) {
      assert.ok((await stat(join(projectRoot, dirname(inventoryPath), part.name))).size <= MAX_ARTIFACT_BYTES);
    }
    assert.equal((await readBookStackInventory(projectRoot, inventoryPath)).length, 31);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});
