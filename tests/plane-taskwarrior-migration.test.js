import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { link, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  buildDryRunReport,
  buildMigrationPlan,
  buildReconciliationReport,
  classifyTask,
  comparePlannedWorkItem,
  dependencyEdgesForTasks,
  migrationPlanSha256,
  normalizeTaskwarriorTask,
  normalizeTaskwarriorTimestamp,
  parseTaskwarriorProjectMap,
  reconcilePlannedItems,
  reconcilePlannedRelations,
  workItemInputForTask,
} from "../lib/plane-taskwarrior-migration.ts";
import {
  HISTORY_POLICIES,
  buildPreparationSource,
  decisionsToPlanInputs,
} from "../lib/plane-taskwarrior-planning.ts";
import {
  MIGRATION_ARTIFACTS,
  clearReconciliationReport,
  createMigrationRun,
  loadMigrationRun,
  readCheckpoint,
  readRunArtifact,
  replaceRunArtifact,
  withMigrationLock,
  writeCheckpoint,
  writeRunArtifact,
} from "../lib/plane-taskwarrior-migration-artifacts.ts";
import { runPlaneTaskwarriorMigration, stripPlaneEnvironment } from "../scripts/plane-taskwarrior-migrate.mjs";
import { PlaneApiError } from "../skills/plane-api/scripts/plane-client.mjs";
import {
  DESTINATIONS,
  migrationFixture,
  normalizedPlaneItemFor,
} from "./plane-taskwarrior-migration-fixtures.js";

const planFromFixture = () => buildMigrationPlan(migrationFixture());

const planeItemIdFor = (taskUuid) => taskUuid;

const observedItemsFor = (plan) => Object.fromEntries(
  plan.items
    .filter((item) => item.disposition === "create")
    .map((item) => [
      item.taskUuid,
      normalizedPlaneItemFor(item, planeItemIdFor(item.taskUuid)),
    ]),
);

const observedRelationsFor = (plan) => plan.eligibleRelations.reduce((relations, edge) => {
  const blockedByIds = relations[edge.sourceTaskUuid]?.blockedByIds ?? [];
  return {
    ...relations,
    [edge.sourceTaskUuid]: {
      blockedByIds: [...blockedByIds, planeItemIdFor(edge.targetTaskUuid)],
    },
  };
}, {});

const copiedPlan = (plan) => JSON.parse(JSON.stringify(plan));

const selfHashedPlan = (plan) => ({
  ...plan,
  planSha256: migrationPlanSha256(plan),
});

test("parses the approved project mappings and constructs corrected edge accounting", () => {
  const fixture = migrationFixture();
  const mappings = parseTaskwarriorProjectMap(fixture.worksheet);
  const plan = buildMigrationPlan(fixture);

  assert.equal(mappings.length, 3);
  assert.deepEqual(plan.summary, {
    sourceTasks: 272,
    creates: 252,
    taskSkips: 20,
    pending: 57,
    completed: 195,
    createsByProject: { SKYNET: 176, WEB: 76 },
    sourceEdges: 318,
    eligibleRelations: 307,
    deletedEndpointSkips: 11,
  });
  assert.equal(plan.eligibleRelations.length, 307);
  assert.equal(plan.skippedRelations.length, 11);
  assert.equal(plan.skippedRelations.every((relation) => relation.reason === "deleted_endpoint"), true);
  assert.equal(plan.items.filter((item) => item.disposition === "skip").length, 20);
});

test("produces deterministic plans and preserves state, priority, and provenance", () => {
  const firstPlan = planFromFixture();
  const secondPlan = planFromFixture();
  const pendingItem = firstPlan.items.find((item) => item.taskStatus === "pending");
  const completedItem = firstPlan.items.find((item) => item.taskStatus === "completed");

  assert.equal(firstPlan.planSha256, secondPlan.planSha256);
  assert.equal(pendingItem.destination.stateKind, "backlog");
  assert.equal(completedItem.destination.stateKind, "done");
  assert.equal(pendingItem.workItem.externalSource, "taskwarrior");
  assert.equal(pendingItem.workItem.descriptionStripped.includes("Taskwarrior UUID:"), true);
  assert.equal(pendingItem.workItem.descriptionStripped.includes("entry: 2026-09-01T00:00:00.000Z"), true);
  assert.equal(completedItem.workItem.descriptionStripped.includes("end: 2026-09-03T00:00:00.000Z"), true);
});

test("classifies deleted tasks and records every deleted-endpoint relation as skipped", () => {
  const fixture = migrationFixture();
  const plan = buildMigrationPlan(fixture);
  const deletedTask = fixture.tasks.find((task) => task.status === "deleted");
  const edgeResult = dependencyEdgesForTasks({ tasks: fixture.tasks, items: plan.items });

  assert.deepEqual(classifyTask(deletedTask), { disposition: "skip", reason: "deleted_task" });
  assert.equal(edgeResult.eligibleRelations.length, 307);
  assert.equal(edgeResult.skippedRelations.length, 11);
  assert.equal(edgeResult.skippedRelations.every((edge) => edge.reason === "deleted_endpoint"), true);
});

test("normalizes Taskwarrior timestamps and rejects malformed data", () => {
  assert.equal(normalizeTaskwarriorTimestamp("20260901T010203Z"), "2026-09-01T01:02:03.000Z");
  assert.equal(normalizeTaskwarriorTimestamp("2026-09-01T01:02:03Z"), "2026-09-01T01:02:03.000Z");
  assert.throws(() => normalizeTaskwarriorTimestamp("20260230T010203Z"), /timestamp_invalid/);
  assert.throws(
    () => normalizeTaskwarriorTask({ uuid: "not-a-uuid", status: "pending", description: "Task" }),
    /task_uuid_invalid/,
  );

  const fixture = migrationFixture();
  const invalidWorksheet = fixture.worksheet.replace("| web-project | 76 |", "| web-project | 77 |");
  assert.throws(
    () => buildMigrationPlan({ ...fixture, worksheet: invalidWorksheet }),
    /worksheet_count_invalid|worksheet_count_mismatch/,
  );
});

