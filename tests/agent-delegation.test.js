import assert from "node:assert/strict";
import test from "node:test";
import {
  agentContractFingerprint,
  buildChildBrief,
  classifyBashCommand,
  createDelegationState,
  isOwnedTarget,
  normalizeOwnershipTarget,
  reduceDelegationEvent,
  validateDelegationCompletion,
  validateDelegationRequest,
  writeScopesOverlap,
} from "../lib/ima-delegation.ts";

const agent = {
  name: "implementer", authority: "write", tools: ["read", "write"], escalation: ["scope"],
  result: { kind: "implementation", requiredSections: ["files", "verification"] },
  independence: { freshInitial: false, followUpAllowed: true }, prompt: "Implement safely.",
};
const assignment = { id: "a", agent: "implementer", goal: "Change code", context: "Approved plan", paths: ["lib/x.ts"], constraints: ["small"], nonGoals: ["rewrite"], expectedOutput: "report", writeScope: ["lib/x.ts"] };

test("validates bounded assignments, path safety, and disjoint writers", () => {
  assert.equal(validateDelegationRequest({ title: "work", assignments: [assignment] }, [agent]).valid, true);
  for (const unsafe of ["", ".", "/", "/absolute", "../unsafe", "lib/../unsafe", "lib\\unsafe", "lib//unsafe"]) {
    assert.ok(validateDelegationRequest({ title: "work", assignments: [{ ...assignment, writeScope: [unsafe] }] }, [agent]).errors.some((error) => error.startsWith("delegation_path_invalid")), unsafe);
  }
  assert.ok(validateDelegationRequest({ title: "work", assignments: [assignment, { ...assignment, id: "b", writeScope: ["lib"] }] }, [agent]).errors.some((error) => error.startsWith("delegation_write_scope_overlap")));
  assert.equal(writeScopesOverlap(["a/x"], ["b/x"]), false);
  assert.equal(writeScopesOverlap(["lib/a"], ["lib/ab"]), false);
});

test("normalizes ownership and enforces path-segment containment", () => {
  assert.equal(normalizeOwnershipTarget("lib/a/"), "lib/a");
  assert.equal(normalizeOwnershipTarget("../lib/a"), null);
  assert.equal(isOwnedTarget("lib/a/file.ts", ["lib/a"]), true);
  assert.equal(isOwnedTarget("lib/ab/file.ts", ["lib/a"]), false);
  assert.equal(isOwnedTarget("lib/a", ["lib/a"]), true);
  assert.equal(isOwnedTarget("/repo/lib/a", ["lib/a"]), false);
});

test("classifies bash commands narrowly and fails closed on ambiguity", () => {
  assert.deepEqual(classifyBashCommand("git diff --check", ["lib/a"]), { kind: "read-only", paths: [] });
  assert.deepEqual(classifyBashCommand("cat lib/a/file.ts", ["lib/a"]), { kind: "read-only", paths: [] });
  assert.equal(classifyBashCommand("echo ok > lib/a/result.txt", ["lib/a"]).kind, "owned-mutation");
  assert.equal(classifyBashCommand("echo ok>lib/a/result.txt", ["lib/a"]).kind, "owned-mutation");
  assert.equal(classifyBashCommand("echo no > lib/ab/result.txt", ["lib/a"]).kind, "unsafe-ambiguous");
  for (const command of ["", "rm lib/a/file.ts", "npm test", "cat x | tee lib/a/x", "echo $(touch lib/a/x)", "git clean -fd", "find . -delete", "node script.js > lib/a/x", "echo a > lib/a/x\nrm lib/a/y", "echo pwn>../escape.txt", "cat owned/a>sibling/f", "echo pwn>>../escape.txt", "printf x>../escape.txt", "echo x 2>../escape.txt", "echo x &>../escape.txt", "echo x>lib/a/ok>../escape.txt", "echo x>>>lib/a/escape.txt"]) {
    assert.equal(classifyBashCommand(command, ["lib/a"]).kind, "unsafe-ambiguous", command);
  }
});

test("builds a self-contained brief and immutable event state", () => {
  const brief = buildChildBrief({ projectRoot: "/repo", assignment, agent });
  assert.match(brief, /Project root: \/repo/); assert.doesNotMatch(brief, /as discussed/i);
  const initial = createDelegationState({ title: "work", assignments: [assignment] });
  const next = reduceDelegationEvent(initial, { type: "started", id: "a" });
  const failed = reduceDelegationEvent(next, { type: "failed", id: "a", partialEffects: false });
  const unsafe = reduceDelegationEvent(next, { type: "failed", id: "a", partialEffects: true });
  assert.equal(initial.assignments[0].status, "pending");
  assert.equal(next.assignments[0].status, "running");
  assert.equal(failed.partialEffects, false);
  assert.equal(unsafe.partialEffects, true);
});

test("requires normal terminal reports, sections, observed identity, and session identity", () => {
  const base = {
    final: { stopReason: "stop" },
    text: "## Files\nlib/x.ts\n\n## Verification\npassed",
    requiredSections: ["files", "verification"],
    expected: { provider: "p", model: "m", thinking: "high" },
    observed: { provider: "p", model: "m", thinking: "high", sessionId: "s", sessionFile: "/sessions/s.jsonl" },
  };
  assert.deepEqual(validateDelegationCompletion(base), { ok: true, failures: [] });
  const cases = [
    [{ ...base, final: undefined }, "assistant_missing"],
    [{ ...base, final: { stopReason: "error", isError: true } }, "assistant_error"],
    [{ ...base, final: { stopReason: "aborted" } }, "assistant_aborted"],
    [{ ...base, final: { stopReason: "length" } }, "assistant_truncated"],
    [{ ...base, final: { stopReason: "toolUse", hasPendingToolUse: true } }, "assistant_tool_use"],
    [{ ...base, text: "" }, "report_empty"],
    [{ ...base, text: "## Files\nlib/x.ts" }, "report_section_missing"],
    [{ ...base, observed: { ...base.observed, provider: "other" } }, "runtime_identity_mismatch"],
    [{ ...base, observed: { ...base.observed, provider: "" } }, "runtime_identity_missing"],
    [{ ...base, observed: { ...base.observed, sessionFile: "" } }, "session_identity_missing"],
  ];
  for (const [input, code] of cases) assert.ok(validateDelegationCompletion(input).failures.includes(code), code);
});

test("fingerprints canonical agent authority and ownership contracts", () => {
  const first = agentContractFingerprint(agent, ["lib/b", "lib/a"]);
  const reordered = agentContractFingerprint({ ...agent, tools: [...agent.tools].reverse(), result: { ...agent.result, requiredSections: [...agent.result.requiredSections].reverse() } }, ["lib/a", "lib/b"]);
  const drifted = agentContractFingerprint({ ...agent, tools: [...agent.tools, "edit"] }, ["lib/a", "lib/b"]);
  assert.equal(first, reordered);
  assert.notEqual(first, drifted);
});
