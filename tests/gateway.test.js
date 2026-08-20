import assert from "node:assert/strict";
import test from "node:test";
import {
  CHILD_EXECUTION_TIMEOUT,
  JIRA_KEY,
  LIFECYCLE_KEY,
  MCP_TIMEOUT_MS,
  QDRANT_PROBE_QUERY,
  USAGE,
  buildChildBrief,
  buildLifecyclePayload,
  childExecutionErrorCode,
  childOperations,
  classifyGatewayCommand,
  deriveGatewayProbeResult,
  evaluateObservedWorkflow,
  evaluateSemanticCompletion,
  parseGatewayProbeArgs,
  parseModelSelector,
  runParentCheck,
  sanitizeGatewayError,
  validateGatewayResult,
  withDeadline,
} from "../extensions/gateway-probe.ts";
import {
  authorizeMcpPolicyCall,
  createMcpChildRuntime,
  createMcpPolicyState,
} from "../extensions/mcp.ts";

const nonce = "01234567-89ab-cdef-0123-456789abcdef";
const payload = buildLifecyclePayload({
  lifecycleKey: LIFECYCLE_KEY,
  jiraKey: JIRA_KEY,
  nonce,
});
const context = { repoPath: "/repo", payload };
const directResult = (text = "ok") => ({
  content: [{ type: "text", text }],
});
const compactResult = ({ server, tool, text = "ok", error } = {}) => ({
  content: [{ type: "text", text }],
  details: {
    mode: "call",
    server,
    tool,
    ...(error === undefined ? {} : { error }),
  },
});
const recalled = (results) => ({ structuredContent: { results } });
const expectedEvents = [
  {
    toolName: "mcp",
    args: {
      server: "serena",
      tool: "serena_activate_project",
      args: { project: "/repo" },
    },
  },
  {
    toolName: "mcp",
    args: {
      server: "serena",
      tool: "serena_get_current_config",
      args: {},
    },
  },
  {
    toolName: "mcp",
    args: {
      server: "vestige",
      tool: "vestige_memory_status",
      args: { view: "health" },
    },
  },
  {
    toolName: "mcp",
    args: {
      server: "qdrant-memory",
      tool: "qdrant_memory_qdrant_find",
      args: { query: QDRANT_PROBE_QUERY, limit: 1 },
    },
  },
  {
    toolName: "mcp",
    args: {
      server: "vestige",
      tool: "vestige_smart_ingest",
      args: {
        content: payload,
        node_type: "event",
        tags: ["FNR-3011", "gateway-probe"],
      },
    },
  },
];
const expectedWorkflow = [
  { service: "serena", operation: "activate_project", mutation: false },
  { service: "serena", operation: "get_current_config", mutation: false },
  { service: "vestige", operation: "memory_status", mutation: false },
  { service: "qdrant-memory", operation: "qdrant_find", mutation: false },
  { service: "vestige", operation: "smart_ingest", mutation: true },
];

const check = (service, operation, passed = true) => ({
  service,
  operation,
  passed,
  errorCode: passed ? null : "failed",
});

const successfulResult = () => ({
  schemaVersion: 1,
  story: "FNR-3011",
  requestedChild: { provider: "openai", model: "model" },
  actualChild: { provider: "openai", model: "model" },
  parent: {
    serenaActivate: check("serena", "activate_project"),
    serenaConfig: check("serena", "get_current_config"),
    vestige: check("vestige", "memory_status"),
    qdrant: check("qdrant-memory", "qdrant_find"),
  },
  child: {
    serenaActivate: check("serena", "activate_project"),
    serenaConfig: check("serena", "get_current_config"),
    vestigeRead: check("vestige", "memory_status"),
    qdrant: check("qdrant-memory", "qdrant_find"),
    vestigeIngest: check("vestige", "smart_ingest"),
  },
  semanticCompletion: {
    ingestAccepted: true,
    recallMatched: true,
    lifecycleKeyMatched: true,
    jiraKeyMatched: true,
    nonceMatched: true,
    outcomeMatched: true,
    physicalShapeIgnored: true,
  },
  observedCommands: expectedWorkflow,
});

const directCheck = (result) => validateGatewayResult({
  service: "serena",
  operation: "activate_project",
  kind: "direct",
  expected: { server: "serena", tool: "activate_project" },
  result,
});

const compactCheck = (result, isError) => validateGatewayResult({
  service: "serena",
  operation: "activate_project",
  kind: "compact",
  expected: { server: "serena", tool: "activate_project" },
  result,
  isError,
});

test("selector and command grammar accept one nested provider/model selector only", () => {
  assert.deepEqual(parseModelSelector("openrouter/openai/gpt-5.4"), {
    valid: true,
    provider: "openrouter",
    model: "openai/gpt-5.4",
  });
  assert.deepEqual(parseGatewayProbeArgs("openai/gpt-5.4-mini"), {
    provider: "openai",
    model: "gpt-5.4-mini",
  });
  for (const input of ["", "openai", "/model", "openai/", "openai/model extra"]) {
    assert.deepEqual(parseGatewayProbeArgs(input), {
      error: "invalid_arguments",
      message: USAGE,
    });
  }
});

