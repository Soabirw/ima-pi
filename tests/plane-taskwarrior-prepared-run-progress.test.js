import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import * as artifactApi from "../lib/plane-taskwarrior-migration-artifacts.ts";
import {
  PreparedMigrationError,
  applyPreparedMigration,
  readPreparedMigrationStatus,
  reconcilePreparedMigration,
  runPreparedMigrationReadiness,
} from "../lib/plane-taskwarrior-prepared-run.ts";
import {
  BACKLOG_STATE_ID,
  DONE_STATE_ID,
  applyInput,
  migrationClient,
  preparedData,
  preparedRun,
} from "./plane-taskwarrior-prepared-run-fixtures.js";

test("persists blocked live readiness before creating any Plane work item", async (t) => {
  const prepared = await preparedRun(t);
  const fake = migrationClient({ stateGroup: "started" });

  await assert.rejects(
    applyPreparedMigration(applyInput({ prepared, client: fake.client })),
    (error) => error instanceof PreparedMigrationError && error.code === "READINESS_BLOCKED",
  );
  assert.deepEqual(fake.stats(), {
    createdItems: 0,
    createdRelations: 0,
    stateReads: 1,
    identityReads: 2,
  });

  const report = JSON.parse(await readFile(
    join(prepared.run.directory, artifactApi.MIGRATION_ARTIFACTS.preflightReport),
    "utf8",
  ));
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.outcome, "BLOCKED");
  const status = await readPreparedMigrationStatus({
    cwd: prepared.root,
    relativeRunPath: prepared.run.relativeRunPath,
    artifactApi,
  });
  assert.equal(status.state, "blocked");
});

test("requires a checkpoint before reconciliation can create a Plane client", async (t) => {
  const prepared = await preparedRun(t);
  let clientCalls = 0;
  let configCalls = 0;

  await assert.rejects(
    reconcilePreparedMigration({
      cwd: prepared.root,
      relativeRunPath: prepared.run.relativeRunPath,
      env: {},
      artifactApi,
      createClient: () => { clientCalls += 1; return {}; },
      readConfig: () => { configCalls += 1; return {}; },
    }),
    (error) => error instanceof PreparedMigrationError && error.code === "CHECKPOINT_REQUIRED",
  );
  assert.equal(clientCalls, 0);
  assert.equal(configCalls, 0);
});

test("reports detailed readiness progress around each destination read", async () => {
  const { source, plan } = preparedData();
  const steps = [];
  const client = {
    listProjectStates: async () => {
      steps.push({ kind: "state-read" });
      return [
        { id: BACKLOG_STATE_ID, group: "backlog" },
        { id: DONE_STATE_ID, group: "completed" },
      ];
    },
    listProjectWorkItems: async () => {
      steps.push({ kind: "identity-read" });
      return [];
    },
  };

  const report = await runPreparedMigrationReadiness({
    client,
    source,
    plan,
    onProgress: (event) => {
      if (!event.readinessStep) return;
      steps.push({
        kind: "progress",
        completed: event.completed,
        total: event.total,
        projectKey: event.projectKey,
        readinessStep: event.readinessStep,
        readinessCompleted: event.readinessCompleted,
        readinessTotal: event.readinessTotal,
      });
    },
  });

  assert.equal(report.outcome, "READY");
  assert.deepEqual(steps, [
    {
      kind: "progress",
      completed: 0,
      total: 1,
      projectKey: "DEST",
      readinessStep: "project-states",
      readinessCompleted: 0,
      readinessTotal: 1,
    },
    { kind: "state-read" },
    {
      kind: "progress",
      completed: 0,
      total: 1,
      projectKey: "DEST",
      readinessStep: "project-states",
      readinessCompleted: 1,
      readinessTotal: 1,
    },
    {
      kind: "progress",
      completed: 0,
      total: 1,
      projectKey: "DEST",
      readinessStep: "external-identities",
      readinessCompleted: 0,
      readinessTotal: 2,
    },
    { kind: "identity-read" },
    {
      kind: "progress",
      completed: 0,
      total: 1,
      projectKey: "DEST",
      readinessStep: "external-identities",
      readinessCompleted: 1,
      readinessTotal: 2,
    },
    { kind: "identity-read" },
    {
      kind: "progress",
      completed: 0,
      total: 1,
      projectKey: "DEST",
      readinessStep: "external-identities",
      readinessCompleted: 2,
      readinessTotal: 2,
    },
  ]);
});

