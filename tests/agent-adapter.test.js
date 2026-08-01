import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { coordinateDelegation, createScopedTools } from "../extensions/agents.ts";

const agent = {
  schemaVersion: 1, name: "implementer", description: "Implement", tier: "MID", authority: "write",
  tools: ["read", "write", "edit", "bash"], skills: [], delegation: { allowed: false, maxDepth: 0 },
  independence: { freshInitial: false, followUpAllowed: true }, result: { kind: "implementation", requiredSections: ["files", "verification"] },
  escalation: ["scope"], prompt: "Implement safely.", source: "package", path: "/agents/implementer.md",
};
const assignment = (id, writeScope = ["owned"]) => ({ id, agent: "implementer", goal: "Change code", context: "Approved", paths: ["owned/file.txt"], constraints: [], nonGoals: [], expectedOutput: "report", writeScope });
const config = { models: { MID: { provider: "p", model: "m", thinking: "high" } } };
const runtime = { getModels: () => [{ provider: "p", id: "m", input: ["text"] }], getModel: (provider, model) => provider === "p" && model === "m" ? { provider, id: model } : undefined };
const report = "## Files\nowned/file.txt\n\n## Verification\npassed";

const fakeSession = (overrides = {}) => {
  const state = {
    aborts: 0, disposes: 0, prompts: [], unsubscribes: 0,
    messages: [{ role: "assistant", stopReason: "stop", content: [] }],
    ...overrides.state,
  };
  const listeners = [];
  const session = {
    messages: state.messages,
    model: { provider: "p", id: "m" }, thinkingLevel: "high", sessionId: overrides.sessionId ?? "session", sessionFile: overrides.sessionFile ?? "/sessions/session.jsonl",
    subscribe: (listener) => { listeners.push(listener); return () => { state.unsubscribes += 1; }; },
    prompt: async (brief, options) => { state.prompts.push({ brief, options }); await overrides.prompt?.({ state, listeners, session }); },
    waitForIdle: async () => overrides.waitForIdle?.({ state, listeners, session }),
    getLastAssistantText: () => overrides.text ?? report,
    abort: async () => { state.aborts += 1; await overrides.abort?.({ state, listeners, session }); },
    dispose: () => { state.disposes += 1; },
  };
  return { session, state };
};

const run = ({ assignments = [assignment("a")], sessions, signal, onActivity, selectedConfig = config, selectedRuntime = runtime } = {}) => {
  let index = 0;
  let tick = 1_000;
  return coordinateDelegation({
    cwd: "/repo", request: { title: "work", assignments }, agents: [agent], config: selectedConfig, runtime: selectedRuntime, runId: "tool-call", onActivity, signal,
    sessionStore: new Map(), dependencies: {
      createManager: () => ({}), scopedTools: () => [], clock: () => "2026-07-31T20:00:00.000Z", activityClock: () => tick += 10,
      createSession: async () => sessions[index++],
    },
  });
};

test("scoped write and edit permit owned targets and deny sibling, parent, traversal, symlink, and ambiguous bash effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-agent-adapter-"));
  const outside = await mkdtemp(join(tmpdir(), "ima-agent-outside-"));
  await mkdir(join(root, "owned"));
  await mkdir(join(root, "sibling"));
  await writeFile(join(root, "owned", "edit.txt"), "before\n");
  await symlink(outside, join(root, "owned", "escape"));
  const tools = createScopedTools({ cwd: root, assignment: assignment("a"), agent });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const invoke = (name, args) => byName.get(name).execute("call", args, undefined, undefined, {});

  await invoke("write", { path: "owned/new.txt", content: "owned" });
  await invoke("edit", { path: "owned/edit.txt", edits: [{ oldText: "before", newText: "after" }] });
  assert.equal(await readFile(join(root, "owned", "new.txt"), "utf8"), "owned");
  assert.equal(await readFile(join(root, "owned", "edit.txt"), "utf8"), "after\n");

  const denied = [
    ["write", { path: "sibling/no.txt", content: "no" }],
    ["write", { path: "../parent-no.txt", content: "no" }],
    ["write", { path: "owned/../sibling/no.txt", content: "no" }],
    ["write", { path: "owned/escape/no.txt", content: "no" }],
    ["bash", { command: "rm owned/edit.txt" }],
    ["bash", { command: "echo pwn>sibling/no-space.txt" }],
  ];
  for (const [name, args] of denied) await assert.rejects(invoke(name, args));
  assert.equal(existsSync(join(root, "sibling", "no.txt")), false);
  assert.equal(existsSync(join(root, "sibling", "no-space.txt")), false);
  assert.equal(existsSync(join(root, "..", "parent-no.txt")), false);
  assert.equal(existsSync(join(outside, "no.txt")), false);
  assert.equal(existsSync(join(root, "owned", "edit.txt")), true);
});

