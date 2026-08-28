import assert from "node:assert/strict";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { createInstitutionalSnapshot } from "../lib/qdrant-http-boundary.ts";
import {
  MAX_MIGRATION_REPORT_BYTES,
  buildMigrationReport,
  classifyVestigeExport,
  parseMigrationReport,
  redactSecrets,
  serializeMigrationReport,
} from "../lib/vestige-migrate.ts";
import { migrateVestige } from "../extensions/vestige-migrate.ts";
import {
  fakeClient,
  lifecycleContent,
  lifecycleId,
  lifecycleRecord,
  migrationCli,
  readReport,
  retainedId,
  temporaryProject,
} from "./vestige-migrate-fixtures.js";

const MCP_ARTIFACT_LIMIT_BYTES = 64 * 1024;
const LARGE_EXPORT_RECORD_COUNT = 80;
const LARGE_EXPORT_RECORD_BYTES = 1_024;
const reportPath = (migration) => migration.artifactPath;

test("redactSecrets stays deterministic and counts changed records instead of matches", () => {
  const source = [
    "Authorization: abc",
    "token=01234567890",
    "api-key: key",
    "access_token=access",
    "client-secret = client",
    "private_key=private",
    "Bearer bearer-token",
  ].join("\n");
  const first = redactSecrets(source);
  assert.equal(first.redacted, 7);
  assert.deepEqual(redactSecrets(source), first);
  assert.deepEqual(redactSecrets(first.text), { text: first.text, redacted: 0 });
  assert.doesNotMatch(first.text, /bearer-token|01234567890/);
  const classification = classifyVestigeExport([lifecycleRecord(lifecycleContent(source))]);
  assert.equal(classification.institutional[0].wasRedacted, true);
});

test("classification retains only explicit standalone preferences", () => {
  const classification = classifyVestigeExport([
    lifecycleRecord(),
    { id: retainedId, content: "User prefers this setting in Vestige.", createdAt: "2026-08-26T21:33:02.576436343+00:00" },
    { id: "44444444-4444-4444-8444-444444444444", content: "Unknown legacy content.", createdAt: "2026-08-26T21:33:02.576436343+00:00" },
    { id: "not-a-uuid", content: "invalid", createdAt: "2026-08-26T21:33:02.576436343+00:00" },
  ]);
  assert.equal(classification.institutional.length, 2);
  assert.deepEqual(classification.retained, [{ vestigeId: retainedId, reason: "explicit_preference" }]);
  assert.deepEqual(classification.quarantined, [{ vestigeId: null, reason: "export_invalid" }]);
  assert.equal(classification.institutional[0].records[0].expected.sourceRefs.includes(`vestige:${lifecycleId}`), true);
  assert.doesNotMatch(classification.institutional[0].records[0].expected.detail, /lifecycle-secret/);
});

test("migration creates a strict source-bundles v2 report and verifies full records", async (t) => {
  const root = await temporaryProject(t);
  const exportText = JSON.stringify([
    lifecycleRecord(),
    { id: retainedId, content: "User prefers this setting in Vestige.", createdAt: "2026-08-26T21:33:02.576436343+00:00" },
  ]);
  const calls = [];
  const state = { collection: "absent" };
  const fake = fakeClient(state);
  let run = 0;
  const dependencies = {
    client: fake.client,
    createSnapshot: async () => ({ success: true, data: { name: "snapshot.snapshot" } }),
    mcpSession: async () => { throw new Error("migration must not open an MCP session"); },
    ...migrationCli("backup", exportText, calls),
    now: () => new Date(`2026-08-26T21:3${run++}:00.000Z`),
  };
  const first = await migrateVestige(root, dependencies);
  const firstReport = await readReport(root, reportPath(first));
  assert.equal(first.report.summary.migrated, 1);
  assert.equal(first.report.summary.retainedPreferences, 1);
  assert.equal(first.report.summary.redacted, 1);
  assert.equal(first.report.summary.unverified, 0);
  assert.equal(firstReport.schemaVersion, 2);
  assert.equal(parseMigrationReport(firstReport)?.outcomes.length, 1);
  assert.equal(JSON.stringify(firstReport).includes("lifecycle-secret"), false);
  assert.equal(firstReport.recovery.backup.sha256.length, 64);
  assert.equal(firstReport.recovery.export.sizeBytes, Buffer.byteLength(exportText));
  const second = await migrateVestige(root, dependencies);
  assert.equal(second.report.summary.unchanged, 1);
  assert.deepEqual(
    calls.map(({ command, outputPath }) => ({ command, outputName: basename(outputPath) })),
    [
      { command: "backup", outputName: "vestige-backup.sqlite" },
      { command: "export", outputName: "vestige-export.json" },
      { command: "backup", outputName: "vestige-backup.sqlite" },
      { command: "export", outputName: "vestige-export.json" },
    ],
  );
  assert.deepEqual(
    calls.map(({ outputPath }) => dirname(outputPath)),
    [
      dirname(join(root, first.artifactPath)),
      dirname(join(root, first.artifactPath)),
      dirname(join(root, second.artifactPath)),
      dirname(join(root, second.artifactPath)),
    ],
  );
});

