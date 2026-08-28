import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import { cleanupVestige, dryRunVestige, registerVestigeMigrateTools } from "../extensions/vestige-migrate.ts";
import { corpusFailure } from "../lib/qdrant-corpus.ts";
import {
  MAX_BACKUP_FILE_BYTES,
  MAX_EXPORT_FILE_BYTES,
} from "../lib/vestige-migrate-artifacts.ts";
import { requiredMigrationMutations } from "../lib/vestige-migrate-dry-run.ts";
import { parseDryRunReport } from "../lib/vestige-migrate-dry-run-report.ts";
import {
  corpusPrerequisites,
  fakeClient,
  lifecycleRecord,
  migrationCli,
  retainedId,
  temporaryProject,
} from "./vestige-migrate-fixtures.js";

const MAX_EXPECTED_DRY_RUN_COUNT = 100_000;

const checksByName = (report) => Object.fromEntries(
  report.checks.map((check) => [check.name, check]),
);

const effectCounters = () => ({
  preflight: 0,
  status: 0,
  snapshot: 0,
  ensure: 0,
  embed: 0,
  insert: 0,
  destinationGet: 0,
  session: 0,
});

const countedClient = (counters, collection = "absent") => {
  const fake = fakeClient({ collection });
  const preflight = fake.client.preflight;
  fake.client.preflight = async () => {
    counters.preflight += 1;
    return preflight();
  };
  fake.client.status = async () => {
    counters.status += 1;
    return { success: true, data: { status: "ready", qdrantVersion: "1.17.1", collection, missingIndexes: [] } };
  };
  fake.client.ensureCollection = async () => {
    counters.ensure += 1;
    return { success: true, data: {} };
  };
  fake.client.embedSummary = async () => {
    counters.embed += 1;
    return { success: true, data: [] };
  };
  fake.client.insertPoint = async () => {
    counters.insert += 1;
    return { success: true, data: undefined };
  };
  fake.client.getInstitutional = async () => {
    counters.destinationGet += 1;
    return { success: true, data: {} };
  };
  return fake.client;
};

test("dry run writes a bounded checklist while excluding all destination and Vestige mutations", async (t) => {
  const root = await temporaryProject(t);
  const counters = effectCounters();
  const calls = [];
  const client = countedClient(counters);
  const result = await dryRunVestige(root, {
    client,
    createSnapshot: async () => {
      counters.snapshot += 1;
      return { success: true, data: { name: "must-not-exist.snapshot" } };
    },
    mcpSession: async () => {
      counters.session += 1;
      return null;
    },
    ...migrationCli("backup", JSON.stringify([
      lifecycleRecord(),
      { id: retainedId, content: "User prefers this setting.", createdAt: "2026-08-26T21:33:02.576436343+00:00" },
    ]), calls),
    now: () => new Date("2026-08-28T01:00:00.000Z"),
  });

  const checks = checksByName(result.report);
  assert.equal(result.report.outcome, "READY");
  assert.deepEqual(result.report.summary, {
    institutionalSources: 1,
    destinationRecords: 1,
    retainedPreferences: 1,
    quarantined: 0,
    redacted: 1,
  });
  assert.deepEqual(result.report.checks.map((check) => check.name), [
    "endpoint_configuration",
    "qdrant_service_and_version",
    "ollama_embedding_model",
    "institutional_collection",
    "artifact_run_directory",
    "vestige_sqlite_backup",
    "vestige_json_export",
    "export_validation",
    "classification_and_redaction",
    "migration_mutations",
  ]);
  assert.equal(result.report.checks.slice(0, -1).every((check) => check.status === "PASS"), true);
  assert.equal(checks.migration_mutations.status, "SKIP");
  assert.deepEqual(result.report.requiredMigrationMutations, [
    "create_institutional_collection",
    "create_missing_indexes",
    "embed_summaries",
    "store_and_verify_records",
  ]);
  assert.deepEqual(counters, {
    preflight: 1,
    status: 0,
    snapshot: 0,
    ensure: 0,
    embed: 0,
    insert: 0,
    destinationGet: 0,
    session: 0,
  });
  assert.deepEqual(calls.map((call) => call.command), ["backup", "export"]);
  assert.equal(result.artifactPath.endsWith("dry-run-report.json"), true);

  const artifact = JSON.parse(await readFile(join(root, result.artifactPath), "utf8"));
  assert.deepEqual(parseDryRunReport(artifact), result.report);
  assert.equal(parseDryRunReport({
    ...artifact,
    requiredMigrationMutations: [...artifact.requiredMigrationMutations, "create_snapshot"],
  }), null);
  assert.equal(parseDryRunReport({ ...artifact, summary: null }), null);

  const backupAtLimit = {
    ...artifact,
    recovery: {
      ...artifact.recovery,
      backup: { ...artifact.recovery.backup, sizeBytes: MAX_BACKUP_FILE_BYTES },
    },
  };
  assert.ok(parseDryRunReport(backupAtLimit));
  assert.equal(parseDryRunReport({
    ...backupAtLimit,
    recovery: {
      ...backupAtLimit.recovery,
      backup: { ...backupAtLimit.recovery.backup, sizeBytes: MAX_BACKUP_FILE_BYTES + 1 },
    },
  }), null);

  const exportAtLimit = {
    ...artifact,
    recovery: {
      ...artifact.recovery,
      export: { ...artifact.recovery.export, sizeBytes: MAX_EXPORT_FILE_BYTES },
    },
  };
  assert.ok(parseDryRunReport(exportAtLimit));
  assert.equal(parseDryRunReport({
    ...exportAtLimit,
    recovery: {
      ...exportAtLimit.recovery,
      export: { ...exportAtLimit.recovery.export, sizeBytes: MAX_EXPORT_FILE_BYTES + 1 },
    },
  }), null);

  const countAtLimit = {
    ...artifact,
    summary: {
      ...artifact.summary,
      institutionalSources: MAX_EXPECTED_DRY_RUN_COUNT,
    },
  };
  assert.ok(parseDryRunReport(countAtLimit));
  assert.equal(parseDryRunReport({
    ...countAtLimit,
    summary: {
      ...countAtLimit.summary,
      institutionalSources: MAX_EXPECTED_DRY_RUN_COUNT + 1,
    },
  }), null);

  await assert.rejects(
    cleanupVestige(root, { reportPath: result.artifactPath, confirm: true }, {
      client,
      mcpSession: async () => {
        counters.session += 1;
        return null;
      },
    }),
    /artifact_unavailable/,
  );
  assert.equal(counters.destinationGet, 0);
  assert.equal(counters.session, 0);
});

