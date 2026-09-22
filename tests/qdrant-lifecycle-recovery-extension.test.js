import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stream as streamAnthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { Check } from "typebox/value";
import { createLifecycleProviderPin, createLifecycleProviderPinAttempt } from "../lib/ima-lifecycle-pin.ts";
import {
  beginLifecyclePinWith,
  confirmLifecyclePinWith,
  loadLifecyclePinStateWith,
  markLifecyclePinAttemptWritingWith,
} from "../lib/ima-lifecycle-pin-store.ts";
import { corpusFailure, normalizeInstitutionalRecord } from "../lib/qdrant-corpus.ts";
import { registerQdrantLifecycleRecoveryTools } from "../extensions/qdrant-lifecycle-recovery.ts";

const lifecycleKey = "ima-pi:plane:ima:SKYNET-248";
const createdAt = "2026-09-20T12:00:00.000Z";
const snapshotName = "extension-recovery.snapshot";
const reportPath = ".ima-cycle/qdrant-lifecycle-reset-2026-09-20.report.json";
const confirmation = "a".repeat(64);

const success = (data) => ({ success: true, data });
const failure = (code) => corpusFailure(code);
const clone = (value) => structuredClone(value);

const recoveryFixture = () => {
  const normalized = normalizeInstitutionalRecord({
    recordKey: `${lifecycleKey}:plan:52701d4c3039`,
    project: "ima-pi",
    site: "",
    repo: "ima-pi",
    lifecycleKey,
    phase: "plan",
    summary: "Verified Qdrant lifecycle recovery test evidence.",
    detail: "# Recovery fixture\n\nExact test-only lifecycle evidence.",
    sourceRefs: ["plane:ima:SKYNET-248"],
  }, createdAt);
  assert.equal(normalized.success, true, "extension recovery fixture must normalize");
  if (!normalized.success) throw new Error("extension recovery fixture is invalid");
  const reference = {
    schemaVersion: 1,
    provider: "qdrant",
    artifactId: normalized.data.id,
    recordKey: normalized.data.recordKey,
    contentHash: normalized.data.payload.content_hash,
    lifecycleKey,
    phase: "plan",
    nonce: "00000000-0000-5000-8000-000000000001",
  };
  const pin = createLifecycleProviderPin({
    lifecycleKey,
    provider: "qdrant",
    initialReference: reference,
    artifactId: reference.artifactId,
    recordKey: reference.recordKey,
    pinnedAt: createdAt,
  });
  assert.ok(pin, "extension recovery fixture pin must be valid");
  return {
    pin,
    inventory: {
      schemaVersion: 1,
      lifecycleKey,
      records: [{
        storageSchemaVersion: 1,
        recordKey: normalized.data.recordKey,
        contentHash: normalized.data.payload.content_hash,
        points: [{ id: normalized.data.id, payload: clone(normalized.data.payload) }],
      }],
    },
  };
};

const setupRecoveryTool = async (t, { deleteResult = success(undefined) } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "ima-qdrant-recovery-extension-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const { pin, inventory } = recoveryFixture();
  const resolveProjectRoot = async () => root;
  const attempt = createLifecycleProviderPinAttempt({
    lifecycleKey,
    provider: "qdrant",
    attemptId: "00000000-0000-5000-8000-000000000002",
    startedAt: createdAt,
  });
  assert.ok(attempt, "extension recovery fixture attempt must be valid");
  assert.equal(
    (await beginLifecyclePinWith(resolveProjectRoot)(root, attempt)).status,
    "started",
  );
  const writing = await markLifecyclePinAttemptWritingWith(resolveProjectRoot)(root, attempt);
  assert.equal(writing.status, "writing");
  if (writing.status !== "writing") throw new Error("extension recovery fixture did not enter writing state");
  assert.equal(
    (await confirmLifecyclePinWith(resolveProjectRoot)(root, writing.attempt, pin)).status,
    "pinned",
  );

  const calls = { inventory: 0, snapshot: 0, deletion: 0, absence: 0 };
  const dependencies = {
    client: {
      inventoryLifecycleRecovery: async () => {
        calls.inventory += 1;
        return success(clone(inventory));
      },
      deleteLifecycleRecoveryInventory: async () => {
        calls.deletion += 1;
        return clone(deleteResult);
      },
      proveLifecycleRecoveryAbsence: async () => {
        calls.absence += 1;
        return success(undefined);
      },
    },
    createSnapshot: async () => {
      calls.snapshot += 1;
      return success({ name: snapshotName });
    },
    resolveProjectRoot,
    now: () => new Date(createdAt),
  };
  const tools = [];
  registerQdrantLifecycleRecoveryTools({ registerTool: (tool) => tools.push(tool) }, dependencies);
  const tool = tools.find(({ name }) => name === "ima_qdrant_lifecycle_reset");
  assert.ok(tool, "recovery extension must register its tool");
  return { root, pin, calls, tool, resolveProjectRoot };
};