test("migration imports an export larger than the MCP artifact limit", async (t) => {
  const root = await temporaryProject(t);
  const preferences = Array.from({ length: LARGE_EXPORT_RECORD_COUNT }, (_value, index) => ({
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    content: `User prefers ${"p".repeat(LARGE_EXPORT_RECORD_BYTES)}`,
    createdAt: "2026-08-26T21:33:02.576436343+00:00",
  }));
  const exportText = JSON.stringify([lifecycleRecord(), ...preferences]);
  assert.equal(Buffer.byteLength(exportText) > MCP_ARTIFACT_LIMIT_BYTES, true);

  const fake = fakeClient();
  const migration = await migrateVestige(root, {
    client: fake.client,
    ...migrationCli("backup", exportText),
    now: () => new Date("2026-08-26T21:39:00.000Z"),
  });

  assert.equal(migration.report.summary.migrated, 1);
  assert.equal(migration.report.summary.retainedPreferences, LARGE_EXPORT_RECORD_COUNT);
  assert.equal(migration.report.recovery.export.sizeBytes, Buffer.byteLength(exportText));
});

test("canonical collisions quarantine sources before only unique records reach Qdrant", async (t) => {
  const root = await temporaryProject(t);
  const duplicateId = "33333333-3333-4333-8333-333333333333";
  const uniqueId = "44444444-4444-4444-8444-444444444444";
  const fake = fakeClient();
  const migration = await migrateVestige(root, {
    client: fake.client,
    ...migrationCli("backup", JSON.stringify([
      lifecycleRecord(),
      lifecycleRecord(lifecycleContent(), duplicateId),
      { id: uniqueId, content: "A unique legacy record still migrates.", createdAt: "2026-08-26T21:33:02.576436343+00:00" },
    ])),
    now: () => new Date("2026-08-26T21:39:15.000Z"),
  });

  assert.equal(migration.report.summary.migrated, 1);
  assert.equal(migration.report.summary.quarantined, 2);
  assert.equal(fake.records.size, 1);
  assert.equal(fake.records.has(`vestige:${uniqueId}`), true);
  assert.deepEqual(migration.report.quarantined, [
    { vestigeId: lifecycleId, reason: "record_invalid" },
    { vestigeId: duplicateId, reason: "record_invalid" },
  ]);
  assert.ok(parseMigrationReport(await readReport(root, migration.artifactPath)));
});

test("unverified store results remain visible and never become cleanup candidates", async (t) => {
  const root = await temporaryProject(t);
  const exportText = JSON.stringify([lifecycleRecord()]);
  const fake = fakeClient();
  fake.client.getInstitutional = async () => ({ success: true, data: { recordKey: "wrong", sourceRefs: [] } });
  const migration = await migrateVestige(root, {
    client: fake.client,
    ...migrationCli("backup", exportText),
    now: () => new Date("2026-08-26T21:40:00.000Z"),
  });
  assert.deepEqual(migration.report.summary, {
    migrated: 0,
    unchanged: 0,
    retainedPreferences: 0,
    quarantined: 0,
    conflicts: 0,
    failed: 0,
    unverified: 1,
    redacted: 1,
  });
  assert.equal(migration.report.outcomes[0].status, "unverified");
});

test("a preferences-only export writes a successful report without snapshot or collection mutation", async (t) => {
  const root = await temporaryProject(t);
  const exportText = JSON.stringify([{ id: retainedId, content: "User prefers this setting.", createdAt: "2026-08-26T21:33:02.576436343+00:00" }]);
  const fake = fakeClient({ collection: "ready" });
  let snapshots = 0;
  let ensured = 0;
  fake.client.ensureCollection = async () => { ensured += 1; return { success: true, data: {} }; };
  const migration = await migrateVestige(root, {
    client: fake.client,
    createSnapshot: async () => { snapshots += 1; return { success: true, data: { name: "snapshot.snapshot" } }; },
    ...migrationCli("backup", exportText),
    now: () => new Date("2026-08-26T21:40:30.000Z"),
  });
  assert.equal(migration.report.summary.retainedPreferences, 1);
  assert.equal(snapshots, 0);
  assert.equal(ensured, 0);
});

test("snapshot boundary posts only to the fixed institutional collection", async () => {
  const calls = [];
  const result = await createInstitutionalSnapshot({
    env: { IMA_QDRANT_URL: "http://qdrant.test", IMA_OLLAMA_URL: "http://ollama.test" },
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      calls.push({ path: url.pathname, method: init.method });
      return new Response(JSON.stringify({ result: { name: "snapshot-1.snapshot" } }), { status: 200 });
    },
  });
  assert.deepEqual(result, { success: true, data: { name: "snapshot-1.snapshot" } });
  assert.deepEqual(calls, [{ path: "/collections/ima-institutional-memory/snapshots", method: "POST" }]);
});

test("strict source-bundle reports use one writer-reader bound", () => {
  const classification = classifyVestigeExport([lifecycleRecord()]);
  const candidate = classification.institutional[0];
  const destination = candidate.records[0];
  const report = buildMigrationReport({
    classification,
    outcomes: [{
      vestigeId: candidate.vestigeId,
      sourceHash: candidate.sourceHash,
      sourceBytes: candidate.sourceBytes,
      status: "migrated",
      records: [{
        role: destination.role,
        vestigeId: candidate.vestigeId,
        id: destination.expected.id,
        recordKey: destination.expected.recordKey,
        lifecycleKey: destination.expected.lifecycleKey,
        phase: destination.expected.phase,
        contentHash: destination.expected.contentHash,
        status: "migrated",
      }],
    }],
    recovery: {
      backup: { relativePath: "vestige-backup.sqlite", sizeBytes: 100, sha256: "a".repeat(64) },
      export: { relativePath: "vestige-export.json", sizeBytes: 2, sha256: "b".repeat(64) },
      snapshot: { status: "not_applicable" },
    },
  });
  assert.ok(report);
  const serialized = serializeMigrationReport(report);
  assert.equal(serialized.success, true);
  assert.equal(Buffer.byteLength(serialized.data) <= MAX_MIGRATION_REPORT_BYTES, true);
  assert.equal(parseMigrationReport(JSON.parse(serialized.data))?.schemaVersion, 2);
});
