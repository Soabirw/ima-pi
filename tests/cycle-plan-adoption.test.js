import assert from "node:assert/strict";
import test from "node:test";
import {
  adoptedPlanState,
  coordinateCyclePlanAdoption,
  revalidateImportedPlanReference,
} from "../lib/ima-cycle-plan-adoption.ts";
import { buildCycleOutcomeMarker, createCycleState } from "../lib/ima-cycle.ts";
import { buildLifecycleArtifact } from "../lib/ima-lifecycle.ts";
import { filterImportedPlanLineage } from "../lib/ima-cycle-plan.ts";
import {
  coordinateCycleStart,
  observeLifecycleResult,
  registerCycleExtension,
} from "../extensions/cycle.ts";
import {
  contentHash,
  lifecycleKey,
  planArtifact,
  planIdentity,
  planRecord,
  planeSource,
  recordKey,
  recallPayload,
  uuid,
} from "./cycle-plan-fixtures.js";

const state = () => createCycleState(planeSource, {
  lifecycleKey,
  timestamp: "2026-09-08T01:00:00.000Z",
});

const legacy = (overrides = {}) => planRecord({ artifact: planArtifact(), ...overrides });

const completed = (artifactId, recordKey) => ({
  status: "completed",
  artifactId,
  recordKey,
  receiptAccepted: true,
  semanticRecall: { matched: true },
});

test("adopts a directly approved plan without prompting or writing an approval wrapper", async () => {
  const direct = planRecord();
  let confirms = 0;
  let persists = 0;
  const result = await coordinateCyclePlanAdoption({
    state: state(),
    recall: async () => recallPayload([direct]),
    interactive: true,
    confirm: async () => { confirms += 1; return true; },
    persistApproval: async () => { persists += 1; return null; },
    identity: planIdentity(),
  });
  assert.equal(result.kind, "approved");
  assert.equal(confirms, 0);
  assert.equal(persists, 0);
});

test("confirms a legacy plan once, persists only a reference, and rechecks the wrapper", async () => {
  const original = legacy({ id: uuid(20), key: recordKey("legacy") });
  const approvalId = uuid(21);
  const approvalKey = recordKey("legacy-approval");
  let records = [original];
  let confirmation = 0;
  let request;
  const result = await coordinateCyclePlanAdoption({
    state: state(),
    recall: async () => recallPayload(records),
    interactive: true,
    confirm: async () => { confirmation += 1; return true; },
    identity: planIdentity(),
    persistApproval: async (value) => {
      request = value;
      records = [
        original,
        planRecord({
          id: approvalId,
          key: approvalKey,
          createdAt: "2026-09-08T01:02:00.000Z",
          artifact: value.artifact,
          identity: value.identity,
          hash: contentHash(approvalKey),
        }),
      ];
      return completed(approvalId, approvalKey);
    },
  });
  assert.equal(result.kind, "approved");
  if (result.kind !== "approved") return;
  assert.equal(confirmation, 1);
  assert.equal(result.approval.recordKey, approvalKey);
  assert.equal(result.contract.recordKey, original.recordKey);
  assert.equal(request.type, "plan");
  assert.match(request.artifact, /ima-plan-approval/);
  assert.match(request.artifact, /ima-cycle outcome: phase=plan; outcome=APPROVED/);
  assert.doesNotMatch(request.artifact, /lifecycle:\n/);
  assert.deepEqual(request.identity.priorArtifactIds, [original.id]);
  assert.ok(request.identity.sourceRefs.includes(`QdrantRecordKey:${original.recordKey}`));
});

