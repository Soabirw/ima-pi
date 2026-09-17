import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerBookStackMigrateTools } from "../extensions/bookstack-migrate.ts";
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

test("migration tool keeps canary, apply, and cleanup confirmation gates before any fetch", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "ima-bookstack-confirmation-"));
  const environmentNames = [
    "BOOKSTACK_BASE_URL",
    "BOOKSTACK_ORIGIN",
    "BOOKSTACK_TOKEN_ID",
    "BOOKSTACK_TOKEN_SECRET",
  ];
  const originalEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  try {
    process.env.BOOKSTACK_BASE_URL = "https://bookstack.example";
    process.env.BOOKSTACK_ORIGIN = "https://bookstack.example";
    process.env.BOOKSTACK_TOKEN_ID = "test-id";
    process.env.BOOKSTACK_TOKEN_SECRET = "synthetic-token-secret";
    globalThis.fetch = async () => {
      fetches += 1;
      throw new Error("unexpected_fetch");
    };

    const tools = [];
    registerBookStackMigrateTools({ registerTool: (tool) => tools.push(tool) });
    const migration = tools.find(({ name }) => name === "ima_bookstack_migrate");
    assert.ok(migration);
    for (const [operation, expectedCode] of [
      ["canary", "canary_confirmation_required"],
      ["apply", "apply_confirmation_required"],
      ["cleanup", "cleanup_confirmation_required"],
    ]) {
      await assert.rejects(migration.execute(
        "test",
        { operation, reportPath: ".ima/bookstack-migrate/run/dry-run-report.json" },
        new AbortController().signal,
        undefined,
        { cwd: projectRoot },
      ), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, expectedCode);
        assert.doesNotMatch(error.message, /synthetic-token-secret/);
        return true;
      });
    }
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(projectRoot, { recursive: true, force: true });
  }
});
