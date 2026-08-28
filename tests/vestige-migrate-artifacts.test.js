import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_BACKUP_FILE_BYTES,
  copyVerifiedArtifact,
  createMigrationArtifactRun,
  hashReadableSqliteFile,
  verifyRecoveryReceipt,
  withReservedExclusiveText,
  writeExclusiveText,
} from "../lib/vestige-migrate-artifacts.ts";
import { vestigeArgs } from "../lib/vestige-cli.ts";
import { migrateVestige } from "../extensions/vestige-migrate.ts";
import {
  fakeClient,
  lifecycleRecord,
  sqliteBackup,
  temporaryProject,
} from "./vestige-migrate-fixtures.js";

test("vestige CLI arguments target a direct output file", () => {
  assert.deepEqual(
    vestigeArgs({
      command: "backup",
      outputPath: "/tmp/vestige-backup.sqlite",
      dataDir: "/tmp/vestige-data",
    }),
    ["backup", "/tmp/vestige-backup.sqlite", "--data-dir", "/tmp/vestige-data"],
  );
  assert.deepEqual(
    vestigeArgs({ command: "export", outputPath: "/tmp/vestige-export.json" }),
    ["export", "/tmp/vestige-export.json", "--format", "json"],
  );
});

test("migration fails closed when direct CLI artifacts are unavailable", async (t) => {
  const failures = [
    ["backup", "backup_unavailable"],
    ["export", "export_unavailable"],
  ];

  for (const [unavailableArtifact, errorCode] of failures) {
    const root = await temporaryProject(t);
    const fake = fakeClient();
    await assert.rejects(
      migrateVestige(root, {
        client: fake.client,
        runVestigeBackup: async ({ outputPath }) => {
          if (unavailableArtifact === "backup") throw new Error("unavailable");
          await writeFile(outputPath, sqliteBackup());
        },
        runVestigeExport: async ({ outputPath }) => {
          if (unavailableArtifact === "export") throw new Error("unavailable");
          await writeFile(outputPath, JSON.stringify([lifecycleRecord()]));
        },
        now: () => new Date("2026-08-26T21:39:30.000Z"),
      }),
      new RegExp(errorCode),
    );
  }
});

test("migration rejects invalid SQLite backups before export or Qdrant effects", async (t) => {
  for (const backup of [Buffer.alloc(0), Buffer.from("not a SQLite database"), sqliteBackup().subarray(0, 99)]) {
    const root = await temporaryProject(t);
    const fake = fakeClient();
    let exports = 0;
    await assert.rejects(
      migrateVestige(root, {
        client: fake.client,
        runVestigeBackup: async ({ outputPath }) => writeFile(outputPath, backup),
        runVestigeExport: async ({ outputPath }) => {
          exports += 1;
          await writeFile(outputPath, JSON.stringify([lifecycleRecord()]));
        },
        now: () => new Date("2026-08-26T21:39:31.000Z"),
      }),
      /backup_unavailable/,
    );
    assert.equal(exports, 0);
    assert.equal(fake.records.size, 0);
  }
});

test("SQLite recovery verification rejects a changed backup", async (t) => {
  const root = await temporaryProject(t);
  const path = join(root, "vestige-backup.sqlite");
  await writeFile(path, sqliteBackup());
  const receipt = await hashReadableSqliteFile(path, MAX_BACKUP_FILE_BYTES);
  const changed = sqliteBackup();
  changed[20] = 1;
  await writeFile(path, changed);

  assert.equal(await verifyRecoveryReceipt({
    reportDirectory: root,
    receipt: { relativePath: "vestige-backup.sqlite", ...receipt },
    maximumBytes: MAX_BACKUP_FILE_BYTES,
    hashFile: hashReadableSqliteFile,
  }), false);
});

test("migration fails closed when direct CLI output is a symlink", async (t) => {
  const root = await temporaryProject(t);
  const outside = join(root, "outside-backup.sqlite");
  await writeFile(outside, sqliteBackup());
  const fake = fakeClient();
  let exports = 0;

  await assert.rejects(
    migrateVestige(root, {
      client: fake.client,
      runVestigeBackup: async ({ outputPath }) => symlink(outside, outputPath),
      runVestigeExport: async ({ outputPath }) => {
        exports += 1;
        await writeFile(outputPath, JSON.stringify([lifecycleRecord()]));
      },
      now: () => new Date("2026-08-26T21:39:45.000Z"),
    }),
    /backup_unavailable/,
  );

  assert.equal(exports, 0);
  assert.equal(fake.records.size, 0);
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
    directory: run.directory,
    name: "cleanup.json",
    maximumBytes: 100,
    signal: reservationAbort.signal,
    operation: async () => {
      reservationAbort.abort();
      reservationAbort.signal.throwIfAborted();
      deletes += 1;
    },
  }), /abort/i);
  assert.equal(deletes, 0);
  await writeExclusiveText({ directory: run.directory, name: "cleanup.json", content: "{}", maximumBytes: 100 });
});