test("payload and child brief carry fixed compact-MCP and safety contracts", () => {
  const brief = buildChildBrief(context);
  for (const text of [
    LIFECYCLE_KEY,
    JIRA_KEY,
    nonce,
    "implementation-probe",
    "completed",
    "serena_activate_project",
    "serena_get_current_config",
    "vestige_memory_status",
    "qdrant_memory_qdrant_find",
    "vestige_smart_ingest",
    "use only mcp",
  ]) {
    assert.match(
      payload.includes(text) ? payload : brief,
      new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    );
  }
  assert.match(brief, /Do not modify the repository/i);
  assert.match(brief, /do not run shell commands/i);
  assert.doesNotMatch(brief, /bash command|user supplied shell fragment/i);
});

test("classifier permits only the exact five compact MCP operations in order", () => {
  assert.deepEqual(
    expectedEvents.map((event) => classifyGatewayCommand(event, context)),
    expectedWorkflow,
  );
  assert.deepEqual(evaluateObservedWorkflow(expectedWorkflow), {
    passed: true,
    errorCode: null,
  });
});

test("classifier rejects shell, wrong server, extra arguments, and malformed MCP calls", () => {
  const invalidEvents = [
    { toolName: "bash", args: { command: "echo unexpected" } },
    { ...expectedEvents[0], args: { ...expectedEvents[0].args, server: "vestige" } },
    { ...expectedEvents[0], args: { ...expectedEvents[0].args, args: { project: "/repo", extra: true } } },
    { ...expectedEvents[3], args: { ...expectedEvents[3].args, args: { query: "unbounded", limit: 1 } } },
    { toolName: "mcp", args: { server: "serena", tool: "serena_activate_project" } },
  ];
  for (const event of invalidEvents) {
    assert.deepEqual(classifyGatewayCommand(event, context), {
      service: "unknown",
      operation: "unknown",
      mutation: false,
    });
  }
  assert.deepEqual(evaluateObservedWorkflow([
    expectedWorkflow[1],
    expectedWorkflow[0],
    ...expectedWorkflow.slice(2),
  ]), {
    passed: false,
    errorCode: "unexpected_child_command",
  });
  assert.deepEqual(evaluateObservedWorkflow([
    ...expectedWorkflow,
    { service: "unknown", operation: "unknown", mutation: false },
  ]), {
    passed: false,
    errorCode: "unexpected_child_command",
  });
});

test("parent checks use native server tool names with exact arguments", async () => {
  const calls = [];
  const session = async (server, callback) => callback(async (tool, args, timeout) => {
    calls.push({ server, tool, args, timeout });
    return directResult();
  });
  const checks = await Promise.all(
    childOperations(context).slice(0, 4).map((operation) => runParentCheck(operation, session)),
  );

  assert.equal(checks.every((result) => result.passed), true);
  assert.deepEqual(calls, [
    { server: "serena", tool: "activate_project", args: { project: "/repo" }, timeout: MCP_TIMEOUT_MS },
    { server: "serena", tool: "get_current_config", args: {}, timeout: MCP_TIMEOUT_MS },
    { server: "vestige", tool: "memory_status", args: { view: "health" }, timeout: MCP_TIMEOUT_MS },
    { server: "qdrant-memory", tool: "qdrant_find", args: { query: QDRANT_PROBE_QUERY, limit: 1 }, timeout: MCP_TIMEOUT_MS },
  ]);
});

test("gateway result validation fails closed for direct and compact failure shapes", () => {
  assert.equal(directCheck(directResult()).passed, true);
  assert.equal(compactCheck(compactResult({ server: "serena", tool: "activate_project" })).passed, true);

  for (const result of [undefined, {}, { isError: true }, { content: [] }]) {
    assert.equal(directCheck(result).passed, false);
  }
  for (const error of ["tool_error", "call_failed", "auth_required", "init_failed", "connect_failed"]) {
    assert.equal(compactCheck(compactResult({
      server: "serena",
      tool: "activate_project",
      error,
    })).passed, false);
  }
  assert.equal(compactCheck(compactResult({
    server: "vestige",
    tool: "activate_project",
  })).passed, false);
  assert.equal(compactCheck(compactResult({
    server: "serena",
    tool: "other",
  })).passed, false);
  assert.equal(compactCheck(compactResult({
    server: "serena",
    tool: "activate_project",
  }), true).passed, false);
});

