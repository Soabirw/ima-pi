import assert from "node:assert/strict";
import test from "node:test";
import { derivePhaseContext, evaluateSerenaBootstrap, normalizeCorpusLifecycleRecord, normalizeSourcePayload, normalizeSourceReference, parseContextSourceIdentifier, prepareContextArguments, sanitizeContextError, sanitizeContextText, validateContextRequest } from "../lib/ima-context.ts";

const invalidVestigeId = "-".repeat(36);
const sources = [{ type: "jira", key: "FNR-3016" }, { type: "taskwarrior", project: "FNR-3007", uuid: "689fa7ac-84b7-42d0-8912-b8ef76041370" }, { type: "file", path: "README.md" }, { type: "vestige", id: "7027acec-43d3-4fa4-83ec-16e993551720" }, { type: "text", title: "Brief", content: "Approved outcome" }, { type: "lifecycle", key: "ima-pi:adhoc:lifecycle-source-identifiers:2026-08-04" }];
test("validates each closed context source and rejects ambiguous input", () => {
  for (const source of sources) assert.equal(validateContextRequest({ source }).valid, true);
  for (const source of [{ type: "jira", key: "not-a-key" }, { type: "taskwarrior", project: "x", uuid: "x" }, { type: "shell", command: "rm" }, { type: "vestige", id: invalidVestigeId }, { type: "text", title: "", content: "x" }]) assert.equal(validateContextRequest({ source }).valid, false);
  for (const request of [{ source: "FNR-3016" }, { source: { type: "jira" } }, { source: { ...sources[0], path: "README.md" } }, { source: { ...sources[0], url: "https://example.test/FNR-3016" } }, { source: sources[0], phase: "technical-planning" }, { source: sources[0], durableKnowledge: "FNR-3016" }, { source: sources[0], durableKnowledge: { required: true, correlationKeys: ["FNR-3016"] } }, { source: sources[0], durableKnowledge: { query: "x", sources: ["serena"] } }]) assert.equal(validateContextRequest(request).valid, false);
});
test("prepares canonical context requests without reflecting malformed input", () => {
  for (const source of sources) assert.deepEqual(prepareContextArguments({ source }), { source });
  assert.deepEqual(prepareContextArguments({ source: sources[0], durableKnowledge: { query: " evidence ", collection: " ima ", limit: 2 } }), { source: sources[0], durableKnowledge: { query: "evidence", collection: "ima", limit: 2 } });
  const invalidVestige = { source: { type: "vestige", id: invalidVestigeId } };
  const preparedVestige = prepareContextArguments(invalidVestige);
  assert.deepEqual(preparedVestige, { source: { type: "invalid_context_request" } });
  assert.doesNotMatch(JSON.stringify(preparedVestige), new RegExp(invalidVestigeId));
  const marker = "fake-context-token=do-not-echo";
  for (const request of [{ source: { type: "jira" } }, { source: { ...sources[0], path: "README.md" } }, { source: { ...sources[0], unexpected: marker } }]) {
    const prepared = prepareContextArguments(request);
    assert.deepEqual(prepared, { source: { type: "invalid_context_request" } });
    assert.doesNotMatch(JSON.stringify(prepared), /fake-context-token=do-not-echo/);
  }
});
test("parses canonical source identifiers and space-delimited aliases", () => {
  const taskwarrior = { type: "taskwarrior", project: "FNR-3007", uuid: "689fa7ac-84b7-42d0-8912-b8ef76041370" };
  const jira = { type: "jira", key: "FNR-3016" };
  const lifecycle = { type: "lifecycle", key: "ima-pi:adhoc:lifecycle-source-identifiers:2026-08-04" };
  const vestige = { type: "vestige", id: "7027acec-43d3-4fa4-83ec-16e993551720" };
  const forms = [
    ["taskwarrior:FNR-3007:689fa7ac-84b7-42d0-8912-b8ef76041370", taskwarrior],
    ["taskwarrior FNR-3007 689fa7ac-84b7-42d0-8912-b8ef76041370", taskwarrior],
    ["jira:FNR-3016", jira],
    ["jira FNR-3016", jira],
    ["lifecycle:ima-pi:adhoc:lifecycle-source-identifiers:2026-08-04", lifecycle],
    ["lifecycle ima-pi:adhoc:lifecycle-source-identifiers:2026-08-04", lifecycle],
    ["vestige:7027acec-43d3-4fa4-83ec-16e993551720", vestige],
    ["vestige 7027acec-43d3-4fa4-83ec-16e993551720", vestige],
  ];

  for (const [identifier, expected] of forms) {
    assert.deepEqual(parseContextSourceIdentifier(identifier), expected);
    assert.deepEqual(prepareContextArguments({ source: { type: "reference", value: identifier } }), { source: expected });
  }
  assert.equal(parseContextSourceIdentifier("lifecycle:ima-pi:adhoc:internal:colons")?.key, "ima-pi:adhoc:internal:colons");
  for (const identifier of ["taskwarrior:FNR-3007:689fa7ac-84b7-42d0-8912-b8ef76041370:extra", "jira:fnr-3016", "lifecycle:", "vestige:not-a-uuid", "unknown:source", "https://example.test/FNR-3016", "lifecycle:line\nbreak"]) assert.equal(parseContextSourceIdentifier(identifier), null);
});