test("reports application progress only after checkpoints persist and contains observer failures", async (t) => {
  const prepared = await preparedRun(t);
  const fake = migrationClient();
  const checkpoints = [];
  const events = [];
  const persistedItemCounts = [];
  const persistedRelationCounts = [];
  let observerThrew = false;
  let asyncObserverRejected = false;
  const trackingArtifacts = {
    ...artifactApi,
    writeCheckpoint: async (input) => {
      await artifactApi.writeCheckpoint(input);
      checkpoints.push(input.value);
    },
  };

  const result = await applyPreparedMigration({
    ...applyInput({ prepared, client: fake.client, artifact: trackingArtifacts }),
    onProgress: (event) => {
      events.push(event);
      if (event.phase === "applying-items" && event.completed > 0) {
        persistedItemCounts.push(Object.keys(checkpoints.at(-1).itemOutcomesByTaskUuid).length);
      }
      if (event.phase === "applying-relations" && event.completed > 0) {
        persistedRelationCounts.push(Object.keys(checkpoints.at(-1).relationOutcomesByKey).length);
      }
      if (!observerThrew && event.phase === "applying-items" && event.completed === 1) {
        observerThrew = true;
        throw new Error("progress observers must not alter migration behavior");
      }
      if (!asyncObserverRejected && event.phase === "applying-relations" && event.completed === 1) {
        asyncObserverRejected = true;
        return Promise.reject(new Error("async progress observers must not alter migration behavior"));
      }
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.state, "applied");
  assert.equal(observerThrew, true);
  assert.equal(asyncObserverRejected, true);
  assert.deepEqual(persistedItemCounts, [1, 2]);
  assert.deepEqual(persistedRelationCounts, [1]);
  assert.deepEqual(
    events.filter(({ phase }) => phase === "applying-items").map(({ completed, total }) => ({ completed, total })),
    [{ completed: 0, total: 2 }, { completed: 1, total: 2 }, { completed: 2, total: 2 }],
  );
  assert.deepEqual(
    events.filter(({ phase }) => phase === "applying-relations").map(({ completed, total }) => ({ completed, total })),
    [{ completed: 0, total: 1 }, { completed: 1, total: 1 }],
  );
  assert.equal(events.some(({ phase }) => phase === "readiness-persisted"), true);
  assert.equal(events.some(({ phase }) => phase === "application-checkpoints-complete"), true);
});

test("reports reconciliation observation and persistence progress", async (t) => {
  const prepared = await preparedRun(t);
  const fake = migrationClient();
  await applyPreparedMigration(applyInput({ prepared, client: fake.client }));
  const events = [];

  const result = await reconcilePreparedMigration({
    cwd: prepared.root,
    relativeRunPath: prepared.run.relativeRunPath,
    env: {},
    artifactApi,
    createClient: () => fake.client,
    readConfig: () => ({}),
    onProgress: (event) => events.push(event),
  });

  assert.equal(result.state, "reconciled");
  assert.deepEqual(
    events.filter(({ phase }) => phase === "reconciling-items").map(({ completed, total }) => ({ completed, total })),
    [{ completed: 0, total: 2 }, { completed: 1, total: 2 }, { completed: 2, total: 2 }],
  );
  assert.deepEqual(
    events.filter(({ phase }) => phase === "reconciling-relations").map(({ completed, total }) => ({ completed, total })),
    [{ completed: 0, total: 1 }, { completed: 1, total: 1 }],
  );
  assert.equal(events.some(({ phase }) => phase === "reconciliation-persisted"), true);
});