const invoke = (tool, request, ctx) => tool.execute("test", request, undefined, undefined, ctx);
const noUiContext = (cwd) => ({ cwd, hasUI: false });
const uiContext = (cwd, confirm) => ({ cwd, hasUI: true, ui: { confirm } });

const prepare = async (subject) => {
  const result = await invoke(subject.tool, { operation: "prepare", lifecycleKey }, noUiContext(subject.root));
  assert.equal(result.details.status, "prepared");
  return result.details;
};

test("REVIEW-004 exposes root recovery fields to installed non-strict Anthropic serialization and rejects strict runtime projection failures", async () => {
  const tools = [];
  registerQdrantLifecycleRecoveryTools({ registerTool: (tool) => tools.push(tool) });
  const tool = tools.find(({ name }) => name === "ima_qdrant_lifecycle_reset");
  assert.ok(tool);

  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [
    "confirmation",
    "lifecycleKey",
    "operation",
    "reportPath",
  ]);
  assert.deepEqual(tool.parameters.required, ["operation"]);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.parameters.properties.operation.enum, ["prepare", "execute", "reconcile"]);
  for (const request of [
    { operation: "prepare", lifecycleKey },
    { operation: "execute", reportPath, confirmation },
    { operation: "reconcile", reportPath, confirmation },
  ]) {
    assert.equal(Check(tool.parameters, request), true);
  }

  let payload;
  let transportCalls = 0;
  const providerStream = streamAnthropicMessages({
    id: "synthetic-anthropic",
    name: "Synthetic Anthropic",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://not-used.example",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  }, {
    messages: [{ role: "user", content: "serialize", timestamp: 0 }],
    tools: [tool],
  }, {
    client: {
      messages: {
        create: () => {
          transportCalls += 1;
          throw new Error("unexpected network");
        },
      },
    },
    onPayload: (value) => {
      payload = value;
      throw new Error("stop after serialization");
    },
  });
  const serialized = await providerStream.result();
  assert.equal(serialized.stopReason, "error");
  assert.equal(transportCalls, 0);
  assert.ok(payload);
  const schema = payload.tools.find(({ name }) => name === "ima_qdrant_lifecycle_reset").input_schema;
  assert.equal(schema.type, "object");
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    "confirmation",
    "lifecycleKey",
    "operation",
    "reportPath",
  ]);
  assert.deepEqual(schema.required, ["operation"]);
  assert.deepEqual(schema.properties.operation.enum, ["prepare", "execute", "reconcile"]);

  const accessor = {};
  Object.defineProperty(accessor, "operation", {
    enumerable: true,
    get: () => { throw new Error("untrusted accessor"); },
  });
  const invalidRequests = [
    { operation: "prepare" },
    { operation: "execute", reportPath },
    { operation: "reconcile", confirmation },
    { operation: "prepare", lifecycleKey, unexpected: true },
    { operation: "prepare", lifecycleKey, reportPath, confirmation },
    { operation: "execute", lifecycleKey, reportPath, confirmation },
    { operation: "unknown", lifecycleKey },
    { operation: "execute", reportPath: "../escape.report.json", confirmation },
    null,
    [],
    accessor,
  ];
  let prompts = 0;
  for (const request of invalidRequests) {
    const result = await invoke(tool, request, uiContext("not-used", async () => {
      prompts += 1;
      return true;
    }));
    assert.deepEqual(result.details, {
      status: "blocked",
      code: "lifecycle_reset_request_invalid",
    });
  }
  assert.equal(prompts, 0);
});

