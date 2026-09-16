import assert from "node:assert/strict";
import test from "node:test";
import {
  agentContractFingerprint,
  buildChildBrief,
  classifyBashCommand,
  composeDelegatedBashPrompt,
  DELEGATED_BASH_PROMPT_GUIDANCE,
  createDelegationState,
  isOwnedTarget,
  normalizeOwnershipTarget,
  reduceDelegationEvent,
  requiresDelegatedBashGuidance,
  validateDelegationCompletion,
  validateAdversarialAssignments,
  validateDelegationRequest,
  validateDelegationRouteIdentity,
  writeScopesOverlap,
  isDocumentationTarget,
  validateDocumentWriteScope,
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

test("requires one matching adversary-a and adversary-b evidence packet", () => {
  const adversaryA = { ...agent, name: "adversary-a", authority: "review-read", tools: ["read"], result: { kind: "review", requiredSections: ["findings"] } };
  const adversaryB = { ...adversaryA, name: "adversary-b" };
  const adversaryAAssignment = { ...assignment, id: "adversary-a", agent: "adversary-a", writeScope: [] };
  const adversaryBAssignment = { ...adversaryAAssignment, id: "adversary-b", agent: "adversary-b" };
  const cases = [
    [[adversaryAAssignment], "delegation_adversary_pair_required"],
    [[adversaryBAssignment], "delegation_adversary_pair_required"],
    [[adversaryAAssignment, { ...adversaryAAssignment, id: "duplicate-a" }], "delegation_adversary_pair_required"],
    [[adversaryAAssignment, { ...adversaryBAssignment, context: "Different evidence" }], "delegation_adversary_packet_mismatch"],
  ];

  for (const [assignments, error] of cases) {
    assert.deepEqual(validateAdversarialAssignments(assignments), { valid: false, errors: [error] });
    assert.ok(validateDelegationRequest({ title: "adversarial", assignments }, [adversaryA, adversaryB]).errors.includes(error));
  }
  assert.deepEqual(validateAdversarialAssignments([adversaryAAssignment, adversaryBAssignment]), { valid: true, errors: [] });
  assert.equal(validateDelegationRequest({ title: "adversarial", assignments: [adversaryAAssignment, adversaryBAssignment] }, [adversaryA, adversaryB]).valid, true);
});

test("permits read-only documentation assessment without a write scope", () => {
  const assessor = { ...agent, name: "document-assessor", authority: "read", tools: ["read", "grep", "find", "ls"], result: { kind: "documentation", requiredSections: ["evidence", "external-update-manifest", "residual-risk"] } };
  const assessorAssignment = { ...assignment, agent: "document-assessor", paths: ["agents/document-assessor.md"], writeScope: [] };
  assert.equal(validateDelegationRequest({ title: "assess", assignments: [assessorAssignment] }, [assessor]).valid, true);
  const withWriteScope = validateDelegationRequest({ title: "assess", assignments: [{ ...assessorAssignment, writeScope: ["agents/document-assessor.md"] }] }, [assessor]);
  assert.ok(withWriteScope.errors.includes("delegation_read_write_scope:a"));

  const documenter = { ...agent, name: "documenter", authority: "document-write", result: { kind: "documentation", requiredSections: ["local-changes", "evidence", "external-update-manifest", "residual-risk"] } };
  const withoutWriteScope = validateDelegationRequest({ title: "document", assignments: [{ ...assignment, agent: "documenter", paths: ["README.md"], writeScope: [] }] }, [documenter]);
  assert.ok(withoutWriteScope.errors.includes("delegation_write_scope_required:a"));
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

test("composes mandatory delegated-Bash guidance only for resolved Bash or test definitions", () => {
  const original = "Original child brief.";
  assert.equal(requiresDelegatedBashGuidance(["read", "write"]), false);
  assert.equal(composeDelegatedBashPrompt(original, ["read", "write"]), original);

  for (const tools of [["read", "bash"], ["read", "test"]]) {
    const customAgent = { ...agent, tools, source: "project" };
    const brief = buildChildBrief({ projectRoot: "/repo", assignment, agent: customAgent });
    assert.equal(requiresDelegatedBashGuidance(tools), true);
    assert.ok(brief.endsWith(DELEGATED_BASH_PROMPT_GUIDANCE));
    assert.match(brief, /`&&` runs its right side only after its left succeeds/);
    assert.match(brief, /Report unsupported verification to the parent; never claim it/);
  }
});

test("accepts non-empty reports regardless of heading wording or order while preserving terminal and identity gates", () => {
  const base = {
    final: { stopReason: "stop" },
    text: "Completed normally without headings.",
    requiredSections: ["files", "verification"],
    expected: { provider: "p", model: "m", thinking: "high" },
    observed: { provider: "p", model: "m", thinking: "high", sessionId: "s", sessionFile: "/sessions/s.jsonl" },
  };
  for (const text of ["Completed normally without headings.", "## Verification\npassed\n\n## Files\nlib/x.ts", "## Outcome\nThe work is complete."]) assert.deepEqual(validateDelegationCompletion({ ...base, text }), { ok: true, failures: [] }, text);
  const cases = [
    [{ ...base, final: undefined }, "assistant_missing"],
    [{ ...base, final: { stopReason: "error", isError: true } }, "assistant_error"],
    [{ ...base, final: { stopReason: "aborted" } }, "assistant_aborted"],
    [{ ...base, final: { stopReason: "length" } }, "assistant_truncated"],
    [{ ...base, final: { stopReason: "toolUse", hasPendingToolUse: true } }, "assistant_tool_use"],
    [{ ...base, text: "" }, "report_empty"],
    [{ ...base, observed: { ...base.observed, provider: "other" } }, "runtime_identity_mismatch"],
    [{ ...base, observed: { ...base.observed, provider: "" } }, "runtime_identity_missing"],
    [{ ...base, observed: { ...base.observed, sessionFile: "" } }, "session_identity_missing"],
    [{ ...base, expected: { ...base.expected, sessionId: "s", sessionFile: "/sessions/s.jsonl" }, observed: { ...base.observed, sessionId: "other" } }, "session_identity_mismatch"],
  ];
  for (const [input, code] of cases) assert.ok(validateDelegationCompletion(input).failures.includes(code), code);
});

test("validates provider, model, and thinking identity independently of completion", () => {
  const expected = { provider: "p", model: "m", thinking: "high" };
  assert.deepEqual(validateDelegationRouteIdentity({ expected, observed: expected }), { ok: true, failures: [] });
  assert.deepEqual(validateDelegationRouteIdentity({ expected, observed: { provider: "", model: "m", thinking: "high" } }), { ok: false, failures: ["runtime_identity_missing"] });
  for (const observed of [
    { provider: "other", model: "m", thinking: "high" },
    { provider: "p", model: "other", thinking: "high" },
    { provider: "p", model: "m", thinking: "low" },
  ]) assert.deepEqual(validateDelegationRouteIdentity({ expected, observed }), { ok: false, failures: ["runtime_identity_mismatch"] });
});

test("accepts non-empty verifier-style prose reports", () => {
  const input = {
    final: { stopReason: "stop" },
    text: "The finding is confirmed because the supplied evidence supports it.",
    requiredSections: ["verdict", "reason"],
    expected: { provider: "p", model: "m", thinking: "high" },
    observed: { provider: "p", model: "m", thinking: "high", sessionId: "s", sessionFile: "/sessions/s.jsonl" },
  };
  assert.deepEqual(validateDelegationCompletion(input), { ok: true, failures: [] });
});

test("fingerprints canonical agent authority and ownership contracts", () => {
  const first = agentContractFingerprint(agent, ["lib/b", "lib/a"]);
  const reordered = agentContractFingerprint({ ...agent, tools: [...agent.tools].reverse(), result: { ...agent.result, requiredSections: [...agent.result.requiredSections].reverse() } }, ["lib/a", "lib/b"]);
  const drifted = agentContractFingerprint({ ...agent, tools: [...agent.tools, "edit"] }, ["lib/a", "lib/b"]);
  assert.equal(first, reordered);
  assert.notEqual(first, drifted);
});


test("accepts only exact documentation write targets", () => {
  for (const path of ["README", "README.md", "CHANGELOG.md", "docs/FNR-3019.md", "docs/guide.txt", "agents/README.md", "config/README.md", "policies/README.md"]) assert.equal(isDocumentationTarget(path), true, path);
  for (const path of ["docs", "config/other.md", "tests/notes.md", "lib/design.md", "extensions/notes.md", "migrations/notes.md", "package.md", "../README.md", "/README.md"]) assert.equal(isDocumentationTarget(path), false, path);
  assert.deepEqual(validateDocumentWriteScope(["docs/FNR-3019.md"]), { valid: true, errors: [] });
  assert.ok(validateDocumentWriteScope(["config/other.md"]).errors[0].startsWith("document_scope_invalid"));
});

test("admits image paths only for vision evidence assignments", () => {
  const vision = { ...agent, name: "vision-handoff", tier: "vision", authority: "vision-read", tools: ["read", "image"], result: { kind: "vision", requiredSections: ["source-access"] } };
  const visual = { ...assignment, agent: "vision-handoff", writeScope: [], imagePaths: ["/tmp/a.png"] };
  assert.equal(validateDelegationRequest({ title: "visual", assignments: [visual] }, [vision]).valid, true);
  for (const input of [{ ...visual, imagePaths: ["relative.png"] }, { ...visual, imagePaths: ["/tmp/a.png", "/tmp/a.png"] }, { ...visual, imagePaths: Array.from({ length: 5 }, (_, i) => `/tmp/${i}.png`) }]) assert.equal(validateDelegationRequest({ title: "visual", assignments: [input] }, [vision]).valid, false);
  assert.ok(validateDelegationRequest({ title: "wrong", assignments: [{ ...visual, agent: "implementer" }] }, [agent]).errors.some((error) => error.startsWith("delegation_images_vision_only")));
  const brief = buildChildBrief({ projectRoot: "/repo", assignment: visual, agent: vision, images: [{ id: "opaque", sourceLabel: "a.png", mimeType: "image/png", byteLength: 8 }] });
  assert.match(brief, /opaque/); assert.doesNotMatch(brief, /\/tmp\/a\.png/);
});
