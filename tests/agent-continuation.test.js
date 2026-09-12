import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CYCLE_AGENT_SESSION_SCHEMA_VERSION,
  CYCLE_PHASE_CONTEXT_ENTRY,
  createDirectSessionReference,
  cycleSessionOwnerFromEntries,
  loadCycleOwnedSession,
  loadCycleOwnedSessionRecord,
  loadDirectSessionRecord,
  storeCycleOwnedSessionRecord,
  storeDirectSessionRecord,
  validateCycleOwnedSessionRecord,
  validateCycleSessionOwner,
} from "../lib/ima-agent-sessions.ts";

const TIMESTAMP = "2026-08-04T18:00:00.000Z";
const UPDATED_TIMESTAMP = "2026-08-04T18:01:00.000Z";
const sessionFile = (root) => join(root, "sessions", "reviewer-session.jsonl");
const sessionsFile = (root) => join(root, ".ima-cycle", "agent-sessions.json");
const directSessionsFile = (root) => join(root, ".ima-cycle", "direct-agent-sessions.json");
const cycleOwner = (overrides = {}) => ({
  schemaVersion: CYCLE_AGENT_SESSION_SCHEMA_VERSION,
  project: "ima-pi",
  lifecycleKey: "ima-pi:jira:SKYNET-192",
  source: "jira:SKYNET-192",
  phase: "review",
  dispatchId: "cycle-review-dispatch",
  ...overrides,
});
const specialistRecord = (root, overrides = {}) => ({
  reference: "cycle:reviewer-1",
  agent: "reviewer",
  role: "review-read",
  resultKind: "review",
  provider: "fake-provider",
  model: "fake-review-model",
  thinking: "high",
  sessionId: "reviewer-session",
  sessionFile: sessionFile(root),
  writeScope: [],
  contractFingerprint: "reviewer-contract-fingerprint",
  status: "succeeded",
  fresh: true,
  followUpAllowed: true,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  ...overrides,
});
const createProject = async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-cycle-agent-session-"));
  await mkdir(join(root, "sessions"));
  await writeFile(sessionFile(root), "specialist session fixture\n");
  return root;
};