test("REVIEW-001 dispatches all valid routes with two exact trusted UI confirmations before deletion and one for reconciliation", async (t) => {
  const executable = await setupRecoveryTool(t);
  const prepared = await prepare(executable);
  const report = JSON.parse(await readFile(join(executable.root, prepared.reportPath), "utf8"));
  const prompts = [];
  const executeResult = await invoke(
    executable.tool,
    { operation: "execute", reportPath: prepared.reportPath, confirmation: prepared.reportHash },
    uiContext(executable.root, async (title, body) => {
      prompts.push({ title, body });
      return true;
    }),
  );
  assert.equal(executeResult.details.status, "completed");
  assert.deepEqual(executable.calls, { inventory: 3, snapshot: 1, deletion: 1, absence: 1 });
  assert.deepEqual(prompts.map(({ title }) => title), [
    "Confirm Qdrant lifecycle recovery intent",
    "Confirm Qdrant lifecycle deletion",
  ]);
  for (const prompt of prompts) {
    assert.match(prompt.body, new RegExp(`Lifecycle key: ${lifecycleKey}`));
    assert.match(prompt.body, new RegExp(`Verified report SHA-256: ${prepared.reportHash}`));
    assert.match(prompt.body, new RegExp(report.inventory.fingerprint));
    assert.match(
      prompt.body,
      new RegExp(`Exact scope: ${report.inventory.pointCount} report-listed Qdrant point\\(s\\) across ${report.inventory.recordCount} lifecycle record\\(s\\)`),
    );
  }
  assert.match(prompts[0].body, /Deletion requires a separate confirmation\./);
  assert.match(prompts[1].body, new RegExp(`Verified snapshot receipt: ${snapshotName}`));
  assert.deepEqual(
    await loadLifecyclePinStateWith(executable.resolveProjectRoot)(executable.root, lifecycleKey),
    { status: "absent" },
  );

  const reconcilable = await setupRecoveryTool(t, { deleteResult: failure("store_unverified") });
  const recoveryPrepared = await prepare(reconcilable);
  const reconciliationPrompts = [];
  const confirmationUi = uiContext(reconcilable.root, async (title, body) => {
    reconciliationPrompts.push({ title, body });
    return true;
  });
  const blockedExecution = await invoke(
    reconcilable.tool,
    {
      operation: "execute",
      reportPath: recoveryPrepared.reportPath,
      confirmation: recoveryPrepared.reportHash,
    },
    confirmationUi,
  );
  assert.deepEqual(blockedExecution.details, {
    status: "blocked",
    code: "lifecycle_reset_delete_store_unverified",
  });
  const reconciled = await invoke(
    reconcilable.tool,
    {
      operation: "reconcile",
      reportPath: recoveryPrepared.reportPath,
      confirmation: recoveryPrepared.reportHash,
    },
    confirmationUi,
  );
  assert.equal(reconciled.details.status, "reconciled");
  assert.deepEqual(reconcilable.calls, { inventory: 3, snapshot: 1, deletion: 1, absence: 1 });
  assert.deepEqual(reconciliationPrompts.map(({ title }) => title), [
    "Confirm Qdrant lifecycle recovery intent",
    "Confirm Qdrant lifecycle deletion",
    "Confirm Qdrant lifecycle recovery intent",
  ]);
  assert.deepEqual(
    await loadLifecyclePinStateWith(reconcilable.resolveProjectRoot)(reconcilable.root, lifecycleKey),
    { status: "absent" },
  );
});

