import assert from "node:assert/strict";
import test from "node:test";
import { buildMigrationPlan } from "../lib/plane-taskwarrior-migration.ts";
import {
  buildMigrationBackfillPlan,
  isBlankDescription,
  validateMigrationBackfillPlan,
} from "../lib/plane-taskwarrior-description-backfill.ts";

const TASK_A = "11111111-1111-4111-8111-111111111111";
const TASK_B = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BACKLOG_STATE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DONE_STATE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const task = ({ uuid, status = "pending", description = `Task ${uuid}` }) => ({
  uuid,
  project: "alpha",
  status,
  description,
  priority: "M",
  entry: "20260901T000000Z",
  modified: "20260902T000000Z",
  ...(status === "completed" ? { end: "20260903T000000Z" } : {}),
});

const sourceTasks = () => [
  task({ uuid: TASK_B, status: "completed" }),
  task({ uuid: TASK_A }),
];

const migrationPlan = () => buildMigrationPlan({
  worksheet: [{
    taskwarriorProject: "alpha",
    total: 1,
    pending: 1,
    completed: 0,
    deleted: 0,
    migrate: true,
    workspace: "ima",
    projectName: "Destination",
    projectKey: "DEST",
    treatment: "Migrate pending and completed history",
    notes: null,
  }],
  destinations: {
    DEST: {
      workspace: "ima",
      projectId: PROJECT_ID,
      backlogStateId: BACKLOG_STATE_ID,
      doneStateId: DONE_STATE_ID,
    },
  },
  tasks: [task({ uuid: TASK_A })],
});

const discovered = [{
  project: { id: PROJECT_ID },
  items: [
    {
      id: ITEM_A,
      projectId: PROJECT_ID,
      externalId: TASK_A,
      externalSource: "taskwarrior",
    },
    {
      id: ITEM_B,
      projectId: PROJECT_ID,
      externalId: TASK_B,
      externalSource: "taskwarrior",
    },
  ],
}];

const backfillTargets = () => ({
  [TASK_B]: { projectId: PROJECT_ID, itemId: ITEM_B },
  [TASK_A]: { projectId: PROJECT_ID, itemId: ITEM_A },
});

test("detects blank descriptions without coercing non-text values", () => {
  assert.equal(isBlankDescription(""), true);
  assert.equal(isBlankDescription(" \n\t "), true);
  assert.equal(isBlankDescription(null), true);
  assert.equal(isBlankDescription({}), true);
  assert.equal(isBlankDescription("Taskwarrior provenance"), false);
});

test("builds deterministic description-only backfills without changing inputs", () => {
  const plan = migrationPlan();
  const tasks = sourceTasks();
  const targets = backfillTargets();
  const inputSnapshot = structuredClone({ tasks, targets });

  const backfillPlan = buildMigrationBackfillPlan({
    planSha256: plan.planSha256,
    workspace: "ima",
    backfillByTaskUuid: targets,
    tasks,
  });

  assert.deepEqual(backfillPlan.updates.map((update) => update.taskUuid), [TASK_A, TASK_B]);
  assert.deepEqual(backfillPlan.updates.map((update) => update.itemId), [ITEM_A, ITEM_B]);
  assert.equal(backfillPlan.updates[0].descriptionStripped.includes("--- Taskwarrior task details ---"), true);
  assert.deepEqual({ tasks, targets }, inputSnapshot);

  const repeated = buildMigrationBackfillPlan({
    planSha256: plan.planSha256,
    workspace: "ima",
    backfillByTaskUuid: Object.fromEntries(Object.entries(targets).reverse()),
    tasks: [...tasks].reverse(),
  });
  assert.deepEqual(repeated, backfillPlan);
});

test("validates each backfill against its source task, workspace, reviewed plan, and discovered identity", () => {
  const plan = migrationPlan();
  const backfillPlan = buildMigrationBackfillPlan({
    planSha256: plan.planSha256,
    workspace: "ima",
    backfillByTaskUuid: backfillTargets(),
    tasks: sourceTasks(),
  });

  const validationInput = {
    plan,
    sourceTasks: sourceTasks(),
    discovered,
    expectedWorkspace: "ima",
  };
  assert.strictEqual(validateMigrationBackfillPlan({
    ...validationInput,
    backfillPlan,
  }), backfillPlan);

  const wrongDescription = structuredClone(backfillPlan);
  wrongDescription.updates[0].descriptionStripped = "unreviewed text";
  assert.throws(
    () => validateMigrationBackfillPlan({
      ...validationInput,
      backfillPlan: wrongDescription,
    }),
    /description_invalid/,
  );

  const wrongWorkspace = structuredClone(backfillPlan);
  wrongWorkspace.updates[0].workspace = "other-workspace";
  assert.throws(
    () => validateMigrationBackfillPlan({
      ...validationInput,
      backfillPlan: wrongWorkspace,
    }),
    /workspace_invalid/,
  );

  const wrongTarget = structuredClone(backfillPlan);
  wrongTarget.updates[0].itemId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  assert.throws(
    () => validateMigrationBackfillPlan({
      ...validationInput,
      backfillPlan: wrongTarget,
    }),
    /target_invalid/,
  );
});
