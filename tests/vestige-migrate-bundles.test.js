import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_STORED_ARTIFACT_BYTES,
  deriveRecordId,
  utf8ByteLength,
} from "../lib/qdrant-corpus.ts";
import { hashDetail } from "../lib/qdrant-corpus-chunks.ts";
import {
  buildMigrationReport,
  classifyVestigeExport,
  parseMigrationReport,
  serializeMigrationReport,
} from "../lib/vestige-migrate.ts";
import {
  importMigrationSource,
  verifyMigrationSourceForCleanup,
} from "../lib/vestige-migrate-qdrant.ts";
import { cleanupVestige, migrateVestige } from "../extensions/vestige-migrate.ts";
import {
  createLogicalQdrantFixture,
  purgeReceipt,
  sqliteBackup,
} from "./vestige-migrate-fixtures.js";

const createdAt = "2026-08-27T22:43:29.085Z";
const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const recovery = {
  backup: { relativePath: "vestige-backup.sqlite", sizeBytes: 100, sha256: "a".repeat(64) },
  export: { relativePath: "vestige-export.json", sizeBytes: 2, sha256: "b".repeat(64) },
  snapshot: { status: "not_applicable" },
};

const sourceFor = (content, id = sourceId) => classifyVestigeExport([{
  id,
  content,
  createdAt,
}]).institutional[0];

const oversizedContent = () => "é".repeat(Math.ceil((MAX_STORED_ARTIFACT_BYTES + 8) / 2));

