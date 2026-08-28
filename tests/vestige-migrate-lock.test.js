import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { registerVestigeMigrateTools } from "../extensions/vestige-migrate.ts";
import { withVestigeMigrationLock } from "../lib/vestige-migrate-lock.ts";
import {
  corpusPrerequisites,
  createdAt,
  retainedId,
  sqliteBackup,
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

test("migration lock preserves rejected operation identity when release fails", async (t) => {
  const root = await temporaryProject(t);
  const lockPath = join(root, "locks", "rejected.lock");
  const sentinel = { reason: "original_interruption" };

  await assert.rejects(
    withVestigeMigrationLock(async () => {
      await rm(lockPath);
      throw sentinel;
    }, { lockPath }),
    (error) => {
      assert.equal(error, sentinel);
      return true;
    },
  );
});

test("migration lock reports release failure after a successful callback", async (t) => {
  const root = await temporaryProject(t);
  const lockPath = join(root, "locks", "fulfilled.lock");

  await assert.rejects(
    withVestigeMigrationLock(async () => {
      await rm(lockPath);
      return "completed";
    }, { lockPath }),
    /migration lock release_failed/,
  );
});

test("registered tools serialize shared Vestige/Qdrant operations before project queues", async (t) => {
  const rootA = await temporaryProject(t);
  const rootB = await temporaryProject(t);
  const lockPath = join(rootA, "shared", "vestige-migrate.lock");
  const tools = [];
  const preflightStarted = deferred();
  const releasePreflight = deferred();
  let preflightCalls = 0;
  let backups = 0;
  let exports = 0;
  const dependencies = {
    migrationLockPath: lockPath,
    client: {
      preflight: async () => {
        preflightCalls += 1;
        if (preflightCalls === 1) {
          preflightStarted.resolve();
          await releasePreflight.promise;
        }
        return corpusPrerequisites("ready");
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

  const first = migrate.execute("first", { confirm: true }, undefined, () => {}, { cwd: rootA });
  await preflightStarted.promise;
  await assert.rejects(
    migrate.execute("second", { confirm: true }, undefined, () => {}, { cwd: rootB }),
    /migration lock in_progress/,
  );
  await assert.rejects(
    cleanup.execute("cleanup", { reportPath: ".ima/report.json", confirm: false }, undefined, () => {}, { cwd: rootB }),
    /migration lock in_progress/,
  );
  assert.deepEqual({ preflightCalls, backups, exports }, { preflightCalls: 1, backups: 0, exports: 0 });

  releasePreflight.resolve();
  await first;
  assert.deepEqual({ preflightCalls, backups, exports }, { preflightCalls: 1, backups: 1, exports: 1 });
});

test("dry-run tool holds the shared migration lock before safe preparation completes", async (t) => {
  const rootA = await temporaryProject(t);
  const rootB = await temporaryProject(t);
  const lockPath = join(rootA, "shared", "vestige-migrate.lock");
  const tools = [];
  const preflightStarted = deferred();
  const releasePreflight = deferred();
  let preflightCalls = 0;
  let backups = 0;
  let exports = 0;
  const dependencies = {
    migrationLockPath: lockPath,
    client: {
      preflight: async () => {
        preflightCalls += 1;
        if (preflightCalls === 1) {
          preflightStarted.resolve();
          await releasePreflight.promise;
        }
        return corpusPrerequisites("ready");
      },
    },
    runVestigeBackup: async ({ outputPath }) => {
      backups += 1;
      await writeFile(outputPath, sqliteBackup());
    },
    runVestigeExport: async ({ outputPath }) => {
      exports += 1;
      await writeFile(outputPath, JSON.stringify([
        { id: retainedId, content: "User prefers shared lock safety.", createdAt },
      ]));
    },
    now: () => new Date("2026-08-28T00:01:00.000Z"),
  };
  registerVestigeMigrateTools({ registerTool: (tool) => tools.push(tool) }, dependencies);
  const migrate = tools.find((tool) => tool.name === "ima_vestige_migrate");
  assert.ok(migrate);

  const dryRun = migrate.execute("dry-run", { dryRun: true }, undefined, () => {}, { cwd: rootA });
  await preflightStarted.promise;
  await assert.rejects(
    migrate.execute("actual", { confirm: true }, undefined, () => {}, { cwd: rootB }),
    /migration lock in_progress/,
  );
  assert.deepEqual({ preflightCalls, backups, exports }, { preflightCalls: 1, backups: 0, exports: 0 });

  releasePreflight.resolve();
  const output = await dryRun;
  assert.equal(output.details.outcome, "READY");
  assert.deepEqual({ preflightCalls, backups, exports }, { preflightCalls: 1, backups: 1, exports: 1 });
});
