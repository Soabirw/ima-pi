import assert from "node:assert/strict";
import test from "node:test";
import { createSerenaLifecycleProvider } from "../lib/serena-lifecycle.ts";
import {
  createSerenaLifecycleProject,
  createSerenaLifecycleRecord,
  serenaLifecycleNamespacePrefix,
} from "../lib/serena-lifecycle-record.ts";

const createdAt = "2026-10-15T12:00:00.000Z";
const lifecycleKey = "synthetic-project:plane:ima:TEST-1500";
const project = (() => {
  const value = createSerenaLifecycleProject({
    projectName: "synthetic-serena-project",
    projectPath: "/workspace/synthetic-serena-project",
  });
  assert.ok(value);
  return value;
})();

const success = (data) => ({ success: true, data });
const failure = (code) => ({ success: false, code });
const settledWrite = () => ({
  success: true,
  data: undefined,
  dispatch: "dispatched",
  settlement: "settled",
});
const identityFor = (key = lifecycleKey) => ({
  project: "synthetic-project",
  lifecycleKey: key,
  lifecycleRootMemoryId: "",
  taskwarriorProject: "",
  taskwarriorTask: "",
  taskwarriorUuid: "",
  jiraKey: "",
  planeWorkspace: "ima",
  planeWorkItem: "TEST-1500",
  sourceRefs: ["plane:ima:TEST-1500"],
  priorArtifactIds: [],
});
const requestFor = ({
  key = lifecycleKey,
  type = "plan",
  summary = "Synthetic Serena lifecycle continuity evidence remains exact.",
  artifact = "# Synthetic lifecycle artifact\n\nThis fixture is not production Serena lifecycle content.",
} = {}) => ({
  type,
  identity: identityFor(key),
  summary,
  artifact,
});

const recordFor = (options = {}) => {
  const record = createSerenaLifecycleRecord({
    request: options.request ?? requestFor(options),
    project,
    createdAt: options.createdAt ?? createdAt,
  });
  assert.ok(record);
  return record;
};

const createState = (options = {}) => {
  const memories = new Map(Object.entries(options.memories ?? {}));
  const calls = [];
  const client = {
    activate: async (value, signal) => {
      calls.push({ operation: "activate" });
      if (options.onActivate) return options.onActivate({ value, signal, calls, memories });
      return success(structuredClone(project));
    },
    listMemoryNames: async (signal) => {
      calls.push({ operation: "list" });
      if (options.onList) return options.onList({ signal, calls, memories });
      return success([...memories.keys()]);
    },
    readMemory: async (memoryName, signal) => {
      calls.push({ operation: "read", memoryName });
      if (options.onRead) return options.onRead({ memoryName, signal, calls, memories });
      return memories.has(memoryName)
        ? success(memories.get(memoryName))
        : failure("serena_memory_read_unavailable");
    },
    writeMemory: async ({ memoryName, content }, signal) => {
      calls.push({ operation: "write", memoryName });
      if (options.onWrite) return options.onWrite({ memoryName, content, signal, calls, memories });
      memories.set(memoryName, content);
      return settledWrite();
    },
  };
  const acquireLease = async () => ({ release: async () => undefined });
  return { client, calls, memories, acquireLease };
};

const providerFor = (state) => createSerenaLifecycleProvider({
  client: state.client,
  project,
  now: () => new Date(createdAt),
  acquireLease: state.acquireLease,
});

test("fresh provider instances get and reconcile serialized references through read-only exact evidence", async () => {
  const state = createState({ memories: { core: "ordinary memory", preferences: "ordinary preference" } });
  const firstProvider = providerFor(state);
  const persisted = await firstProvider.persist(requestFor());
  assert.equal(persisted.status, "verified");
  const writesBeforeFreshReads = state.calls.filter(({ operation }) => operation === "write").length;
  const reference = JSON.parse(JSON.stringify(persisted.reference));

  const freshProvider = providerFor(state);
  const read = await freshProvider.get(reference);
  const reconciled = await freshProvider.reconcile(JSON.parse(JSON.stringify(reference)));
  assert.equal(read.status, "verified");
  assert.equal(read.disposition, "unchanged");
  assert.equal(read.artifactId, persisted.artifactId);
  assert.equal(reconciled.status, "verified");
  assert.equal(reconciled.disposition, "unchanged");
  assert.equal(reconciled.recordKey, persisted.recordKey);
  assert.equal(state.calls.filter(({ operation }) => operation === "write").length, writesBeforeFreshReads);
  assert.equal(state.memories.get("core"), "ordinary memory");
  assert.equal(state.memories.get("preferences"), "ordinary preference");

  const changedReference = { ...reference, contentHash: "a".repeat(64) };
  const beforeMismatchWrites = state.calls.filter(({ operation }) => operation === "write").length;
  const mismatch = await freshProvider.get(changedReference);
  assert.equal(mismatch.status, "blocked");
  assert.equal(mismatch.code, "serena_verification_failed");
  assert.equal(state.calls.filter(({ operation }) => operation === "write").length, beforeMismatchWrites);
});