test("validates and normalizes bounded Plane work-item sources", () => {
  const plane = { type: "plane", workspace: "IMA", project: "ERIC", sequenceId: 1 };
  const forms = ["plane:IMA:ERIC-1", "plane IMA ERIC-1"];
  const nearBoundaryPlane = {
    type: "plane",
    workspace: "W".repeat(1_014),
    project: "P",
    sequenceId: 1,
  };
  const nearBoundaryReference = `plane:${nearBoundaryPlane.workspace}:P-1`;

  assert.equal(validateContextRequest({ source: plane }).valid, true);
  assert.deepEqual(prepareContextArguments({ source: plane }), { source: plane });
  assert.equal(nearBoundaryReference.length, 1_024);
  assert.equal(validateContextRequest({ source: nearBoundaryPlane }).valid, true);
  assert.deepEqual(parseContextSourceIdentifier(nearBoundaryReference), nearBoundaryPlane);
  for (const identifier of forms) {
    assert.deepEqual(parseContextSourceIdentifier(identifier), plane);
    assert.deepEqual(prepareContextArguments({ source: { type: "reference", value: identifier } }), { source: plane });
  }

  const normalized = normalizeSourcePayload({ source: plane, payload: { content: "Plane description" } });
  assert.deepEqual(normalized, {
    type: "plane",
    key: "IMA:ERIC-1",
    title: "Plane:IMA:ERIC-1",
    content: "Plane description",
    references: ["Plane:IMA:ERIC-1"],
  });
  assert.equal(normalizeSourceReference(plane), "Plane:IMA:ERIC-1");

  for (const source of [
    { type: "plane", workspace: "-IMA", project: "ERIC", sequenceId: 1 },
    { type: "plane", workspace: "IMA", project: "eric", sequenceId: 1 },
    { type: "plane", workspace: "IMA", project: "ERIC", sequenceId: 0 },
    { type: "plane", workspace: "IMA", project: "ERIC", sequenceId: 1.5 },
    { type: "plane", workspace: "IMA", project: "ERIC", sequenceId: Number.MAX_SAFE_INTEGER + 1 },
    { type: "plane", workspace: "IMA", project: "ERIC", sequenceId: "1" },
    { type: "plane", workspace: "W".repeat(1_025), project: "P", sequenceId: 1 },
    { type: "plane", workspace: "W", project: "P".repeat(1_025), sequenceId: 1 },
    { type: "plane", workspace: "W".repeat(1_014), project: "PP", sequenceId: 1 },
  ]) assert.equal(validateContextRequest({ source }).valid, false);
  for (const identifier of [
    "plane:IMA:ERIC-0",
    "plane:IMA:eric-1",
    "plane:IMA:ERIC-1:extra",
    "plane IMA ERIC-1 extra",
    "plane:IMA:ERIC-9007199254740992",
  ]) assert.equal(parseContextSourceIdentifier(identifier), null);
});