test("does not prompt in noninteractive recovery and does not write after cancellation", async () => {
  const original = legacy({ id: uuid(22), key: recordKey("noninteractive") });
  let persists = 0;
  const noninteractive = await coordinateCyclePlanAdoption({
    state: state(),
    recall: async () => recallPayload([original]),
    interactive: false,
    persistApproval: async () => { persists += 1; return null; },
    identity: planIdentity(),
  });
  assert.equal(noninteractive.kind, "confirmation-required");
  assert.equal(persists, 0);

  const cancelled = await coordinateCyclePlanAdoption({
    state: state(),
    recall: async () => recallPayload([original]),
    interactive: true,
    confirm: async () => false,
    persistApproval: async () => { persists += 1; return null; },
    identity: planIdentity(),
  });
  assert.equal(cancelled.kind, "cancelled");
  assert.equal(persists, 0);
});

test("fails closed when current evidence changes, persistence fails, or re-read is unavailable", async () => {
  const original = legacy({ id: uuid(23), key: recordKey("changed") });
  const newerBlocked = planRecord({
    id: uuid(24),
    key: recordKey("newer-blocked"),
    createdAt: "2026-09-08T01:01:00.000Z",
    artifact: planArtifact("BLOCKED"),
  });
  let reads = 0;
  const changed = await coordinateCyclePlanAdoption({
    state: state(),
    recall: async () => recallPayload(reads++ === 0 ? [original] : [original, newerBlocked]),
    interactive: true,
    confirm: async () => true,
    persistApproval: async () => { throw new Error("must not persist changed plan"); },
    identity: planIdentity(),
  });
  assert.deepEqual(changed, { kind: "blocked", code: "plan_selection_changed" });

  const failedPersistence = await coordinateCyclePlanAdoption({
    state: state(),
    recall: async () => recallPayload([original]),
    interactive: true,
    confirm: async () => true,
    persistApproval: async () => ({ status: "failed" }),
    identity: planIdentity(),
  });
  assert.deepEqual(failedPersistence, { kind: "blocked", code: "plan_approval_persist_failed" });

  const unavailable = await coordinateCyclePlanAdoption({
    state: state(),
    recall: async () => null,
    interactive: false,
  });
  assert.deepEqual(unavailable, { kind: "blocked", code: "plan_recall_failed" });
});