test("exact recall excludes ordinary and other-lifecycle memories while retaining only verified selected records", async () => {
  const plan = recordFor({
    type: "plan",
    summary: "Synthetic plan lifecycle evidence remains isolated.",
    artifact: "# Plan\n\nSynthetic plan evidence.",
  });
  const implementation = recordFor({
    type: "implementation",
    summary: "Synthetic implementation lifecycle evidence remains isolated.",
    artifact: "# Implementation\n\nSynthetic implementation evidence.",
  });
  const other = recordFor({
    key: "synthetic-project:plane:ima:OTHER-1500",
    summary: "Other lifecycle evidence must be excluded.",
    artifact: "# Other\n\nOther lifecycle evidence.",
  });
  const state = createState({
    memories: {
      core: "ordinary project context",
      conventions: "ordinary project preference",
      [plan.memoryName]: plan.serialized,
      [implementation.memoryName]: implementation.serialized,
      [other.memoryName]: other.serialized,
    },
  });
  const provider = providerFor(state);

  const recalled = await provider.recall({ lifecycleKey, limit: 2 });
  assert.equal(Array.isArray(recalled), true);
  assert.equal(recalled.length, 2);
  assert.deepEqual(new Set(recalled.map(({ artifactId }) => artifactId)), new Set([
    plan.artifactId,
    implementation.artifactId,
  ]));
  assert.equal(recalled.every(({ lifecycleKey: key }) => key === lifecycleKey), true);
  assert.equal(state.calls.filter(({ operation }) => operation === "read").some(({ memoryName }) =>
    memoryName === "core" || memoryName === "conventions" || memoryName === other.memoryName,
  ), false);

  const planOnly = await provider.recall({ lifecycleKey, phase: "plan", limit: 1 });
  assert.equal(Array.isArray(planOnly), true);
  assert.equal(planOnly.length, 1);
  assert.equal(planOnly[0].artifactId, plan.artifactId);
  assert.equal(state.calls.filter(({ operation }) => operation === "write").length, 0);
});

test("recall blocks malformed namespace evidence, malformed records, duplicate lists, overflow, and incomplete reads without repair writes", async () => {
  const record = recordFor();
  const prefix = serenaLifecycleNamespacePrefix(lifecycleKey);
  assert.ok(prefix);
  const extra = recordFor({
    type: "implementation",
    summary: "Synthetic overflow evidence.",
    artifact: "# Implementation\n\nSynthetic overflow evidence.",
  });
  const scenarios = [
    {
      label: "malformed names sharing the selected namespace",
      state: createState({ onList: () => success([`${prefix}malformed`]) }),
      selection: { lifecycleKey, limit: 1 },
      code: "serena_recall_unverifiable",
      reads: 0,
    },
    {
      label: "malformed stored record",
      state: createState({ memories: { [record.memoryName]: "not-json" } }),
      selection: { lifecycleKey, limit: 1 },
      code: "serena_recall_unverifiable",
      reads: 1,
    },
    {
      label: "duplicate authoritative names",
      state: createState({ onList: () => success([record.memoryName, record.memoryName]) }),
      selection: { lifecycleKey, limit: 2 },
      code: "serena_memory_listing_unverifiable",
      reads: 0,
    },
    {
      label: "over-limit exact records",
      state: createState({
        memories: {
          [record.memoryName]: record.serialized,
          [extra.memoryName]: extra.serialized,
        },
      }),
      selection: { lifecycleKey, limit: 1 },
      code: "serena_recall_unverifiable",
      reads: 0,
    },
    {
      label: "unavailable selected read",
      state: createState({ onList: () => success([record.memoryName]) }),
      selection: { lifecycleKey, limit: 1 },
      code: "serena_recall_unverifiable",
      reads: 1,
    },
  ];

  for (const scenario of scenarios) {
    const result = await providerFor(scenario.state).recall(scenario.selection);
    assert.equal(result.status, "blocked", scenario.label);
    assert.equal(result.code, scenario.code, scenario.label);
    assert.equal(
      scenario.state.calls.filter(({ operation }) => operation === "read").length,
      scenario.reads,
      scenario.label,
    );
    assert.equal(
      scenario.state.calls.filter(({ operation }) => operation === "write").length,
      0,
      scenario.label,
    );
  }
});

test("get and reconcile block missing or malformed exact references without fallback writes", async () => {
  const record = recordFor();
  const missing = createState();
  const provider = providerFor(missing);
  const notFound = await provider.get(structuredClone(record.reference));
  assert.equal(notFound.status, "blocked");
  assert.equal(notFound.code, "serena_record_not_found");
  assert.deepEqual(missing.calls.map(({ operation }) => operation), ["activate", "list"]);
  assert.equal(missing.calls.filter(({ operation }) => operation === "write").length, 0);

  const malformed = createState({ memories: { [record.memoryName]: "malformed-token=do-not-return" } });
  const malformedResult = await providerFor(malformed).reconcile(structuredClone(record.reference));
  assert.equal(malformedResult.status, "blocked");
  assert.equal(malformedResult.code, "serena_verification_failed");
  assert.ok(malformedResult.reference);
  assert.doesNotMatch(JSON.stringify(malformedResult), /token=|do-not-return/i);
  assert.equal(malformed.calls.filter(({ operation }) => operation === "write").length, 0);

  const invalid = createState();
  const invalidReference = await providerFor(invalid).get({
    ...record.reference,
    memoryName: "core",
  });
  assert.equal(invalidReference.status, "blocked");
  assert.equal(invalidReference.code, "serena_reference_invalid");
  assert.deepEqual(invalid.calls, []);
});

test("recall stops on cancellation during a selected read and never writes a fallback record", async () => {
  const record = recordFor();
  const controller = new AbortController();
  const state = createState({
    memories: { [record.memoryName]: record.serialized },
    onRead: ({ memoryName, memories }) => {
      controller.abort();
      return success(memories.get(memoryName));
    },
  });
  const result = await providerFor(state).recall({ lifecycleKey, limit: 1 }, controller.signal);
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "aborted");
  assert.deepEqual(state.calls.map(({ operation }) => operation), ["activate", "list", "read"]);
  assert.equal(state.calls.filter(({ operation }) => operation === "write").length, 0);
});