test("retains annotation detail in generated migration descriptions", () => {
  const fixture = migrationFixture();
  const sourceTask = fixture.tasks.find((task) => task.status === "pending");
  const annotationText = "Lifecycle unit: description detail\nBusiness outcome: Plane retains the brief";
  const annotatedTask = {
    ...sourceTask,
    wait: "20260905T010203Z",
    annotations: [{ entry: "20260901T184804Z", description: annotationText }],
  };
  const tasks = fixture.tasks.map((task) => (
    task.uuid === annotatedTask.uuid ? annotatedTask : task
  ));
  const normalizedTask = normalizeTaskwarriorTask(annotatedTask);
  const plan = buildMigrationPlan({ ...fixture, tasks });
  const plannedItem = plan.items.find((item) => item.taskUuid === annotatedTask.uuid);
  const description = plannedItem.workItem.descriptionStripped;

  assert.deepEqual(normalizedTask.annotations, [{
    entry: "2026-09-01T18:48:04.000Z",
    description: annotationText,
  }]);
  assert.equal(description.includes(annotationText), true);
  assert.equal(description.includes("entry: 2026-09-01T18:48:04.000Z"), true);
  assert.equal(description.includes(`project: ${normalizedTask.project}`), true);
  assert.equal(description.includes(`status: ${normalizedTask.status}`), true);
  assert.equal(description.includes(`priority: ${normalizedTask.priority}`), true);
  assert.equal(description.includes(`wait: ${normalizedTask.wait}`), true);
  assert.equal(description.includes(`depends: ${normalizedTask.depends.join(", ")}`), true);
  assert.equal(description.includes(`Taskwarrior UUID: ${normalizedTask.uuid}`), true);
});

test("derives one plan hash from equal-timestamp annotation permutations", () => {
  const fixture = migrationFixture();
  const sourceTask = fixture.tasks.find((task) => task.status === "pending");
  const planWithAnnotations = (annotations) => buildMigrationPlan({
    ...fixture,
    tasks: fixture.tasks.map((task) => (
      task.uuid === sourceTask.uuid ? { ...sourceTask, annotations } : task
    )),
  });
  const firstPlan = planWithAnnotations([
    { entry: "20260901T000000Z", description: "ä" },
    { entry: "20260901T000000Z", description: "z" },
  ]);
  const secondPlan = planWithAnnotations([
    { entry: "20260901T000000Z", description: "z" },
    { entry: "20260901T000000Z", description: "ä" },
  ]);
  const firstItem = firstPlan.items.find((item) => item.taskUuid === sourceTask.uuid);
  const secondItem = secondPlan.items.find((item) => item.taskUuid === sourceTask.uuid);

  assert.equal(firstPlan.planSha256, secondPlan.planSha256);
  assert.equal(firstItem.workItem.descriptionStripped, secondItem.workItem.descriptionStripped);
});

test("rejects duplicate dependencies before producing a migration plan", () => {
  const fixture = migrationFixture();
  const source = fixture.tasks.find((task) => task.depends?.length > 0);
  const [dependency] = source.depends;
  const tasks = fixture.tasks.map((task) => (
    task.uuid === source.uuid ? { ...task, depends: [dependency, dependency] } : task
  ));

  assert.throws(
    () => buildMigrationPlan({ ...fixture, tasks }),
    /task_depends_duplicate/,
  );
});

test("rejects a dependency endpoint absent from the captured source", () => {
  const fixture = migrationFixture();
  const source = fixture.tasks.find((task) => task.status === "pending");
  const tasks = fixture.tasks.map((task) => (
    task.uuid === source.uuid
      ? { ...task, depends: [...(task.depends ?? []), "ffffffff-ffff-4fff-8fff-ffffffffffff"] }
      : task
  ));

  assert.throws(
    () => buildMigrationPlan({ ...fixture, tasks }),
    /dependency_target_missing/,
  );
});

test("rejects a dependency that crosses Plane projects", () => {
  const fixture = migrationFixture();
  const source = fixture.tasks.find((task) => task.project === "web-project");
  const target = fixture.tasks.find((task) => task.project === "skynet-project");
  const tasks = fixture.tasks.map((task) => (
    task.uuid === source.uuid
      ? { ...task, depends: [...(task.depends ?? []), target.uuid] }
      : task
  ));

  assert.throws(
    () => buildMigrationPlan({ ...fixture, tasks }),
    /cross_project_dependency/,
  );
});

test("compares planned work items without exposing observed values", () => {
  const plan = planFromFixture();
  const item = plan.items.find((entry) => entry.disposition === "create");
  const observed = normalizedPlaneItemFor(item, planeItemIdFor(item.taskUuid));
  const changed = { ...observed, description: "different description" };

  assert.deepEqual(comparePlannedWorkItem({ item, observedWorkItem: observed }), {
    taskUuid: item.taskUuid,
    planeItemId: item.taskUuid,
    matches: true,
    differentFields: [],
  });
  assert.deepEqual(comparePlannedWorkItem({ item, observedWorkItem: changed }).differentFields, ["description"]);
});

test("builds dry-run and reconciliation reports that account for every task and source edge", () => {
  const plan = planFromFixture();
  const observedItemsByTaskUuid = observedItemsFor(plan);
  const planeItemIdsByTaskUuid = Object.fromEntries(
    Object.keys(observedItemsByTaskUuid).map((taskUuid) => [taskUuid, planeItemIdFor(taskUuid)]),
  );
  const itemReconciliation = reconcilePlannedItems({ plan, observedItemsByTaskUuid });
  const relationReconciliation = reconcilePlannedRelations({
    plan,
    planeItemIdsByTaskUuid,
    observedRelationsByTaskUuid: observedRelationsFor(plan),
  });
  const dryRun = buildDryRunReport(plan);
  const report = buildReconciliationReport({
    plan,
    itemReconciliation,
    relationReconciliation,
    unresolvedRelationAttempts: [{
      sourceTaskUuid: plan.eligibleRelations[0].sourceTaskUuid,
      targetTaskUuid: plan.eligibleRelations[0].targetTaskUuid,
      reason: "HTTP_ERROR",
    }],
  });

  assert.equal(dryRun.summary.sourceEdges, 318);
  assert.equal(dryRun.plannedCreates.length, 252);
  assert.equal(dryRun.skippedTasks.length, 20);
  assert.equal(dryRun.eligibleRelations.length, 307);
  assert.equal(dryRun.skippedRelations.length, 11);
  assert.deepEqual(itemReconciliation.summary, { matched: 252, different: 0, missing: 0, skipped: 20 });
  assert.deepEqual(relationReconciliation.summary, { matched: 307, missing: 0, unresolved: 0, skipped: 11 });
  assert.equal(report.summary.relation.applyUnresolved, 1);
});

