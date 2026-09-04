import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildMigrationPlan } from "../lib/plane-taskwarrior-migration.ts";
import {
  HISTORY_POLICIES,
  analyzeTaskwarriorInventory,
  buildPreparationSource,
  buildPreparationReadinessReport,
  decisionsToPlanInputs,
  destinationCompatibility,
  indexExistingIdentities,
  projectsNeedingDecisions,
} from "../lib/plane-taskwarrior-planning.ts";

const TASK_A_PENDING = "11111111-1111-4111-8111-111111111111";
const TASK_A_COMPLETED = "22222222-2222-4222-8222-222222222222";
const TASK_A_DELETED = "33333333-3333-4333-8333-333333333333";
const TASK_B_PENDING = "44444444-4444-4444-8444-444444444444";
const PLANE_PROJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PLANE_PROJECT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PLANE_ITEM_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PLANE_ITEM_B = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const BACKLOG_STATE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const COMPLETED_STATE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PLAN_HASH = "f".repeat(64);

const task = ({ uuid, project, status, depends = [] }) => ({
  uuid,
  project,
  status,
  description: `Task ${uuid}`,
  priority: "M",
  entry: "20260901T000000Z",
  modified: "20260902T000000Z",
  ...(status === "completed" || status === "deleted" ? { end: "20260903T000000Z" } : {}),
  ...(depends.length > 0 ? { depends } : {}),
});

const sourceTasks = () => [
  task({ uuid: TASK_A_PENDING, project: "alpha", status: "pending", depends: [TASK_A_COMPLETED] }),
  task({ uuid: TASK_A_COMPLETED, project: "alpha", status: "completed" }),
  task({ uuid: TASK_A_DELETED, project: "alpha", status: "deleted" }),
  task({ uuid: TASK_B_PENDING, project: "beta", status: "pending" }),
];

const project = (id, identifier) => ({ id, identifier, name: identifier, archivedAt: null });

const destination = (overrides = {}) => ({
  workspace: "ima",
  projectId: PLANE_PROJECT_A,
  projectKey: "DEST",
  projectName: "Destination",
  backlogStateId: BACKLOG_STATE,
  doneStateId: COMPLETED_STATE,
  ...overrides,
});

const migrateDecision = (overrides = {}) => ({
  taskwarriorProject: "alpha",
  action: "migrate",
  taskUuids: [TASK_A_PENDING, TASK_A_COMPLETED],
  historyPolicy: HISTORY_POLICIES.pendingAndCompleted,
  destination: destination(),
  ...overrides,
});

const discovery = (overrides = {}) => [{
  project: project(PLANE_PROJECT_A, "DEST"),
  compatibility: {
    compatible: true,
    backlogStateId: BACKLOG_STATE,
    doneStateId: COMPLETED_STATE,
  },
  identityLookup: { status: "ready", itemCount: 0 },
  ...overrides,
}];

const capability = (report, name) => report.destinations[0].capabilities
  .find((entry) => entry.capability === name);

test("keeps planning decisions and readiness free of I/O boundaries", async () => {
  const source = await readFile("lib/plane-taskwarrior-planning.ts", "utf8");

  for (const effectBoundary of ["node:fs", "node:child_process", "node:process", "process.env", "fetch("]) {
    assert.equal(source.includes(effectBoundary), false, effectBoundary);
  }
});

test("analyzes Taskwarrior inventory while excluding and counting deleted tasks", () => {
  const inventory = analyzeTaskwarriorInventory(sourceTasks());

  assert.equal(inventory.deletedCount, 1);
  assert.equal(inventory.eligibleTasks.length, 3);
  assert.deepEqual(inventory.projects, [
    {
      taskwarriorProject: "alpha",
      total: 3,
      pending: 1,
      completed: 1,
      deleted: 1,
      eligibleTaskUuids: [TASK_A_PENDING, TASK_A_COMPLETED],
    },
    {
      taskwarriorProject: "beta",
      total: 1,
      pending: 1,
      completed: 0,
      deleted: 0,
      eligibleTaskUuids: [TASK_B_PENDING],
    },
  ]);
});

