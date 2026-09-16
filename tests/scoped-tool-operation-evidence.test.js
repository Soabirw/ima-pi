import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertOwnedPath, createScopedTools } from "../extensions/agents.ts";
import { createScopedToolOperationEvidence } from "../lib/ima-agent-continuation.ts";

const agent = {
  schemaVersion: 1, name: "implementer", description: "Implement", tier: "MID", authority: "write",
  tools: ["read", "write", "edit"], skills: [], delegation: { allowed: false, maxDepth: 0 },
  independence: { freshInitial: false, followUpAllowed: true }, result: { kind: "implementation", requiredSections: ["files"] },
  escalation: ["scope"], prompt: "Implement safely.", source: "package", path: "/agents/implementer.md",
};
const assignment = { id: "assignment", agent: "implementer", goal: "Change code", context: "Approved", paths: ["owned/file.txt"], constraints: [], nonGoals: [], expectedOutput: "report", writeScope: ["owned"] };
const deferred = () => {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
};
const enoent = () => Object.assign(new Error("missing"), { code: "ENOENT" });

test("records a correlated pre-entry authorization denial as recoverable evidence", async () => {
  let unsafe = 0;
  let effects = 0;
  const evidence = createScopedToolOperationEvidence({ attempt: 1, onUnsafe: () => { unsafe += 1; } });
  evidence.observeToolStart({ toolCallId: "denied-write", toolName: "write" });

  await assert.rejects(
    evidence.runTool("denied-write", "write", () => evidence.runOperation({
      name: "write.authorization",
      mutation: false,
      safeRelativePath: "sibling/blocked.txt",
      authorize: () => { throw new Error("ownership_target_out_of_scope"); },
      effect: async () => { effects += 1; },
    })),
    { message: "ownership_target_out_of_scope" },
  );

  assert.equal(evidence.hasUnsettledToolExecution(), true);
  assert.equal(evidence.hasPossibleMutation(), false);
  assert.equal(evidence.isUnsafeToolFailure({
    toolCallId: "denied-write",
    toolName: "write",
    signalAborted: false,
  }), false);
  assert.equal(evidence.hasUnsettledToolExecution(), false);
  assert.equal(unsafe, 0);
  assert.equal(effects, 0);
  assert.equal(evidence.firstSafeCause(), "ownership_target_out_of_scope");
  assert.deepEqual(evidence.snapshot()[0].operations[0], {
    name: "write.authorization",
    mutation: false,
    entered: false,
    mutationEntry: "not-entered",
    completed: false,
    failed: true,
    authorization: "denied",
    safeRelativePath: "sibling/blocked.txt",
    stage: "authorization",
    allowlistedCause: "ownership_target_out_of_scope",
  });
});

test("TEST-001 records a correlated pre-entry containment denial without retaining an unsafe target", async () => {
  let unsafe = 0;
  let effects = 0;
  const evidence = createScopedToolOperationEvidence({ attempt: 1, onUnsafe: () => { unsafe += 1; } });
  evidence.observeToolStart({ toolCallId: "contained-write", toolName: "write" });

  await assert.rejects(
    evidence.runTool("contained-write", "write", () => evidence.runOperation({
      name: "write.authorization",
      mutation: false,
      safeRelativePath: null,
      authorize: () => { throw new Error("ownership_target_outside_project"); },
      effect: async () => { effects += 1; },
    })),
    { message: "ownership_target_outside_project" },
  );

  assert.equal(evidence.isUnsafeToolFailure({
    toolCallId: "contained-write",
    toolName: "write",
    signalAborted: false,
  }), false);
  assert.equal(unsafe, 0);
  assert.equal(effects, 0);
  assert.equal(evidence.firstSafeCause(), "ownership_target_outside_project");
  assert.equal(evidence.snapshot()[0].operations[0].safeRelativePath, null);
});