test("keeps the migration core free of effect-boundary imports", async () => {
  const source = await readFile("lib/plane-taskwarrior-migration.ts", "utf8");

  for (const effectModule of ["node:fs", "node:child_process", "node:process", "node:net"]) {
    assert.equal(source.includes(effectModule), false, effectModule);
  }
  assert.equal(source.includes("process.env"), false);
});

test("builds a client input from a normalized task and destination", () => {
  const fixture = migrationFixture();
  const plan = planFromFixture();
  const item = plan.items.find((entry) => entry.disposition === "create");
  const task = fixture.tasks.find((entry) => entry.uuid === item.taskUuid);
  const input = workItemInputForTask({
    task,
    destination: { disposition: "create", stateId: item.destination.stateId },
  });

  assert.equal(input.externalId, item.taskUuid);
  assert.equal(input.stateId, item.destination.stateId);
  assert.equal(input.descriptionStripped.includes("--- Taskwarrior provenance ---"), true);
});

const temporaryProject = async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ima-pi-plane-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

const outputWriter = () => {
  let output = "";
  return {
    writer: { write: (chunk) => { output += chunk; } },
    output: () => output,
  };
};

const runCommand = async (input) => {
  const stdout = outputWriter();
  const stderr = outputWriter();
  const exitCode = await runPlaneTaskwarriorMigration({
    stdout: stdout.writer,
    stderr: stderr.writer,
    ...input,
  });
  return {
    exitCode,
    stdout: stdout.output(),
    stderr: stderr.output(),
  };
};

const migrationClient = ({
  failFirstRelation = false,
  malformedFirstRelation = false,
  preflightStateFailure = false,
} = {}) => {
  const itemsByExternalId = new Map();
  const blockedByIdsByWorkItemId = new Map();
  const representativeDestinations = Object.entries(DESTINATIONS).map(([projectKey, destination]) => ({
    projectKey,
    ...destination,
  }));
  let createdItems = 0;
  let createdRelations = 0;
  let relationLookups = 0;
  let preflightRepresentativeReads = 0;
  let preflightStateReads = 0;
  let preflightRelationReads = 0;
  let preflightIdentityReads = 0;
  let failRelation = failFirstRelation;
  let malformedRelation = malformedFirstRelation;

  const destinationForProject = (projectId) =>
    representativeDestinations.find((destination) => destination.projectId === projectId) ?? null;

  const destinationForRepresentative = (reference) =>
    representativeDestinations.find((destination) =>
      reference === `plane:${destination.workspace}:${destination.projectKey}-1`) ?? null;

  const client = {
    getWorkItem: async (reference) => {
      preflightRepresentativeReads += 1;
      const destination = destinationForRepresentative(reference);
      if (!destination) throw new PlaneApiError("RESPONSE_ERROR");
      return { id: destination.projectId, projectId: destination.projectId };
    },
    listProjectStates: async ({ projectId }) => {
      preflightStateReads += 1;
      const destination = destinationForProject(projectId);
      if (!destination) throw new PlaneApiError("RESPONSE_ERROR");
      return [
        {
          id: destination.backlogStateId,
          group: preflightStateFailure ? "started" : "backlog",
        },
        { id: destination.doneStateId, group: "completed" },
      ];
    },
    listProjectWorkItems: async ({ externalId, externalSource }) => {
      preflightIdentityReads += 1;
      const item = itemsByExternalId.get(externalId);
      return item && item.externalSource === externalSource ? [item] : [];
    },
    createProjectWorkItem: async ({ projectId, input }) => {
      createdItems += 1;
      const item = {
        id: input.externalId,
        projectId,
        name: input.name,
        description: input.descriptionStripped,
        priority: input.priority,
        stateId: input.stateId,
        externalId: input.externalId,
        externalSource: input.externalSource,
      };
      itemsByExternalId.set(input.externalId, item);
      return item;
    },
    listWorkItemRelations: async ({ workItemId }) => {
      if (destinationForProject(workItemId)) {
        preflightRelationReads += 1;
        return { blockedByIds: [] };
      }

      relationLookups += 1;
      if (malformedRelation) {
        malformedRelation = false;
        throw new PlaneApiError("RESPONSE_ERROR");
      }
      return { blockedByIds: [...(blockedByIdsByWorkItemId.get(workItemId) ?? new Set())] };
    },
    createWorkItemRelation: async ({ workItemId, relation }) => {
      if (failRelation) {
        failRelation = false;
        throw new Error("synthetic relation failure");
      }
      createdRelations += 1;
      const blockedByIds = blockedByIdsByWorkItemId.get(workItemId) ?? new Set();
      blockedByIds.add(relation.issueIds[0]);
      blockedByIdsByWorkItemId.set(workItemId, blockedByIds);
      return { workItemId, ...relation };
    },
  };

  return {
    client,
    stats: () => ({ createdItems, createdRelations }),
    relationStats: () => ({ relationLookups, createdRelations }),
    preflightStats: () => ({
      representativeReads: preflightRepresentativeReads,
      stateReads: preflightStateReads,
      relationReads: preflightRelationReads,
      identityReads: preflightIdentityReads,
    }),
  };
};

const prepareFixtureRun = async ({ root, fixture, taskEnvironments }) => runCommand({
  argv: ["prepare"],
  cwd: root,
  env: { PLANE_BASE_URL: "https://plane.internal.example", PLANE_API_KEY: "secret", KEEP: "yes" },
  clock: () => new Date("2026-09-04T00:00:00.000Z"),
  execFile: async (file, args, options) => {
    taskEnvironments.push({ file, args, env: options.env, shell: options.shell });
    return { stdout: JSON.stringify(fixture.tasks) };
  },
});

