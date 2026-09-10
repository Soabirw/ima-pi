import assert from "node:assert/strict";
import test from "node:test";
import { buildBookStackMigrationReport, parseBookStackMigrationReport, serializeBookStackMigrationReport } from "../lib/bookstack-migrate-report.ts";

const report = () => buildBookStackMigrationReport({
  runId: "2026-09-10-run", specHash: "a".repeat(64), sourceFingerprint: "b".repeat(64),
  outcomes: [{ sourceId: "qdrant:one", sourceHash: "c".repeat(64), status: "unverified" }],
});

test("migration reports are closed, itemized, and reject tampered summaries", () => {
  const value = report();
  assert.deepEqual(value.summary, { created: 0, unchanged: 0, conflict: 0, quarantined: 0, failed: 0, unverified: 1 });
  assert.deepEqual(parseBookStackMigrationReport(JSON.parse(serializeBookStackMigrationReport(value))), value);
  assert.equal(parseBookStackMigrationReport({ ...value, summary: { ...value.summary, unverified: 0 } }), null);
  assert.throws(() => buildBookStackMigrationReport({ ...value, outcomes: [...value.outcomes, ...value.outcomes] }), /migration_report_invalid/);
});
