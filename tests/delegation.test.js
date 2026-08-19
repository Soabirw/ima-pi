import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  NONCE_MARKER,
  RESEARCH_URL,
  SERENA_ACTIVATE_TOOL,
  assistantExecutionFailed,
  childIdentityVerified,
  buildFollowUpBrief,
  buildStartBrief,
  classifyToolEvent,
  evaluateAuthorityEvidence,
  evaluateContinuity,
  extractNonceFromText,
  independentRouting,
  modelIdentity,
  openFollowUpSession,
  parseDelegationProbeArgs,
  parseModelSelector,
  sanitizeError,
  withResultWriteFailure,
} from "../extensions/delegation-probe.ts";

const requiredTools = [
  { tool: "read", category: "file-read" },
  { tool: "write", category: "file-write" },
  { tool: "bash", category: "shell" },
  { tool: "bash", category: "research" },
  { tool: "mcp", category: "integration" },
];

test("parseModelSelector splits provider and model", () => {
  assert.deepEqual(parseModelSelector("openai/gpt-5.4-mini"), {
    valid: true,
    provider: "openai",
    model: "gpt-5.4-mini",
  });
});

test("parseModelSelector preserves nested model-id slashes", () => {
  assert.deepEqual(parseModelSelector(" openrouter/openai/gpt-5.4 "), {
    valid: true,
    provider: "openrouter",
    model: "openai/gpt-5.4",
  });
});

test("parseModelSelector rejects empty and malformed selectors", () => {
  for (const input of [undefined, "", "openai", "/gpt", "openai/", " / "]) {
    assert.equal(parseModelSelector(input).valid, false, String(input));
  }
});

test("parseDelegationProbeArgs parses exact start grammar", () => {
  assert.deepEqual(parseDelegationProbeArgs("start openai/gpt-5.4-mini"), {
    mode: "start",
    provider: "openai",
    model: "gpt-5.4-mini",
  });
});

test("parseDelegationProbeArgs requires an absolute follow-up session path", () => {
  assert.deepEqual(
    parseDelegationProbeArgs("follow-up openai/gpt-5.4-mini /tmp/session.jsonl"),
    {
      mode: "follow-up",
      provider: "openai",
      model: "gpt-5.4-mini",
      sessionFile: "/tmp/session.jsonl",
    },
  );
  assert.equal(
    parseDelegationProbeArgs("follow-up openai/gpt-5.4-mini relative.jsonl").error,
    "invalid_arguments",
  );
});

test("parseDelegationProbeArgs rejects unsupported modes and extra arguments", () => {
  for (const input of [
    "",
    "other openai/gpt-5.4-mini",
    "start openai/gpt-5.4-mini extra",
    "follow-up openai/gpt-5.4-mini /tmp/session.jsonl extra",
  ]) {
    assert.equal(parseDelegationProbeArgs(input).error, "invalid_arguments", input);
  }
});