test("required dry-run mutations match the actual collection-state snapshot policy", () => {
  assert.deepEqual(requiredMigrationMutations("absent", 1), [
    "create_institutional_collection",
    "create_missing_indexes",
    "embed_summaries",
    "store_and_verify_records",
  ]);
  for (const collection of ["needs_indexes", "ready"]) {
    assert.equal(requiredMigrationMutations(collection, 1).includes("create_snapshot"), true);
  }
  assert.deepEqual(requiredMigrationMutations("absent", 0), []);
});

test("dry run does not predict migration mutations for a preferences-only export", async (t) => {
  const root = await temporaryProject(t);
  const counters = effectCounters();
  const result = await dryRunVestige(root, {
    client: countedClient(counters),
    ...migrationCli("backup", JSON.stringify([
      { id: retainedId, content: "User prefers dry-run safety.", createdAt: "2026-08-26T21:33:02.576436343+00:00" },
    ])),
    now: () => new Date("2026-08-28T01:00:30.000Z"),
  });

  assert.equal(result.report.outcome, "READY");
  assert.equal(result.report.summary?.institutionalSources, 0);
  assert.deepEqual(result.report.requiredMigrationMutations, []);
  assert.equal(counters.ensure, 0);
  assert.equal(counters.destinationGet, 0);
});

test("dry run records a Qdrant timeout but continues independent local preparation", async (t) => {
  const root = await temporaryProject(t);
  const counters = effectCounters();
  const calls = [];
  const client = countedClient(counters, "ready");
  client.preflight = async () => {
    counters.preflight += 1;
    const prerequisites = corpusPrerequisites("ready");
    return {
      success: true,
      data: {
        ...prerequisites.data,
        qdrantServiceAndVersion: corpusFailure("qdrant_unavailable", {
          operation: "qdrant_version",
          cause: "timeout",
        }),
      },
    };
  };

  const result = await dryRunVestige(root, {
    client,
    ...migrationCli("backup", JSON.stringify([lifecycleRecord()]), calls),
    now: () => new Date("2026-08-28T01:01:00.000Z"),
  });

  const checks = checksByName(result.report);
  assert.equal(result.report.outcome, "NOT_READY");
  assert.deepEqual(checks.qdrant_service_and_version, {
    name: "qdrant_service_and_version",
    status: "FAIL",
    code: "qdrant_unavailable",
    message: "Qdrant service and version failed: qdrant_unavailable; operation=qdrant_version; cause=timeout.",
  });
  assert.equal(checks.ollama_embedding_model.status, "PASS");
  assert.equal(checks.institutional_collection.status, "PASS");
  assert.equal(checks.vestige_sqlite_backup.status, "PASS");
  assert.equal(checks.vestige_json_export.status, "PASS");
  assert.equal(checks.classification_and_redaction.status, "PASS");
  assert.deepEqual(calls.map((call) => call.command), ["backup", "export"]);
});

test("dry run blocks only export-dependent stages after a safe export failure", async (t) => {
  const root = await temporaryProject(t);
  const counters = effectCounters();
  const client = countedClient(counters, "ready");
  const result = await dryRunVestige(root, {
    client,
    runVestigeBackup: migrationCli("backup", "[]").runVestigeBackup,
    runVestigeExport: async () => { throw new Error("export-secret"); },
    now: () => new Date("2026-08-28T01:02:00.000Z"),
  });

  const checks = checksByName(result.report);
  assert.equal(result.report.outcome, "NOT_READY");
  assert.equal(checks.vestige_sqlite_backup.status, "PASS");
  assert.equal(checks.vestige_json_export.status, "FAIL");
  assert.equal(checks.export_validation.status, "BLOCKED");
  assert.equal(checks.classification_and_redaction.status, "BLOCKED");
  assert.equal(result.report.summary, null);
  assert.equal(result.report.recovery.backup?.relativePath, "vestige-backup.sqlite");
  assert.equal(result.report.recovery.export, undefined);
  assert.doesNotMatch(JSON.stringify(result.report), /export-secret/);
});