test("stores migration artifacts with restrictive modes, safe paths, atomic checkpoints, and a lock", async (t) => {
  const root = await temporaryProject(t);
  const run = await createMigrationRun({ cwd: root, timestamp: "2026-09-04T00-00-00-000Z" });

  assert.equal((await lstat(run.directory)).mode & 0o777, 0o700);
  await writeRunArtifact({ run, name: MIGRATION_ARTIFACTS.source, value: { tasks: [] } });
  assert.equal((await lstat(join(run.directory, MIGRATION_ARTIFACTS.source))).mode & 0o777, 0o600);

  await writeCheckpoint({ run, value: { schemaVersion: 1, planeItemIdsByTaskUuid: {} } });
  await writeCheckpoint({ run, value: { schemaVersion: 2, planeItemIdsByTaskUuid: {} } });
  assert.deepEqual(await readCheckpoint({ run }), { schemaVersion: 2, planeItemIdsByTaskUuid: {} });
  await assert.rejects(
    withMigrationLock({
      run,
      operation: () => withMigrationLock({ run, operation: async () => "nested" }),
    }),
    /lock_in_progress/,
  );
  await assert.rejects(
    writeRunArtifact({ run, name: MIGRATION_ARTIFACTS.plan, value: { apiKey: "never-store" } }),
    /secret_field/,
  );
  await assert.rejects(loadMigrationRun({ cwd: root, relativeRunPath: "/tmp/outside" }), /run_path_invalid/);
});

test("clears only a regular reconciliation report from a checked run", async (t) => {
  const root = await temporaryProject(t);
  const run = await createMigrationRun({ cwd: root, timestamp: "2026-09-04T01-00-00-000Z" });
  const reportPath = join(run.directory, MIGRATION_ARTIFACTS.reconciliationReport);

  assert.equal(await clearReconciliationReport({ run }), false);
  await writeRunArtifact({
    run,
    name: MIGRATION_ARTIFACTS.reconciliationReport,
    value: { schemaVersion: 1 },
  });
  assert.equal(await clearReconciliationReport({ run }), true);
  await assert.rejects(lstat(reportPath), /ENOENT/);

  await symlink("missing-reconciliation-report", reportPath);
  await assert.rejects(clearReconciliationReport({ run }), /file_invalid/);
});

test("rejects a symlinked artifact root", async (t) => {
  const root = await temporaryProject(t);
  const outside = await mkdtemp(join(tmpdir(), "ima-pi-plane-migration-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, ".ima"));

  await assert.rejects(
    createMigrationRun({ cwd: root, timestamp: "2026-09-04T00-00-00-000Z" }),
    /directory_invalid/,
  );
});

test("gates the CLI, strips Plane configuration from Taskwarrior, and resumes without duplicates", async (t) => {
  const root = await temporaryProject(t);
  const fixture = migrationFixture();
  const taskEnvironments = [];
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "plane-taskwarrior-project-map.md"), fixture.worksheet);

  const prepared = await prepareFixtureRun({ root, fixture, taskEnvironments });
  assert.equal(prepared.exitCode, 0);
  assert.equal(prepared.stderr, "");
  const prepareData = JSON.parse(prepared.stdout).data;
  assert.equal(prepareData.summary.sourceEdges, 318);
  assert.equal(taskEnvironments.length, 1);
  assert.deepEqual(taskEnvironments[0].args, ["export"]);
  assert.equal(taskEnvironments[0].shell, false);
  assert.equal(taskEnvironments[0].env.PLANE_BASE_URL, undefined);
  assert.equal(taskEnvironments[0].env.PLANE_API_KEY, undefined);
  assert.equal(taskEnvironments[0].env.KEEP, "yes");
  assert.deepEqual(stripPlaneEnvironment({ PLANE_API_KEY: "secret", KEEP: "yes" }), { KEEP: "yes" });

  const noNetworkDryRun = await runCommand({
    argv: ["dry-run", prepareData.relativeRunPath],
    cwd: root,
    createClient: () => { throw new Error("dry run must not create a client"); },
    readConfig: () => { throw new Error("dry run must not read configuration"); },
  });
  assert.equal(noNetworkDryRun.exitCode, 0);
  assert.equal(JSON.parse(noNetworkDryRun.stdout).data.summary.eligibleRelations, 307);

  let clientCalls = 0;
  const wrongHash = await runCommand({
    argv: ["apply", prepareData.relativeRunPath, "0".repeat(64), "confirm"],
    cwd: root,
    createClient: () => { clientCalls += 1; return {}; },
    readConfig: () => ({}),
  });
  assert.equal(wrongHash.exitCode, 1);
  assert.equal(JSON.parse(wrongHash.stderr).error.code, "PLAN_HASH_MISMATCH");
  assert.equal(clientCalls, 0);

  const fake = migrationClient({ failFirstRelation: true });
  const applyInput = {
    cwd: root,
    env: {},
    createClient: () => fake.client,
    readConfig: () => ({}),
  };
  const firstApply = await runCommand({
    argv: ["apply", prepareData.relativeRunPath, prepareData.planSha256, "confirm"],
    ...applyInput,
  });
  assert.equal(firstApply.exitCode, 0);
  assert.equal(JSON.parse(firstApply.stdout).data.unresolvedRelations, 1);
  assert.deepEqual(fake.stats(), { createdItems: 252, createdRelations: 306 });

  const secondApply = await runCommand({
    argv: ["apply", prepareData.relativeRunPath, prepareData.planSha256, "confirm"],
    ...applyInput,
  });
  assert.equal(secondApply.exitCode, 0);
  assert.equal(JSON.parse(secondApply.stdout).data.unresolvedRelations, 0);
  assert.deepEqual(fake.stats(), { createdItems: 252, createdRelations: 307 });

  const thirdApply = await runCommand({
    argv: ["apply", prepareData.relativeRunPath, prepareData.planSha256, "confirm"],
    ...applyInput,
  });
  assert.equal(thirdApply.exitCode, 0);
  assert.deepEqual(fake.stats(), { createdItems: 252, createdRelations: 307 });

  const reconciled = await runCommand({
    argv: ["reconcile", prepareData.relativeRunPath],
    ...applyInput,
  });
  assert.equal(reconciled.exitCode, 0);
  const reconciliationSummary = JSON.parse(reconciled.stdout).data.summary;
  assert.equal(reconciliationSummary.task.matched, 252);
  assert.equal(reconciliationSummary.relation.matched, 307);
  assert.equal(reconciliationSummary.relation.skipped, 11);

  const run = await loadMigrationRun({ cwd: root, relativeRunPath: prepareData.relativeRunPath });
  const report = await readRunArtifact({ run, name: MIGRATION_ARTIFACTS.reconciliationReport });
  assert.equal(report.summary.relation.applyUnresolved, 1);
  assert.equal((await readFile(join(run.directory, MIGRATION_ARTIFACTS.source), "utf8")).includes("secret"), false);
});