test("REVIEW-001 blocks unavailable, refused, cancelled, exceptional, and mismatched confirmation before recovery mutation", async (t) => {
  const intentDenials = [
    ["no UI", (root) => noUiContext(root), 0],
    ["refused", (root, count) => uiContext(root, async () => {
      count.calls += 1;
      return false;
    }), 1],
    ["cancelled", (root, count) => uiContext(root, async () => {
      count.calls += 1;
      return undefined;
    }), 1],
    ["exception", (root, count) => uiContext(root, async () => {
      count.calls += 1;
      throw new Error("confirmation UI failed");
    }), 1],
  ];

  for (const [label, context, expectedPrompts] of intentDenials) {
    const subject = await setupRecoveryTool(t);
    const prepared = await prepare(subject);
    const registry = join(subject.root, ".ima-cycle", "provider-pins.json");
    const before = await readFile(registry, "utf8");
    const promptCount = { calls: 0 };
    const result = await invoke(
      subject.tool,
      { operation: "execute", reportPath: prepared.reportPath, confirmation: prepared.reportHash },
      context(subject.root, promptCount),
    );
    assert.deepEqual(result.details, {
      status: "blocked",
      code: "lifecycle_reset_confirmation_required",
    }, label);
    assert.equal(promptCount.calls, expectedPrompts, label);
    assert.deepEqual(subject.calls, { inventory: 1, snapshot: 0, deletion: 0, absence: 0 }, label);
    assert.equal(await readFile(registry, "utf8"), before, label);
    assert.deepEqual(
      await loadLifecyclePinStateWith(subject.resolveProjectRoot)(subject.root, lifecycleKey),
      { status: "pinned", pin: subject.pin },
      label,
    );
  }

  const mismatched = await setupRecoveryTool(t);
  const mismatchedPrepared = await prepare(mismatched);
  const mismatchedRegistry = join(mismatched.root, ".ima-cycle", "provider-pins.json");
  const mismatchedBefore = await readFile(mismatchedRegistry, "utf8");
  let mismatchPrompts = 0;
  const wrongHash = mismatchedPrepared.reportHash === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
  const mismatchResult = await invoke(
    mismatched.tool,
    { operation: "execute", reportPath: mismatchedPrepared.reportPath, confirmation: wrongHash },
    uiContext(mismatched.root, async () => {
      mismatchPrompts += 1;
      return true;
    }),
  );
  assert.deepEqual(mismatchResult.details, {
    status: "blocked",
    code: "lifecycle_reset_confirmation_invalid",
  });
  assert.equal(mismatchPrompts, 0);
  assert.deepEqual(mismatched.calls, { inventory: 1, snapshot: 0, deletion: 0, absence: 0 });
  assert.equal(await readFile(mismatchedRegistry, "utf8"), mismatchedBefore);
  assert.deepEqual(
    await loadLifecyclePinStateWith(mismatched.resolveProjectRoot)(mismatched.root, lifecycleKey),
    { status: "pinned", pin: mismatched.pin },
  );

  for (const [label, secondResponse] of [
    ["deletion cancellation", false],
    ["deletion UI exception", new Error("deletion confirmation failed")],
  ]) {
    const subject = await setupRecoveryTool(t);
    const prepared = await prepare(subject);
    let prompts = 0;
    const result = await invoke(
      subject.tool,
      { operation: "execute", reportPath: prepared.reportPath, confirmation: prepared.reportHash },
      uiContext(subject.root, async () => {
        prompts += 1;
        if (prompts === 1) return true;
        if (secondResponse instanceof Error) throw secondResponse;
        return secondResponse;
      }),
    );
    assert.deepEqual(result.details, {
      status: "blocked",
      code: "lifecycle_reset_confirmation_required",
    }, label);
    assert.equal(prompts, 2, label);
    assert.deepEqual(subject.calls, { inventory: 3, snapshot: 1, deletion: 0, absence: 0 }, label);
    const state = await loadLifecyclePinStateWith(subject.resolveProjectRoot)(subject.root, lifecycleKey);
    assert.equal(state.status, "recovering", label);
    if (state.status === "recovering") {
      assert.equal(state.recovery.checkpoint.stage, "snapshot_verified", label);
    }
  }
});
