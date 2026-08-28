import assert from "node:assert/strict";
import test from "node:test";
import { MAX_STORED_ARTIFACT_BYTES, utf8ByteLength } from "../lib/qdrant-corpus.ts";
import { normalizeSourceReferences } from "../lib/qdrant-corpus-contract.ts";
import {
  classifyVestigeExport,
  redactSecrets,
  sourceBundleIndexDetail,
  splitVestigeSource,
} from "../lib/vestige-migrate.ts";

const createdAt = "2026-08-27T22:43:29.085Z";
const nonce = "33333333-3333-4333-8333-333333333333";
const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666666",
  "77777777-7777-4777-8777-777777777777",
  "88888888-8888-4888-8888-888888888888",
];

const record = (id, content, extra = {}) => ({ id, content, createdAt, ...extra });

const canonicalContent = (detail = "The approved plan is complete.") => `---
lifecycle:
  project: 'ima-pi'
  lifecycle_key: 'ima-pi:lifecycle:classification-test'
  source_refs:
    - 'lifecycle:ima-pi:lifecycle:classification-test'
  phase: 'plan'
---

# Approved migration plan

${detail}

<!-- ima-lifecycle verification: lifecycle_key=ima-pi:lifecycle:classification-test; nonce=${nonce}; phase=plan; jira_key=; taskwarrior_uuid=; outcome=completed -->
`;

test("classification defaults valid non-preference records to institutional storage", () => {
  const classification = classifyVestigeExport([
    record(ids[0], canonicalContent()),
    record(ids[1], "Legacy machine provenance record.", { source: "ima-mcp vestige save implementation" }),
    record(ids[2], "# Decision\n\nThis artifact mentions a preference but remains institutional."),
    record(ids[3], "Keep this setting.", { tags: ["preferences"] }),
    record(ids[4], "User prefers concise migration reports."),
    record(ids[5], "An unknown legacy record migrates conservatively."),
  ]);

  assert.equal(classification.institutional.length, 4);
  assert.deepEqual(classification.retained, [
    { vestigeId: ids[3], reason: "explicit_preference" },
    { vestigeId: ids[4], reason: "explicit_preference" },
  ]);
  assert.deepEqual(classification.quarantined, []);

  const [canonical, provenance, artifact, unknown] = classification.institutional;
  assert.equal(canonical.records[0].expected.recordKey, `ima-pi:lifecycle:classification-test:plan:${nonce}`);
  assert.equal(provenance.records[0].expected.phase, "implementation");
  assert.equal(provenance.records[0].expected.project, "legacy-vestige");
  assert.equal(artifact.records[0].expected.phase, "legacy");
  assert.equal(unknown.records[0].expected.recordKey, `vestige:${ids[5]}`);
  assert.equal(artifact.records[0].expected.sourceRefs.includes(`vestige:${ids[2]}`), true);
});

test("classification redacts before fallback summaries and keeps legacy identity stable", () => {
  const source = record(
    ids[6],
    "\n\nHeading-free first paragraph with token=super-secret.\n\nSecond paragraph.",
    { nodeType: "Decision Note" },
  );
  const first = classifyVestigeExport([source]);
  const second = classifyVestigeExport([source]);
  const candidate = first.institutional[0];

  assert.deepEqual(first, second);
  assert.equal(candidate.records[0].expected.phase, "decision-note");
  assert.match(candidate.records[0].expected.summary, /Heading-free first paragraph/);
  assert.doesNotMatch(candidate.records[0].expected.summary, /super-secret/);
  assert.doesNotMatch(candidate.records[0].expected.detail, /super-secret/);
  assert.equal(candidate.wasRedacted, true);
  assert.deepEqual(redactSecrets(candidate.records[0].expected.detail), {
    text: candidate.records[0].expected.detail,
    redacted: 0,
  });
});

test("large sources split at Unicode boundaries and use a raw-free deterministic index", () => {
  const content = "🙂".repeat(Math.ceil((MAX_STORED_ARTIFACT_BYTES + 4) / 4));
  const classification = classifyVestigeExport([record(ids[7], content)]);
  const source = classification.institutional[0];
  const parts = source.records.filter((candidate) => candidate.role === "part");
  const index = source.records.at(-1);

  assert.equal(parts.length >= 2, true);
  assert.equal(index?.role, "index");
  assert.equal(index?.partCount, parts.length);
  assert.equal(source.records.at(-1)?.role, "index");
  assert.equal(parts.map((candidate) => candidate.record.detail).join(""), content);
  assert.equal(parts.every((candidate) => utf8ByteLength(candidate.record.detail) <= MAX_STORED_ARTIFACT_BYTES), true);
  assert.equal(parts.every((candidate) => utf8ByteLength(candidate.record.detail) > 44_000), true);
  assert.equal(index?.record.detail, sourceBundleIndexDetail({
    sourceHash: source.sourceHash,
    sourceBytes: source.sourceBytes,
    partKeys: parts.map((candidate) => candidate.expected.recordKey),
  }));
  assert.doesNotMatch(index?.record.detail ?? "", /🙂/);
  assert.deepEqual(splitVestigeSource(content), parts.map((candidate) => candidate.record.detail));
});

test("invalid, duplicate, and unstorable source records quarantine without retaining content", () => {
  const duplicate = record(ids[0], "duplicate");
  const classification = classifyVestigeExport([
    record(ids[0], "first"),
    duplicate,
    record(ids[1], "contains\0nul"),
    { id: "not-a-uuid", content: "invalid", createdAt },
  ]);

  assert.deepEqual(classification.institutional, []);
  assert.deepEqual(classification.retained, []);
  assert.deepEqual(classification.quarantined, [
    { vestigeId: ids[0], reason: "record_invalid" },
    { vestigeId: ids[1], reason: "record_invalid" },
    { vestigeId: null, reason: "export_invalid" },
  ]);
});

test("canonical destination collisions quarantine every participating source", () => {
  const classification = classifyVestigeExport([
    record(ids[0], canonicalContent()),
    record(ids[1], canonicalContent()),
    record(ids[2], "A unique legacy record still migrates."),
  ]);

  assert.deepEqual(classification.institutional.map((source) => source.vestigeId), [ids[2]]);
  assert.deepEqual(classification.quarantined, [
    { vestigeId: ids[0], reason: "record_invalid" },
    { vestigeId: ids[1], reason: "record_invalid" },
  ]);
});

test("canonical source references normalize or fail closed", () => {
  const references = [
    "taskwarrior:ima-pi:7742b1e1-af39-44d1-9c7e-39c455b15828",
    "file:docs/decision.md",
    "taskwarrior:ima-pi:7742b1e1-af39-44d1-9c7e-39c455b15828",
  ];
  const validContent = canonicalContent().replace(
    "  source_refs:\n    - 'lifecycle:ima-pi:lifecycle:classification-test'",
    `  source_refs:\n${references.map((reference) => `    - '${reference}'`).join("\n")}`,
  );
  const valid = classifyVestigeExport([record(ids[3], validContent)]);
  const expected = normalizeSourceReferences([...references, `vestige:${ids[3]}`]);
  assert.deepEqual(valid.institutional[0].records[0].expected.sourceRefs, expected);

  const invalidContent = validContent.replace("file:docs/decision.md", `file:docs/${String.fromCharCode(1)}bad.md`);
  const invalid = classifyVestigeExport([record(ids[4], invalidContent)]);
  assert.deepEqual(invalid.institutional, []);
  assert.deepEqual(invalid.quarantined, [{ vestigeId: ids[4], reason: "record_invalid" }]);
});