test("logical records and source bundles import idempotently with index-last ordering", async () => {
  const logical = sourceFor("l".repeat(50_000), "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  const bundle = sourceFor(oversizedContent());
  const fixture = createLogicalQdrantFixture();
  await fixture.client.ensureCollection();

  const logicalOutcome = await importMigrationSource({ source: logical, client: fixture.client });
  const first = await importMigrationSource({ source: bundle, client: fixture.client });
  const second = await importMigrationSource({ source: bundle, client: fixture.client });

  const logicalId = deriveRecordId(logical.records[0].expected.recordKey);
  assert.equal(logicalId.success, true);
  assert.equal(fixture.points.get(logicalId.data)?.payload.schema_version, 2);
  assert.equal(logicalOutcome.status, "migrated");
  assert.equal(first.status, "migrated");
  assert.equal(second.status, "unchanged");
  assert.equal(first.records.at(-1)?.role, "index");
  assert.equal(first.records.every((record) => record.status === "migrated"), true);
  assert.equal(second.records.every((record) => record.status === "unchanged"), true);

  const expectedKeys = bundle.records.map((candidate) => candidate.expected.recordKey);
  const destinationWrites = fixture.writeOrder.filter((recordKey) => expectedKeys.includes(recordKey));
  assert.deepEqual(destinationWrites, expectedKeys);
  assert.equal(destinationWrites.at(-1), bundle.records.at(-1)?.expected.recordKey);
  assert.equal(await verifyMigrationSourceForCleanup({ source: first, client: fixture.client }), null);
});

test("short source hashes describe the normalized detail used by cleanup", async () => {
  const source = sourceFor("\nInstitutional note.\n", "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  const fixture = createLogicalQdrantFixture();
  await fixture.client.ensureCollection();
  const outcome = await importMigrationSource({ source, client: fixture.client });
  const stored = await fixture.client.getInstitutional(outcome.records[0].recordKey);

  assert.equal(stored.success, true);
  assert.equal(stored.data.detail, "Institutional note.");
  assert.equal(source.sourceHash, hashDetail(stored.data.detail));
  assert.equal(source.sourceBytes, utf8ByteLength(stored.data.detail));
  assert.equal(await verifyMigrationSourceForCleanup({ source: outcome, client: fixture.client }), null);
});

test("a failed or conflicting part blocks later parts, resumes safely, and prevents index insertion", async () => {
  const bundle = sourceFor(oversizedContent());
  const firstPart = bundle.records[0];
  const secondPart = bundle.records[1];
  const index = bundle.records.at(-1);

  const failedFixture = createLogicalQdrantFixture({
    failRecordKeys: [secondPart.expected.recordKey],
  });
  await failedFixture.client.ensureCollection();
  const failed = await importMigrationSource({ source: bundle, client: failedFixture.client });
  assert.equal(failed.status, "failed");
  assert.equal(failed.records[0].status, "migrated");
  assert.equal(failed.records[1].status, "failed");
  assert.equal(failed.records.at(-1)?.reason, "dependency_blocked");
  assert.equal(failedFixture.writeOrder.includes(index.expected.recordKey), false);
  failedFixture.failRecordKeys.delete(secondPart.expected.recordKey);
  const resumed = await importMigrationSource({ source: bundle, client: failedFixture.client });
  assert.equal(resumed.status, "migrated");
  assert.equal(resumed.records[0].status, "unchanged");
  assert.equal(resumed.records.at(-1)?.status, "migrated");

  const conflictFixture = createLogicalQdrantFixture();
  await conflictFixture.client.ensureCollection();
  conflictFixture.addManifestConflict({
    ...firstPart.record,
    detail: `${firstPart.record.detail.slice(0, -1)}x`,
  }, firstPart.expected.createdAt);
  const conflicted = await importMigrationSource({ source: bundle, client: conflictFixture.client });
  assert.equal(conflicted.status, "record_conflict");
  assert.equal(conflicted.records[0].status, "record_conflict");
  assert.equal(conflicted.records.at(-1)?.reason, "dependency_blocked");
  assert.equal(conflictFixture.writeOrder.includes(index.expected.recordKey), false);
});

test("a seventy-four-part source remains bounded with directly verifiable expectations", () => {
  const content = "x".repeat(73 * (MAX_STORED_ARTIFACT_BYTES - 3) + 1);
  const source = sourceFor(content, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  const parts = source.records.filter((candidate) => candidate.role === "part");

  assert.equal(parts.length, 74);
  assert.equal(source.records.length, 75);
  assert.equal(parts.map((candidate) => candidate.record.detail).join(""), content);
  assert.equal(parts.every((candidate) => candidate.record.detail.length <= MAX_STORED_ARTIFACT_BYTES), true);
  assert.equal(parts.every((candidate) => candidate.expected.id && candidate.expected.contentHash), true);
  assert.equal(source.records.at(-1)?.role, "index");
});

test("source-bundle reports enforce complete ordered unique records and reject old layouts", async () => {
  const bundle = sourceFor(oversizedContent());
  const fixture = createLogicalQdrantFixture();
  await fixture.client.ensureCollection();
  const outcome = await importMigrationSource({ source: bundle, client: fixture.client });
  const classification = {
    institutional: [bundle],
    retained: [],
    quarantined: [],
  };
  const report = buildMigrationReport({ classification, outcomes: [outcome], recovery });

  assert.ok(report);
  const serialized = serializeMigrationReport(report);
  assert.equal(serialized.success, true);
  assert.equal(parseMigrationReport(JSON.parse(serialized.data))?.layout, "source-bundles");

  const reordered = structuredClone(report);
  [reordered.outcomes[0].records[0], reordered.outcomes[0].records[1]] = [
    reordered.outcomes[0].records[1],
    reordered.outcomes[0].records[0],
  ];
  assert.equal(parseMigrationReport(reordered), null);

  const truncated = structuredClone(report);
  truncated.outcomes[0].records.splice(1, 1);
  assert.equal(parseMigrationReport(truncated), null);

  const duplicate = structuredClone(report);
  duplicate.outcomes[0].records[1] = {
    ...duplicate.outcomes[0].records[0],
    partIndex: 2,
  };
  assert.equal(parseMigrationReport(duplicate), null);

  assert.equal(parseMigrationReport({
    schemaVersion: 2,
    recovery,
    summary: report.summary,
    outcomes: report.outcomes,
    quarantined: [],
  }), null);
});

test("cleanup deletes one verified source once after all bundle records verify", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ima-pi-vestige-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = createLogicalQdrantFixture();
  const exportText = JSON.stringify([{ id: sourceId, content: oversizedContent(), createdAt }]);
  const migration = await migrateVestige(root, {
    client: fixture.client,
    runVestigeBackup: async ({ outputPath }) => writeFile(outputPath, sqliteBackup()),
    runVestigeExport: async ({ outputPath }) => writeFile(outputPath, exportText),
    now: () => new Date("2026-08-27T22:43:29.085Z"),
  });
  const deleted = [];
  const actions = [];
  const cleanup = await cleanupVestige(root, {
    reportPath: migration.artifactPath,
    confirm: true,
  }, {
    client: fixture.client,
    mcpSession: async (_server, callback) => callback(async (name, args) => {
      actions.push({ name, action: args.action });
      deleted.push(args.id);
      return purgeReceipt(args.id);
    }),
    now: () => new Date("2026-08-27T22:44:29.085Z"),
  });

  assert.equal(cleanup.purged, 1);
  assert.deepEqual(deleted, [sourceId]);
  assert.deepEqual(actions, [{ name: "memory", action: "purge" }]);
});

test("cleanup deletes an idempotently unchanged bundle after all records verify", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ima-pi-vestige-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = createLogicalQdrantFixture();
  const content = "é".repeat(Math.ceil((MAX_STORED_ARTIFACT_BYTES + 8) / 2));
  const exportText = JSON.stringify([{ id: sourceId, content, createdAt }]);
  let migrationMinute = 50;
  const dependencies = {
    client: fixture.client,
    createSnapshot: async () => ({ success: true, data: { name: "snapshot.snapshot" } }),
    runVestigeBackup: async ({ outputPath }) => writeFile(outputPath, sqliteBackup()),
    runVestigeExport: async ({ outputPath }) => writeFile(outputPath, exportText),
    now: () => new Date(`2026-08-27T22:${migrationMinute++}:29.085Z`),
  };
  const first = await migrateVestige(root, dependencies);
  const second = await migrateVestige(root, dependencies);
  assert.equal(first.report.outcomes[0].status, "migrated");
  assert.equal(second.report.outcomes[0].status, "unchanged");
  assert.equal(second.report.outcomes[0].records.length > 1, true);

  const deleted = [];
  const actions = [];
  const cleanup = await cleanupVestige(root, {
    reportPath: second.artifactPath,
    confirm: true,
  }, {
    client: fixture.client,
    mcpSession: async (_server, callback) => callback(async (name, args) => {
      actions.push({ name, action: args.action });
      deleted.push(args.id);
      return purgeReceipt(args.id);
    }),
    now: () => new Date("2026-08-27T22:52:29.085Z"),
  });

  assert.equal(cleanup.purged, 1);
  assert.equal(cleanup.retained, 0);
  assert.deepEqual(deleted, [sourceId]);
  assert.deepEqual(actions, [{ name: "memory", action: "purge" }]);
});

test("cleanup verification retains an entire bundle when one destination is missing", async () => {
  const bundle = sourceFor(oversizedContent());
  const fixture = createLogicalQdrantFixture();
  await fixture.client.ensureCollection();
  const outcome = await importMigrationSource({ source: bundle, client: fixture.client });
  const missingPart = bundle.records.find((candidate) => candidate.role === "part");
  const pointId = deriveRecordId(missingPart.expected.recordKey);
  assert.equal(pointId.success, true);
  fixture.points.delete(pointId.data);

  assert.equal(
    await verifyMigrationSourceForCleanup({ source: outcome, client: fixture.client }),
    "qdrant_unverified",
  );
});