test("normalizes only verified direct corpus lifecycle records", () => {
  const lifecycleKey = "ima-pi:adhoc:lifecycle-source-identifiers:2026-08-04";
  const marker = `<!-- ima-lifecycle verification: lifecycle_key=${lifecycleKey}; nonce=01234567-89ab-cdef-0123-456789abcdef; phase=plan; jira_key=; taskwarrior_uuid=; outcome=completed -->`;
  const content = `# Plan\n${marker}\n`;
  const record = {
    id: "plan-artifact",
    recordKey: "ima-pi:adhoc:lifecycle-source-identifiers:2026-08-04:plan:artifact",
    lifecycleKey,
    detail: content,
  };
  const abbreviated = `<!-- ima-lifecycle verification: lifecycle_key=${lifecycleKey}; outcome=completed -->`;

  assert.deepEqual(normalizeCorpusLifecycleRecord({ lifecycleKey, record }), {
    id: "plan-artifact",
    recordKey: record.recordKey,
    content,
  });
  assert.equal(normalizeCorpusLifecycleRecord({ lifecycleKey, record: { ...record, lifecycleKey: "other" } }), null);
  for (const recordKey of [
    `\t${record.recordKey}`,
    `${record.recordKey}\r`,
    `${record.recordKey}\u0085`,
  ]) {
    assert.equal(normalizeCorpusLifecycleRecord({ lifecycleKey, record: { ...record, recordKey } }), null);
  }
  assert.equal(normalizeCorpusLifecycleRecord({ lifecycleKey, record: { ...record, detail: abbreviated } }), null);
  assert.equal(normalizeCorpusLifecycleRecord({ lifecycleKey, record: { ...record, detail: content.replace("01234567-89ab-cdef-0123-456789abcdef", "not-a-uuid") } }), null);
  assert.equal(normalizeCorpusLifecycleRecord({ lifecycleKey, record: { ...record, detail: content.replace("phase=plan", "phase=unknown") } }), null);
  assert.equal(normalizeCorpusLifecycleRecord({ lifecycleKey, record: { ...record, detail: `${content}unrelated` } }), null);
  assert.equal(normalizeCorpusLifecycleRecord({ lifecycleKey, record: { ...record, detail: content.replace("outcome=completed", "outcome=blocked") } }), null);
});

test("accepts only canonical complete Plane lifecycle markers", () => {
  const lifecycleKey = "ima-pi:plane:ima:SKYNET-61";
  const marker = `<!-- ima-lifecycle verification: lifecycle_key=${lifecycleKey}; nonce=01234567-89ab-cdef-0123-456789abcdef; phase=implementation; jira_key=; taskwarrior_uuid=; plane_workspace=ima; plane_work_item=SKYNET-61; outcome=completed -->`;
  const content = `# Implementation\n${marker}\n`;
  const record = {
    id: "plane-implementation",
    recordKey: `${lifecycleKey}:implementation:artifact`,
    lifecycleKey,
    detail: content,
  };

  assert.deepEqual(normalizeCorpusLifecycleRecord({ lifecycleKey, record }), {
    id: record.id,
    recordKey: record.recordKey,
    content,
  });
  for (const detail of [
    content.replace("; plane_work_item=SKYNET-61", ""),
    content.replace("plane_work_item=SKYNET-61", "plane_work_item=skynet-61"),
    content.replace("plane_work_item=SKYNET-61", "plane_work_item=SKYNET-0"),
    content.replace("plane_work_item=SKYNET-61", "plane_work_item=SKYNET-9007199254740992"),
    content.replace("; plane_work_item=SKYNET-61", "; plane_workspace=other; plane_work_item=SKYNET-61"),
    content.replace("; outcome=completed", "; unexpected=value; outcome=completed"),
    content.replace("01234567-89ab-cdef-0123-456789abcdef", "not-a-uuid"),
    content.replace(lifecycleKey, "ima-pi:plane:ima:SKYNET-62"),
    `${content}unrelated`,
  ]) {
    assert.equal(normalizeCorpusLifecycleRecord({ lifecycleKey, record: { ...record, detail } }), null);
  }
});