test("starts implementation directly from an approved manual plan without routing planning", async () => {
  const direct = planRecord({ id: uuid(27), key: recordKey("start-direct") });
  const routes = [];
  const messages = [];
  const states = [];
  const result = await coordinateCycleStart({
    source: planeSource,
    lifecycleKey,
    cwd: "/repo",
    context: async () => ({ status: "ready" }),
    adoptPlan: (candidate) => coordinateCyclePlanAdoption({
      state: candidate,
      recall: async () => recallPayload([direct]),
      interactive: false,
    }),
    applyRoute: async (phase) => { routes.push(phase); return { ok: true }; },
    appendState: (next) => states.push(next),
    persistAdoptionState: (next) => states.push(next),
    expandPrompt: async (message) => message,
    sendUserMessage: async (message, provisional) => {
      messages.push(message);
      return provisional;
    },
    timestamp: "2026-09-08T02:00:00.000Z",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(routes, ["implementation"]);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^\/ima:implement plane:ima:SKYNET-189/);
  assert.deepEqual({ phase: states[0].phase, status: states[0].status }, {
    phase: "implementation",
    status: "awaiting-resume",
  });
  assert.equal(states.some(({ phase }) => phase === "plan"), false);
});

test("revalidates imported plans and filters downstream recovery to bound lineage", async () => {
  const direct = planRecord({ id: uuid(29), key: recordKey("lineage") });
  const adoption = await coordinateCyclePlanAdoption({
    state: state(),
    recall: async () => recallPayload([direct]),
    interactive: false,
  });
  assert.equal(adoption.kind, "approved");
  if (adoption.kind !== "approved") return;
  const adopted = adoptedPlanState(state(), adoption, {
    allowAwaitingEvidence: true,
    timestamp: "2026-09-08T01:00:00.000Z",
  });
  assert.equal(adopted.ok, true);
  if (!adopted.ok) return;
  const revalidated = await revalidateImportedPlanReference({
    state: adopted.state,
    recall: async () => recallPayload([direct]),
  });
  assert.deepEqual(revalidated, { kind: "verified" });

  const implementation = {
    id: uuid(30),
    recordKey: `${lifecycleKey}:implementation:lineage`,
    project: "ima-pi",
    lifecycleKey,
    phase: "implementation",
    sourceRefs: ["plane:ima:SKYNET-189"],
    contentHash: contentHash("implementation-lineage"),
    createdAt: "2026-09-08T01:01:00.000Z",
    content: buildLifecycleArtifact({
      type: "implementation",
      identity: planIdentity({ priorArtifactIds: [direct.id] }),
      artifact: "# Implementation",
      nonce: "01234567-89ab-4def-8abc-0123456789ac",
    }),
  };
  const filtered = filterImportedPlanLineage(recallPayload([implementation]), {
    lifecycleKey,
    source: planeSource,
    phase: "implementation",
    lineage: { approvalArtifactId: direct.id, approvedAt: direct.createdAt },
  });
  assert.equal(filtered.valid, true);
  if (filtered.valid) assert.equal(filtered.payload.results.length, 1);

  const unbound = {
    ...implementation,
    id: uuid(31),
    recordKey: `${lifecycleKey}:implementation:unbound`,
    content: buildLifecycleArtifact({
      type: "implementation",
      identity: planIdentity(),
      artifact: "# Implementation",
      nonce: "01234567-89ab-4def-8abc-0123456789ad",
    }),
  };
  assert.deepEqual(filterImportedPlanLineage(recallPayload([unbound]), {
    lifecycleKey,
    source: planeSource,
    phase: "implementation",
    lineage: { approvalArtifactId: direct.id, approvedAt: direct.createdAt },
  }), { valid: false, code: "plan_lineage_unbound" });
});

test("requires imported approval lineage on live implementation persistence", async () => {
  const direct = planRecord({ id: uuid(34), key: recordKey("live-lineage") });
  const adoption = await coordinateCyclePlanAdoption({
    state: state(),
    recall: async () => recallPayload([direct]),
    interactive: false,
  });
  assert.equal(adoption.kind, "approved");
  if (adoption.kind !== "approved") return;
  const adopted = adoptedPlanState(state(), adoption, {
    allowAwaitingEvidence: true,
    timestamp: "2026-09-08T01:00:00.000Z",
  });
  assert.equal(adopted.ok, true);
  if (!adopted.ok) return;
  const artifact = `# Implementation\n\n${buildCycleOutcomeMarker({ phase: "implementation", outcome: "COMPLETED" })}`;
  const result = (priorArtifactIds) => observeLifecycleResult({
    state: { ...adopted.state, status: "awaiting-evidence" },
    toolName: "ima_lifecycle",
    toolCallId: "implementation-tool",
    input: {
      type: "implementation",
      identity: planIdentity({ priorArtifactIds }),
      artifact,
    },
    result: {
      details: {
        status: "completed",
        phase: "implementation",
        lifecycleKey,
        artifactId: uuid(35),
        recordKey: `${lifecycleKey}:implementation:live`,
        receiptAccepted: true,
        semanticRecall: { matched: true },
      },
      content: [],
      isError: false,
    },
    timestamp: "2026-09-08T01:01:00.000Z",
  });
  assert.equal(result([]).matched, false);
  assert.equal(result([direct.id]).matched, true);
});

test("session recovery adopts deterministic manual approval without prompting or dispatching", async () => {
  const direct = planRecord({ id: uuid(28), key: recordKey("recovery") });
  const handlers = new Map();
  const commands = new Map();
  const entries = [];
  const messages = [];
  const original = {
    ...state(),
    status: "awaiting-resume",
  };
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (customType, data) => entries.push({ customType, data }),
    sendUserMessage: (message) => { messages.push(message); return Promise.resolve(); },
    exec: async () => ({ code: 0, stdout: "" }),
  };
  const ctx = {
    cwd: "/repo",
    mode: "tui",
    hasUI: true,
    abort: () => {},
    sessionManager: { getBranch: () => [], getLeafId: () => "branch" },
    ui: {
      setStatus: () => {},
      notify: () => {},
      confirm: async () => true,
      editor: async (_title, value) => value,
    },
  };
  registerCycleExtension(pi, {
    recall: async (query) => ({
      structuredContent: query.endsWith(" plan") ? recallPayload([direct]) : recallPayload([]),
    }),
    resolveProjectRoot: async (cwd) => cwd,
    loadDurableState: async () => original,
    persistDurableState: async () => {},
    applyRoute: async () => ({ ok: true }),
    expandPrompt: async (value) => value,
  });
  await handlers.get("session_start")({}, ctx);
  await commands.get("ima:cycle").handler("status", ctx);
  assert.equal(messages.length, 0);
  assert.ok(entries.some(({ data }) => data.phase === "implementation" && data.status === "awaiting-resume"));
});