test("classifies blank identities for backfill and blocks ambiguous observations", () => {
  const observed = [{
    project: project(PLANE_PROJECT_A, "DEST"),
    items: [
      {
        id: PLANE_ITEM_A,
        projectId: PLANE_PROJECT_A,
        externalId: TASK_A_PENDING,
        externalSource: "taskwarrior",
        description: " \n ",
      },
      {
        id: PLANE_ITEM_B,
        projectId: PLANE_PROJECT_A,
        externalId: TASK_A_COMPLETED,
        externalSource: "taskwarrior",
        description: "Human-authored description",
      },
    ],
  }];

  assert.deepEqual(indexExistingIdentities(observed), {
    existingByTaskUuid: {
      [TASK_A_COMPLETED]: { projectId: PLANE_PROJECT_A, itemId: PLANE_ITEM_B },
    },
    backfillByTaskUuid: {
      [TASK_A_PENDING]: { projectId: PLANE_PROJECT_A, itemId: PLANE_ITEM_A },
    },
    ambiguous: [],
  });

  const ambiguous = indexExistingIdentities([
    ...observed,
    {
      project: project(PLANE_PROJECT_B, "OTHER"),
      items: [{
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        projectId: PLANE_PROJECT_B,
        externalId: TASK_A_PENDING,
        externalSource: "taskwarrior",
        description: "",
      }],
    },
  ]);

  assert.deepEqual(ambiguous.existingByTaskUuid, {
    [TASK_A_COMPLETED]: { projectId: PLANE_PROJECT_A, itemId: PLANE_ITEM_B },
  });
  assert.deepEqual(ambiguous.backfillByTaskUuid, {});
  assert.deepEqual(ambiguous.ambiguous, [{
    taskUuid: TASK_A_PENDING,
    projectIds: [PLANE_PROJECT_A, PLANE_PROJECT_B],
    itemIds: [PLANE_ITEM_A, "ffffffff-ffff-4fff-8fff-ffffffffffff"],
  }]);
});

test("separates prompted inserts from automatic in-place backfills", () => {
  const inventory = analyzeTaskwarriorInventory(sourceTasks());
  const fullyMigrated = {
    [TASK_A_PENDING]: {},
    [TASK_A_COMPLETED]: {},
  };

  const initial = projectsNeedingDecisions({
    inventory,
    existingByTaskUuid: fullyMigrated,
    backfillByTaskUuid: {},
    historyPolicyDefault: HISTORY_POLICIES.pendingAndCompleted,
  });
  assert.deepEqual(initial.map((entry) => entry.taskwarriorProject), ["beta"]);

  const reappeared = projectsNeedingDecisions({
    inventory,
    existingByTaskUuid: { [TASK_A_PENDING]: {} },
    backfillByTaskUuid: { [TASK_A_COMPLETED]: {} },
    historyPolicyDefault: HISTORY_POLICIES.pendingAndCompleted,
  });
  assert.deepEqual(reappeared.map((entry) => entry.taskwarriorProject), ["alpha", "beta"]);
  assert.deepEqual(reappeared[0].insertTaskUuids, []);
  assert.deepEqual(reappeared[0].updateTaskUuids, [TASK_A_COMPLETED]);
  assert.equal(reappeared[0].updateCompleted, 1);
  assert.deepEqual(reappeared[1].insertTaskUuids, [TASK_B_PENDING]);
});

test("requires deterministic backlog and completed destination states", () => {
  const compatible = destinationCompatibility({
    project: project(PLANE_PROJECT_A, "DEST"),
    states: [
      { id: COMPLETED_STATE, group: "completed", sequence: 2 },
      { id: BACKLOG_STATE, group: "backlog", sequence: 1 },
    ],
  });

  assert.deepEqual(compatible, {
    compatible: true,
    backlogStateId: BACKLOG_STATE,
    doneStateId: COMPLETED_STATE,
  });
  assert.deepEqual(destinationCompatibility({
    project: project(PLANE_PROJECT_A, "DEST"),
    states: [{ id: BACKLOG_STATE, group: "backlog", sequence: 1 }],
  }), { compatible: false, reason: "COMPLETED_STATE_MISSING" });
});

