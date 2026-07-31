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
    prompt: async (brief) => { state.prompts.push(brief); await overrides.prompt?.({ state, listeners, session }); },
    waitForIdle: async () => overrides.waitForIdle?.({ state, listeners, session }),
    getLastAssistantText: () => overrides.text ?? report,
    abort: async () => { state.aborts += 1; await overrides.abort?.({ state, listeners, session }); },
    dispose: () => { state.disposes += 1; },
  };
  return { session, state };
};

const run = ({ assignments = [assignment("a")], sessions, signal } = {}) => {
  let index = 0;
  return coordinateDelegation({
    cwd: "/repo", request: { title: "work", assignments }, agents: [agent], config, runtime, signal,
    sessionStore: new Map(), dependencies: {
      createManager: () => ({}), scopedTools: () => [], clock: () => "2026-07-31T20:00:00.000Z",
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
