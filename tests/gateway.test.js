import assert from "node:assert/strict";
import test from "node:test";
import {
  CHILD_EXECUTION_TIMEOUT, JIRA_KEY, LIFECYCLE_KEY, USAGE, buildChildBrief, buildLifecyclePayload, childExecutionErrorCode, classifyGatewayCommand, withDeadline,
  deriveGatewayProbeResult, evaluateObservedWorkflow, evaluateSemanticCompletion,
  parseGatewayProbeArgs, parseModelSelector, sanitizeGatewayError, validateGatewayEnvelope,
} from "../extensions/gateway-probe.ts";

const nonce = "01234567-89ab-cdef-0123-456789abcdef";
const payload = buildLifecyclePayload({ lifecycleKey: LIFECYCLE_KEY, jiraKey: JIRA_KEY, nonce });
const context = { repoPath: "/repo", workspace: "/workspace", payload };
const successful = (command) => ({ ok: true, command, data: { processed: true } });
const recalled = (results) => ({ ok: true, command: "vestige.search", data: { results } });

test("selector and command grammar accept one nested provider/model selector only", () => {
  assert.deepEqual(parseModelSelector("openrouter/openai/gpt-5.4"), { valid: true, provider: "openrouter", model: "openai/gpt-5.4" });
  assert.deepEqual(parseGatewayProbeArgs("openai/gpt-5.4-mini"), { provider: "openai", model: "gpt-5.4-mini" });
  for (const input of ["", "openai", "/model", "openai/", "openai/model extra"]) assert.deepEqual(parseGatewayProbeArgs(input), { error: "invalid_arguments", message: USAGE });
});