test("keeps missing, mismatched, cancelled, duplicate, and post-entry evidence unsafe", async () => {
  const missing = createScopedToolOperationEvidence({ attempt: 1 });
  missing.observeToolStart({ toolCallId: "missing", toolName: "write" });
  assert.equal(missing.isUnsafeToolFailure({ toolCallId: "missing", toolName: "write", signalAborted: false }), true);

  const mismatched = createScopedToolOperationEvidence({ attempt: 1 });
  mismatched.observeToolStart({ toolCallId: "actual", toolName: "write" });
  await assert.rejects(mismatched.runTool("actual", "write", () => mismatched.runOperation({
    name: "write.authorization",
    mutation: false,
    safeRelativePath: "sibling/blocked.txt",
    authorize: () => { throw new Error("ownership_target_out_of_scope"); },
    effect: async () => undefined,
  })));
  assert.equal(mismatched.isUnsafeToolFailure({ toolCallId: "other", toolName: "write", signalAborted: false }), true);

  const cancelled = createScopedToolOperationEvidence({ attempt: 1 });
  cancelled.observeToolStart({ toolCallId: "cancelled", toolName: "write" });
  await assert.rejects(cancelled.runTool("cancelled", "write", () => cancelled.runOperation({
    name: "write.authorization",
    mutation: false,
    safeRelativePath: "sibling/blocked.txt",
    authorize: () => { throw new Error("ownership_target_out_of_scope"); },
    effect: async () => undefined,
  })));
  assert.equal(cancelled.isUnsafeToolFailure({ toolCallId: "cancelled", toolName: "write", signalAborted: true }), true);

  const duplicate = createScopedToolOperationEvidence({ attempt: 1 });
  duplicate.observeToolStart({ toolCallId: "duplicate", toolName: "write" });
  await duplicate.runTool("duplicate", "write", () => duplicate.runOperation({
    name: "writeFile",
    mutation: true,
    safeRelativePath: "owned/file.txt",
    authorize: async () => undefined,
    effect: async () => undefined,
  }));
  await duplicate.runTool("duplicate", "write", () => undefined);
  assert.equal(duplicate.isUnsafeToolFailure({ toolCallId: "duplicate", toolName: "write", signalAborted: false, isError: false }), true);

  const unresolved = createScopedToolOperationEvidence({ attempt: 1 });
  unresolved.observeToolStart({ toolCallId: "unresolved", toolName: "write" });
  await assert.rejects(unresolved.runTool("unresolved", "write", () => unresolved.runOperation({
    name: "write.authorization",
    mutation: false,
    safeRelativePath: null,
    authorize: () => { throw new Error("ownership_path_unresolved"); },
    effect: async () => undefined,
  })));
  assert.equal(unresolved.isUnsafeToolFailure({ toolCallId: "unresolved", toolName: "write", signalAborted: false }), true);

  const postEntry = createScopedToolOperationEvidence({ attempt: 1 });
  postEntry.observeToolStart({ toolCallId: "post-entry", toolName: "write" });
  await assert.rejects(postEntry.runTool("post-entry", "write", () => postEntry.runOperation({
    name: "writeFile",
    mutation: true,
    safeRelativePath: "owned/file.txt",
    authorize: async () => undefined,
    effect: async () => { throw new Error("interrupted_effect"); },
  })));
  assert.equal(postEntry.isUnsafeToolFailure({ toolCallId: "post-entry", toolName: "write", signalAborted: false }), true);
});

test("retries one ENOENT-to-existing canonical observation without a lexical fallback", async () => {
  const root = "/repo";
  const target = "/repo/owned/file.txt";
  let targetRealpaths = 0;
  const operations = {
    realpath: async (path) => {
      if (path === root) return "/canonical/repo";
      if (path === target) {
        targetRealpaths += 1;
        if (targetRealpaths === 1) throw enoent();
        return "/canonical/repo/owned/file.txt";
      }
      if (path === "/repo/owned") return "/canonical/repo/owned";
      throw new Error(`unexpected_realpath:${path}`);
    },
    lstat: async (path) => {
      assert.equal(path, target);
      return {};
    },
  };

  assert.deepEqual(
    await assertOwnedPath(root, target, ["owned"], false, operations),
    { root: "/canonical/repo", target: "/canonical/repo/owned/file.txt" },
  );
  assert.equal(targetRealpaths, 2);

  let retries = 0;
  await assert.rejects(
    assertOwnedPath(root, target, ["owned"], false, {
      ...operations,
      realpath: async (path) => {
        if (path === root) return "/canonical/repo";
        if (path === target) {
          retries += 1;
          throw enoent();
        }
        throw new Error(`unexpected_realpath:${path}`);
      },
    }),
    { message: "ownership_path_unresolved" },
  );
  assert.equal(retries, 2);
});

test("keeps an ENOENT-to-existing symlink escape outside the canonical root", async () => {
  const root = "/repo";
  const target = "/repo/owned/file.txt";
  let targetRealpaths = 0;
  const operations = {
    realpath: async (path) => {
      if (path === root) return "/canonical/repo";
      if (path === target) {
        targetRealpaths += 1;
        if (targetRealpaths === 1) throw enoent();
        return "/outside/file.txt";
      }
      throw new Error(`unexpected_realpath:${path}`);
    },
    lstat: async (path) => {
      assert.equal(path, target);
      return {};
    },
  };

  await assert.rejects(
    assertOwnedPath(root, target, ["owned"], false, operations),
    { message: "ownership_symlink_escape" },
  );
  assert.equal(targetRealpaths, 2);
});

test("serializes edit and write authorization through settlement within one assignment", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-assignment-queue-"));
  const firstEntered = deferred();
  const releaseFirst = deferred();
  let secondEntered = false;
  try {
    await mkdir(join(root, "owned"));
    const tools = createScopedTools({
      cwd: root,
      assignment,
      agent,
      operations: {
        mkdir: (path, options) => mkdir(path, options),
        writeFile: async (path, content) => {
          if (path.endsWith("first.txt")) {
            firstEntered.resolve();
            await releaseFirst.promise;
          }
          if (path.endsWith("second.txt")) secondEntered = true;
          await writeFile(path, content);
        },
      },
    });
    const write = tools.find((tool) => tool.name === "write");
    const first = write.execute("first", { path: "owned/first.txt", content: "first" }, undefined, undefined, {});
    await firstEntered.promise;
    const second = write.execute("second", { path: "owned/second.txt", content: "second" }, undefined, undefined, {});
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(secondEntered, false);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    assert.equal(await readFile(join(root, "owned", "first.txt"), "utf8"), "first");
    assert.equal(await readFile(join(root, "owned", "second.txt"), "utf8"), "second");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