test("semantic completion accepts valid compact ingest and direct or proxy recall", () => {
  const result = { metadata: { arbitrary: "shape" }, nested: [{ text: payload }] };
  const recallShapes = [
    recalled([result]),
    { content: [{ type: "text", text: JSON.stringify({ results: [result] }) }] },
    { data: { results: [result] } },
  ];
  for (const recalledMemories of recallShapes) {
    const semantic = evaluateSemanticCompletion({
      ingestResult: compactResult({ server: "vestige", tool: "smart_ingest" }),
      recalledMemories,
      lifecycleKey: LIFECYCLE_KEY,
      jiraKey: JIRA_KEY,
      nonce,
    });
    assert.equal(semantic.passed, true);
    assert.equal(semantic.physicalShapeIgnored, true);
  }
});

test("semantic completion fails closed unless one result contains every marker", () => {
  const input = {
    ingestResult: compactResult({ server: "vestige", tool: "smart_ingest" }),
    lifecycleKey: LIFECYCLE_KEY,
    jiraKey: JIRA_KEY,
    nonce,
  };
  const failures = [
    recalled([]),
    recalled([{ content: payload.replace(nonce, "other") }]),
    recalled([{ content: `${LIFECYCLE_KEY} ${JIRA_KEY}` }, { content: `${nonce} completed` }]),
    { structuredContent: { metadata: { content: payload } } },
    { structuredContent: { results: {} } },
  ];
  for (const recalledMemories of failures) {
    assert.equal(evaluateSemanticCompletion({ ...input, recalledMemories }).passed, false);
  }
  assert.equal(evaluateSemanticCompletion({
    ...input,
    ingestIsError: true,
    recalledMemories: recalled([{ content: payload }]),
  }).passed, false);
});

test("MCP policy blocks off-contract calls before a fake adapter executes", async () => {
  const policy = expectedEvents.map(({ args }) => args);
  let state = createMcpPolicyState(policy);
  const executed = [];
  const attempt = (input) => {
    const decision = authorizeMcpPolicyCall(state, input);
    state = decision.state;
    if (decision.allowed) executed.push(input);
    return decision.allowed;
  };

  assert.equal(attempt({
    server: "vestige",
    tool: "vestige_smart_ingest",
    args: { content: "destructive", node_type: "event", tags: [] },
  }), false);
  assert.equal(attempt({
    server: "serena",
    tool: "serena_get_current_config",
    args: { project: "/repo" },
  }), false);
  assert.equal(attempt(expectedEvents[0].args), true);
  assert.equal(attempt(expectedEvents[0].args), false);
  assert.equal(attempt(expectedEvents[2].args), false);
  assert.equal(attempt({
    ...expectedEvents[1].args,
    args: { extra: true },
  }), false);
  assert.equal(attempt(expectedEvents[1].args), true);
  assert.equal(attempt(expectedEvents[2].args), true);
  assert.equal(attempt(expectedEvents[3].args), true);
  assert.equal(attempt(expectedEvents[4].args), true);
  assert.equal(executed.length, 5);

  await assert.rejects(createMcpChildRuntime({
    cwd: "/tmp",
    model: {},
    modelRuntime: {},
    tools: ["mcp"],
    sessionManager: {},
  }), /mcp_policy_required/);
});

test("result derivation requires checks, exact child identity, workflow, and semantic completion", () => {
  const base = successfulResult();
  assert.equal(deriveGatewayProbeResult(base).status, "passed");
  assert.equal(deriveGatewayProbeResult({ ...base, actualChild: null }).status, "failed");
  assert.equal(deriveGatewayProbeResult({
    ...base,
    parent: {
      ...base.parent,
      qdrant: check("qdrant-memory", "qdrant_find", false),
    },
  }).status, "failed");
  assert.equal(deriveGatewayProbeResult({
    ...base,
    child: {
      ...base.child,
      vestigeIngest: check("vestige", "smart_ingest", false),
    },
  }).status, "failed");
  assert.equal(deriveGatewayProbeResult({
    ...base,
    semanticCompletion: { ...base.semanticCompletion, recallMatched: false },
  }).status, "failed");
});

test("sanitization never echoes sensitive error material", () => {
  const error = sanitizeGatewayError(
    "child_execution_failed",
    "token=secret raw memory provider response",
  );
  assert.deepEqual(error, {
    code: "child_execution_failed",
    message: "Gateway probe failed: child_execution_failed.",
  });
});

test("deadline uses its singleton discriminator and preserves child failures", async () => {
  await assert.rejects(
    withDeadline(new Promise(() => {}), 1),
    (error) => error === CHILD_EXECUTION_TIMEOUT,
  );
  assert.equal(childExecutionErrorCode(CHILD_EXECUTION_TIMEOUT), "child_execution_timeout");
  assert.equal(childExecutionErrorCode(new Error("child_execution_timeout")), "child_execution_failed");
  assert.equal(await withDeadline(Promise.resolve("done"), 20), "done");
  await new Promise((resolve) => setTimeout(resolve, 25));
});
