import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveBookStackOrigin } from "../lib/bookstack-migrate-config.ts";
import {
  buildApplySourceDelta,
  inventoryFingerprint,
  parseApplySourceDelta,
  revalidateMigrationSources,
} from "../lib/bookstack-migrate-preflight.ts";
import { dryRunBookStackMigration, preflightBookStackMigration } from "../lib/bookstack-migrate.ts";
import { normalizeInstitutionalRecord } from "../lib/qdrant-corpus.ts";
import { sourceHash, targetPage } from "../lib/bookstack-migrate-source.ts";

const knowledgePage = (path, body = "# knowledge\n") => targetPage({
  kind: "knowledge",
  sourceOrigin: "filesystem",
  sourceId: `filesystem:${path}`,
  project: "ima-rag",
  artifactType: "knowledge",
  sourceRefs: [`path:${path}`],
  createdAt: "2026-09-10T00:00:00.000Z",
  author: "legacy-unknown",
  body,
  sourceHash: sourceHash(body),
  path,
});

const lifecyclePage = (suffix, body = "# lifecycle\n") => targetPage({
  kind: "lifecycle",
  sourceOrigin: "qdrant",
  sourceId: `qdrant:${suffix}`,
  recordKey: `ima-pi:manual:test:plan:${suffix}`,
  lifecycleKey: "ima-pi:manual:test",
  project: "ima-pi",
  artifactType: "plan",
  phase: "plan",
  sourceRefs: [],
  createdAt: "2026-09-10T00:00:00.000Z",
  author: "legacy-unknown",
  body,
  sourceHash: sourceHash(body),
});

const json = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" },
});

test("source revalidation permits lifecycle appends but rejects approved and Markdown drift", () => {
  const inventory = [lifecyclePage("one"), knowledgePage("guides/one.md")];
  const appended = lifecyclePage("two");
  assert.deepEqual(revalidateMigrationSources({
    inventory,
    reportFingerprint: inventoryFingerprint(inventory),
    freshPages: [...inventory, appended],
  }).appendedLifecycle, [{ sourceId: appended.sourceId, sourceHash: appended.sourceHash }]);

  assert.throws(() => revalidateMigrationSources({
    inventory,
    reportFingerprint: inventoryFingerprint(inventory),
    freshPages: [inventory[0], knowledgePage("guides/one.md", "# changed\n")],
  }), /migration_source_changed/);
  assert.throws(() => revalidateMigrationSources({
    inventory,
    reportFingerprint: inventoryFingerprint(inventory),
    freshPages: [...inventory, knowledgePage("guides/two.md")],
  }), /markdown_source_changed/);
  assert.throws(() => revalidateMigrationSources({
    inventory,
    reportFingerprint: inventoryFingerprint(inventory),
    freshPages: inventory,
    freshQuarantined: [{
      sourceId: "filesystem:top-level.md",
      sourceHash: sourceHash("# invalid location\n"),
    }],
  }), /markdown_source_changed/);
  assert.throws(() => revalidateMigrationSources({
    inventory,
    reportFingerprint: "0".repeat(64),
    freshPages: inventory,
  }), /migration_inventory_fingerprint_invalid/);
});

test("BookStack origin resolution reuses the established base URL and fails on conflicts", () => {
  assert.equal(resolveBookStackOrigin({ BOOKSTACK_BASE_URL: "https://bookstack.example" }), "https://bookstack.example");
  assert.equal(resolveBookStackOrigin({ BOOKSTACK_ORIGIN: "https://legacy.example" }), "https://legacy.example");
  assert.equal(resolveBookStackOrigin({ BOOKSTACK_BASE_URL: "https://same.example", BOOKSTACK_ORIGIN: "https://same.example/" }), "https://same.example");
  assert.throws(() => resolveBookStackOrigin({ BOOKSTACK_BASE_URL: "https://one.example", BOOKSTACK_ORIGIN: "https://two.example" }), /bookstack_origin_conflict/);
  assert.throws(() => resolveBookStackOrigin({}), /bookstack_base_url_required/);
});

test("source delta is bounded, sorted, and strictly parsed", () => {
  const appended = Array.from({ length: 501 }, (_, index) => ({
    sourceId: `qdrant:${String(index).padStart(4, "0")}`,
    sourceHash: sourceHash(String(index)),
  })).reverse();
  const delta = buildApplySourceDelta("run", appended);
  assert.equal(delta.appended.length, 500);
  assert.equal(delta.appendedCount, 501);
  assert.equal(delta.truncated, true);
  assert.deepEqual(parseApplySourceDelta(delta), delta);
  assert.equal(parseApplySourceDelta({ ...delta, appendedCount: 1 }), null);
});

