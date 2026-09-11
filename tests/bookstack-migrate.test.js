import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildBookStackMigrationReport, parseBookStackMigrationReport, serializeBookStackMigrationReport } from "../lib/bookstack-migrate-report.ts";

const report = () => buildBookStackMigrationReport({
  runId: "2026-09-10-run", specHash: "a".repeat(64), sourceFingerprint: "b".repeat(64),
  outcomes: [{ sourceId: "qdrant:one", sourceHash: "c".repeat(64), status: "unverified" }],
});

test("packaged installed-version API docs are valid and sanitized", async () => {
  const text = await readFile(new URL("../skills/ima-bookstack-migrate/references/bookstack-api-v25.12.3.json", import.meta.url), "utf8");
  const docs = JSON.parse(text);
  assert.equal(docs.bookstackVersion, "v25.12.3");
  assert.equal(Object.keys(docs.sections).length, 16);
  assert.doesNotMatch(text, /bookstack\.theflccc\.org/);
  assert.doesNotMatch(text, /Authorization:\s*Token\s+(?!<token_id>)/i);
  assert.doesNotMatch(text, /hunter2000/i);
  assert.match(text, /<example_password>/);
});

test("migration reports are closed, itemized, and reject tampered summaries", () => {
  const value = report();
  assert.deepEqual(value.summary, { created: 0, unchanged: 0, conflict: 0, quarantined: 0, failed: 0, unverified: 1 });
  assert.deepEqual(parseBookStackMigrationReport(JSON.parse(serializeBookStackMigrationReport(value))), value);
  assert.equal(parseBookStackMigrationReport({ ...value, summary: { ...value.summary, unverified: 0 } }), null);
  assert.throws(() => buildBookStackMigrationReport({ ...value, outcomes: [...value.outcomes, ...value.outcomes] }), /migration_report_invalid/);
});