test("rejects malformed or absolute apply commands before reading configuration or creating a client", async (t) => {
  let clientCalls = 0;
  const client = () => { clientCalls += 1; return {}; };
  const malformed = await runCommand({
    argv: ["apply", "relative-run", "f".repeat(64), "not-confirm"],
    createClient: client,
    readConfig: () => { throw new Error("must not read"); },
  });
  const root = await temporaryProject(t);
  const absolute = await runCommand({
    argv: ["apply", "/tmp/outside", "f".repeat(64), "confirm"],
    cwd: root,
    createClient: client,
    readConfig: () => { throw new Error("must not read"); },
  });

  assert.equal(malformed.exitCode, 2);
  assert.equal(JSON.parse(malformed.stderr).error.code, "USAGE_ERROR");
  assert.equal(absolute.exitCode, 1);
  assert.equal(clientCalls, 0);
});

const preparedMigrationPlan = async ({ root, fixture, taskEnvironments = [] }) => {
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "plane-taskwarrior-project-map.md"), fixture.worksheet);
  const prepared = await prepareFixtureRun({ root, fixture, taskEnvironments });
  assert.equal(prepared.exitCode, 0);
  const data = JSON.parse(prepared.stdout).data;
  const run = await loadMigrationRun({ cwd: root, relativeRunPath: data.relativeRunPath });
  return {
    ...data,
    run,
    plan: await readRunArtifact({ run, name: MIGRATION_ARTIFACTS.plan }),
  };
};

const writeSchemaV2StaticRun = async ({ root }) => {
  const fixture = migrationFixture();
  const tasks = fixture.tasks.map(({ priority, ...task }) =>
    priority === undefined ? task : { ...task, priority });
  const sourceProjects = [
    ["web-project", "WEB", "Web"],
    ["skynet-project", "SKYNET", "Skynet"],
  ];
  const decisions = sourceProjects.map(([taskwarriorProject, projectKey, projectName]) => ({
    taskwarriorProject,
    action: "migrate",
    taskUuids: tasks
      .filter((task) => task.project === taskwarriorProject)
      .map((task) => task.uuid),
    historyPolicy: HISTORY_POLICIES.pendingAndCompleted,
    destination: { ...DESTINATIONS[projectKey], projectKey, projectName },
  }));
  const discovered = sourceProjects.map(([_taskwarriorProject, projectKey, projectName]) => {
    const destination = DESTINATIONS[projectKey];
    return {
      project: {
        id: destination.projectId,
        identifier: projectKey,
        name: projectName,
        archivedAt: null,
      },
      compatibility: {
        compatible: true,
        backlogStateId: destination.backlogStateId,
        doneStateId: destination.doneStateId,
      },
      identityLookup: { status: "ready", itemCount: 0 },
      states: [
        { id: destination.backlogStateId, group: "backlog", sequence: 1 },
        { id: destination.doneStateId, group: "completed", sequence: 2 },
      ],
      items: [],
    };
  });
  const source = buildPreparationSource({
    workspace: "ima",
    decisions,
    discovered,
    tasks,
  });
  const inputs = decisionsToPlanInputs({ decisions, tasks });
  const plan = buildMigrationPlan({
    worksheet: inputs.projectMappings,
    destinations: inputs.destinations,
    tasks: inputs.tasks,
  });
  const run = await createMigrationRun({ cwd: root, timestamp: "2026-09-07T00-00-00-000Z" });
  await writeRunArtifact({ run, name: MIGRATION_ARTIFACTS.source, value: source });
  await writeRunArtifact({ run, name: MIGRATION_ARTIFACTS.plan, value: plan });
  return { run, plan };
};

test("keeps schema-v2 prepared runs out of legacy direct apply and reconcile", async (t) => {
  const root = await temporaryProject(t);
  const prepared = await writeSchemaV2StaticRun({ root });
  let configCalls = 0;
  let clientCalls = 0;
  const guardedInput = {
    cwd: root,
    env: {},
    createClient: () => { clientCalls += 1; return {}; },
    readConfig: () => { configCalls += 1; return {}; },
  };

  const apply = await runCommand({
    argv: ["apply", prepared.run.relativeRunPath, prepared.plan.planSha256, "confirm"],
    ...guardedInput,
  });
  const reconcile = await runCommand({
    argv: ["reconcile", prepared.run.relativeRunPath],
    ...guardedInput,
  });

  for (const result of [apply, reconcile]) {
    assert.equal(result.exitCode, 1);
    assert.equal(JSON.parse(result.stderr).error.code, "PREPARED_RUN_INTERACTIVE_ONLY");
  }
  assert.equal(configCalls, 0);
  assert.equal(clientCalls, 0);
});