test("preflight rejects traversal-shaped report paths before local writes", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "ima-bookstack-preflight-path-"));
  try {
    await assert.rejects(preflightBookStackMigration({
      projectRoot,
      dryRunReportPath: ".ima/bookstack-migrate/../outside/dry-run-report.json",
      configurationError: new Error("bookstack_base_url_required"),
    }), /migration_report_path_invalid/);
    await assert.rejects(readFile(join(projectRoot, ".ima", "outside", "apply-preflight-report.json")));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("preflight reads real fixture contracts without issuing a BookStack write", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "ima-bookstack-preflight-"));
  const knowledgeRoot = join(projectRoot, "knowledge");
  const specPath = join(projectRoot, "migration.json");
  const record = normalizeInstitutionalRecord({
    recordKey: "ima-pi:manual:test:plan:one",
    project: "ima-pi",
    site: "",
    repo: "ima-pi",
    lifecycleKey: "ima-pi:manual:test",
    phase: "plan",
    summary: "plan",
    detail: "# lifecycle\n",
    sourceRefs: [],
  }, "2026-09-10T00:00:00.000Z");
  assert.equal(record.success, true);
  const originalFetch = globalThis.fetch;
  let points = [{ id: record.data.id, payload: record.data.payload }];
  globalThis.fetch = async () => json({ result: { points, next_page_offset: null } });
  const writes = [];
  const bookStackFetch = async (url, options = {}) => {
    if (options.method && options.method !== "GET") writes.push({ url: String(url), method: options.method });
    const path = new URL(url).pathname;
    if (path === "/api/shelves/1") return json({ id: 1, name: "Lifecycle Artifacts", books: [] });
    if (path === "/api/shelves/2") return json({ id: 2, name: "Institutional Knowledge", books: [] });
    if (path === "/api/shelves") return json({ data: [
      { id: 1, name: "Lifecycle Artifacts" },
      { id: 2, name: "Institutional Knowledge" },
    ] });
    return json({ data: [] });
  };

  try {
    await mkdir(join(knowledgeRoot, "guides"), { recursive: true });
    await writeFile(join(knowledgeRoot, "guides", "one.md"), "# knowledge\n");
    await writeFile(specPath, JSON.stringify({
      schemaVersion: 1,
      lifecycle: { collection: "ima-lifecycle", qdrantOrigin: "https://qdrant.example", shelfName: "Lifecycle Artifacts" },
      knowledge: { root: knowledgeRoot, shelfName: "Institutional Knowledge" },
    }));
    const dryRun = await dryRunBookStackMigration({ projectRoot, specPath });
    const result = await preflightBookStackMigration({
      projectRoot,
      dryRunReportPath: dryRun.artifact.path,
      bookStack: { origin: "https://bookstack.example", tokenId: "id", tokenSecret: "secret", fetch: bookStackFetch },
    });
    assert.equal(result.report.outcome, "PASS");
    assert.deepEqual(writes, []);

    const appended = normalizeInstitutionalRecord({
      recordKey: "ima-pi:manual:test:plan:appended",
      project: "ima-pi",
      site: "",
      repo: "ima-pi",
      lifecycleKey: "ima-pi:manual:test-appended",
      phase: "plan",
      summary: "appended",
      detail: "# appended lifecycle\n",
      sourceRefs: [],
    }, "2026-09-10T01:00:00.000Z");
    assert.equal(appended.success, true);
    points = [...points, { id: appended.data.id, payload: appended.data.payload }];
    const withAppend = await preflightBookStackMigration({
      projectRoot,
      dryRunReportPath: dryRun.artifact.path,
      bookStack: { origin: "https://bookstack.example", tokenId: "id", tokenSecret: "secret", fetch: bookStackFetch },
    });
    assert.equal(withAppend.report.outcome, "PASS");
    const delta = JSON.parse(await readFile(join(dryRun.run.directory, "apply-source-delta.json"), "utf8"));
    assert.equal(delta.appendedCount, 1);
    assert.equal(delta.appended[0].sourceId, `qdrant:${appended.data.id}`);

    const blocked = await preflightBookStackMigration({
      projectRoot,
      dryRunReportPath: dryRun.artifact.path,
      configurationError: new Error("bookstack_base_url_required"),
    });
    assert.equal(blocked.report.outcome, "BLOCKED");
    assert.equal(blocked.report.checks[0].code, "bookstack_base_url_required");
    assert.deepEqual(writes, []);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectRoot, { recursive: true, force: true });
  }
});
