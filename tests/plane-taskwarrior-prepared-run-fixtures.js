import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as artifactApi from "../lib/plane-taskwarrior-migration-artifacts.ts";
import {
  buildMigrationPlan,
  migrationPlanSha256,
} from "../lib/plane-taskwarrior-migration.ts";
import {
  HISTORY_POLICIES,
  buildPreparationReadinessReport,
  buildPreparationSource,
  decisionsToPlanInputs,
} from "../lib/plane-taskwarrior-planning.ts";

export const TASK_A = "11111111-1111-4111-8111-111111111111";
export const TASK_B = "22222222-2222-4222-8222-222222222222";
export const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const BACKLOG_STATE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const DONE_STATE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const HISTORICAL_ENTRY = "2026-09-01T00:00:00.000Z";
const HISTORICAL_MODIFIED = "2026-09-02T00:00:00.000Z";

const task = ({ uuid, depends = [], description = `Task ${uuid}` }) => ({
  uuid,
  project: "alpha",
  status: "pending",
  description,
  priority: "M",
  entry: "20260901T000000Z",
  modified: "20260902T000000Z",
  ...(depends.length === 0 ? {} : { depends }),
});

const historicalDescriptionForTask = (sourceTask) => [
  sourceTask.description,
  "",
  "--- Taskwarrior provenance ---",
  `Taskwarrior UUID: ${sourceTask.uuid}`,
  `entry: ${HISTORICAL_ENTRY}`,
  `modified: ${HISTORICAL_MODIFIED}`,
  "end: none",
].join("\n");

export const preparedData = ({ taskDescription } = {}) => {
  const tasks = [
    task({ uuid: TASK_A, description: taskDescription ?? `Task ${TASK_A}` }),
    task({ uuid: TASK_B, depends: [TASK_A] }),
  ];
  const decisions = [{
    taskwarriorProject: "alpha",
    action: "migrate",
    taskUuids: [TASK_A, TASK_B],
    historyPolicy: HISTORY_POLICIES.pendingAndCompleted,
    destination: {
      workspace: "ima",
      projectId: PROJECT_ID,
      projectKey: "DEST",
      projectName: "Destination",
      backlogStateId: BACKLOG_STATE_ID,
      doneStateId: DONE_STATE_ID,
    },
  }];
  const discovered = [{
    project: {
      id: PROJECT_ID,
      identifier: "DEST",
      name: "Destination",
      archivedAt: null,
    },
    compatibility: {
      compatible: true,
      backlogStateId: BACKLOG_STATE_ID,
      doneStateId: DONE_STATE_ID,
    },
    identityLookup: { status: "ready", itemCount: 0 },
    states: [
      { id: BACKLOG_STATE_ID, group: "backlog", sequence: 1 },
      { id: DONE_STATE_ID, group: "completed", sequence: 2 },
    ],
    items: [],
  }];
  const source = buildPreparationSource({ workspace: "ima", decisions, discovered, tasks });
  const inputs = decisionsToPlanInputs({ decisions, tasks });
  const plan = buildMigrationPlan({
    worksheet: inputs.projectMappings,
    destinations: inputs.destinations,
    tasks: inputs.tasks,
  });

  return { source, plan };
};

export const historicalPreparedData = (options = {}) => {
  const data = preparedData(options);
  const tasksByUuid = new Map(data.source.tasks.map((sourceTask) => [sourceTask.uuid, sourceTask]));
  const planWithoutHash = {
    ...data.plan,
    items: data.plan.items.map((item) => {
      if (item.disposition !== "create") return item;

      return {
        ...item,
        workItem: {
          ...item.workItem,
          descriptionStripped: historicalDescriptionForTask(tasksByUuid.get(item.taskUuid)),
        },
      };
    }),
  };
  const plan = {
    ...planWithoutHash,
    planSha256: migrationPlanSha256(planWithoutHash),
  };

  return { ...data, plan };
};

export const preparedRun = async (t, data = preparedData()) => {
  const root = await mkdtemp(join(tmpdir(), "ima-pi-prepared-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await artifactApi.createMigrationRun({
    cwd: root,
    timestamp: "2026-09-04T00-00-00-000Z",
  });
  const readiness = buildPreparationReadinessReport({
    decisions: data.source.decisions,
    discovered: data.source.discovered,
    planSha256: data.plan.planSha256,
  });
  await artifactApi.writeRunArtifact({
    run,
    name: artifactApi.MIGRATION_ARTIFACTS.source,
    value: data.source,
  });
  await artifactApi.writeRunArtifact({
    run,
    name: artifactApi.MIGRATION_ARTIFACTS.plan,
    value: data.plan,
  });
  await artifactApi.writeRunArtifact({
    run,
    name: artifactApi.MIGRATION_ARTIFACTS.preflightReport,
    value: readiness,
  });
  return { root, run, ...data };
};

export const migrationClient = ({ stateGroup = "backlog" } = {}) => {
  const itemsByExternalId = new Map();
  const blockedByIds = new Map();
  let createdItems = 0;
  let createdRelations = 0;
  const createdWorkItemInputs = [];
  let stateReads = 0;
  let identityReads = 0;
  let failingRelationLookups = 0;

  const client = {
    listProjectStates: async () => {
      stateReads += 1;
      return [
        { id: BACKLOG_STATE_ID, group: stateGroup },
        { id: DONE_STATE_ID, group: "completed" },
      ];
    },
    listProjectWorkItems: async ({ externalId, externalSource }) => {
      identityReads += 1;
      const item = itemsByExternalId.get(externalId);
      return item?.externalSource === externalSource ? [item] : [];
    },
    createProjectWorkItem: async ({ projectId, input }) => {
      createdItems += 1;
      createdWorkItemInputs.push(structuredClone(input));
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
      if (failingRelationLookups > 0) {
        failingRelationLookups -= 1;
        throw new Error("synthetic relation lookup failure");
      }
      return { blockedByIds: [...(blockedByIds.get(workItemId) ?? new Set())] };
    },
    createWorkItemRelation: async ({ workItemId, relation }) => {
      createdRelations += 1;
      const relations = blockedByIds.get(workItemId) ?? new Set();
      relations.add(relation.issueIds[0]);
      blockedByIds.set(workItemId, relations);
      return { workItemId, ...relation };
    },
  };

  return {
    client,
    stats: () => ({ createdItems, createdRelations, stateReads, identityReads }),
    createdWorkItemInputs: () => structuredClone(createdWorkItemInputs),
    failNextRelationLookup: () => { failingRelationLookups += 1; },
  };
};

export const applyInput = ({ prepared, client, artifact = artifactApi }) => ({
  cwd: prepared.root,
  relativeRunPath: prepared.run.relativeRunPath,
  reviewedPlanSha256: prepared.plan.planSha256,
  env: {},
  artifactApi: artifact,
  createClient: () => client,
  readConfig: () => ({}),
  toErrorCode: () => "HTTP_ERROR",
});