test("coordinates concurrent children but returns results in request order with observed reports and identity", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = fakeSession({ sessionId: "s-a", sessionFile: "/sessions/a.jsonl", waitForIdle: () => firstGate });
  const second = fakeSession({ sessionId: "s-b", sessionFile: "/sessions/b.jsonl", waitForIdle: () => { releaseFirst(); } });
  const result = await run({ assignments: [assignment("a", ["owned/a"]), assignment("b", ["owned/b"])], sessions: [{ session: first.session }, { session: second.session }] });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.results.map(({ id }) => id), ["a", "b"]);
  assert.deepEqual(result.results.map(({ sessionId }) => sessionId), ["s-a", "s-b"]);
  assert.equal(result.results[0].report, report);
  assert.equal(first.state.disposes, 1); assert.equal(second.state.disposes, 1);
  assert.equal(first.state.unsubscribes, 1); assert.equal(second.state.unsubscribes, 1);
});

test("coordinates an exact review verifier response as succeeded", async () => {
  const verifier = { ...agent, name: "review-verifier", tier: "reviewVerify", authority: "review-read", tools: ["read"], result: { kind: "review", format: "review-verdict-v1", requiredSections: ["verdict", "reason"] } };
  const verifierAssignment = { ...assignment("verify", []), agent: "review-verifier" };
  const child = fakeSession({ text: "VERDICT: CONFIRMED\nREASON: supported by direct evidence" });
  const result = await coordinateDelegation({
    cwd: "/repo", request: { title: "verify", assignments: [verifierAssignment] }, agents: [verifier], config: { models: { ...config.models, HIGH: config.models.MID } }, runtime, runId: "verify",
    sessionStore: new Map(), dependencies: { createManager: () => ({}), scopedTools: () => [], clock: () => "2026-07-31T20:00:00.000Z", activityClock: () => 1_000, createSession: async () => ({ session: child.session }) },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.results[0].status, "succeeded");
});

test("caller abort cancels and settles live children without retry", async () => {
  const controller = new AbortController();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const child = fakeSession({ waitForIdle: () => gate, abort: () => release() });
  const promise = run({ sessions: [{ session: child.session }], signal: controller.signal });
  await Promise.resolve(); await Promise.resolve();
  controller.abort();
  const result = await promise;
  assert.equal(result.status, "cancelled");
  assert.equal(result.partialEffects, true);
  assert.ok(child.state.aborts >= 1);
  assert.equal(child.state.disposes, 1);
});

test("unexpected mutation marks unsafe partial state and aborts settled siblings", async () => {
  let releaseSibling;
  const siblingGate = new Promise((resolve) => { releaseSibling = resolve; });
  const unsafeChild = fakeSession({ prompt: ({ listeners }) => { for (const listener of listeners) listener({ type: "tool_execution_start", toolName: "write", args: { path: "owned/b/escape.txt" } }); } });
  const sibling = fakeSession({ waitForIdle: () => siblingGate, abort: () => releaseSibling() });
  const result = await run({ assignments: [assignment("a", ["owned/a"]), assignment("b", ["owned/b"])], sessions: [{ session: unsafeChild.session }, { session: sibling.session }] });
  assert.equal(result.status, "failed");
  assert.equal(result.partialEffects, true);
  assert.deepEqual(result.unsafeEvidence, [{ assignmentId: "a", writeScope: ["owned/a"] }]);
  assert.ok(sibling.state.aborts >= 1);
  assert.equal(sibling.state.disposes, 1);
  assert.equal(unsafeChild.state.disposes, 1);
});

test("retries one transient provider failure in a fresh session and never retries contract failures", async () => {
  const transient = fakeSession({ state: { messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider timeout", content: [] }] }, text: "" });
  const success = fakeSession({ sessionId: "fresh", sessionFile: "/sessions/fresh.jsonl" });
  const recovered = await run({ sessions: [{ session: transient.session }, { session: success.session }] });
  assert.equal(recovered.status, "succeeded");
  assert.equal(recovered.results[0].attempts, 2);
  assert.equal(recovered.results[0].sessionId, "fresh");
  assert.equal(transient.state.disposes, 1); assert.equal(success.state.disposes, 1);

  const malformed = fakeSession({ text: "no required headings" });
  const notUsed = fakeSession();
  const failed = await run({ sessions: [{ session: malformed.session }, { session: notUsed.session }] });
  assert.equal(failed.status, "failed");
  assert.equal(failed.results[0].attempts, 1);
  assert.equal(notUsed.state.prompts.length, 0);
});

test("idle is not success when terminal report or observed identity is invalid", async () => {
  const wrongIdentity = fakeSession();
  wrongIdentity.session.model = { provider: "p", id: "other" };
  const result = await run({ sessions: [{ session: wrongIdentity.session }] });
  assert.equal(result.status, "failed");
  assert.ok(result.results[0].completion.includes("runtime_identity_mismatch"));
});

test("emits ordered sanitized route, start, tool, and success activity with a final report", async () => {
  const snapshots = [];
  const child = fakeSession({ prompt: ({ listeners }) => {
    for (const listener of listeners) {
      listener({ type: "agent_start" });
      listener({ type: "tool_execution_start", toolName: "read", args: { path: "/secret/credentials", token: "secret" } });
    }
  } });
  const result = await run({ sessions: [{ session: child.session }], onActivity: (snapshot) => snapshots.push(snapshot) });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(snapshots.map((snapshot) => snapshot.children[0].state), ["pending", "starting", "running", "running", "succeeded", "succeeded"]);
  assert.equal(snapshots[3].children[0].activity, "tool:read");
  assert.doesNotMatch(JSON.stringify(snapshots), /credentials|token|secret/);
  assert.equal(result.activity.state, "succeeded");
  assert.equal(result.report.state, "succeeded");
  assert.equal(result.report.children[0].resumeReference, "a");
});

test("transient retry is visible and attempt two remains the maximum", async () => {
  const snapshots = [];
  const transient = fakeSession({ state: { messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider timeout", content: [] }] }, text: "" });
  const success = fakeSession();
  const result = await run({ sessions: [{ session: transient.session }, { session: success.session }], onActivity: (snapshot) => snapshots.push(snapshot) });
  assert.equal(result.status, "succeeded");
  const retry = snapshots.find((snapshot) => snapshot.children[0].state === "retrying").children[0];
  assert.equal(retry.attempt, 2);
  assert.equal(retry.retryReason, "transient-provider");
  assert.equal(result.results[0].attempts, 2);
});

test("abort activity is emitted before child abort, preserves a completed sibling, and discloses writer scope", async () => {
  const controller = new AbortController();
  const snapshots = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let abortSawCancelling = false;
  const completed = fakeSession();
  const writing = fakeSession({ waitForIdle: () => gate, abort: () => { abortSawCancelling = snapshots.some((snapshot) => snapshot.children[1]?.state === "cancelling"); release(); } });
  const promise = run({
    assignments: [assignment("done", []), assignment("writing", ["owned/write"])],
    sessions: [{ session: completed.session }, { session: writing.session }], signal: controller.signal,
    onActivity: (snapshot) => snapshots.push(snapshot),
  });
  for (let i = 0; i < 20 && !snapshots.some((snapshot) => snapshot.children[0].state === "succeeded"); i += 1) await Promise.resolve();
  controller.abort();
  const result = await promise;
  assert.equal(abortSawCancelling, true);
  assert.equal(result.status, "cancelled");
  assert.equal(result.activity.children[0].state, "succeeded");
  assert.equal(result.activity.children[1].state, "cancelled");
  assert.deepEqual(result.report.partialState.possibleWriteScopes, ["owned/write"]);
  assert.equal(result.report.children[1].resumeReference, null);
  assert.equal(result.report.safeNextAction.code, "inspect-partial-state");
});

test("unsafe mutation emits visible interception and reports unsafe partial state", async () => {
  const snapshots = [];
  const child = fakeSession({ prompt: ({ listeners }) => { for (const listener of listeners) listener({ type: "tool_execution_start", toolName: "write", args: { path: "outside/file" } }); } });
  const result = await run({ sessions: [{ session: child.session }], onActivity: (snapshot) => snapshots.push(snapshot) });
  assert.equal(result.status, "failed");
  assert.ok(snapshots.some((snapshot) => snapshot.children[0].activity === "safety:intercepted"));
  assert.equal(result.report.safeNextAction.code, "correct-safety-boundary");
  assert.deepEqual(result.report.partialState.unsafeAssignmentIds, ["a"]);
});

test("missing exact model blocks without creating a child and exposes escalation", async () => {
  let created = false;
  const snapshots = [];
  const missingRuntime = { getModels: () => [], getModel: () => undefined };
  const result = await run({ sessions: [{ session: fakeSession().session }], selectedRuntime: missingRuntime, onActivity: (snapshot) => snapshots.push(snapshot) });
  assert.equal(result.status, "failed");
  assert.equal(result.results[0].status, "blocked");
  assert.equal(result.results[0].attempts, 0);
  assert.match(result.activity.children[0].escalation, /minimum capability/);
  assert.equal(result.report.safeNextAction.code, "restore-exact-model");
  assert.equal(created, false);
});

test("credential-like provider errors are redacted from activity and outcome reports", async () => {
  const snapshots = [];
  const child = fakeSession({
    state: { messages: [{ role: "assistant", stopReason: "error", errorMessage: "authorization=BearerVerySecret quota exceeded", content: [] }] },
    text: "",
  });
  const result = await run({ sessions: [{ session: child.session }], onActivity: (snapshot) => snapshots.push(snapshot) });
  assert.equal(result.status, "failed");
  assert.equal(result.results[0].attempts, 1);
  assert.equal(result.report.safeNextAction.code, "restore-exact-model");
  assert.match(result.report.blocker, /authorization=\[redacted\] quota exceeded/);
  assert.doesNotMatch(JSON.stringify({ snapshots, result }), /BearerVerySecret/);
});

test("throwing activity observer never changes coordinator completion or cleanup", async () => {
  const child = fakeSession();
  const result = await run({ sessions: [{ session: child.session }], onActivity: () => { throw new Error("projection failed"); } });
  assert.equal(result.status, "succeeded");
  assert.equal(child.state.disposes, 1);
  assert.equal(child.state.unsubscribes, 1);
});


test("documenter tools refuse code targets even when ownership is supplied", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-documenter-"));
  await mkdir(join(root, "docs")); await mkdir(join(root, "lib"));
  const documenter = { ...agent, name: "documenter", authority: "document-write", tools: ["write", "edit", "bash"], result: { kind: "documentation", requiredSections: ["local-changes"] } };
  const docsAssignment = { ...assignment("docs", ["docs/readme.md"]), writeScope: ["docs/readme.md"] };
  const tools = createScopedTools({ cwd: root, assignment: docsAssignment, agent: documenter });
  const write = tools.find((tool) => tool.name === "write");
  await write.execute("call", { path: "docs/readme.md", content: "ok" }, undefined, undefined, {});
  await assert.rejects(write.execute("call", { path: "lib/unsafe.ts", content: "no" }, undefined, undefined, {}));
});

test("documenter permits only exact owned documentation targets and rejects code and symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-documenter-boundary-"));
  const outside = await mkdtemp(join(tmpdir(), "ima-documenter-outside-"));
  await mkdir(join(root, "docs")); await mkdir(join(root, "lib"));
  await writeFile(join(root, "docs", "FNR-3019.md"), "before\n");
  await symlink(outside, join(root, "docs", "escape"));
  const documenter = { ...agent, name: "documenter", authority: "document-write", tools: ["write", "edit", "bash"], result: { kind: "documentation", requiredSections: ["local-changes"] } };
  const docsAssignment = { ...assignment("docs", ["docs/FNR-3019.md", "docs/README"]), writeScope: ["docs/FNR-3019.md", "docs/README"] };
  const tools = new Map(createScopedTools({ cwd: root, assignment: docsAssignment, agent: documenter }).map((tool) => [tool.name, tool]));
  const invoke = (name, args) => tools.get(name).execute("call", args, undefined, undefined, {});

  await invoke("edit", { path: "docs/FNR-3019.md", edits: [{ oldText: "before", newText: "after" }] });
  await invoke("write", { path: "docs/README", content: "guide" });
  assert.equal(await readFile(join(root, "docs", "FNR-3019.md"), "utf8"), "after\n");
  assert.equal(await readFile(join(root, "docs", "README"), "utf8"), "guide");

  for (const args of [
    { path: "lib/unsafe.ts", content: "no" },
    { path: "docs/escape/unsafe.md", content: "no" },
  ]) await assert.rejects(invoke("write", args));
  assert.equal(existsSync(join(root, "lib", "unsafe.ts")), false);
  assert.equal(existsSync(join(outside, "unsafe.md")), false);
});

test("documenter rejects prohibited documentation-looking locations at construction and effect time", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-documenter-prohibited-"));
  for (const directory of ["docs", "config", "tests", "lib", "extensions", "migrations"]) await mkdir(join(root, directory));
  const documenter = { ...agent, name: "documenter", authority: "document-write", tools: ["write", "edit", "bash"], result: { kind: "documentation", requiredSections: ["local-changes"] } };
  assert.throws(() => createScopedTools({ cwd: root, assignment: { ...assignment("bad"), writeScope: ["config/other.md"] }, agent: documenter }));
  const tools = new Map(createScopedTools({ cwd: root, assignment: { ...assignment("docs"), writeScope: ["docs/guide.md"] }, agent: documenter }).map((tool) => [tool.name, tool]));
  for (const [name, args] of [["write", { path: "config/other.md", content: "no" }], ["edit", { path: "lib/design.md", edits: [] }], ["bash", { command: "echo no > tests/notes.md" }]]) await assert.rejects(tools.get(name).execute("call", args, undefined, undefined, {}));
});

test("delivers admitted vision images through Pi prompt options without projecting bytes or paths", async () => {
  const vision = { ...agent, name: "vision-handoff", tier: "vision", authority: "vision-read", tools: ["read", "image"], result: { kind: "vision", requiredSections: ["source-access"] } };
  const visual = { ...assignment("visual", []), agent: "vision-handoff", imagePaths: ["/tmp/evidence.png"] };
  const child = fakeSession({ text: "## Source-access\naccessible" });
  child.session.model = { provider: "p", id: "vision" };
  const runtimeWithVision = { getModels: () => [{ provider: "p", id: "vision", input: ["text", "image"] }], getModel: () => ({ provider: "p", id: "vision" }) };
  const result = await coordinateDelegation({ cwd: "/repo", request: { title: "visual", assignments: [visual] }, agents: [vision], config: { models: { vision: { provider: "p", model: "vision", thinking: "high" } } }, runtime: runtimeWithVision, dependencies: { createManager: () => ({}), scopedTools: () => [], clock: () => "now", activityClock: () => 1, admitImages: async () => ({ admitted: true, value: [{ source: { id: "opaque", sourceLabel: "evidence.png", mimeType: "image/png", byteLength: 8, absolutePath: "/tmp/evidence.png" }, attachment: { type: "image", data: "cHJpdmF0ZQ==", mimeType: "image/png" } }] }), createSession: async () => ({ session: child.session }) } });
  assert.equal(result.status, "succeeded");
  assert.equal(child.state.prompts.length, 1);
  assert.equal(child.state.prompts[0].options.images[0].data, "cHJpdmF0ZQ==");
  assert.doesNotMatch(JSON.stringify(result), /cHJpdmF0ZQ==|\/tmp\/evidence\.png/);
});

test("blocks all vision delivery before session creation when any local image admission fails", async () => {
  const vision = { ...agent, name: "vision-handoff", tier: "vision", authority: "vision-read", tools: ["read", "image"], result: { kind: "vision", requiredSections: ["source-access"] } };
  const visual = { ...assignment("visual", []), agent: "vision-handoff", imagePaths: ["/tmp/first.png", "/tmp/unreadable.png"] };
  let created = false;
  const result = await coordinateDelegation({
    cwd: "/repo", request: { title: "visual", assignments: [visual] }, agents: [vision], config: { models: { vision: { provider: "p", model: "vision", thinking: "high" } } }, runtime: { getModels: () => [{ provider: "p", id: "vision", input: ["text", "image"] }], getModel: () => ({ provider: "p", id: "vision" }) },
    dependencies: { createManager: () => ({}), scopedTools: () => [], clock: () => "now", activityClock: () => 1, admitImages: async () => ({ admitted: false, error: "image_not_found" }), createSession: async () => { created = true; return { session: fakeSession().session }; } },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.results[0].status, "blocked");
  assert.equal(result.results[0].error, "image_not_found");
  assert.equal(created, false);
  assert.doesNotMatch(JSON.stringify(result), /\/tmp\/(first|unreadable)\.png/);
});

test("keeps text-only delegation on the original prompt call shape", async () => {
  const child = fakeSession();
  const result = await run({ sessions: [{ session: child.session }] });
  assert.equal(result.status, "succeeded");
  assert.equal(child.state.prompts.length, 1);
  assert.equal(child.state.prompts[0].options, undefined);
});


test("unavailable model and pre-aborted signal never admit local images", async () => {
  const vision = { ...agent, name: "vision-handoff", tier: "vision", authority: "vision-read", tools: ["read", "image"], result: { kind: "vision", requiredSections: ["source-access"] } };
  const visual = { ...assignment("visual", []), agent: "vision-handoff", imagePaths: ["/tmp/evidence.png"] };
  let admissions = 0;
  const dependencies = { createManager: () => ({}), scopedTools: () => [], clock: () => "now", activityClock: () => 1, admitImages: async () => { admissions += 1; return { admitted: true, value: [] }; }, createSession: async () => { assert.fail("session must not be created"); } };
  const unavailable = await coordinateDelegation({ cwd: "/repo", request: { title: "visual", assignments: [visual] }, agents: [vision], config: { models: { vision: { provider: "p", model: "vision", thinking: "high" } } }, runtime: { getModels: () => [], getModel: () => undefined }, dependencies });
  assert.equal(unavailable.results[0].error, "model_unavailable");
  assert.equal(admissions, 0);
  const controller = new AbortController(); controller.abort();
  const availableRuntime = { getModels: () => [{ provider: "p", id: "vision", input: ["text", "image"] }], getModel: () => ({ provider: "p", id: "vision" }) };
  const aborted = await coordinateDelegation({ cwd: "/repo", request: { title: "visual", assignments: [visual] }, agents: [vision], config: { models: { vision: { provider: "p", model: "vision", thinking: "high" } } }, runtime: availableRuntime, signal: controller.signal, dependencies });
  assert.equal(aborted.status, "cancelled");
  assert.equal(admissions, 0);
});

test("cancellation during image admission prevents child session creation", async () => {
  const vision = { ...agent, name: "vision-handoff", tier: "vision", authority: "vision-read", tools: ["read", "image"], result: { kind: "vision", requiredSections: ["source-access"] } };
  const visual = { ...assignment("visual", []), agent: "vision-handoff", imagePaths: ["/tmp/evidence.png"] };
  const controller = new AbortController();
  let release; const admitted = new Promise((resolve) => { release = resolve; });
  let created = 0;
  const runtimeWithVision = { getModels: () => [{ provider: "p", id: "vision", input: ["text", "image"] }], getModel: () => ({ provider: "p", id: "vision" }) };
  const promise = coordinateDelegation({ cwd: "/repo", request: { title: "visual", assignments: [visual] }, agents: [vision], config: { models: { vision: { provider: "p", model: "vision", thinking: "high" } } }, runtime: runtimeWithVision, signal: controller.signal, dependencies: { createManager: () => ({}), scopedTools: () => [], clock: () => "now", activityClock: () => 1, admitImages: () => admitted, createSession: async () => { created += 1; return { session: fakeSession().session }; } } });
  await Promise.resolve(); controller.abort(); release({ admitted: true, value: [] });
  const result = await promise;
  assert.equal(result.status, "cancelled");
  assert.equal(created, 0);
});

test("adversarial pairs block before child creation when routes are matching or incomplete", async () => {
  const adversaryA = { ...agent, name: "adversary-a", tier: "adversaryA", authority: "review-read", tools: ["read"], independence: { freshInitial: true, followUpAllowed: false }, result: { kind: "review", requiredSections: ["model-route", "verdict", "findings", "disproof-attempts", "confidence"] } };
  const adversaryB = { ...adversaryA, name: "adversary-b", tier: "adversaryB" };
  const assignments = [
    { ...assignment("a", []), agent: "adversary-a" },
    { ...assignment("b", []), agent: "adversary-b" },
  ];
  let created = 0;
  const result = await coordinateDelegation({
    cwd: "/repo", request: { title: "adversarial", assignments }, agents: [adversaryA, adversaryB],
    config: { models: { adversaryA: { provider: "p", model: "m" }, adversaryB: { provider: "p", model: "m" } } }, runtime, runId: "adversarial", sessionStore: new Map(),
    dependencies: { createManager: () => ({}), scopedTools: () => [], clock: () => "now", activityClock: () => 1_000, createSession: async () => { created += 1; return { session: fakeSession().session }; } },
  });
  assert.equal(result.status, "failed");
  assert.equal(created, 0);
  assert.deepEqual(result.results.map(({ error }) => error), ["adversary_routes_not_distinct", "adversary_routes_not_distinct"]);
});