test("validates durable knowledge boundaries", () => {
  assert.equal(validateContextRequest({ source: sources[0], durableKnowledge: { query: "x", collection: "c", limit: 1 } }).valid, true);
  assert.equal(validateContextRequest({ source: sources[0], durableKnowledge: { query: "x".repeat(2_000), collection: "c".repeat(256), limit: 20 } }).valid, true);
  for (const durableKnowledge of [{ query: "" }, { query: "x".repeat(2_001) }, { query: "x", collection: "c".repeat(257) }, { query: "x", limit: 0 }, { query: "x", limit: 21 }]) assert.equal(validateContextRequest({ source: sources[0], durableKnowledge }).valid, false);
});
test("normalizes direct and hydrated sources into the common source shape", () => {
  const direct = normalizeSourcePayload({ source: sources[4], payload: null });
  const hydrated = normalizeSourcePayload({ source: sources[0], payload: { key: "FNR-3016", title: "Integrations", content: "Description", references: ["https://example.test"] } });
  assert.deepEqual(direct, { type: "text", key: "Brief", title: "Brief", content: "Approved outcome", references: ["Text:Brief"] });
  const sensitive = normalizeSourcePayload({ source: { type: "text", title: "token=secret-value", content: "Approved outcome" }, payload: null });
  assert.deepEqual(sensitive, { type: "text", key: "[redacted]", title: "[redacted]", content: "Approved outcome", references: ["Text:[redacted]"] });
  assert.doesNotMatch(JSON.stringify(sensitive), /secret-value/);
  const sensitiveFileFallback = normalizeSourcePayload({ source: { type: "file", path: "fixtures/token=demo-value" }, payload: { content: "File contents" } });
  assert.deepEqual(sensitiveFileFallback, { type: "file", key: "fixtures/[redacted]", title: "File:fixtures/[redacted]", content: "File contents", references: ["File:fixtures/[redacted]"] });
  const sensitiveFileKey = normalizeSourcePayload({ source: { type: "file", path: "fixtures/ordinary.md" }, payload: { key: "fixtures/token=demo-value", content: "File contents" } });
  assert.equal(sensitiveFileKey.key, "fixtures/[redacted]");
  assert.doesNotMatch(JSON.stringify(sensitiveFileKey), /demo-value/);
  const ordinaryFile = normalizeSourcePayload({ source: { type: "file", path: "fixtures/ordinary.md" }, payload: { content: "File contents" } });
  assert.deepEqual(ordinaryFile, { type: "file", key: "fixtures/ordinary.md", title: "File:fixtures/ordinary.md", content: "File contents", references: ["File:fixtures/ordinary.md"] });
  assert.equal(hydrated.type, "jira"); assert.deepEqual(hydrated.references, ["Jira:FNR-3016", "https://example.test"]);
  assert.equal(normalizeSourceReference(sources[1]), "Taskwarrior:FNR-3007:689fa7ac-84b7-42d0-8912-b8ef76041370");
  assert.equal(normalizeSourceReference(sources[5]), "Lifecycle:ima-pi:adhoc:lifecycle-source-identifiers:2026-08-04");
});
test("Serena evidence explicitly distinguishes missing and failed memories", () => {
  const bootstrap = evaluateSerenaBootstrap({ activated: true, instructionsLoaded: true, memoryListLoaded: true, memories: { core: "Core", conventions: null, tech_stack: "failed" } });
  assert.equal(bootstrap.memories.core.status, "loaded"); assert.equal(bootstrap.memories.conventions.status, "missing"); assert.equal(bootstrap.memories.tech_stack.status, "failed");
  assert.deepEqual(bootstrap.missingRequiredMemories, [
    "conventions",
    "tech_stack",
    "suggested_commands",
    "task_completion",
    "memory_maintenance",
  ]);
});
test("derives ready, degraded, and failed contexts without mutating inputs", () => {
  const source = normalizeSourcePayload({ source: sources[4], payload: null });
  const ready = evaluateSerenaBootstrap({ activated: true, instructionsLoaded: true, memoryListLoaded: true, memories: Object.fromEntries(["core", "conventions", "tech_stack", "suggested_commands", "task_completion", "memory_maintenance"].map((name) => [name, name])) });
  assert.equal(derivePhaseContext({ cwd: "/repo", serenaProjectPath: "/repo", source, serena: ready }).status, "ready");
  assert.equal(derivePhaseContext({ cwd: "/repo", serenaProjectPath: "/repo", source, serena: { ...ready, missingRequiredMemories: ["core"] } }).status, "degraded");
  assert.equal(derivePhaseContext({ cwd: "/repo", serenaProjectPath: "/repo", source: null, serena: ready }).status, "failed");
});
test("sanitization never echoes external secrets and safely corrects invalid requests", () => {
  assert.deepEqual(sanitizeContextError("source_failed", "token=secret"), { code: "source_failed", message: "Context integration failed: source_failed." });
  assert.equal(sanitizeContextText("Authorization: Bearer abc123\nsafe"), "[redacted]\nsafe");
  const invalid = sanitizeContextError("invalid_context_request", "token=secret");
  assert.equal(invalid.code, "invalid_context_request");
  assert.match(invalid.hint, /jira:key.*durableKnowledge requires query/);
  assert.doesNotMatch(JSON.stringify(invalid), /secret/);
});