test("runs and persists a read-only migration preflight without Plane writes", async (t) => {
  const root = await temporaryProject(t);
  const prepared = await preparedMigrationPlan({ root, fixture: migrationFixture() });
  const fake = migrationClient();
  const preflight = await runCommand({
    argv: ["preflight", prepared.relativeRunPath],
    cwd: root,
    env: {},
    createClient: () => fake.client,
    readConfig: () => ({ apiKey: "synthetic-secret" }),
  });

  assert.equal(preflight.exitCode, 0);
  const data = JSON.parse(preflight.stdout).data;
  assert.equal(data.preflight.outcome, "READY");
  assert.deepEqual(fake.stats(), { createdItems: 0, createdRelations: 0 });
  assert.deepEqual(fake.preflightStats(), {
    representativeReads: 2,
    stateReads: 2,
    relationReads: 2,
    identityReads: 2,
  });

  const report = await readRunArtifact({
    run: prepared.run,
    name: MIGRATION_ARTIFACTS.preflightReport,
  });
  assert.equal(report.outcome, "READY");
  assert.equal(report.destinations.length, 2);
  assert.equal(report.destinations.every((destination) =>
    destination.capabilities.some((entry) =>
      entry.capability === "work_item_creation" && entry.status === "UNVERIFIED_WRITE")), true);
  assert.equal(JSON.stringify(report).includes("synthetic-secret"), false);
});

test("blocks apply before writes when migration preflight is incomplete", async (t) => {
  const root = await temporaryProject(t);
  const prepared = await preparedMigrationPlan({ root, fixture: migrationFixture() });
  const fake = migrationClient({ preflightStateFailure: true });
  const applied = await runCommand({
    argv: ["apply", prepared.relativeRunPath, prepared.planSha256, "confirm"],
    cwd: root,
    env: {},
    createClient: () => fake.client,
    readConfig: () => ({ apiKey: "synthetic-secret" }),
  });

  assert.equal(applied.exitCode, 1);
  const failure = JSON.parse(applied.stderr).error;
  assert.equal(failure.code, "PREFLIGHT_BLOCKED");
  assert.equal(failure.details.outcome, "BLOCKED");
  assert.equal(JSON.stringify(failure).includes("synthetic-secret"), false);
  assert.deepEqual(fake.stats(), { createdItems: 0, createdRelations: 0 });

  const report = await readRunArtifact({
    run: prepared.run,
    name: MIGRATION_ARTIFACTS.preflightReport,
  });
  const stateCapability = report.destinations
    .flatMap((destination) => destination.capabilities)
    .find((entry) => entry.capability === "project_states");
  assert.deepEqual(stateCapability, {
    capability: "project_states",
    status: "BLOCKED",
    reason: "BACKLOG_STATE_GROUP_INVALID",
  });
});

test("stops before writes when preflight report persistence fails", async (t) => {
  const root = await temporaryProject(t);
  const prepared = await preparedMigrationPlan({ root, fixture: migrationFixture() });
  const fake = migrationClient();
  const artifactApi = {
    MIGRATION_ARTIFACTS,
    loadMigrationRun,
    readRunArtifact,
    withMigrationLock,
    readCheckpoint,
    writeCheckpoint,
    replaceRunArtifact: async ({ run, name, value }) => {
      if (name === MIGRATION_ARTIFACTS.preflightReport) throw new Error("synthetic report secret");
      return replaceRunArtifact({ run, name, value });
    },
  };
  const applied = await runCommand({
    argv: ["apply", prepared.relativeRunPath, prepared.planSha256, "confirm"],
    cwd: root,
    env: {},
    artifactApi,
    createClient: () => fake.client,
    readConfig: () => ({}),
  });

  assert.equal(applied.exitCode, 1);
  assert.equal(JSON.parse(applied.stderr).error.code, "PREFLIGHT_REPORT_WRITE_FAILED");
  assert.equal(applied.stderr.includes("synthetic report secret"), false);
  assert.deepEqual(fake.stats(), { createdItems: 0, createdRelations: 0 });
});

test("rejects self-hashed destination and schema variants before configuration or client effects", async (t) => {
  const root = await temporaryProject(t);
  const prepared = await preparedMigrationPlan({ root, fixture: migrationFixture() });
  const foreignWorkspace = "other-workspace";
  const foreignProjectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const foreignBacklogStateId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const foreignDoneStateId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const foreignRelationProjectId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const missingEndpoint = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const firstWebItem = prepared.plan.items.find((item) =>
    item.disposition === "create" && item.destination.projectKey === "WEB");
  const firstBacklogItem = prepared.plan.items.find((item) =>
    item.disposition === "create" && item.destination.stateKind === "backlog");
  const firstDoneItem = prepared.plan.items.find((item) =>
    item.disposition === "create" && item.destination.stateKind === "done");
  const webProjectId = firstWebItem.destination.projectId;

  const variants = [
    ["foreign workspace", (plan) => ({
      ...plan,
      items: plan.items.map((item) => item.disposition === "create" ? {
        ...item,
        destination: { ...item.destination, workspace: foreignWorkspace },
      } : item),
      eligibleRelations: plan.eligibleRelations.map((relation) => ({
        ...relation,
        workspace: foreignWorkspace,
      })),
    })],
    ["foreign project", (plan) => ({
      ...plan,
      items: plan.items.map((item) => item.disposition === "create" && item.destination.projectId === webProjectId ? {
        ...item,
        destination: { ...item.destination, projectId: foreignProjectId },
      } : item),
      eligibleRelations: plan.eligibleRelations.map((relation) => relation.projectId === webProjectId ? {
        ...relation,
        projectId: foreignProjectId,
      } : relation),
    })],
    ["foreign backlog state", (plan) => ({
      ...plan,
      items: plan.items.map((item) => item.taskUuid === firstBacklogItem.taskUuid ? {
        ...item,
        destination: { ...item.destination, stateId: foreignBacklogStateId },
        workItem: { ...item.workItem, stateId: foreignBacklogStateId },
      } : item),
    })],
    ["foreign done state", (plan) => ({
      ...plan,
      items: plan.items.map((item) => item.taskUuid === firstDoneItem.taskUuid ? {
        ...item,
        destination: { ...item.destination, stateId: foreignDoneStateId },
        workItem: { ...item.workItem, stateId: foreignDoneStateId },
      } : item),
    })],
    ["relation project mismatch", (plan) => ({
      ...plan,
      eligibleRelations: [{ ...plan.eligibleRelations[0], projectId: foreignRelationProjectId }, ...plan.eligibleRelations.slice(1)],
    })],
    ["work-item state mismatch", (plan) => ({
      ...plan,
      items: plan.items.map((item) => item.taskUuid === firstBacklogItem.taskUuid ? {
        ...item,
        workItem: { ...item.workItem, stateId: foreignBacklogStateId },
      } : item),
    })],
    ["duplicate item", (plan) => ({ ...plan, items: [...plan.items, plan.items[0]] })],
    ["duplicate relation", (plan) => ({
      ...plan,
      eligibleRelations: [...plan.eligibleRelations, plan.eligibleRelations[0]],
    })],
    ["missing relation endpoint", (plan) => ({
      ...plan,
      eligibleRelations: [{ ...plan.eligibleRelations[0], targetTaskUuid: missingEndpoint }, ...plan.eligibleRelations.slice(1)],
    })],
    ["inconsistent summary", (plan) => ({
      ...plan,
      summary: { ...plan.summary, creates: plan.summary.creates + 1 },
    })],
  ];

  let configurationCalls = 0;
  let clientCalls = 0;
  for (const [name, mutate] of variants) {
    const variant = selfHashedPlan(mutate(copiedPlan(prepared.plan)));
    await replaceRunArtifact({
      run: prepared.run,
      name: MIGRATION_ARTIFACTS.plan,
      value: variant,
    });
    const result = await runCommand({
      argv: ["apply", prepared.relativeRunPath, variant.planSha256, "confirm"],
      cwd: root,
      createClient: () => { clientCalls += 1; return {}; },
      readConfig: () => { configurationCalls += 1; return {}; },
    });
    assert.equal(result.exitCode, 1, name);
  }

  assert.equal(configurationCalls, 0);
  assert.equal(clientCalls, 0);
});

