import assert from "node:assert/strict";
import test from "node:test";
import { normalizeInstitutionalRecord } from "../lib/qdrant-corpus.ts";
import { reassembleLifecyclePoints, sourceFingerprint } from "../lib/bookstack-migrate-qdrant.ts";

test("reassembles schema-v1 lifecycle points and creates a stable source fingerprint", () => {
  const normalized = normalizeInstitutionalRecord({
    recordKey: "ima-pi:plane:ima:SKYNET-149:plan:abcdef123456", project: "ima-pi", site: "", repo: "ima-pi",
    lifecycleKey: "ima-pi:plane:ima:SKYNET-149", phase: "plan", summary: "Approved plan", detail: "# plan\n", sourceRefs: ["plane:ima:SKYNET-149"],
  }, "2026-09-10T00:00:00.000Z");
  assert.equal(normalized.success, true);
  const result = reassembleLifecyclePoints([{ id: normalized.data.id, payload: normalized.data.payload }]);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].recordKey, normalized.data.recordKey);
  assert.equal(sourceFingerprint(result.sources), sourceFingerprint([...result.sources].reverse()));
  assert.deepEqual(result.quarantined, []);
});

test("quarantines invalid logical lifecycle points", () => {
  const result = reassembleLifecyclePoints([{ id: "not-a-record", payload: { schema_version: 1 } }]);
  assert.deepEqual(result.sources, []);
  assert.deepEqual(result.quarantined.map(({ sourceId, code, status }) => ({ sourceId, code, status })), [{
    sourceId: "qdrant:not-a-record",
    code: "qdrant_v1_invalid",
    status: "quarantined",
  }]);
  assert.match(result.quarantined[0].sourceHash, /^[a-f0-9]{64}$/);
});
