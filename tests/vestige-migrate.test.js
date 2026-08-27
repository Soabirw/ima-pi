import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import { MAX_PAYLOAD_BYTES, VECTOR_SIZE, corpusFailure } from "../lib/qdrant-corpus.ts";
import { MAX_BACKUP_FILE_BYTES, copyVerifiedArtifact, createMigrationArtifactRun, withReservedExclusiveText, writeExclusiveText } from "../lib/vestige-migrate-artifacts.ts";
import { createInstitutionalSnapshot } from "../lib/qdrant-http-boundary.ts";
import { MAX_MIGRATION_REPORT_BYTES, buildMigrationReport, classifyVestigeExport, parseMigrationReport, redactSecrets, serializeMigrationReport } from "../lib/vestige-migrate.ts";
import { cleanupVestige, migrateVestige, registerVestigeMigrateTools } from "../extensions/vestige-migrate.ts";
const success = (data) => ({ success: true, data });
const failure = (code) => corpusFailure(code);
const vector = () => Array.from({ length: VECTOR_SIZE }, () => 0.25);
const lifecycleId = "11111111-1111-4111-8111-111111111111";
const retainedId = "22222222-2222-4222-8222-222222222222";
const nonce = "33333333-3333-4333-8333-333333333333";
const createdAt = "2026-08-26T21:33:02.576436343+00:00";
const lifecycleContent = (detail = "Authorization: lifecycle-secret") => `---
lifecycle:
  project: 'ima-pi'
  lifecycle_key: 'ima-pi:lifecycle:vestige-migrate-command-2026-08-26'
  source_refs:
    - 'taskwarrior:ima-pi:7742b1e1-af39-44d1-9c7e-39c455b15828'
  phase: 'plan'
---

# Migration plan

${detail}

<!-- ima-lifecycle verification: lifecycle_key=ima-pi:lifecycle:vestige-migrate-command-2026-08-26; nonce=${nonce}; phase=plan; jira_key=; taskwarrior_uuid=7742b1e1-af39-44d1-9c7e-39c455b15828; outcome=completed -->
`;
const lifecycleRecord = (content = lifecycleContent(), id = lifecycleId) => ({ id, content, createdAt });
const response = (data) => ({ structuredContent: data });
const temporaryProject = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ima-pi-vestige-migrate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};
const fullRecord = (record) => ({
  id: record.id, recordKey: record.recordKey, project: record.payload.project,
  site: record.payload.site, repo: record.payload.repo, lifecycleKey: record.payload.lifecycle_key,
  phase: record.payload.phase, summary: record.payload.summary, detail: record.payload.detail,
  sourceRefs: record.payload.source_refs, contentHash: record.payload.content_hash, createdAt: record.payload.created_at,
});
const fakeClient = (state = { collection: "absent" }) => {
  const points = new Map();
  const records = new Map();
  return {
    points,
    records,
    client: {
      status: async () => success({
        status: "ready", qdrantVersion: "1.17.1", collection: state.collection, missingIndexes: [],
      }),
      ensureCollection: async () => {
        state.collection = "ready";
        return success({ status: "ready", qdrantVersion: "1.17.1", collection: "ready", missingIndexes: [] });
      },
      getPoint: async (id) => success(points.get(id) ?? null),
      embedSummary: async () => success(vector()),
      insertPoint: async ({ record }) => {
        points.set(record.id, {
          id: record.id,
          recordKey: record.recordKey,
          contentHash: record.payload.content_hash,
        });
        records.set(record.recordKey, fullRecord(record));
        return success(undefined);
      },
      findInstitutional: async () => success([]),
      recallInstitutional: async ({ lifecycleKey }) => success(
        [...records.values()]
          .filter((record) => record.lifecycleKey === lifecycleKey)
          .map(({ id, recordKey, project, site, repo, lifecycleKey: key, phase, summary }) => ({
            id, recordKey, project, site, repo, lifecycleKey: key, phase, summary,
          })),
      ),
      getInstitutional: async (recordKey) => records.has(recordKey)
        ? success(records.get(recordKey))
        : failure("record_not_found"),
      findKnowledge: async () => success([]),
    },
  };
};
const migrationMcp = (backupPath, exportPath, exportText, calls) => async (_server, callback) => callback(async (name, args) => {
  calls.push({ name, args });
  if (name !== "maintain") throw new Error("unexpected MCP tool");
  if (args.action === "backup") return response({ path: backupPath, sizeBytes: 6 });
  if (args.action === "export") return response({
    path: exportPath,
    sizeBytes: Buffer.byteLength(exportText),
    memoriesExported: JSON.parse(exportText).length,
  });
  throw new Error("unexpected maintenance action");
});
const reportPath = (migration) => migration.artifactPath;
const readReport = async (root, relativePath) =>
  JSON.parse(await readFile(join(root, relativePath), "utf8"));
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
  assert.equal(classification.lifecycle[0].wasRedacted, true);
});
test("classification preserves preferences and quarantines invalid or oversized records", () => {
  const oversizedPreference = {
    id: "44444444-4444-4444-8444-444444444444",
    content: "p".repeat(MAX_PAYLOAD_BYTES + 1),
    createdAt,
  };
  const redactedLarge = lifecycleRecord(
    lifecycleContent(`token=${"s".repeat(MAX_PAYLOAD_BYTES + 100)}`),
    "55555555-5555-4555-8555-555555555555",
  );
  const oversizedLifecycle = lifecycleRecord(
    lifecycleContent("x".repeat(MAX_PAYLOAD_BYTES + 1)),
    "66666666-6666-4666-8666-666666666666",
  );
  const classification = classifyVestigeExport([
    lifecycleRecord(),
    { id: retainedId, content: "Keep this preference in Vestige.", createdAt },
    { id: "not-a-uuid", content: "invalid", createdAt },
    oversizedPreference,
    redactedLarge,
    oversizedLifecycle,
  ]);
  assert.equal(classification.lifecycle.length, 2);
  assert.deepEqual(classification.retained, [retainedId]);
  assert.deepEqual(
    classification.quarantined.map((item) => item.reason),
    ["export_invalid", "record_too_large", "record_too_large"],
  );
  assert.equal(classification.lifecycle[0].expected.sourceRefs.includes(`vestige:${lifecycleId}`), true);
  assert.doesNotMatch(classification.lifecycle[0].expected.detail, /lifecycle-secret/);
});
test("migration creates a strict v2 report and verifies full records plus lifecycle recall", async (t) => {
  const root = await temporaryProject(t);
  const backupPath = join(root, "source-backup.db");
  const exportPath = join(root, "source-export.json");
  const exportText = JSON.stringify([
    lifecycleRecord(),
    { id: retainedId, content: "Keep this preference in Vestige.", createdAt },
  ]);
  await writeFile(backupPath, "backup");
  await writeFile(exportPath, exportText);
  const calls = [];
  const state = { collection: "absent" };
  const fake = fakeClient(state);
  let run = 0;
  const dependencies = {
    client: fake.client,
    createSnapshot: async () => success({ name: "snapshot.snapshot" }),
    mcpSession: migrationMcp(backupPath, exportPath, exportText, calls),
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
  assert.equal(calls.filter((call) => call.name === "maintain").length, 4);
});
test("unverified store results remain visible and never become cleanup candidates", async (t) => {
  const root = await temporaryProject(t);
  const backupPath = join(root, "source-backup.db");
  const exportPath = join(root, "source-export.json");
  const exportText = JSON.stringify([lifecycleRecord()]);
  await writeFile(backupPath, "backup");
  await writeFile(exportPath, exportText);
  const fake = fakeClient();
  fake.client.getInstitutional = async () => success({ recordKey: "wrong", sourceRefs: [] });
  const migration = await migrateVestige(root, {
    client: fake.client,
    mcpSession: migrationMcp(backupPath, exportPath, exportText, []),
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
test("precheck does not snapshot or ensure an existing collection without lifecycle candidates", async (t) => {
  const root = await temporaryProject(t);
  const backupPath = join(root, "source-backup.db");
  const exportPath = join(root, "source-export.json");
  const exportText = JSON.stringify([{ id: retainedId, content: "Preference only.", createdAt }]);
  await writeFile(backupPath, "backup");
  await writeFile(exportPath, exportText);
  const fake = fakeClient({ collection: "ready" });
  let snapshots = 0;
  let ensured = 0;
  fake.client.ensureCollection = async () => { ensured += 1; return success({}); };
  await assert.rejects(
    migrateVestige(root, {
      client: fake.client,
      createSnapshot: async () => { snapshots += 1; return success({ name: "snapshot.snapshot" }); },
      mcpSession: migrationMcp(backupPath, exportPath, exportText, []),
      now: () => new Date("2026-08-26T21:40:30.000Z"),
    }),
    /no_lifecycle_records/,
  );
  assert.equal(snapshots, 0);
  assert.equal(ensured, 0);
});
test("cleanup rejects v1 reports and damaged recovery receipts before opening Vestige", async (t) => {
  const root = await temporaryProject(t);
  const legacyDirectory = join(root, ".ima", "vestige-migrate", "legacy");
  await mkdir(legacyDirectory, { recursive: true });
  await writeFile(join(legacyDirectory, "report.json"), JSON.stringify({
    schemaVersion: 1,
    cleanupCandidates: [{ vestigeId: lifecycleId, recordKey: "legacy" }],
  }));
  let sessions = 0;

  await assert.rejects(
    cleanupVestige(root, {
      reportPath: ".ima/vestige-migrate/legacy/report.json",
      confirm: true,
    }, {
      client: {},
      mcpSession: async () => { sessions += 1; return null; },
    }),
    /cleanup_report_invalid/,
  );
  assert.equal(sessions, 0);

  const backupPath = join(root, "source-backup.db");
  const exportPath = join(root, "source-export.json");
  const exportText = JSON.stringify([lifecycleRecord()]);
  await writeFile(backupPath, "backup");
  await writeFile(exportPath, exportText);
  const fake = fakeClient();
  const migration = await migrateVestige(root, {
    client: fake.client,
    mcpSession: migrationMcp(backupPath, exportPath, exportText, []),
    now: () => new Date("2026-08-26T21:41:00.000Z"),
  });
  const report = await readReport(root, migration.artifactPath);
  await writeFile(join(root, migration.artifactPath, "..", report.recovery.export.relativePath), "corrupt");

  await assert.rejects(
    cleanupVestige(root, { reportPath: migration.artifactPath, confirm: true }, {
      client: fake.client,
      mcpSession: async () => { sessions += 1; return null; },
    }),
    /cleanup_recovery_invalid/,
  );
  assert.equal(sessions, 0);
});

test("cleanup records complete ID-level outcomes and refuses identity mismatches", async (t) => {
  const root = await temporaryProject(t);
  const backupPath = join(root, "source-backup.db");
  const exportPath = join(root, "source-export.json");
  const exportText = JSON.stringify([lifecycleRecord()]);
  await writeFile(backupPath, "backup");
  await writeFile(exportPath, exportText);
  const fake = fakeClient();
  const migration = await migrateVestige(root, {
    client: fake.client,
    mcpSession: migrationMcp(backupPath, exportPath, exportText, []),
    now: () => new Date("2026-08-26T21:42:00.000Z"),
  });
  const outcome = migration.report.outcomes[0];
  fake.client.getInstitutional = async () => success({
    ...fake.records.get(outcome.recordKey),
    contentHash: "a".repeat(64),
  });
  const deleted = [];
  const result = await cleanupVestige(root, { reportPath: migration.artifactPath, confirm: true }, {
    client: fake.client,
    mcpSession: async (_server, callback) => callback(async (name, args) => {
      deleted.push({ name, args });
      return response({ deleted: true });
    }),
    now: () => new Date("2026-08-26T21:43:00.000Z"),
  });

  assert.equal(result.purged, 0);
  assert.equal(result.retained, 1);
  assert.deepEqual(deleted, []);
  const cleanup = JSON.parse(await readFile(join(root, result.reportPath), "utf8"));
  assert.deepEqual(cleanup.purgedIds, []);
  assert.deepEqual(cleanup.retained, [{ vestigeId: lifecycleId, reason: "qdrant_unverified" }]);
});

test("cleanup requires positive Vestige acknowledgement and confirms every retained reason", async (t) => {
  const root = await temporaryProject(t);
  const backupPath = join(root, "source-backup.db");
  const exportPath = join(root, "source-export.json");
  const exportText = JSON.stringify([lifecycleRecord()]);
  await writeFile(backupPath, "backup");
  await writeFile(exportPath, exportText);
  const fake = fakeClient();
  const migration = await migrateVestige(root, {
    client: fake.client,
    mcpSession: migrationMcp(backupPath, exportPath, exportText, []),
    now: () => new Date("2026-08-26T21:44:00.000Z"),
  });
  await writeFile(
    join(root, ".ima", "vestige-migrate", "2026-08-26T21-44-00-000Z", "cleanup-2026-08-26T21-45-00-000Z.json"),
    "collision",
  );
  let collisionCalls = 0;
  await assert.rejects(
    cleanupVestige(root, { reportPath: migration.artifactPath, confirm: true }, {
      client: fake.client,
      mcpSession: async () => { collisionCalls += 1; return null; },
      now: () => new Date("2026-08-26T21:45:00.000Z"),
    }),
    /artifact_unavailable/,
  );
  assert.equal(collisionCalls, 0);

  for (const acknowledgement of [{ deleted: false }, {}]) {
    const result = await cleanupVestige(root, { reportPath: migration.artifactPath, confirm: true }, {
      client: fake.client,
      mcpSession: async (_server, callback) => callback(async () => response(acknowledgement)),
      now: () => new Date(`2026-08-26T21:4${acknowledgement.deleted === false ? "7" : "8"}:00.000Z`),
    });
    assert.equal(result.purged, 0);
    assert.equal(result.retained, 1);
  }
});

test("artifact helpers reject symlink paths and timestamp collisions", async (t) => {
  const root = await temporaryProject(t);
  const outside = await mkdtemp(join(tmpdir(), "ima-pi-vestige-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, ".ima"));
  await assert.rejects(createMigrationArtifactRun(root, "2026-08-26T21-50-00-000Z"), /artifact_directory_invalid/);

  await rm(join(root, ".ima"), { recursive: true, force: true });
  const run = await createMigrationArtifactRun(root, "2026-08-26T21-50-00-000Z");
  await assert.rejects(createMigrationArtifactRun(root, "2026-08-26T21-50-00-000Z"), /artifact_run_collision/);
  const source = join(root, "source.db");
  await writeFile(source, "backup");
  const link = join(root, "source-link.db");
  await symlink(source, link);
  await assert.rejects(
    copyVerifiedArtifact({ sourcePath: link, run, destinationName: "backup.sqlite", maximumBytes: MAX_BACKUP_FILE_BYTES }),
    /artifact_source_invalid/,
  );
  await writeExclusiveText({ directory: run.directory, name: "report.json", content: "{}", maximumBytes: 100 });
  await assert.rejects(
    writeExclusiveText({ directory: run.directory, name: "report.json", content: "{}", maximumBytes: 100 }),
    /EEXIST|artifact_/,
  );
  const reservationAbort = new AbortController();
  let deletes = 0;
  await assert.rejects(withReservedExclusiveText({
    directory: run.directory, name: "cleanup.json", maximumBytes: 100, signal: reservationAbort.signal,
    operation: async () => { reservationAbort.abort(); reservationAbort.signal.throwIfAborted(); deletes += 1; },
  }), /abort/i);
  assert.equal(deletes, 0);
  await writeExclusiveText({ directory: run.directory, name: "cleanup.json", content: "{}", maximumBytes: 100 });
});

test("cancellation reaches snapshot and cleanup boundaries without normal reports", async (t) => {
  const root = await temporaryProject(t);
  const backupPath = join(root, "source-backup.db");
  const exportPath = join(root, "source-export.json");
  const exportText = JSON.stringify([lifecycleRecord()]);
  await writeFile(backupPath, "backup");
  await writeFile(exportPath, exportText);
  const fake = fakeClient({ collection: "ready" });
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    createMigrationArtifactRun(root, "2026-08-26T21-50-30-000Z", preAborted.signal),
    /abort/i,
  );
  const controller = new AbortController();
  let snapshotSignal;

  await assert.rejects(
    migrateVestige(root, {
      client: fake.client,
      createSnapshot: async (signal) => {
        snapshotSignal = signal;
        controller.abort();
        signal?.throwIfAborted();
        return success({ name: "snapshot.snapshot" });
      },
      mcpSession: migrationMcp(backupPath, exportPath, exportText, []),
      now: () => new Date("2026-08-26T21:51:00.000Z"),
    }, controller.signal),
    /abort/i,
  );
  assert.equal(snapshotSignal, controller.signal);

  const cleanupClient = fakeClient();
  const migration = await migrateVestige(root, {
    client: cleanupClient.client,
    mcpSession: migrationMcp(backupPath, exportPath, exportText, []),
    now: () => new Date("2026-08-26T21:52:00.000Z"),
  });
  const cleanupAbort = new AbortController();
  cleanupClient.client.getInstitutional = async (recordKey) => {
    cleanupAbort.abort();
    return success(cleanupClient.records.get(recordKey));
  };
  let cleanupMcpCalls = 0;
  await assert.rejects(
    cleanupVestige(root, { reportPath: migration.artifactPath, confirm: true }, {
      client: cleanupClient.client,
      mcpSession: async (_server, callback) => callback(async () => { cleanupMcpCalls += 1; return response({ deleted: true }); }),
    }, cleanupAbort.signal),
    /abort/i,
  );
  assert.equal(cleanupMcpCalls, 0);
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
  assert.deepEqual(result, success({ name: "snapshot-1.snapshot" }));
  assert.deepEqual(calls, [{ path: "/collections/ima-institutional-memory/snapshots", method: "POST" }]);
});

test("cleanup schema is provider-compatible but runtime confirmation remains fail-closed", async () => {
  const tools = [];
  registerVestigeMigrateTools({ registerTool: (tool) => tools.push(tool) });
  assert.equal(Check(tools[1].parameters, { reportPath: ".ima/report.json", confirm: true }), true);
  assert.equal(Check(tools[1].parameters, { reportPath: ".ima/report.json", confirm: false }), true);

  let effects = 0;
  await assert.rejects(
    cleanupVestige("/unused", { reportPath: ".ima/report.json", confirm: false }, {
      client: {},
      mcpSession: async () => { effects += 1; return null; },
    }),
    /cleanup_confirmation_required/,
  );
  assert.equal(effects, 0);
});

test("strict reports use one writer-reader bound", () => {
  const classification = classifyVestigeExport([lifecycleRecord()]);
  const candidate = classification.lifecycle[0];
  const report = buildMigrationReport({
    classification,
    outcomes: [{
      vestigeId: candidate.vestigeId,
      id: candidate.expected.id,
      recordKey: candidate.expected.recordKey,
      lifecycleKey: candidate.expected.lifecycleKey,
      phase: candidate.expected.phase,
      contentHash: candidate.expected.contentHash,
      status: "migrated",
    }],
    recovery: {
      backup: { relativePath: "vestige-backup.sqlite", sizeBytes: 6, sha256: "a".repeat(64) },
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