test("records a malformed relation lookup as unresolved without posting that edge", async (t) => {
  const root = await temporaryProject(t);
  const prepared = await preparedMigrationPlan({ root, fixture: migrationFixture() });
  const fake = migrationClient({ malformedFirstRelation: true });
  const applyInput = {
    cwd: root,
    env: {},
    createClient: () => fake.client,
    readConfig: () => ({}),
  };
  const applied = await runCommand({
    argv: ["apply", prepared.relativeRunPath, prepared.planSha256, "confirm"],
    ...applyInput,
  });

  assert.equal(applied.exitCode, 0);
  assert.equal(JSON.parse(applied.stdout).data.unresolvedRelations, 1);
  assert.deepEqual(fake.stats(), { createdItems: 252, createdRelations: 306 });
  const checkpoint = await readCheckpoint({ run: prepared.run });
  assert.equal(checkpoint.unresolvedRelationAttempts.length, 1);
  assert.equal(checkpoint.unresolvedRelationAttempts[0].reason, "RESPONSE_ERROR");

  const reconciled = await runCommand({
    argv: ["reconcile", prepared.relativeRunPath],
    ...applyInput,
  });
  assert.equal(reconciled.exitCode, 0);
  assert.equal(JSON.parse(reconciled.stdout).data.summary.relation.applyUnresolved, 1);
});

const ownerRecord = ({ pid, token }) => JSON.stringify({ schemaVersion: 1, pid, token });

const lockPathFor = (run) => join(run.directory, ".migration.lock");
const transitionPathFor = (run) => join(run.directory, ".migration.lock.transition");

test("keeps malformed and ambiguous lock owners locked and never removes a replacement owner", async (t) => {
  const root = await temporaryProject(t);
  const run = await createMigrationRun({ cwd: root, timestamp: "2026-09-05T00-00-00-000Z" });
  const lockPath = lockPathFor(run);
  await writeFile(lockPath, "not-json", { mode: 0o600 });
  await assert.rejects(
    withMigrationLock({ run, operation: async () => "unexpected" }),
    /lock_in_progress/,
  );
  await rm(lockPath);

  await writeFile(lockPath, ownerRecord({
    pid: 424242,
    token: "11111111-1111-4111-8111-111111111111",
  }), { mode: 0o600 });
  await assert.rejects(
    withMigrationLock({
      run,
      probeProcess: () => "unknown",
      operation: async () => "unexpected",
    }),
    /lock_in_progress/,
  );
  await rm(lockPath);

  const replacementToken = "33333333-3333-4333-8333-333333333333";
  await assert.rejects(
    withMigrationLock({
      run,
      token: "22222222-2222-4222-8222-222222222222",
      operation: async () => {
        await writeFile(lockPath, ownerRecord({ pid: process.pid, token: replacementToken }), { mode: 0o600 });
      },
    }),
    /lock_replaced/,
  );
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).token, replacementToken);
  await rm(lockPath);
});

test("reclaims a dead internally consistent transition before publishing a new owner", async (t) => {
  const root = await temporaryProject(t);
  const run = await createMigrationRun({ cwd: root, timestamp: "2026-09-05T01-00-00-000Z" });
  const lockPath = lockPathFor(run);
  await writeFile(lockPath, ownerRecord({
    pid: 999999,
    token: "44444444-4444-4444-8444-444444444444",
  }), { mode: 0o600 });
  await link(lockPath, transitionPathFor(run));

  let entered = 0;
  await withMigrationLock({
    run,
    processId: 1001,
    token: "55555555-5555-4555-8555-555555555555",
    probeProcess: (pid) => pid === 999999 ? "dead" : "alive",
    operation: async () => { entered += 1; },
  });

  assert.equal(entered, 1);
  await assert.rejects(lstat(lockPath), /ENOENT/);
  await assert.rejects(lstat(transitionPathFor(run)), /ENOENT/);
});

test("keeps ambiguous and malformed transitions locked", async (t) => {
  const root = await temporaryProject(t);
  const run = await createMigrationRun({ cwd: root, timestamp: "2026-09-05T02-00-00-000Z" });
  const lockPath = lockPathFor(run);
  const transitionPath = transitionPathFor(run);
  await writeFile(lockPath, ownerRecord({
    pid: 424242,
    token: "66666666-6666-4666-8666-666666666666",
  }), { mode: 0o600 });
  await link(lockPath, transitionPath);

  await assert.rejects(
    withMigrationLock({
      run,
      probeProcess: () => "unknown",
      operation: async () => "unexpected",
    }),
    /lock_in_progress/,
  );
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, 424242);
  await rm(lockPath);
  await rm(transitionPath);

  await writeFile(transitionPath, "not-json", { mode: 0o600 });
  await assert.rejects(
    withMigrationLock({ run, operation: async () => "unexpected" }),
    /lock_in_progress/,
  );
});

