import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import { createMigrationArtifactRun } from "../lib/vestige-migrate-artifacts.ts";
import { vestigePurgeAcknowledged } from "../lib/vestige-migrate.ts";
import { cleanupVestige, migrateVestige, registerVestigeMigrateTools } from "../extensions/vestige-migrate.ts";
import {
  createdAt,
  fakeClient,
  lifecycleId,
  lifecycleRecord,
  migrationCli,
  purgeReceipt,
  readReport,
  retainedId,
  response,
  temporaryProject,
} from "./vestige-migrate-fixtures.js";

test("vestigePurgeAcknowledged requires an identity-bound purge receipt", () => {
  const receipt = {
    action: "purge",
    success: true,
    nodeId: ` ${lifecycleId.toUpperCase()} `,
    deletedAt: "2026-08-28T00:00:00.000Z",
  };
  const missingDeletedAt = {
    action: receipt.action,
    success: receipt.success,
    nodeId: receipt.nodeId,
  };

  assert.equal(vestigePurgeAcknowledged(receipt, lifecycleId), true);
  for (const invalid of [
    { ...receipt, action: "delete" },
    { ...receipt, success: false },
    { ...receipt, nodeId: retainedId },
    { ...receipt, deletedAt: " " },
    missingDeletedAt,
    null,
  ]) {
    assert.equal(vestigePurgeAcknowledged(invalid, lifecycleId), false);
  }
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

  const exportText = JSON.stringify([lifecycleRecord()]);
  const fake = fakeClient();
  const migration = await migrateVestige(root, {
    client: fake.client,
    ...migrationCli("backup", exportText),
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
  const exportText = JSON.stringify([lifecycleRecord()]);
  const fake = fakeClient();
  const migration = await migrateVestige(root, {
    client: fake.client,
    ...migrationCli("backup", exportText),
    now: () => new Date("2026-08-26T21:42:00.000Z"),
  });
  const outcome = migration.report.outcomes[0].records[0];
  fake.client.getInstitutional = async () => ({
    success: true,
    data: {
      ...fake.records.get(outcome.recordKey),
      contentHash: "a".repeat(64),
    },
  });
  const deleted = [];
  const result = await cleanupVestige(root, { reportPath: migration.artifactPath, confirm: true }, {
    client: fake.client,
    mcpSession: async (_server, callback) => callback(async (name, args) => {
      deleted.push({ name, args });
      return purgeReceipt(args.id);
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

test("cleanup retains every non-acknowledged Vestige purge receipt", async (t) => {
  const root = await temporaryProject(t);
  const exportText = JSON.stringify([lifecycleRecord()]);
  const fake = fakeClient();
  const migration = await migrateVestige(root, {
    client: fake.client,
    ...migrationCli("backup", exportText),
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

  const acknowledgements = [
    { label: "legacy deleted flag", reply: response({ deleted: false }) },
    { label: "empty response", reply: response({}) },
    { label: "already absent", reply: purgeReceipt(lifecycleId, { success: false }) },
    { label: "mismatched node", reply: purgeReceipt(retainedId) },
    { label: "missing deletion time", reply: purgeReceipt(lifecycleId, { deletedAt: undefined }) },
  ];
  for (const [index, acknowledgement] of acknowledgements.entries()) {
    const calls = [];
    const result = await cleanupVestige(root, { reportPath: migration.artifactPath, confirm: true }, {
      client: fake.client,
      mcpSession: async (_server, callback) => callback(async (name, args) => {
        calls.push({ name, args });
        return acknowledgement.reply;
      }),
      now: () => new Date(`2026-08-26T21:${String(47 + index).padStart(2, "0")}:00.000Z`),
    });
    assert.equal(result.purged, 0, acknowledgement.label);
    assert.equal(result.retained, 1, acknowledgement.label);
    assert.deepEqual(
      calls.map(({ name, args }) => ({ name, action: args.action, id: args.id, confirm: args.confirm })),
      [{ name: "memory", action: "purge", id: lifecycleId, confirm: true }],
    );
    const cleanup = JSON.parse(await readFile(join(root, result.reportPath), "utf8"));
    assert.deepEqual(cleanup.retained, [{ vestigeId: lifecycleId, reason: "vestige_negative_ack" }]);
  }
});

test("cleanup removes a short outer-whitespace source after normalized verification", async (t) => {
  const root = await temporaryProject(t);
  const sourceId = "55555555-5555-4555-8555-555555555555";
  const fake = fakeClient();
  const migration = await migrateVestige(root, {
    client: fake.client,
    ...migrationCli("backup", JSON.stringify([{ id: sourceId, content: "\nInstitutional note.\n", createdAt }])),
    now: () => new Date("2026-08-26T21:46:00.000Z"),
  });
  const deleted = [];
  const actions = [];
  const cleanup = await cleanupVestige(root, { reportPath: migration.artifactPath, confirm: true }, {
    client: fake.client,
    mcpSession: async (_server, callback) => callback(async (name, args) => {
      actions.push({ name, action: args.action });
      deleted.push(args.id);
      return purgeReceipt(args.id);
    }),
    now: () => new Date("2026-08-26T21:47:00.000Z"),
  });

  assert.equal(cleanup.purged, 1);
  assert.equal(cleanup.retained, 0);
  assert.deepEqual(deleted, [sourceId]);
  assert.deepEqual(actions, [{ name: "memory", action: "purge" }]);
});

test("cleanup removes an idempotently unchanged single-record source", async (t) => {
  const root = await temporaryProject(t);
  const exportText = JSON.stringify([lifecycleRecord()]);
  const fake = fakeClient();
  let migrationMinute = 0;
  const dependencies = {
    client: fake.client,
    createSnapshot: async () => ({ success: true, data: { name: "snapshot.snapshot" } }),
    ...migrationCli("backup", exportText),
    now: () => new Date(`2026-08-28T00:${String(migrationMinute++).padStart(2, "0")}:00.000Z`),
  };
  const first = await migrateVestige(root, dependencies);
  const second = await migrateVestige(root, dependencies);
  assert.equal(first.report.outcomes[0].status, "migrated");
  assert.equal(second.report.outcomes[0].status, "unchanged");

  const deleted = [];
  const actions = [];
  const cleanup = await cleanupVestige(root, { reportPath: second.artifactPath, confirm: true }, {
    client: fake.client,
    mcpSession: async (_server, callback) => callback(async (name, args) => {
      actions.push({ name, action: args.action });
      deleted.push(args.id);
      return purgeReceipt(args.id);
    }),
    now: () => new Date("2026-08-28T00:02:00.000Z"),
  });

  assert.equal(cleanup.purged, 1);
  assert.equal(cleanup.retained, 0);
  assert.deepEqual(deleted, [lifecycleId]);
  assert.deepEqual(actions, [{ name: "memory", action: "purge" }]);
});

test("cancellation reaches snapshot and cleanup boundaries without normal reports", async (t) => {
  const root = await temporaryProject(t);
  const exportText = JSON.stringify([lifecycleRecord()]);
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
        return { success: true, data: { name: "snapshot.snapshot" } };
      },
      ...migrationCli("backup", exportText),
      now: () => new Date("2026-08-26T21:51:00.000Z"),
    }, controller.signal),
    /abort/i,
  );
  assert.equal(snapshotSignal, controller.signal);

  const cleanupClient = fakeClient();
  const migration = await migrateVestige(root, {
    client: cleanupClient.client,
    ...migrationCli("backup", exportText),
    now: () => new Date("2026-08-26T21:52:00.000Z"),
  });
  const cleanupAbort = new AbortController();
  cleanupClient.client.getInstitutional = async (recordKey) => {
    cleanupAbort.abort();
    return { success: true, data: cleanupClient.records.get(recordKey) };
  };
  let cleanupMcpCalls = 0;
  await assert.rejects(
    cleanupVestige(root, { reportPath: migration.artifactPath, confirm: true }, {
      client: cleanupClient.client,
      mcpSession: async (_server, callback) => callback(async () => {
        cleanupMcpCalls += 1;
        return purgeReceipt(lifecycleId);
      }),
    }, cleanupAbort.signal),
    /abort/i,
  );
  assert.equal(cleanupMcpCalls, 0);
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