test("converts reviewed decisions into deterministic migration plans for both history policies", () => {
  const allHistory = decisionsToPlanInputs({
    decisions: [migrateDecision()],
    tasks: sourceTasks(),
  });
  const allHistoryPlan = buildMigrationPlan({
    worksheet: allHistory.projectMappings,
    destinations: allHistory.destinations,
    tasks: allHistory.tasks,
  });
  const repeatedPlan = buildMigrationPlan({
    worksheet: allHistory.projectMappings,
    destinations: allHistory.destinations,
    tasks: allHistory.tasks,
  });

  assert.equal(allHistoryPlan.planSha256, repeatedPlan.planSha256);
  assert.equal(allHistoryPlan.items.length, 2);

  const pendingOnly = decisionsToPlanInputs({
    decisions: [migrateDecision({ historyPolicy: HISTORY_POLICIES.pendingOnly })],
    tasks: sourceTasks(),
  });
  const pendingOnlyPlan = buildMigrationPlan({
    worksheet: pendingOnly.projectMappings,
    destinations: pendingOnly.destinations,
    tasks: pendingOnly.tasks,
  });

  assert.equal(pendingOnly.tasks.length, 1);
  assert.deepEqual(pendingOnly.tasks[0].depends, []);
  assert.equal(pendingOnlyPlan.items.length, 1);
  assert.equal(pendingOnlyPlan.eligibleRelations.length, 0);
});

test("preserves dependencies across selected source projects and fails closed for different Plane destinations", () => {
  const crossProjectTasks = [
    task({ uuid: TASK_A_PENDING, project: "alpha", status: "pending", depends: [TASK_B_PENDING] }),
    task({ uuid: TASK_B_PENDING, project: "beta", status: "pending" }),
  ];
  const alphaDecision = migrateDecision({ taskUuids: [TASK_A_PENDING] });
  const betaDecision = {
    taskwarriorProject: "beta",
    action: "migrate",
    taskUuids: [TASK_B_PENDING],
    historyPolicy: HISTORY_POLICIES.pendingAndCompleted,
    destination: destination(),
  };

  const sameDestination = decisionsToPlanInputs({
    decisions: [alphaDecision, betaDecision],
    tasks: crossProjectTasks,
  });
  const sameDestinationPlan = buildMigrationPlan({
    worksheet: sameDestination.projectMappings,
    destinations: sameDestination.destinations,
    tasks: sameDestination.tasks,
  });
  assert.equal(sameDestinationPlan.eligibleRelations.length, 1);

  const differentDestination = decisionsToPlanInputs({
    decisions: [
      alphaDecision,
      {
        ...betaDecision,
        destination: destination({
          projectId: PLANE_PROJECT_B,
          projectKey: "OTHER",
          projectName: "Other destination",
        }),
      },
    ],
    tasks: crossProjectTasks,
  });
  assert.throws(
    () => buildMigrationPlan({
      worksheet: differentDestination.projectMappings,
      destinations: differentDestination.destinations,
      tasks: differentDestination.tasks,
    }),
    /cross_project_dependency/,
  );

  const skippedEndpoint = decisionsToPlanInputs({
    decisions: [
      alphaDecision,
      { taskwarriorProject: "beta", action: "skip", taskUuids: [TASK_B_PENDING] },
    ],
    tasks: crossProjectTasks,
  });
  const skippedEndpointPlan = buildMigrationPlan({
    worksheet: skippedEndpoint.projectMappings,
    destinations: skippedEndpoint.destinations,
    tasks: skippedEndpoint.tasks,
  });
  assert.deepEqual(skippedEndpoint.tasks[0].depends, []);
  assert.equal(skippedEndpointPlan.eligibleRelations.length, 0);
});

test("reports READY for an empty compatible destination and defers writes and relations", () => {
  const report = buildPreparationReadinessReport({
    planSha256: PLAN_HASH,
    decisions: [migrateDecision()],
    discovered: discovery(),
  });

  assert.equal(report.outcome, "READY");
  assert.deepEqual(capability(report, "project_states"), {
    capability: "project_states",
    status: "READY",
  });
  assert.deepEqual(capability(report, "external_identity_lookup"), {
    capability: "external_identity_lookup",
    status: "READY",
    identityMatchCount: 0,
  });
  assert.deepEqual(capability(report, "work_item_creation"), {
    capability: "work_item_creation",
    status: "UNVERIFIED_WRITE",
    reason: "WRITE_ONLY",
  });
  assert.deepEqual(capability(report, "work_item_relations"), {
    capability: "work_item_relations",
    status: "UNVERIFIED_WRITE",
    reason: "DEFERRED_TO_TASK_B",
  });
  assert.deepEqual(capability(report, "relation_creation"), {
    capability: "relation_creation",
    status: "UNVERIFIED_WRITE",
    reason: "WRITE_ONLY",
  });
});