test("does not move a replacement installed during a stale-owner probe", async (t) => {
  const root = await temporaryProject(t);
  const run = await createMigrationRun({ cwd: root, timestamp: "2026-09-06T00-00-00-000Z" });
  const lockPath = lockPathFor(run);
  const stalePid = 999999;
  const replacementToken = "55555555-5555-4555-8555-555555555555";
  await writeFile(lockPath, ownerRecord({
    pid: stalePid,
    token: "44444444-4444-4444-8444-444444444444",
  }), { mode: 0o600 });

  let entered = 0;
  await assert.rejects(
    withMigrationLock({
      run,
      processId: 1001,
      token: "66666666-6666-4666-8666-666666666666",
      probeProcess: (pid) => {
        if (pid !== stalePid) return "alive";
        const replacementPath = `${lockPath}.replacement`;
        writeFileSync(replacementPath, ownerRecord({ pid: 1002, token: replacementToken }), { mode: 0o600 });
        renameSync(replacementPath, lockPath);
        return "dead";
      },
      operation: async () => { entered += 1; },
    }),
    /lock_in_progress/,
  );

  assert.equal(entered, 0);
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).token, replacementToken);
});

test("does not unlink a replacement installed at the release transition", async (t) => {
  const root = await temporaryProject(t);
  const run = await createMigrationRun({ cwd: root, timestamp: "2026-09-06T01-00-00-000Z" });
  const lockPath = lockPathFor(run);
  const replacementToken = "88888888-8888-4888-8888-888888888888";

  await assert.rejects(
    withMigrationLock({
      run,
      token: "77777777-7777-4777-8777-777777777777",
      beforeCanonicalUnlink: async () => {
        const replacementPath = `${lockPath}.replacement`;
        writeFileSync(replacementPath, ownerRecord({ pid: 1003, token: replacementToken }), { mode: 0o600 });
        renameSync(replacementPath, lockPath);
      },
      operation: async () => "complete",
    }),
    /lock_replaced/,
  );

  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).token, replacementToken);
});

test("allows only one deterministic simultaneous dead-lock reclaimer to enter", async (t) => {
  const root = await temporaryProject(t);
  const run = await createMigrationRun({ cwd: root, timestamp: "2026-09-06T02-00-00-000Z" });
  const stalePid = 999999;
  await writeFile(lockPathFor(run), ownerRecord({
    pid: stalePid,
    token: "99999999-9999-4999-8999-999999999999",
  }), { mode: 0o600 });

  let releaseProbe;
  const waitForFirstProbe = new Promise((resolveProbe) => { releaseProbe = resolveProbe; });
  let signalProbeStarted;
  const probeStarted = new Promise((resolveProbeStarted) => { signalProbeStarted = resolveProbeStarted; });
  let probeCount = 0;
  const probeProcess = async (pid) => {
    if (pid !== stalePid) return "alive";
    probeCount += 1;
    if (probeCount === 1) {
      signalProbeStarted();
      return waitForFirstProbe;
    }
    return "unknown";
  };

  let releaseOperation;
  const waitForRelease = new Promise((resolveOperation) => { releaseOperation = resolveOperation; });
  let signalEntered;
  const waitForEntry = new Promise((resolveEntry) => { signalEntered = resolveEntry; });
  const entered = [];
  const contender = (processId, token) => withMigrationLock({
    run,
    processId,
    token,
    probeProcess,
    operation: async () => {
      entered.push(processId);
      signalEntered();
      await waitForRelease;
      return processId;
    },
  });
  const first = contender(1001, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  void first.catch(() => {});
  await probeStarted;
  const second = contender(1002, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  void second.catch(() => {});
  releaseProbe("dead");
  await waitForEntry;

  assert.equal(entered.length, 1);
  releaseOperation();
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.match(outcomes.find((outcome) => outcome.status === "rejected").reason.message, /lock_in_progress/);
});

test("reclaims a dead child owner so apply resumes its checkpoint without duplicates", async (t) => {
  const root = await temporaryProject(t);
  const prepared = await preparedMigrationPlan({ root, fixture: migrationFixture() });
  const fake = migrationClient();
  const applyInput = {
    cwd: root,
    env: {},
    createClient: () => fake.client,
    readConfig: () => ({}),
  };
  const initialApply = await runCommand({
    argv: ["apply", prepared.relativeRunPath, prepared.planSha256, "confirm"],
    ...applyInput,
  });
  assert.equal(initialApply.exitCode, 0);
  assert.deepEqual(fake.stats(), { createdItems: 252, createdRelations: 307 });

  const artifactUrl = pathToFileURL(resolve("lib/plane-taskwarrior-migration-artifacts.ts")).href;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    `import { withMigrationLock } from ${JSON.stringify(artifactUrl)};
const run = JSON.parse(process.env.MIGRATION_RUN);
await withMigrationLock({ run, operation: async () => {
  process.stdout.write("locked\\n");
  await new Promise(() => setInterval(() => {}, 1000));
}});`,
  ], {
    env: { MIGRATION_RUN: JSON.stringify(prepared.run) },
    stdio: ["ignore", "pipe", "ignore"],
  });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((resolveLock, rejectLock) => {
    const timeout = setTimeout(() => rejectLock(new Error("child lock timeout")), 5_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectLock(error);
    });
    child.stdout.once("data", (chunk) => {
      clearTimeout(timeout);
      assert.equal(String(chunk), "locked\n");
      resolveLock();
    });
  });
  child.kill("SIGKILL");
  await once(child, "exit");

  const resumed = await runCommand({
    argv: ["apply", prepared.relativeRunPath, prepared.planSha256, "confirm"],
    ...applyInput,
  });
  assert.equal(resumed.exitCode, 0);
  assert.deepEqual(fake.stats(), { createdItems: 252, createdRelations: 307 });
});