test("payload and child brief carry fixed semantic and safety contracts", () => {
  for (const text of [LIFECYCLE_KEY, JIRA_KEY, nonce, "implementation-probe", "completed"]) assert.match(payload, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const brief = buildChildBrief(context);
  for (const text of ["ima-mcp serena project status", "ima-mcp vestige status", "ima-mcp qdrant status", "ima-mcp vestige smart_ingest", "Do not modify the repository", "do not run extra commands"]) assert.match(brief, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  assert.doesNotMatch(brief, /user supplied shell fragment/i);
});

test("command classifier permits only the exact four fixed bash commands", () => {
  const lines = buildChildBrief(context).split("\n").filter((line) => /^\d+\. ima-mcp/.test(line)).map((line) => line.replace(/^\d+\. /, ""));
  assert.deepEqual(lines.map((command) => classifyGatewayCommand({ toolName: "bash", args: { command } }, context)), [
    { service: "serena", operation: "status", mutation: false }, { service: "vestige", operation: "status", mutation: false },
    { service: "qdrant", operation: "status", mutation: false }, { service: "vestige", operation: "smart_ingest", mutation: true },
  ]);
  assert.deepEqual(classifyGatewayCommand({ toolName: "bash", args: { command: "ima-mcp vestige search anything --json" } }, context), { service: "unknown", operation: "unknown", mutation: false });
});

test("envelope validation accepts success and rejects malformed/error/rule-breaking responses", () => {
  assert.equal(validateGatewayEnvelope({ service: "serena", operation: "status", envelope: successful("serena.project.status") }).passed, true);
  assert.equal(validateGatewayEnvelope({ service: "vestige", operation: "smart_ingest", envelope: successful("vestige.smart_ingest") }).passed, true);
  for (const envelope of ["not json", { ok: false, command: "serena.project.status" }, { ok: true, command: "qdrant.status" }, { ok: true, command: "serena.project.status", diagnostics: [{ severity: "error" }] }, { ok: true, command: "vestige.smart_ingest" }]) assert.equal(validateGatewayEnvelope({ service: envelope?.command?.startsWith?.("vestige") ? "vestige" : "serena", operation: envelope?.command?.includes?.("smart_ingest") ? "smart_ingest" : "status", envelope }).passed, false);
});

test("workflow evidence requires precisely the approved commands", () => {
  const events = [
    { service: "serena", operation: "status", mutation: false }, { service: "vestige", operation: "status", mutation: false },
    { service: "qdrant", operation: "status", mutation: false }, { service: "vestige", operation: "smart_ingest", mutation: true },
  ];
  assert.equal(evaluateObservedWorkflow(events).passed, true);
  assert.equal(evaluateObservedWorkflow(events.slice(0, -1)).passed, false);
  assert.equal(evaluateObservedWorkflow([...events, { service: "unknown", operation: "unknown", mutation: false }]).passed, false);
});

test("semantic completion accepts one nested matching result regardless of physical shape", () => {
  for (const data of [{ action: "create", id: "x" }, { action: "update", node_type: "event" }, { consolidated: true }, { processed: true }]) {
    const semantic = evaluateSemanticCompletion({ ingestEnvelope: { ok: true, command: "vestige.smart_ingest", data }, recalledMemories: recalled([{ metadata: { arbitrary: "shape" }, nested: [{ text: payload }] }]), lifecycleKey: LIFECYCLE_KEY, jiraKey: JIRA_KEY, nonce });
    assert.equal(semantic.passed, true); assert.equal(semantic.physicalShapeIgnored, true);
  }
});

test("semantic completion fails closed unless one actual search result contains every marker", () => {
  const input = { ingestEnvelope: successful("vestige.smart_ingest"), lifecycleKey: LIFECYCLE_KEY, jiraKey: JIRA_KEY, nonce };
  const failures = [
    { ok: true, command: "vestige.search", data: { query: payload, results: [] } },
    recalled([{ content: payload.replace(nonce, "other") }]),
    recalled([{ content: `${LIFECYCLE_KEY} ${JIRA_KEY}` }, { content: `${nonce} completed` }]),
    { ok: true, command: "vestige.search", data: { metadata: { content: payload } } },
    { ok: true, command: "vestige.search", data: { results: {} } },
  ];
  for (const recalledMemories of failures) assert.equal(evaluateSemanticCompletion({ ...input, recalledMemories }).passed, false);
});

test("result derivation requires checks, exact child identity, workflow, and semantic completion", () => {
  const check = (service, operation) => ({ service, operation, passed: true, errorCode: null });
  const base = { schemaVersion: 1, story: "FNR-3011", requestedChild: { provider: "openai", model: "model" }, actualChild: { provider: "openai", model: "model" }, parent: { serena: check("serena", "status"), vestige: check("vestige", "status"), qdrant: check("qdrant", "status") }, child: { serena: check("serena", "status"), vestigeRead: check("vestige", "status"), vestigeIngest: check("vestige", "smart_ingest"), qdrant: check("qdrant", "status") }, semanticCompletion: { ingestAccepted: true, recallMatched: true, lifecycleKeyMatched: true, jiraKeyMatched: true, nonceMatched: true, outcomeMatched: true, physicalShapeIgnored: true }, observedCommands: [{ service: "serena", operation: "status", mutation: false }, { service: "vestige", operation: "status", mutation: false }, { service: "qdrant", operation: "status", mutation: false }, { service: "vestige", operation: "smart_ingest", mutation: true }] };
  assert.equal(deriveGatewayProbeResult(base).status, "passed");
  assert.equal(deriveGatewayProbeResult({ ...base, actualChild: null }).status, "failed");
});

test("sanitization never echoes sensitive error material", () => {
  const error = sanitizeGatewayError("child_execution_failed", "token=secret raw memory provider response");
  assert.deepEqual(error, { code: "child_execution_failed", message: "Gateway probe failed: child_execution_failed." });
});

test("pure core fails closed for malformed selectors and altered child commands", () => {
  for (const input of [undefined, null, {}, "   ", " /model", "provider/ "]) assert.equal(parseModelSelector(input).valid, false, String(input));
  const commands = buildChildBrief(context).split("\n").filter((line) => /^\d+\. ima-mcp/.test(line)).map((line) => line.replace(/^\d+\. /, ""));
  const invalidEvents = [
    { toolName: "read", args: { command: commands[0] } },
    { toolName: "bash", args: { command: commands[0] + " --verbose" } },
    { toolName: "bash", args: { command: commands[3].replace("--allow-write", "") } },
    { toolName: "bash", args: { command: "ima-mcp qdrant status --json; env" } },
  ];
  for (const event of invalidEvents) assert.deepEqual(classifyGatewayCommand(event, context), { service: "unknown", operation: "unknown", mutation: false });
});

test("pure core rejects every envelope error form and invalid workflow", () => {
  const rejected = [
    { service: "serena", operation: "status", envelope: { ok: true, command: "serena.status", data: {} } },
    { service: "serena", operation: "status", envelope: { ok: true, command: "serena.project.status", error: { code: "bad" }, data: {} } },
    { service: "qdrant", operation: "status", envelope: { ok: true, command: "qdrant.status", diagnostics: [{ severity: "error" }], data: {} } },
    { service: "vestige", operation: "smart_ingest", envelope: { ok: true, command: "vestige.smart_ingest", result: null } },
  ];
  for (const input of rejected) assert.equal(validateGatewayEnvelope(input).passed, false, JSON.stringify(input));
  const expected = [
    { service: "serena", operation: "status", mutation: false }, { service: "vestige", operation: "status", mutation: false },
    { service: "qdrant", operation: "status", mutation: false }, { service: "vestige", operation: "smart_ingest", mutation: true },
  ];
  for (const events of [[expected[1], expected[0], expected[2], expected[3]], [...expected.slice(0, 3), { service: "vestige", operation: "smart_ingest", mutation: false }]]) assert.deepEqual(evaluateObservedWorkflow(events), { passed: false, errorCode: "unexpected_child_command" });
});

test("result derivation fails for unavailable parent, child, identity, semantic, and workflow evidence", () => {
  const check = (service, operation, passed = true) => ({ service, operation, passed, errorCode: passed ? null : "failed" });
  const base = { schemaVersion: 1, story: "FNR-3011", requestedChild: { provider: "openai", model: "model" }, actualChild: { provider: "openai", model: "model" }, parent: { serena: check("serena", "status"), vestige: check("vestige", "status"), qdrant: check("qdrant", "status") }, child: { serena: check("serena", "status"), vestigeRead: check("vestige", "status"), vestigeIngest: check("vestige", "smart_ingest"), qdrant: check("qdrant", "status") }, semanticCompletion: { ingestAccepted: true, recallMatched: true, lifecycleKeyMatched: true, jiraKeyMatched: true, nonceMatched: true, outcomeMatched: true, physicalShapeIgnored: true }, observedCommands: [{ service: "serena", operation: "status", mutation: false }, { service: "vestige", operation: "status", mutation: false }, { service: "qdrant", operation: "status", mutation: false }, { service: "vestige", operation: "smart_ingest", mutation: true }] };
  const failures = [
    { ...base, parent: { ...base.parent, serena: check("serena", "status", false) } },
    { ...base, child: { ...base.child, qdrant: check("qdrant", "status", false) } },
    { ...base, actualChild: { provider: "openai", model: "other" } },
    { ...base, semanticCompletion: { ...base.semanticCompletion, nonceMatched: false, recallMatched: false } },
    { ...base, observedCommands: base.observedCommands.slice(0, -1) },
  ];
  for (const input of failures) assert.equal(deriveGatewayProbeResult(input).status, "failed");
});


test("deadline uses its singleton discriminator and preserves same-message child failures", async () => {
  await assert.rejects(withDeadline(new Promise(() => {}), 1), (error) => error === CHILD_EXECUTION_TIMEOUT);
  assert.equal(childExecutionErrorCode(CHILD_EXECUTION_TIMEOUT), "child_execution_timeout");
  assert.equal(childExecutionErrorCode(new Error("child_execution_timeout")), "child_execution_failed");
  assert.equal(await withDeadline(Promise.resolve("done"), 20), "done");
  await new Promise((resolve) => setTimeout(resolve, 25));
});
