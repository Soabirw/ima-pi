import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dryRunVestige, migrateVestige } from "../../extensions/vestige-migrate.ts";
import { parseDryRunReport } from "../../lib/vestige-migrate-dry-run-report.ts";

const liveMigrationEnabled = process.env.IMA_MIGRATE_IT === "1";

const temporaryProject = async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ima-pi-vestige-migrate-live-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

test("live Vestige dry run and migration produce verified artifacts", {
  skip: !liveMigrationEnabled,
}, async (t) => {
  const root = await temporaryProject(t);
  const dryRun = await dryRunVestige(root);
  const dryRunArtifact = JSON.parse(await readFile(join(root, dryRun.artifactPath), "utf8"));

  assert.equal(dryRun.report.outcome, "READY");
  assert.deepEqual(parseDryRunReport(dryRunArtifact), dryRun.report);

  const migration = await migrateVestige(root);
  assert.equal(migration.report.summary.migrated + migration.report.summary.unchanged >= 1, true);
  assert.equal(migration.report.recovery.snapshot.status, "created");
});
