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
  const sources = reassembleLifecyclePoints([{ id: normalized.data.id, payload: normalized.data.payload }]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].recordKey, normalized.data.recordKey);
  assert.equal(sourceFingerprint(sources), sourceFingerprint([...sources].reverse()));
});

test("fails closed for invalid logical lifecycle points", () => {
  assert.throws(() => reassembleLifecyclePoints([{ id: "not-a-record", payload: { schema_version: 1 } }]), /qdrant_v1_invalid/);
});