test("interactive resume previews the complete legacy artifact and dispatches implementation only after rechecked persistence", async () => {
  const original = legacy({ id: uuid(32), key: recordKey("interactive-legacy") });
  const approvalId = uuid(33);
  const approvalKey = recordKey("interactive-approval");
  let records = [original];
  let preview = null;
  let persisted = null;
  const handlers = new Map();
  const commands = new Map();
  const entries = [];
  const messages = [];
  const originalState = { ...state(), status: "awaiting-resume" };
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (customType, data) => entries.push({ customType, data }),
    sendUserMessage: (message) => {
      messages.push(message);
      queueMicrotask(() => {
        handlers.get("input")({ source: "extension", text: message });
        handlers.get("before_agent_start")({ prompt: message });
        handlers.get("agent_start")();
        handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop" }] });
        handlers.get("agent_settled")();
      });
      return Promise.resolve();
    },
    exec: async () => ({ code: 0, stdout: "" }),
  };
  const ctx = {
    cwd: "/repo",
    mode: "tui",
    hasUI: true,
    abort: () => {},
    sessionManager: { getBranch: () => [], getLeafId: () => "branch" },
    ui: {
      setStatus: () => {},
      notify: () => {},
      confirm: async () => true,
      editor: async (_title, value) => { preview = value; return value; },
    },
  };
  registerCycleExtension(pi, {
    recall: async (query) => ({ structuredContent: query.endsWith(" plan") ? recallPayload(records) : recallPayload([]) }),
    lifecycle: async (request) => {
      persisted = request;
      records = [
        original,
        planRecord({
          id: approvalId,
          key: approvalKey,
          createdAt: "2026-09-08T01:02:00.000Z",
          artifact: request.artifact,
          identity: request.identity,
          hash: contentHash(approvalKey),
        }),
      ];
      return completed(approvalId, approvalKey);
    },
    resolveProjectRoot: async (cwd) => cwd,
    loadDurableState: async () => originalState,
    persistDurableState: async () => {},
    applyRoute: async () => ({ ok: true }),
    expandPrompt: async (value) => value,
  });
  await handlers.get("session_start")({}, ctx);
  await commands.get("ima:cycle").handler("resume", ctx);
  assert.equal(preview, original.content);
  assert.equal(persisted.type, "plan");
  assert.doesNotMatch(persisted.artifact, /lifecycle:\n/);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^\/ima:implement plane:ima:SKYNET-189/);
  assert.ok(entries.some(({ data }) => data.phase === "implementation"));
});

test("stale adoption attempts never persist or report approval", async () => {
  const original = legacy({ id: uuid(25), key: recordKey("stale") });
  let current = true;
  let persists = 0;
  const result = await coordinateCyclePlanAdoption({
    state: state(),
    recall: async () => recallPayload([original]),
    interactive: true,
    confirm: async () => { current = false; return true; },
    persistApproval: async () => { persists += 1; return completed(uuid(26), recordKey("stale-approval")); },
    identity: planIdentity(),
    isCurrent: () => current,
  });
  assert.deepEqual(result, { kind: "cancelled" });
  assert.equal(persists, 0);
});
