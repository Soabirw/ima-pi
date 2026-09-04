import { buildTaskwarriorWorkItemDescription } from "./plane-taskwarrior-description.ts";
import {
  TASKWARRIOR_EXTERNAL_SOURCE,
  normalizeTaskwarriorTask,
  validateMigrationPlan,
} from "./plane-taskwarrior-migration.ts";

const BACKFILL_PLAN_SCHEMA_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_HASH_PATTERN = /^[a-f0-9]{64}$/;
const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const BACKFILL_PLAN_KEYS = new Set(["schemaVersion", "planSha256", "updates"]);
const BACKFILL_UPDATE_KEYS = new Set([
  "taskUuid",
  "workspace",
  "projectId",
  "itemId",
  "descriptionStripped",
]);
const BACKFILL_TARGET_KEYS = new Set(["projectId", "itemId"]);

const backfillFailure = (code) => {
  throw new Error(`plane_taskwarrior_description_backfill_${code}`);
};

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const requireExactKeys = (value, expectedKeys, code) => {
  if (!isRecord(value)) backfillFailure(code);

  const keys = Object.keys(value);
  if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key))) {
    backfillFailure(code);
  }
  return value;
};

const requireUuid = (value, code) => {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) backfillFailure(code);
  return value.toLowerCase();
};

const requirePlanHash = (value) => {
  if (typeof value !== "string" || !PLAN_HASH_PATTERN.test(value)) backfillFailure("plan_hash_invalid");
  return value;
};

const requireWorkspace = (value) => {
  if (typeof value !== "string" || !WORKSPACE_PATTERN.test(value)) {
    backfillFailure("workspace_invalid");
  }
  return value;
};

const normalizedTasksByUuid = (tasks) => {
  if (!Array.isArray(tasks)) backfillFailure("source_tasks_invalid");

  const normalized = tasks.map(normalizeTaskwarriorTask);
  const tasksByUuid = new Map(normalized.map((task) => [task.uuid, task]));
  if (tasksByUuid.size !== normalized.length) backfillFailure("source_tasks_duplicate");
  return tasksByUuid;
};

const normalizedBackfillTargets = (backfillByTaskUuid) => {
  if (!isRecord(backfillByTaskUuid)) backfillFailure("backfill_targets_invalid");

  const targets = Object.entries(backfillByTaskUuid)
    .map(([taskUuid, value]) => {
      const target = requireExactKeys(value, BACKFILL_TARGET_KEYS, "backfill_target_invalid");
      return {
        taskUuid: requireUuid(taskUuid, "backfill_target_invalid"),
        projectId: requireUuid(target.projectId, "backfill_target_invalid"),
        itemId: requireUuid(target.itemId, "backfill_target_invalid"),
      };
    })
    .sort((left, right) => left.taskUuid.localeCompare(right.taskUuid));
  if (new Set(targets.map((target) => target.taskUuid)).size !== targets.length) {
    backfillFailure("backfill_targets_invalid");
  }
  return targets;
};

const discoveredItemKeys = (discovered) => {
  if (!Array.isArray(discovered)) backfillFailure("discovered_invalid");

  return new Set(discovered.flatMap((entry) => {
    if (!isRecord(entry) || !isRecord(entry.project) || !Array.isArray(entry.items)) {
      backfillFailure("discovered_invalid");
    }

    const projectId = requireUuid(entry.project.id, "discovered_invalid");
    return entry.items.map((item) => {
      if (!isRecord(item) || item.externalSource !== TASKWARRIOR_EXTERNAL_SOURCE) {
        backfillFailure("discovered_item_invalid");
      }

      const itemProjectId = requireUuid(item.projectId, "discovered_item_invalid");
      if (itemProjectId !== projectId) backfillFailure("discovered_item_invalid");

      return [
        projectId,
        requireUuid(item.id, "discovered_item_invalid"),
        requireUuid(item.externalId, "discovered_item_invalid"),
      ].join(":");
    });
  }));
};

export const isBlankDescription = (text) => typeof text !== "string" || text.trim() === "";

export const buildMigrationBackfillPlan = ({
  planSha256,
  workspace,
  backfillByTaskUuid,
  tasks,
}) => {
  const normalizedWorkspace = requireWorkspace(workspace);
  const targetsByTaskUuid = new Map(
    normalizedBackfillTargets(backfillByTaskUuid).map((target) => [target.taskUuid, target]),
  );
  const updates = [...normalizedTasksByUuid(tasks).values()]
    .filter((task) => task.status !== "deleted" && targetsByTaskUuid.has(task.uuid))
    .sort((left, right) => left.uuid.localeCompare(right.uuid))
    .flatMap((task) => {
      const target = targetsByTaskUuid.get(task.uuid);
      const descriptionStripped = buildTaskwarriorWorkItemDescription(task);
      if (isBlankDescription(descriptionStripped)) return [];

      return [{
        taskUuid: task.uuid,
        workspace: normalizedWorkspace,
        projectId: target.projectId,
        itemId: target.itemId,
        descriptionStripped,
      }];
    });

  return {
    schemaVersion: BACKFILL_PLAN_SCHEMA_VERSION,
    planSha256: requirePlanHash(planSha256),
    updates,
  };
};

export const validateMigrationBackfillPlan = ({
  backfillPlan,
  plan,
  sourceTasks,
  discovered,
  expectedWorkspace,
}) => {
  let migrationPlan;
  try {
    migrationPlan = validateMigrationPlan(plan);
  } catch {
    backfillFailure("migration_plan_invalid");
  }

  const candidate = requireExactKeys(backfillPlan, BACKFILL_PLAN_KEYS, "plan_invalid");
  if (candidate.schemaVersion !== BACKFILL_PLAN_SCHEMA_VERSION || candidate.planSha256 !== migrationPlan.planSha256) {
    backfillFailure("plan_invalid");
  }
  if (!Array.isArray(candidate.updates)) backfillFailure("plan_invalid");

  const normalizedExpectedWorkspace = requireWorkspace(expectedWorkspace);
  const tasksByUuid = normalizedTasksByUuid(sourceTasks);
  const knownItems = discoveredItemKeys(discovered);
  let previousTaskUuid = null;
  const taskUuids = new Set();

  for (const value of candidate.updates) {
    const update = requireExactKeys(value, BACKFILL_UPDATE_KEYS, "update_invalid");
    const taskUuid = requireUuid(update.taskUuid, "update_invalid");
    const projectId = requireUuid(update.projectId, "update_invalid");
    const itemId = requireUuid(update.itemId, "update_invalid");
    const workspace = requireWorkspace(update.workspace);
    if (workspace !== normalizedExpectedWorkspace) backfillFailure("workspace_invalid");
    if (typeof update.descriptionStripped !== "string") backfillFailure("update_invalid");
    if (taskUuids.has(taskUuid) || (previousTaskUuid !== null && previousTaskUuid.localeCompare(taskUuid) >= 0)) {
      backfillFailure("update_invalid");
    }
    taskUuids.add(taskUuid);
    previousTaskUuid = taskUuid;

    const task = tasksByUuid.get(taskUuid);
    if (!task || task.status === "deleted") backfillFailure("source_task_invalid");
    if (update.descriptionStripped !== buildTaskwarriorWorkItemDescription(task)) {
      backfillFailure("description_invalid");
    }
    if (!knownItems.has([projectId, itemId, taskUuid].join(":"))) {
      backfillFailure("target_invalid");
    }
  }

  return candidate;
};
