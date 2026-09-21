import assert from "node:assert/strict";
import test from "node:test";
import {
  CHILD_EXECUTION_TIMEOUT,
  JIRA_KEY,
  LIFECYCLE_KEY,
  MCP_TIMEOUT_MS,
  USAGE,
  buildChildBrief,
  buildLifecyclePayload,
  childExecutionErrorCode,
  childOperations,
  classifyGatewayCommand,
  deriveGatewayProbeResult,
  evaluateCorpusCompletion,
  evaluateObservedWorkflow,
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
const payload = buildLifecyclePayload({ lifecycleKey: LIFECYCLE_KEY, jiraKey: JIRA_KEY, nonce });
const context = { repoPath: "/repo", payload };
const directResult = (text = "ok") => ({ content: [{ type: "text", text }] });
const compactResult = ({ server, tool, text = "ok", error } = {}) => ({
  content: [{ type: "text", text }],
  details: {
    mode: "call",
    server,
    tool,
    ...(error === undefined ? {} : { error }),
  },
});

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
];

const expectedWorkflow = [
  { service: "serena", operation: "activate_project", mutation: false },
  { service: "serena", operation: "get_current_config", mutation: false },
];

const check = (service, operation, passed = true) => ({
  service,
  operation,
  passed,
  errorCode: passed ? null : "failed",
});
const corpusCheck = (operation, mutation, passed = true) => ({
  operation,
  mutation,
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
  },
  child: {
    serenaActivate: check("serena", "activate_project"),
    serenaConfig: check("serena", "get_current_config"),
  },
  corpus: {
    store: corpusCheck("logical_store", true),
    directGet: corpusCheck("direct_get", false),
  },
  semanticCompletion: {
    storeAccepted: true,
    directGetMatched: true,
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

test("child contract uses exactly two ordered read-only Serena operations", () => {
  const brief = buildChildBrief(context);
  assert.deepEqual(childOperations(context).map(({ compactTool, mutation }) => [compactTool, mutation]), [
    ["serena_activate_project", false],
    ["serena_get_current_config", false],
  ]);
  assert.doesNotMatch(brief, /vestige/i);
  assert.doesNotMatch(brief, /smart_ingest/i);
  assert.match(brief, /Do not modify the repository/i);
  assert.match(payload, /parent-side native Qdrant lifecycle checks/i);
});

test("classifier permits only the exact compact read operations in order", () => {
  assert.deepEqual(expectedEvents.map((event) => classifyGatewayCommand(event, context)), expectedWorkflow);
  assert.deepEqual(evaluateObservedWorkflow(expectedWorkflow), { passed: true, errorCode: null });
  assert.deepEqual(evaluateObservedWorkflow([...expectedWorkflow].reverse()), {
    passed: false,
    errorCode: "unexpected_child_command",
  });
  assert.deepEqual(classifyGatewayCommand({
    toolName: "mcp",
    args: { server: "vestige", tool: "vestige_smart_ingest", args: {} },
  }, context), {
    service: "unknown",
    operation: "unknown",
    mutation: false,
  });
});

test("parent checks use native Serena tool names with exact arguments", async () => {
  const calls = [];
  const session = async (server, callback) => callback(async (tool, args, timeout) => {
    calls.push({ server, tool, args, timeout });
    return directResult();
  });
  const checks = await Promise.all(childOperations(context).map((operation) => runParentCheck(operation, session)));

  assert.equal(checks.every((result) => result.passed), true);
  assert.deepEqual(calls, [
    { server: "serena", tool: "activate_project", args: { project: "/repo" }, timeout: MCP_TIMEOUT_MS },
    { server: "serena", tool: "get_current_config", args: {}, timeout: MCP_TIMEOUT_MS },
  ]);
});

test("gateway result validation fails closed for direct and compact failure shapes", () => {
  assert.equal(directCheck(directResult()).passed, true);
  assert.equal(compactCheck(compactResult({ server: "serena", tool: "activate_project" })).passed, true);
  for (const result of [undefined, {}, { isError: true }, { content: [] }]) {
    assert.equal(directCheck(result).passed, false);
  }
  assert.equal(compactCheck(compactResult({ server: "serena", tool: "activate_project", error: "call_failed" })).passed, false);
  assert.equal(compactCheck(compactResult({ server: "vestige", tool: "activate_project" })).passed, false);
  assert.equal(compactCheck(compactResult({ server: "serena", tool: "activate_project" }), true).passed, false);
});

test("corpus completion requires a successful logical store and matching direct detail", () => {
  const store = { success: true, data: { status: "stored" } };
  const directRecord = { detail: payload };
  const complete = evaluateCorpusCompletion({
    store,
    directRecord,
    lifecycleKey: LIFECYCLE_KEY,
    jiraKey: JIRA_KEY,
    nonce,
  });
  assert.equal(complete.passed, true);
  assert.equal(complete.physicalShapeIgnored, true);

  for (const invalid of [null, { detail: payload.replace(nonce, "other") }, { detail: `${LIFECYCLE_KEY} ${JIRA_KEY}` }]) {
    assert.equal(evaluateCorpusCompletion({
      store,
      directRecord: invalid,
      lifecycleKey: LIFECYCLE_KEY,
      jiraKey: JIRA_KEY,
      nonce,
    }).passed, false);
  }
  assert.equal(evaluateCorpusCompletion({
    store: { success: false },
    directRecord,
    lifecycleKey: LIFECYCLE_KEY,
    jiraKey: JIRA_KEY,
    nonce,
  }).passed, false);
});

test("MCP policy rejects off-contract Vestige calls and permits only Serena operations", async () => {
  let state = createMcpPolicyState(expectedEvents.map(({ args }) => args));
  const attempt = (input) => {
    const decision = authorizeMcpPolicyCall(state, input);
    state = decision.state;
    return decision.allowed;
  };

  assert.equal(attempt({
    server: "vestige",
    tool: "vestige_session_start",
    args: {
      queries: ["user preferences"],
      include_intentions: false,
      include_predictions: false,
      include_status: false,
    },
  }), false);
  assert.equal(attempt({ server: "vestige", tool: "vestige_smart_ingest", args: {} }), false);
  assert.equal(attempt(expectedEvents[0].args), true);
  assert.equal(attempt(expectedEvents[1].args), true);
  assert.equal(attempt(expectedEvents[1].args), false);
  await assert.rejects(createMcpChildRuntime({
    cwd: "/tmp",
    model: {},
    modelRuntime: {},
    tools: ["mcp"],
    sessionManager: {},
  }), /mcp_policy_required/);
});

test("result derivation requires all read checks, corpus checks, identity, and direct verification", () => {
  const base = successfulResult();
  assert.equal(deriveGatewayProbeResult(base).status, "passed");
  assert.equal(deriveGatewayProbeResult({ ...base, actualChild: null }).status, "failed");
  assert.equal(deriveGatewayProbeResult({
    ...base,
    corpus: { ...base.corpus, store: corpusCheck("logical_store", true, false) },
  }).status, "failed");
  assert.equal(deriveGatewayProbeResult({
    ...base,
    semanticCompletion: { ...base.semanticCompletion, directGetMatched: false },
  }).status, "failed");
});

test("sanitization and deadline do not expose provider details", async () => {
  assert.deepEqual(sanitizeGatewayError("child_execution_failed", "token=secret raw provider response"), {
    code: "child_execution_failed",
    message: "Gateway probe failed: child_execution_failed.",
  });
  await assert.rejects(withDeadline(new Promise(() => {}), 1), (error) => error === CHILD_EXECUTION_TIMEOUT);
  assert.equal(childExecutionErrorCode(CHILD_EXECUTION_TIMEOUT), "child_execution_timeout");
  assert.equal(childExecutionErrorCode(new Error("timeout")), "child_execution_failed");
  assert.equal(await withDeadline(Promise.resolve("done"), 20), "done");
});