test("buildStartBrief contains fixed operations and safety boundaries", () => {
  const brief = buildStartBrief({
    workspace: "/tmp/workspace",
    repoPath: "/home/eric/IMA/dev/ima-pi",
    nonce: "01234567-89ab-cdef-0123-456789abcdef",
  });

  for (const expected of [
    "/tmp/workspace",
    "/home/eric/IMA/dev/ima-pi",
    "01234567-89ab-cdef-0123-456789abcdef",
    RESEARCH_URL,
    SERENA_ACTIVATE_TOOL,
    "Do not modify the IMA Pi repository",
    "Do not run destructive commands",
  ]) {
    assert.match(brief, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(brief, /Use the mcp tool exactly once/);
  assert.doesNotMatch(brief, /ima-mcp/);
});

test("openFollowUpSession uses the persisted header cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-pi-delegation-session-"));
  const sessionDirectory = join(root, "sessions");
  const workspace = join(root, "workspace");
  const sessionFile = join(sessionDirectory, "child.jsonl");
  try {
    await Promise.all([mkdir(sessionDirectory), mkdir(workspace)]);
    await writeFile(sessionFile, `${JSON.stringify({
      type: "session",
      version: 3,
      id: "01234567-89ab-cdef-0123-456789abcdef",
      timestamp: "2026-08-19T00:00:00.000Z",
      cwd: workspace,
    })}\n`);

    const reopened = openFollowUpSession(sessionFile);
    assert.equal(reopened.cwd, workspace);
    assert.equal(reopened.sessionManager.getCwd(), workspace);
    assert.notEqual(dirname(sessionFile), workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildFollowUpBrief requires retained context and forbids tools", () => {
  const nonce = "01234567-89ab-cdef-0123-456789abcdef";
  const brief = buildFollowUpBrief(nonce);
  assert.match(brief, /Do NOT use any tools/);
  assert.match(brief, new RegExp(`${NONCE_MARKER}=<value>`));
  assert.doesNotMatch(brief, new RegExp(nonce));
});

test("extractNonceFromText recovers only the persisted nonce marker", () => {
  const nonce = "01234567-89ab-cdef-0123-456789abcdef";
  assert.equal(extractNonceFromText(`prefix ${NONCE_MARKER}=${nonce} suffix`), nonce);
  assert.equal(extractNonceFromText("no marker"), null);
});

test("modelIdentity reports actual Pi provider and id", () => {
  assert.deepEqual(modelIdentity({ provider: "openai", id: "gpt-5.4-mini" }), {
    provider: "openai",
    model: "gpt-5.4-mini",
  });
  assert.equal(modelIdentity(undefined), null);
});

test("classifyToolEvent grants categories only for exact controlled paths and commands", () => {
  const context = {
    seedPath: "/workspace/seed.txt",
    markerPath: "/workspace/marker.txt",
    repoPath: "/repo",
  };
  const events = [
    { toolName: "read", args: { path: "/workspace/seed.txt" } },
    { toolName: "write", args: { path: "/workspace/marker.txt", content: "secret" } },
    { toolName: "bash", args: { command: "pwd" } },
    { toolName: "bash", args: { command: `curl -fsSL --max-time 20 ${RESEARCH_URL}` } },
    { toolName: "mcp", args: { server: "serena", tool: SERENA_ACTIVATE_TOOL, args: { project: "/repo" } } },
    { toolName: "bash", args: { command: "env" } },
  ];

  assert.deepEqual(
    events.map((event) => classifyToolEvent(event, context)),
    [
      { tool: "read", category: "file-read" },
      { tool: "write", category: "file-write" },
      { tool: "bash", category: "shell" },
      { tool: "bash", category: "research" },
      { tool: "mcp", category: "integration" },
      { tool: "bash", category: "other" },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(events.map((event) => classifyToolEvent(event, context))),
    /secret|curl|env/,
  );
});

test("classifyToolEvent rejects off-target paths and commands", () => {
  const context = {
    seedPath: "/workspace/seed.txt",
    markerPath: "/workspace/marker.txt",
    repoPath: "/repo",
  };
  const offTarget = [
    { toolName: "read", args: { path: "/etc/passwd" } },
    { toolName: "write", args: { path: "/workspace/other.txt", content: "x" } },
    { toolName: "bash", args: { command: "curl -fsSL https://evil.example" } },
    { toolName: "bash", args: { command: "printf hi" } },
    { toolName: "mcp", args: { server: "serena", tool: SERENA_ACTIVATE_TOOL, args: { project: "/repo", extra: true } } },
  ];
  assert.deepEqual(
    offTarget.map((event) => classifyToolEvent(event, context).category),
    ["other", "other", "other", "other", "other"],
  );
});

test("evaluateAuthorityEvidence fails when any required signal is missing", () => {
  const completeInput = {
    observedTools: requiredTools,
    markerVerified: true,
    completedWithoutError: true,
  };
  const missingVariants = [
    ...requiredTools.map((_, index) => ({
      ...completeInput,
      observedTools: requiredTools.filter((__, candidate) => candidate !== index),
    })),
    { ...completeInput, markerVerified: false },
    { ...completeInput, completedWithoutError: false },
  ];

  for (const variant of missingVariants) {
    assert.equal(evaluateAuthorityEvidence(variant).passed, false);
  }
});

test("evaluateAuthorityEvidence fails when unexpected tool activity accompanies complete evidence", () => {
  assert.equal(
    evaluateAuthorityEvidence({
      observedTools: [
        ...requiredTools,
        { tool: "bash", category: "other" },
      ],
      markerVerified: true,
      completedWithoutError: true,
    }).passed,
    false,
  );
});

test("evaluateAuthorityEvidence passes complete event and filesystem evidence", () => {
  assert.deepEqual(
    evaluateAuthorityEvidence({
      observedTools: requiredTools,
      markerVerified: true,
      completedWithoutError: true,
    }),
    {
      authority: {
        fileRead: true,
        fileWrite: true,
        shell: true,
        research: true,
        integration: true,
        markerVerified: true,
      },
      passed: true,
    },
  );
});

const completeContinuity = {
  persistedSessionId: "session-1",
  reopenedSessionId: "session-1",
  requestedSessionFile: "/tmp/session.jsonl",
  reopenedSessionFile: "/tmp/session.jsonl",
  requested: { provider: "openai", model: "gpt-5.4-mini" },
  actual: { provider: "openai", model: "gpt-5.4-mini" },
  assistantText: "nonce: 01234567-89ab-cdef-0123-456789abcdef",
  nonce: "01234567-89ab-cdef-0123-456789abcdef",
  followUpToolCount: 0,
  completedWithoutError: true,
};

test("evaluateContinuity requires session id, file, model, nonce, and zero tools", () => {
  assert.equal(evaluateContinuity(completeContinuity).passed, true);

  const failing = [
    { ...completeContinuity, reopenedSessionId: "session-2" },
    { ...completeContinuity, reopenedSessionFile: "/tmp/other.jsonl" },
    { ...completeContinuity, actual: { provider: "anthropic", model: "gpt-5.4-mini" } },
    { ...completeContinuity, assistantText: "forgot" },
    { ...completeContinuity, followUpToolCount: 1 },
    { ...completeContinuity, completedWithoutError: false },
  ];
  for (const variant of failing) {
    assert.equal(evaluateContinuity(variant).passed, false);
  }
});

test("childIdentityVerified requires exact model and persisted identity", () => {
  const requested = { provider: "openai", model: "gpt-5.4-mini" };
  const actual = { ...requested };
  assert.equal(childIdentityVerified(requested, actual, "session-1", "/tmp/session.jsonl"), true);
  assert.equal(childIdentityVerified(requested, null, "session-1", "/tmp/session.jsonl"), false);
  assert.equal(
    childIdentityVerified(requested, { provider: "openai", model: "other" }, "session-1", "/tmp/session.jsonl"),
    false,
  );
  assert.equal(childIdentityVerified(requested, actual, "", "/tmp/session.jsonl"), false);
  assert.equal(childIdentityVerified(requested, actual, "session-1", "relative.jsonl"), false);
});

test("assistantExecutionFailed detects provider failures recorded as resolved turns", () => {
  assert.equal(
    assistantExecutionFailed([{ role: "user" }, { role: "assistant", stopReason: "error" }]),
    true,
  );
  assert.equal(
    assistantExecutionFailed([{ role: "assistant", stopReason: "stop" }]),
    false,
  );
});

test("result helpers expose only stable identities and sanitized errors", () => {
  assert.deepEqual(
    independentRouting(
      { provider: "anthropic", model: "claude-sonnet-4-6" },
      { provider: "openai", model: "gpt-5.4-mini" },
    ),
    { providerDiffers: true, modelDiffers: true },
  );
  const error = sanitizeError(
    "child_execution_failed",
    new Error("provider unavailable API_KEY=not-for-evidence Bearer secret-token sk-live-secret\nSTACK"),
  );
  assert.deepEqual(error, {
    code: "child_execution_failed",
    message:
      "provider unavailable API_KEY=[redacted] Bearer [redacted] sk-[redacted]",
  });
  assert.doesNotMatch(JSON.stringify(error), /not-for-evidence|secret-token|live-secret|STACK/);
});

test("withResultWriteFailure fails passed and failed results while preserving evidence", () => {
  const evidence = {
    child: {
      provider: "openai",
      model: "gpt-5.4-mini",
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
    },
    authority: {
      fileRead: true,
      fileWrite: true,
      shell: true,
      research: true,
      integration: true,
      markerVerified: true,
    },
    continuity: null,
    observedTools: requiredTools,
  };
  const base = {
    schemaVersion: 1,
    story: "FNR-3009",
    mode: "start",
    requestedChild: { provider: "openai", model: "gpt-5.4-mini" },
    parent: { provider: "anthropic", model: "claude-sonnet-4-6" },
    independentRouting: { providerDiffers: true, modelDiffers: true },
    workspace: "/tmp/workspace",
    ...evidence,
  };

  for (const original of [
    { ...base, status: "passed", error: null },
    {
      ...base,
      status: "failed",
      error: { code: "authority_incomplete", message: "prior failure" },
    },
  ]) {
    const result = withResultWriteFailure(
      original,
      new Error("Authorization: Bearer raw-write-secret"),
    );
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "result_write_failed");
    assert.doesNotMatch(JSON.stringify(result.error), /raw-write-secret/);
    assert.deepEqual(
      {
        child: result.child,
        authority: result.authority,
        continuity: result.continuity,
        observedTools: result.observedTools,
      },
      evidence,
    );
  }
});

test("sanitizeError redacts a bearer credential assigned to authorization", () => {
  const error = sanitizeError(
    "child_execution_failed",
    "Authorization: Bearer secret-token",
  );

  assert.doesNotMatch(JSON.stringify(error), /secret-token/);
});
