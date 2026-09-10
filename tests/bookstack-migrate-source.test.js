import assert from "node:assert/strict";
import test from "node:test";
import { deterministicPages, extractSourceBody, lifecycleChapterName, sourceHash, targetPage } from "../lib/bookstack-migrate-source.ts";

const lifecycle = (overrides = {}) => ({
  kind: "lifecycle", sourceId: "qdrant:one", recordKey: "ima-pi:plane:ima:SKYNET-149:plan:abcdef123456",
  lifecycleKey: "ima-pi:plane:ima:SKYNET-149", project: "ima-pi", artifactType: "plan", phase: "plan",
  sourceRefs: ["plane:ima:SKYNET-149"], createdAt: "2026-09-10T00:00:00.000Z", author: "legacy-unknown",
  body: "# Approved plan\n", sourceHash: sourceHash("# Approved plan\n"), ...overrides,
});

test("maps lifecycle and knowledge sources to deterministic BookStack leaves with hash fidelity", () => {
  const lifecyclePage = targetPage(lifecycle());
  assert.equal(lifecycleChapterName("ima-pi:plane:ima:SKYNET-149"), "SKYNET-149");
  assert.equal(lifecyclePage.shelfName, "Lifecycle Artifacts");
  assert.equal(lifecyclePage.bookName, "ima-pi");
  assert.equal(lifecyclePage.pageName, "plan — abcdef123456");
  assert.equal(extractSourceBody(lifecyclePage.markdown), lifecyclePage.body);

  const body = "# Architecture\n";
  const knowledgePage = targetPage({
    kind: "knowledge", sourceId: "git:abc:architecture/records/one.md", project: "ima-rag", artifactType: "decision",
    sourceRefs: ["git:abc"], createdAt: "legacy-unknown", author: "legacy-unknown", body, sourceHash: sourceHash(body),
    sourceOrigin: "filesystem", path: "architecture/records/one.md",
  });
  assert.deepEqual([knowledgePage.shelfName, knowledgePage.bookName, knowledgePage.chapterName, knowledgePage.pageName], ["Institutional Knowledge", "architecture", "records", "one"]);
  assert.match(knowledgePage.markdown, /source_kind: filesystem/);
});

test("quarantines target identity collisions while targetPage still fails closed", () => {
  assert.throws(() => targetPage(lifecycle({ sourceHash: "a".repeat(64) })), /migration_source_invalid/);
  const result = deterministicPages([lifecycle(), lifecycle({ sourceId: "qdrant:two" })]);
  assert.equal(result.pages.length, 1);
  assert.deepEqual(result.quarantined.map(({ sourceId, code, status }) => ({ sourceId, code, status })), [{
    sourceId: "qdrant:two",
    code: "target_identity_conflict",
    status: "quarantined",
  }]);
});
