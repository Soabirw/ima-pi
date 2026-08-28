import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { registerVestigeMigrateTools } from "../extensions/vestige-migrate.ts";
import { withVestigeMigrationLock } from "../lib/vestige-migrate-lock.ts";
import {
  createdAt,
  retainedId,
  sqliteBackup,
  success,
  temporaryProject,
} from "./vestige-migrate-fixtures.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
};

test("migration lock fails closed while held, releases on settlement, and preserves stale locks", async (t) => {
  const root = await temporaryProject(t);
  const lockPath = join(root, "locks", "vestige-migrate.lock");
  const entered = deferred();
  const release = deferred();
  const first = withVestigeMigrationLock(async () => {
    entered.resolve();
    await release.promise;
    return "first";
  }, { lockPath });
  await entered.promise;

  await assert.rejects(
    withVestigeMigrationLock(async () => "second", { lockPath }),
    /migration lock in_progress/,
  );
  release.resolve();
  assert.equal(await first, "first");
  assert.equal(await withVestigeMigrationLock(async () => "released", { lockPath }), "released");

  await assert.rejects(
    withVestigeMigrationLock(async () => { throw new Error("expected"); }, { lockPath }),
    /expected/,
  );
  assert.equal(await withVestigeMigrationLock(async () => "error-released", { lockPath }), "error-released");

  const controller = new AbortController();
  await assert.rejects(
    withVestigeMigrationLock(async () => {
      controller.abort();
      controller.signal.throwIfAborted();
    }, { lockPath, signal: controller.signal }),
    /abort/i,
  );
  assert.equal(await withVestigeMigrationLock(async () => "cancel-released", { lockPath }), "cancel-released");

  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, "stale");
  await assert.rejects(
    withVestigeMigrationLock(async () => "never", { lockPath }),
    /migration lock in_progress/,
  );
  await rm(lockPath);
});

test("registered tools serialize shared Vestige/Qdrant operations before project queues", async (t) => {
  const rootA = await temporaryProject(t);
  const rootB = await temporaryProject(t);
  const lockPath = join(rootA, "shared", "vestige-migrate.lock");
  const tools = [];
  const statusStarted = deferred();
  const releaseStatus = deferred();
  let statusCalls = 0;
  let backups = 0;
  let exports = 0;
  const dependencies = {
    migrationLockPath: lockPath,
    client: {
      status: async () => {
        statusCalls += 1;
        if (statusCalls === 1) {
          statusStarted.resolve();
          await releaseStatus.promise;
        }
        return success({ status: "ready", qdrantVersion: "1.17.1", collection: "ready", missingIndexes: [] });
      },
    },
    runVestigeBackup: async ({ outputPath }) => {
      backups += 1;
      await writeFile(outputPath, sqliteBackup());
    },
    runVestigeExport: async ({ outputPath }) => {
      exports += 1;
      await writeFile(outputPath, JSON.stringify([{ id: retainedId, content: "User prefers lock safety.", createdAt }]));
    },
    now: () => new Date("2026-08-28T00:00:00.000Z"),
  };
  registerVestigeMigrateTools({ registerTool: (tool) => tools.push(tool) }, dependencies);
  const migrate = tools.find((tool) => tool.name === "ima_vestige_migrate");
  const cleanup = tools.find((tool) => tool.name === "ima_vestige_cleanup");
  assert.ok(migrate);
  assert.ok(cleanup);

  const first = migrate.execute("first", {}, undefined, () => {}, { cwd: rootA });
  await statusStarted.promise;
  await assert.rejects(
    migrate.execute("second", {}, undefined, () => {}, { cwd: rootB }),
    /migration lock in_progress/,
  );
  await assert.rejects(
    cleanup.execute("cleanup", { reportPath: ".ima/report.json", confirm: false }, undefined, () => {}, { cwd: rootB }),
    /migration lock in_progress/,
  );
  assert.deepEqual({ statusCalls, backups, exports }, { statusCalls: 1, backups: 0, exports: 0 });

  releaseStatus.resolve();
  await first;
  assert.deepEqual({ statusCalls, backups, exports }, { statusCalls: 1, backups: 1, exports: 1 });
});