test("blocks readiness when destination states are incompatible or identity discovery failed", () => {
  const incompatible = buildPreparationReadinessReport({
    planSha256: PLAN_HASH,
    decisions: [migrateDecision()],
    discovered: discovery({ compatibility: { compatible: false, reason: "BACKLOG_STATE_MISSING" } }),
  });
  assert.equal(incompatible.outcome, "BLOCKED");
  assert.deepEqual(capability(incompatible, "project_states"), {
    capability: "project_states",
    status: "BLOCKED",
    reason: "BACKLOG_STATE_MISSING",
  });

  const failedIdentity = buildPreparationReadinessReport({
    planSha256: PLAN_HASH,
    decisions: [migrateDecision()],
    discovered: discovery({ identityLookup: { status: "failed" } }),
  });
  assert.equal(failedIdentity.outcome, "BLOCKED");
  assert.deepEqual(capability(failedIdentity, "external_identity_lookup"), {
    capability: "external_identity_lookup",
    status: "BLOCKED",
    reason: "IDENTITY_DISCOVERY_FAILED",
  });
});

test("canonicalizes schema-v3 source artifacts independently of discovery and raw object order", () => {
  const sourceDecisions = [
    migrateDecision(),
    {
      taskwarriorProject: "beta",
      action: "migrate",
      taskUuids: [TASK_B_PENDING],
      historyPolicy: HISTORY_POLICIES.pendingAndCompleted,
      destination: destination({
        projectId: PLANE_PROJECT_B,
        projectKey: "OTHER",
        projectName: "Other destination",
      }),
    },
  ];
  const sourceDiscovered = [
    {
      project: project(PLANE_PROJECT_B, "OTHER"),
      compatibility: {
        compatible: true,
        backlogStateId: BACKLOG_STATE,
        doneStateId: COMPLETED_STATE,
      },
      identityLookup: { status: "ready", itemCount: 1 },
      states: [
        { id: COMPLETED_STATE, group: "completed", sequence: 2 },
        { id: BACKLOG_STATE, group: "backlog", sequence: 1 },
      ],
      items: [{
        id: PLANE_ITEM_B,
        projectId: PLANE_PROJECT_B,
        externalId: TASK_B_PENDING,
        externalSource: "taskwarrior",
      }],
    },
    {
      project: project(PLANE_PROJECT_A, "DEST"),
      compatibility: {
        compatible: true,
        backlogStateId: BACKLOG_STATE,
        doneStateId: COMPLETED_STATE,
      },
      identityLookup: { status: "ready", itemCount: 2 },
      states: [
        { id: COMPLETED_STATE, group: "completed", sequence: 2 },
        { id: BACKLOG_STATE, group: "backlog", sequence: 1 },
      ],
      items: [
        {
          id: PLANE_ITEM_B,
          projectId: PLANE_PROJECT_A,
          externalId: TASK_A_COMPLETED,
          externalSource: "taskwarrior",
        },
        {
          id: PLANE_ITEM_A,
          projectId: PLANE_PROJECT_A,
          externalId: TASK_A_PENDING,
          externalSource: "taskwarrior",
        },
      ],
    },
  ];
  const tasksWithAudit = sourceTasks().map((entry) => entry.uuid === TASK_A_DELETED
    ? { ...entry, customAudit: { source: "Taskwarrior", retained: true } }
    : entry);
  const reverseProperties = (value) => {
    if (Array.isArray(value)) return value.map(reverseProperties);
    if (value !== null && typeof value === "object") {
      const entries = [...Object.entries(value)].reverse();
      return Object.fromEntries(entries.map(([key, entry]) => [key, reverseProperties(entry)]));
    }
    return value;
  };

  const first = buildPreparationSource({
    workspace: "ima",
    decisions: sourceDecisions,
    discovered: sourceDiscovered,
    tasks: tasksWithAudit,
  });
  const second = buildPreparationSource({
    workspace: "ima",
    decisions: [...sourceDecisions].reverse().map(reverseProperties),
    discovered: [...sourceDiscovered].reverse().map((entry) => reverseProperties({
      ...entry,
      states: [...entry.states].reverse(),
      items: [...entry.items].reverse(),
    })),
    tasks: [...tasksWithAudit].reverse().map(reverseProperties),
  });

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.schemaVersion, 3);
  assert.equal(first.backfillPlanRequired, true);
  assert.equal(first.tasks.some((entry) => entry.uuid === TASK_A_DELETED), true);
  assert.deepEqual(
    first.tasks.find((entry) => entry.uuid === TASK_A_DELETED).customAudit,
    { retained: true, source: "Taskwarrior" },
  );
  assert.deepEqual(first.discovered.map((entry) => entry.project.id), [PLANE_PROJECT_A, PLANE_PROJECT_B]);
});