test("unexpected corpus client exceptions retain only safe migration diagnostic context", async (t) => {
  const root = await temporaryProject(t);
  const secret = "client-exception-secret";
  await assert.rejects(
    dryRunVestige(root, {
      client: {
        preflight: async () => { throw new Error(secret); },
      },
    }),
    (error) => {
      assert.match(error.message, /qdrant_unavailable; operation=qdrant_version; cause=client_exception/);
      assert.doesNotMatch(error.message, /client-exception-secret/);
      return true;
    },
  );
});

test("abort races rethrow the supplied cancellation reason without provider text", async (t) => {
  const preflightController = new AbortController();
  const preflightReason = new Error("preflight-cancelled");
  const preflightSecret = "preflight-provider-secret";
  await assert.rejects(
    dryRunVestige("/unused", {
      client: {
        preflight: async () => {
          preflightController.abort(preflightReason);
          throw new Error(preflightSecret);
        },
      },
    }, preflightController.signal),
    (error) => {
      assert.equal(error, preflightReason);
      assert.doesNotMatch(error.message, /preflight-provider-secret/);
      return true;
    },
  );

  const root = await temporaryProject(t);
  const backupController = new AbortController();
  const backupReason = new Error("backup-cancelled");
  const backupSecret = "backup-provider-secret";
  let exports = 0;
  await assert.rejects(
    dryRunVestige(root, {
      client: countedClient(effectCounters()),
      runVestigeBackup: async () => {
        backupController.abort(backupReason);
        throw new Error(backupSecret);
      },
      runVestigeExport: async () => { exports += 1; },
      now: () => new Date("2026-08-28T01:02:30.000Z"),
    }, backupController.signal),
    (error) => {
      assert.equal(error, backupReason);
      assert.doesNotMatch(error.message, /backup-provider-secret/);
      return true;
    },
  );
  assert.equal(exports, 0);
  await assert.rejects(readFile(join(
    root,
    ".ima",
    "vestige-migrate",
    "2026-08-28T01-02-30-000Z",
    "dry-run-report.json",
  )));
});

test("migration tool requires explicit live confirmation and dispatches dry runs safely", async (t) => {
  const root = await temporaryProject(t);
  const tools = [];
  const counters = effectCounters();
  const client = countedClient(counters);
  registerVestigeMigrateTools({ registerTool: (tool) => tools.push(tool) }, {
    client,
    ...migrationCli("backup", JSON.stringify([lifecycleRecord()])),
    now: () => new Date("2026-08-28T01:03:00.000Z"),
  });
  const migrate = tools.find((tool) => tool.name === "ima_vestige_migrate");
  assert.ok(migrate);
  assert.equal(Check(migrate.parameters, {}), true);
  assert.equal(Check(migrate.parameters, { dryRun: false }), true);
  assert.equal(Check(migrate.parameters, { dryRun: true }), true);
  assert.equal(Check(migrate.parameters, { confirm: false }), true);
  assert.equal(Check(migrate.parameters, { confirm: true }), true);
  assert.equal(Check(migrate.parameters, { dryRun: true, confirm: true }), true);
  assert.equal(Check(migrate.parameters, { dryRun: "true" }), false);
  assert.equal(Check(migrate.parameters, { unknown: true }), false);

  for (const [request, code] of [
    [{}, "migration_confirmation_required"],
    [{ dryRun: false }, "migration_confirmation_required"],
    [{ confirm: false }, "migration_confirmation_required"],
    [{ dryRun: true, confirm: true }, "migration_request_invalid"],
    [{ unknown: true }, "migration_request_invalid"],
  ]) {
    await assert.rejects(
      migrate.execute("invalid", request, undefined, () => {}, { cwd: root }),
      new RegExp(code),
    );
  }
  assert.deepEqual(counters, {
    preflight: 0,
    status: 0,
    snapshot: 0,
    ensure: 0,
    embed: 0,
    insert: 0,
    destinationGet: 0,
    session: 0,
  });

  const dryRun = await migrate.execute("dry-run", { dryRun: true }, undefined, () => {}, { cwd: root });
  assert.equal(dryRun.details.outcome, "READY");
  assert.equal(dryRun.details.artifactPath.endsWith("dry-run-report.json"), true);
  assert.equal(counters.ensure, 0);

  const liveRoot = await temporaryProject(t);
  const live = await migrate.execute("live", { confirm: true }, undefined, () => {}, { cwd: liveRoot });
  assert.equal(live.details.artifactPath.endsWith("report.json"), true);
  assert.equal(counters.ensure > 0, true);
});