test("validates cycle ownership and specialist records at the persistence trust boundary", async () => {
  const root = await createProject();
  try {
    const owner = cycleOwner();
    const record = specialistRecord(root);
    const entry = {
      schemaVersion: CYCLE_AGENT_SESSION_SCHEMA_VERSION,
      owner,
      record,
    };
    const invalidOwners = [
      { name: "missing project", value: cycleOwner({ project: "" }) },
      { name: "non-cycle lifecycle key", value: cycleOwner({ lifecycleKey: "SKYNET-192" }) },
      { name: "control character in source", value: cycleOwner({ source: "jira:SKYNET-192\nother" }) },
      { name: "unknown phase", value: cycleOwner({ phase: "unknown" }) },
      { name: "invalid dispatch", value: cycleOwner({ dispatchId: "bad dispatch" }) },
    ];
    const invalidRecords = [
      { name: "relative session file", value: { ...record, sessionFile: "sessions/reviewer.jsonl" } },
      { name: "traversal write scope", value: { ...record, writeScope: ["../outside"] } },
      { name: "backslash write scope", value: { ...record, writeScope: ["tests\\outside"] } },
      { name: "unsupported status", value: { ...record, status: "unknown" } },
      { name: "control character in reference", value: { ...record, reference: "cycle:reviewer\n1" } },
    ];

    assert.equal(validateCycleSessionOwner(owner), true);
    assert.equal(validateCycleOwnedSessionRecord(entry), true);
    for (const { name, value } of invalidOwners) assert.equal(validateCycleSessionOwner(value), false, name);
    for (const { name, value } of invalidRecords) {
      assert.equal(validateCycleOwnedSessionRecord({ ...entry, record: value }), false, name);
    }

    const extracted = cycleSessionOwnerFromEntries([
      { type: "message", role: "user", content: "unrelated" },
      { type: "custom", customType: CYCLE_PHASE_CONTEXT_ENTRY, data: owner },
    ]);
    assert.deepEqual(extracted, owner);
    assert.notStrictEqual(extracted, owner);
    assert.equal(cycleSessionOwnerFromEntries([
      { type: "custom", customType: CYCLE_PHASE_CONTEXT_ENTRY, data: invalidOwners[0].value },
    ]), null);
    await assert.rejects(
      storeCycleOwnedSessionRecord({ cwd: root, owner, record: invalidRecords[0].value }),
      /cycle_agent_session_invalid/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stores records under the project .ima-cycle directory and safely updates a same-owner reference", async () => {
  const root = await createProject();
  try {
    const owner = cycleOwner();
    const initial = specialistRecord(root, { status: "running" });
    const updated = specialistRecord(root, { status: "succeeded", updatedAt: UPDATED_TIMESTAMP });

    await storeCycleOwnedSessionRecord({ cwd: root, owner, record: initial });
    await storeCycleOwnedSessionRecord({ cwd: root, owner, record: updated });

    const persisted = JSON.parse(await readFile(sessionsFile(root), "utf8"));
    assert.deepEqual(await readdir(join(root, ".ima-cycle")), ["agent-sessions.json"]);
    assert.deepEqual(persisted, {
      schemaVersion: CYCLE_AGENT_SESSION_SCHEMA_VERSION,
      records: [{
        schemaVersion: CYCLE_AGENT_SESSION_SCHEMA_VERSION,
        owner,
        record: updated,
      }],
    });
    assert.deepEqual(
      await loadCycleOwnedSession({ cwd: root, owner, reference: updated.reference }),
      {
        schemaVersion: CYCLE_AGENT_SESSION_SCHEMA_VERSION,
        owner,
        record: updated,
      },
    );
    assert.deepEqual(
      await loadCycleOwnedSessionRecord({ cwd: root, owner, reference: updated.reference }),
      updated,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists direct follow-up sessions across fresh phase processes", async () => {
  const root = await createProject();
  try {
    const reference = createDirectSessionReference();
    const initial = specialistRecord(root, { reference });
    const updated = specialistRecord(root, { reference, updatedAt: UPDATED_TIMESTAMP });

    await storeDirectSessionRecord({ cwd: root, record: initial });
    await storeDirectSessionRecord({ cwd: root, record: updated });

    const persisted = JSON.parse(await readFile(directSessionsFile(root), "utf8"));
    assert.match(reference, /^direct:[0-9a-f-]{36}$/);
    assert.deepEqual((await readdir(join(root, ".ima-cycle"))).sort(), [".gitignore", "direct-agent-sessions.json"]);
    assert.deepEqual(persisted, {
      schemaVersion: CYCLE_AGENT_SESSION_SCHEMA_VERSION,
      records: [updated],
    });
    assert.deepEqual(await loadDirectSessionRecord({ cwd: root, reference }), updated);
    assert.equal(await loadDirectSessionRecord({ cwd: root, reference: "direct:missing" }), null);
    assert.equal(await readFile(join(root, ".ima-cycle", ".gitignore"), "utf8"), "*\n");

    await assert.rejects(
      storeDirectSessionRecord({ cwd: root, record: { ...updated, sessionId: "replacement" } }),
      /direct_agent_session_conflict/,
    );
    await assert.rejects(
      storeDirectSessionRecord({ cwd: root, record: { ...updated, reference: "direct:no-follow-up", followUpAllowed: false } }),
      /direct_agent_session_invalid/,
    );
    await assert.rejects(
      storeDirectSessionRecord({ cwd: root, record: { ...updated, reference: "direct:failed", status: "failed" } }),
      /direct_agent_session_invalid/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes concurrent cycle-owned specialist records without losing either reference", async () => {
  const root = await createProject();
  try {
    const owner = cycleOwner();
    const first = specialistRecord(root, { reference: "cycle:reviewer-1" });
    const second = specialistRecord(root, { reference: "cycle:reviewer-2", sessionId: "reviewer-session-2" });
    await Promise.all([
      storeCycleOwnedSessionRecord({ cwd: root, owner, record: first }),
      storeCycleOwnedSessionRecord({ cwd: root, owner, record: second }),
    ]);
    const persisted = JSON.parse(await readFile(sessionsFile(root), "utf8"));
    assert.deepEqual(persisted.records.map(({ record }) => record.reference), [first.reference, second.reference]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loads a reviewer record only for its project lifecycle source while permitting rereview", async () => {
  const root = await createProject();
  try {
    const reviewOwner = cycleOwner();
    const record = specialistRecord(root);
    await storeCycleOwnedSessionRecord({ cwd: root, owner: reviewOwner, record });

    const rereviewOwner = cycleOwner({ phase: "rereview", dispatchId: "cycle-rereview-dispatch" });
    const restored = await loadCycleOwnedSession({
      cwd: root,
      owner: rereviewOwner,
      reference: record.reference,
    });
    assert.deepEqual(restored, {
      schemaVersion: CYCLE_AGENT_SESSION_SCHEMA_VERSION,
      owner: reviewOwner,
      record,
    });
    assert.equal(restored.owner.phase, "review");

    const foreignOwners = [
      cycleOwner({ project: "other-project", phase: "rereview", dispatchId: "other-project-dispatch" }),
      cycleOwner({ lifecycleKey: "ima-pi:jira:SKYNET-193", phase: "rereview", dispatchId: "other-lifecycle-dispatch" }),
      cycleOwner({ source: "jira:SKYNET-193", phase: "rereview", dispatchId: "other-source-dispatch" }),
    ];
    for (const owner of foreignOwners) {
      assert.equal(
        await loadCycleOwnedSession({ cwd: root, owner, reference: record.reference }),
        null,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects cross-lifecycle overwrite and malformed durable records without exposing them", async () => {
  const root = await createProject();
  try {
    const owner = cycleOwner();
    const record = specialistRecord(root);
    await storeCycleOwnedSessionRecord({ cwd: root, owner, record });

    const foreignOwner = cycleOwner({
      lifecycleKey: "ima-pi:jira:SKYNET-193",
      source: "jira:SKYNET-193",
      dispatchId: "cycle-other-lifecycle-dispatch",
    });
    await assert.rejects(
      storeCycleOwnedSessionRecord({ cwd: root, owner: foreignOwner, record }),
      /cycle_agent_session_conflict/,
    );
    assert.deepEqual(
      await loadCycleOwnedSession({ cwd: root, owner, reference: record.reference }),
      {
        schemaVersion: CYCLE_AGENT_SESSION_SCHEMA_VERSION,
        owner,
        record,
      },
    );

    await writeFile(sessionsFile(root), `${JSON.stringify({
      schemaVersion: CYCLE_AGENT_SESSION_SCHEMA_VERSION,
      records: [{
        schemaVersion: CYCLE_AGENT_SESSION_SCHEMA_VERSION,
        owner,
        record: { ...record, writeScope: ["../outside"] },
      }],
    })}\n`);
    await assert.rejects(
      loadCycleOwnedSession({ cwd: root, owner, reference: record.reference }),
      /cycle_agent_session_file_invalid/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed rather than writing through a .ima-cycle symlink", async () => {
  const root = await createProject();
  const outside = await mkdtemp(join(tmpdir(), "ima-cycle-agent-session-outside-"));
  try {
    await symlink(outside, join(root, ".ima-cycle"));
    await assert.rejects(
      storeCycleOwnedSessionRecord({ cwd: root, owner: cycleOwner(), record: specialistRecord(root) }),
    );
    await assert.rejects(
      storeDirectSessionRecord({ cwd: root, record: specialistRecord(root, { reference: "direct:reviewer" }) }),
    );
    await assert.rejects(readFile(join(outside, "agent-sessions.json"), "utf8"));
    await assert.rejects(readFile(join(outside, "direct-agent-sessions.json"), "utf8"));
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});
