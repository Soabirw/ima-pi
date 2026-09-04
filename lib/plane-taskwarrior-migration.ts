import { createHash } from "node:crypto";
import {
  buildHistoricalTaskwarriorWorkItemDescription,
  buildTaskwarriorWorkItemDescription,
  normalizeTaskwarriorAnnotations,
} from "./plane-taskwarrior-description.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASKWARRIOR_TIMESTAMP_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const TASK_STATUSES = new Set(["pending", "completed", "deleted"]);
const RAW_PRIORITY_MAP = Object.freeze({ H: "high", M: "medium", L: "low" });
const NORMALIZED_PRIORITIES = new Set(["high", "medium", "low", "none"]);
const PLAN_SCHEMA_VERSION = 1;

export const TASKWARRIOR_EXTERNAL_SOURCE = "taskwarrior";
export const DELETED_ENDPOINT_REASON = "deleted_endpoint";

const migrationFailure = (code) => {
  throw new Error(`plane_taskwarrior_migration_${code}`);
};

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const requireRecord = (value, code) => {
  if (!isRecord(value)) migrationFailure(code);
  return value;
};

const requireText = (value, code) => {
  if (typeof value !== "string" || value.trim() === "") migrationFailure(code);
  return value;
};

const optionalText = (value, code) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") migrationFailure(code);
  return value;
};

const normalizeUuid = (value, code) => {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) migrationFailure(code);
  return value.toLowerCase();
};

const normalizeProject = (value) => {
  if (value === null || value === undefined) return null;
  return requireText(value, "task_project_invalid");
};

const projectKeyFor = (project) => project ?? "(none)";

const sortBy = (items, selector) => [...items].sort((left, right) =>
  selector(left).localeCompare(selector(right)));

const timestampFromParts = (match) => {
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const expected = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`;
  if (date.toISOString() !== expected) migrationFailure("timestamp_invalid");
  return expected;
};

export const normalizeTaskwarriorTimestamp = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") migrationFailure("timestamp_invalid");

  const taskwarriorMatch = TASKWARRIOR_TIMESTAMP_PATTERN.exec(value);
  if (taskwarriorMatch) return timestampFromParts(taskwarriorMatch);
  if (!ISO_TIMESTAMP_PATTERN.test(value)) migrationFailure("timestamp_invalid");

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) migrationFailure("timestamp_invalid");
  return date.toISOString();
};

const normalizePriority = (value) => {
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value !== "string") migrationFailure("task_priority_invalid");
  if (Object.hasOwn(RAW_PRIORITY_MAP, value)) return RAW_PRIORITY_MAP[value];
  if (NORMALIZED_PRIORITIES.has(value)) return value;
  migrationFailure("task_priority_invalid");
};

const normalizeDependencies = (value) => {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) migrationFailure("task_depends_invalid");

  const dependencies = value.map((dependency) => normalizeUuid(dependency, "task_depends_invalid"));
  if (new Set(dependencies).size !== dependencies.length) migrationFailure("task_depends_duplicate");
  return dependencies.sort();
};

export const normalizeTaskwarriorTask = (rawTask) => {
  const task = requireRecord(rawTask, "task_invalid");
  const status = requireText(task.status, "task_status_invalid");
  if (!TASK_STATUSES.has(status)) migrationFailure("task_status_invalid");

  const normalized = {
    uuid: normalizeUuid(task.uuid, "task_uuid_invalid"),
    project: normalizeProject(task.project),
    status,
    description: requireText(task.description, "task_description_invalid"),
    priority: normalizePriority(task.priority),
    entry: normalizeTaskwarriorTimestamp(task.entry),
    modified: normalizeTaskwarriorTimestamp(task.modified),
    end: normalizeTaskwarriorTimestamp(task.end),
    wait: normalizeTaskwarriorTimestamp(task.wait),
    depends: normalizeDependencies(task.depends),
    annotations: normalizeTaskwarriorAnnotations({
      annotations: task.annotations,
      normalizeTimestamp: normalizeTaskwarriorTimestamp,
    }),
  };

  if (!normalized.entry || !normalized.modified) migrationFailure("task_timestamp_missing");
  if (normalized.status === "completed" && !normalized.end) {
    migrationFailure("task_completion_timestamp_missing");
  }
  if (normalized.status === "pending" && normalized.end) {
    migrationFailure("task_completion_timestamp_invalid");
  }

  return normalized;
};

export const classifyTask = (rawTask) => {
  const task = normalizeTaskwarriorTask(rawTask);
  if (task.status === "deleted") return { disposition: "skip", reason: "deleted_task" };
  return {
    disposition: "create",
    stateKind: task.status === "pending" ? "backlog" : "done",
  };
};

const tableCells = (line) => line
  .trim()
  .replace(/^\|/, "")
  .replace(/\|$/, "")
  .split("|")
  .map((cell) => cell.trim());

const parseCount = (value) => {
  if (!/^\d+$/.test(value)) migrationFailure("worksheet_count_invalid");
  return Number(value);
};

const requiredWorksheetHeaders = [
  "Taskwarrior project",
  "Total",
  "Pending",
  "Completed",
  "Deleted",
  "Migrate?",
  "Plane workspace",
  "Plane project name",
  "Plane project key",
  "Migration treatment",
  "Notes",
];

const mappingFromRow = (headers, cells) => {
  if (headers.length !== cells.length) migrationFailure("worksheet_row_invalid");
  const row = Object.fromEntries(headers.map((header, index) => [header, cells[index]]));
  const rawProject = row["Taskwarrior project"];
  const taskwarriorProject = rawProject === "(none)"
    ? null
    : requireText(rawProject, "worksheet_row_invalid").replace(/^`|`$/g, "");
  const migrate = row["Migrate?"] === "Y" ? true : row["Migrate?"] === "N" ? false : null;
  if (migrate === null) migrationFailure("worksheet_row_invalid");

  const mapping = {
    taskwarriorProject,
    total: parseCount(row.Total),
    pending: parseCount(row.Pending),
    completed: parseCount(row.Completed),
    deleted: parseCount(row.Deleted),
    migrate,
    workspace: row["Plane workspace"] || null,
    projectName: row["Plane project name"] || null,
    projectKey: row["Plane project key"] || null,
    treatment: requireText(row["Migration treatment"], "worksheet_row_invalid"),
    notes: row.Notes || null,
  };

  if (mapping.total !== mapping.pending + mapping.completed + mapping.deleted) {
    migrationFailure("worksheet_count_invalid");
  }
  if (mapping.migrate && (!mapping.workspace || !mapping.projectName || !mapping.projectKey)) {
    migrationFailure("worksheet_destination_missing");
  }
  if (!mapping.migrate && (mapping.workspace || mapping.projectName || mapping.projectKey)) {
    migrationFailure("worksheet_destination_invalid");
  }

  return mapping;
};

export const parseTaskwarriorProjectMap = (markdown) => {
  if (typeof markdown !== "string") migrationFailure("worksheet_invalid");

  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) =>
    line.startsWith("|") && line.includes("Taskwarrior project") && line.includes("Migrate?"));
  if (headerIndex < 0 || !lines[headerIndex + 1]?.startsWith("|")) migrationFailure("worksheet_invalid");

  const headers = tableCells(lines[headerIndex]);
  if (requiredWorksheetHeaders.some((header) => !headers.includes(header))) {
    migrationFailure("worksheet_invalid");
  }

  const mappings = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.startsWith("|")) break;
    if (/^\|[-| :]+\|$/.test(line.trim())) continue;
    mappings.push(mappingFromRow(headers, tableCells(line)));
  }
  if (mappings.length === 0) migrationFailure("worksheet_invalid");

  const knownProjects = new Set();
  for (const mapping of mappings) {
    const projectKey = projectKeyFor(mapping.taskwarriorProject);
    if (knownProjects.has(projectKey)) migrationFailure("worksheet_duplicate_project");
    knownProjects.add(projectKey);
  }

  return mappings;
};

const normalizeProjectMappings = (value) => {
  if (typeof value === "string") return parseTaskwarriorProjectMap(value);
  if (!Array.isArray(value) || value.length === 0) migrationFailure("worksheet_invalid");

  return value.map((mapping) => {
    const record = requireRecord(mapping, "worksheet_row_invalid");
    return mappingFromRow(requiredWorksheetHeaders, [
      record.taskwarriorProject ?? "(none)",
      String(record.total),
      String(record.pending),
      String(record.completed),
      String(record.deleted),
      record.migrate === true ? "Y" : record.migrate === false ? "N" : "",
      record.workspace ?? "",
      record.projectName ?? "",
      record.projectKey ?? "",
      record.treatment,
      record.notes ?? "",
    ]);
  });
};

const destinationForMapping = ({ mapping, stateKind, destinations }) => {
  if (!mapping.migrate) migrationFailure("destination_unapproved");
  if (!isRecord(destinations) || !Object.hasOwn(destinations, mapping.projectKey)) {
    migrationFailure("destination_missing");
  }

  const destination = requireRecord(destinations[mapping.projectKey], "destination_invalid");
  const workspace = requireText(destination.workspace, "destination_invalid");
  if (workspace !== mapping.workspace) migrationFailure("destination_workspace_mismatch");

  const stateId = normalizeUuid(
    stateKind === "backlog" ? destination.backlogStateId : destination.doneStateId,
    "destination_invalid",
  );

  return {
    workspace,
    projectKey: mapping.projectKey,
    projectId: normalizeUuid(destination.projectId, "destination_invalid"),
    stateId,
    stateKind,
  };
};

export const destinationForTask = ({ task, projectMappings, destinations }) => {
  const normalizedTask = normalizeTaskwarriorTask(task);
  const classification = classifyTask(normalizedTask);
  if (classification.disposition === "skip") return classification;

  const mappings = normalizeProjectMappings(projectMappings);
  const mapping = mappings.find((entry) => entry.taskwarriorProject === normalizedTask.project);
  if (!mapping) migrationFailure("worksheet_project_missing");

  return {
    disposition: "create",
    ...destinationForMapping({ mapping, stateKind: classification.stateKind, destinations }),
  };
};

const workItemInputForTaskWithDescription = ({
  task,
  destination,
  descriptionRenderer,
}) => {
  const normalizedTask = normalizeTaskwarriorTask(task);
  const normalizedDestination = requireRecord(destination, "destination_invalid");
  if (normalizedDestination.disposition !== "create") migrationFailure("destination_unapproved");

  return {
    name: normalizedTask.description,
    descriptionStripped: descriptionRenderer(normalizedTask),
    priority: normalizedTask.priority,
    stateId: normalizeUuid(normalizedDestination.stateId, "destination_invalid"),
    externalId: normalizedTask.uuid,
    externalSource: TASKWARRIOR_EXTERNAL_SOURCE,
  };
};

export const workItemInputForTask = ({ task, destination }) => (
  workItemInputForTaskWithDescription({
    task,
    destination,
    descriptionRenderer: buildTaskwarriorWorkItemDescription,
  })
);

const taskCounts = (tasks) => tasks.reduce((counts, task) => ({
  total: counts.total + 1,
  pending: counts.pending + Number(task.status === "pending"),
  completed: counts.completed + Number(task.status === "completed"),
  deleted: counts.deleted + Number(task.status === "deleted"),
}), { total: 0, pending: 0, completed: 0, deleted: 0 });

const validateWorksheetCounts = ({ tasks, projectMappings }) => {
  const tasksByProject = new Map();
  for (const task of tasks) {
    const projectKey = projectKeyFor(task.project);
    const projectTasks = tasksByProject.get(projectKey) ?? [];
    tasksByProject.set(projectKey, [...projectTasks, task]);
  }

  const mappedProjects = new Set(projectMappings.map((mapping) => projectKeyFor(mapping.taskwarriorProject)));
  if ([...tasksByProject.keys()].some((project) => !mappedProjects.has(project))) {
    migrationFailure("worksheet_project_missing");
  }

  for (const mapping of projectMappings) {
    const observed = taskCounts(tasksByProject.get(projectKeyFor(mapping.taskwarriorProject)) ?? []);
    if (
      observed.total !== mapping.total
      || observed.pending !== mapping.pending
      || observed.completed !== mapping.completed
      || observed.deleted !== mapping.deleted
    ) {
      migrationFailure("worksheet_count_mismatch");
    }
  }
};

const migrationItemForTask = ({
  task,
  projectMappings,
  destinations,
  descriptionRenderer,
}) => {
  const destination = destinationForTask({ task, projectMappings, destinations });
  if (destination.disposition === "skip") {
    return {
      taskUuid: task.uuid,
      taskProject: task.project,
      taskStatus: task.status,
      disposition: "skip",
      reason: destination.reason,
    };
  }

  return {
    taskUuid: task.uuid,
    taskProject: task.project,
    taskStatus: task.status,
    disposition: "create",
    destination: {
      workspace: destination.workspace,
      projectKey: destination.projectKey,
      projectId: destination.projectId,
      stateId: destination.stateId,
      stateKind: destination.stateKind,
    },
    workItem: workItemInputForTaskWithDescription({
      task,
      destination,
      descriptionRenderer,
    }),
  };
};

export const dependencyEdgesForTasks = ({ tasks, items }) => {
  if (!Array.isArray(tasks) || !Array.isArray(items)) migrationFailure("dependency_input_invalid");

  const itemsByTaskUuid = new Map(items.map((item) => [item.taskUuid, item]));
  if (itemsByTaskUuid.size !== items.length) migrationFailure("migration_item_duplicate");

  const eligibleRelations = [];
  const skippedRelations = [];
  for (const task of sortBy(tasks.map(normalizeTaskwarriorTask), (entry) => entry.uuid)) {
    const sourceItem = itemsByTaskUuid.get(task.uuid);
    if (!sourceItem) migrationFailure("dependency_source_missing");

    for (const targetTaskUuid of task.depends) {
      const targetItem = itemsByTaskUuid.get(targetTaskUuid);
      if (!targetItem) migrationFailure("dependency_target_missing");
      if (sourceItem.disposition !== "create" || targetItem.disposition !== "create") {
        skippedRelations.push({
          sourceTaskUuid: task.uuid,
          targetTaskUuid,
          reason: DELETED_ENDPOINT_REASON,
        });
        continue;
      }
      if (sourceItem.destination.projectId !== targetItem.destination.projectId) {
        migrationFailure("cross_project_dependency");
      }
      eligibleRelations.push({
        sourceTaskUuid: task.uuid,
        targetTaskUuid,
        workspace: sourceItem.destination.workspace,
        projectId: sourceItem.destination.projectId,
        relationType: "blocked_by",
      });
    }
  }

  return { eligibleRelations, skippedRelations };
};

const createsByProject = (items) => Object.fromEntries(
  [...items.reduce((counts, item) => {
    if (item.disposition !== "create") return counts;
    counts.set(item.destination.projectKey, (counts.get(item.destination.projectKey) ?? 0) + 1);
    return counts;
  }, new Map()).entries()].sort(([left], [right]) => left.localeCompare(right)),
);

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
};

const hashValue = (value) => createHash("sha256")
  .update(JSON.stringify(stableValue(value)), "utf8")
  .digest("hex");

const withoutPlanHash = (plan) => {
  const { planSha256: _planSha256, ...content } = requireRecord(plan, "plan_invalid");
  return content;
};

export const migrationPlanSha256 = (plan) => hashValue(withoutPlanHash(plan));

const buildMigrationPlanWithDescriptionRenderer = ({
  worksheet,
  tasks,
  destinations,
  descriptionRenderer,
}) => {
  const projectMappings = normalizeProjectMappings(worksheet);
  if (!Array.isArray(tasks) || tasks.length === 0) migrationFailure("tasks_invalid");

  const normalizedTasks = sortBy(tasks.map(normalizeTaskwarriorTask), (task) => task.uuid);
  if (new Set(normalizedTasks.map((task) => task.uuid)).size !== normalizedTasks.length) {
    migrationFailure("task_uuid_duplicate");
  }
  validateWorksheetCounts({ tasks: normalizedTasks, projectMappings });

  const items = normalizedTasks.map((task) => migrationItemForTask({
    task,
    projectMappings,
    destinations,
    descriptionRenderer,
  }));
  const relations = dependencyEdgesForTasks({ tasks: normalizedTasks, items });
  const createdItems = items.filter((item) => item.disposition === "create");
  const skippedItems = items.filter((item) => item.disposition === "skip");
  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    externalSource: TASKWARRIOR_EXTERNAL_SOURCE,
    items,
    eligibleRelations: relations.eligibleRelations,
    skippedRelations: relations.skippedRelations,
    summary: {
      sourceTasks: items.length,
      creates: createdItems.length,
      taskSkips: skippedItems.length,
      pending: createdItems.filter((item) => item.taskStatus === "pending").length,
      completed: createdItems.filter((item) => item.taskStatus === "completed").length,
      createsByProject: createsByProject(items),
      sourceEdges: relations.eligibleRelations.length + relations.skippedRelations.length,
      eligibleRelations: relations.eligibleRelations.length,
      deletedEndpointSkips: relations.skippedRelations.length,
    },
  };

  return { ...plan, planSha256: hashValue(plan) };
};

export const buildMigrationPlan = (input) => (
  buildMigrationPlanWithDescriptionRenderer({
    ...input,
    descriptionRenderer: buildTaskwarriorWorkItemDescription,
  })
);

export const buildHistoricalMigrationPlan = (input) => (
  buildMigrationPlanWithDescriptionRenderer({
    ...input,
    descriptionRenderer: buildHistoricalTaskwarriorWorkItemDescription,
  })
);

const PLAN_ROOT_KEYS = new Set([
  "schemaVersion",
  "externalSource",
  "items",
  "eligibleRelations",
  "skippedRelations",
  "summary",
  "planSha256",
]);
const CREATE_ITEM_KEYS = new Set([
  "taskUuid",
  "taskProject",
  "taskStatus",
  "disposition",
  "destination",
  "workItem",
]);
const SKIP_ITEM_KEYS = new Set([
  "taskUuid",
  "taskProject",
  "taskStatus",
  "disposition",
  "reason",
]);
const DESTINATION_KEYS = new Set(["workspace", "projectKey", "projectId", "stateId", "stateKind"]);
const WORK_ITEM_KEYS = new Set([
  "name",
  "descriptionStripped",
  "priority",
  "stateId",
  "externalId",
  "externalSource",
]);
const ELIGIBLE_RELATION_KEYS = new Set([
  "sourceTaskUuid",
  "targetTaskUuid",
  "workspace",
  "projectId",
  "relationType",
]);
const SKIPPED_RELATION_KEYS = new Set(["sourceTaskUuid", "targetTaskUuid", "reason"]);
const SUMMARY_KEYS = new Set([
  "sourceTasks",
  "creates",
  "taskSkips",
  "pending",
  "completed",
  "createsByProject",
  "sourceEdges",
  "eligibleRelations",
  "deletedEndpointSkips",
]);

const requireExactKeys = (value, expectedKeys, code) => {
  const record = requireRecord(value, code);
  const keys = Object.keys(record);
  if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key))) {
    migrationFailure(code);
  }
  return record;
};

const requirePlanUuid = (value, code) => {
  const normalized = normalizeUuid(value, code);
  if (value !== normalized) migrationFailure(code);
  return normalized;
};

const requirePlanProject = (value, code) => {
  if (value === null) return null;
  return requireText(value, code);
};

const relationKeyFor = ({ sourceTaskUuid, targetTaskUuid }) => `${sourceTaskUuid}:${targetTaskUuid}`;

const validateDestination = (value) => {
  const destination = requireExactKeys(value, DESTINATION_KEYS, "plan_destination_invalid");
  const stateKind = requireText(destination.stateKind, "plan_destination_invalid");
  if (stateKind !== "backlog" && stateKind !== "done") migrationFailure("plan_destination_invalid");

  return {
    workspace: requireText(destination.workspace, "plan_destination_invalid"),
    projectKey: requireText(destination.projectKey, "plan_destination_invalid"),
    projectId: requirePlanUuid(destination.projectId, "plan_destination_invalid"),
    stateId: requirePlanUuid(destination.stateId, "plan_destination_invalid"),
    stateKind,
  };
};

const validateWorkItem = (value, taskUuid, destination) => {
  const workItem = requireExactKeys(value, WORK_ITEM_KEYS, "plan_work_item_invalid");
  const priority = requireText(workItem.priority, "plan_work_item_invalid");
  if (!NORMALIZED_PRIORITIES.has(priority)) migrationFailure("plan_work_item_invalid");
  if (workItem.externalSource !== TASKWARRIOR_EXTERNAL_SOURCE) migrationFailure("plan_work_item_invalid");
  if (requirePlanUuid(workItem.externalId, "plan_work_item_invalid") !== taskUuid) {
    migrationFailure("plan_work_item_invalid");
  }
  if (requirePlanUuid(workItem.stateId, "plan_work_item_invalid") !== destination.stateId) {
    migrationFailure("plan_work_item_invalid");
  }
  requireText(workItem.name, "plan_work_item_invalid");
  if (typeof workItem.descriptionStripped !== "string") migrationFailure("plan_work_item_invalid");
};

const validatePlanItem = (value) => {
  const item = requireRecord(value, "plan_item_invalid");
  const taskUuid = requirePlanUuid(item.taskUuid, "plan_item_invalid");
  const taskStatus = requireText(item.taskStatus, "plan_item_invalid");
  if (!TASK_STATUSES.has(taskStatus)) migrationFailure("plan_item_invalid");
  requirePlanProject(item.taskProject, "plan_item_invalid");

  if (item.disposition === "skip") {
    requireExactKeys(item, SKIP_ITEM_KEYS, "plan_item_invalid");
    if (taskStatus !== "deleted" || item.reason !== "deleted_task") migrationFailure("plan_item_invalid");
    return { taskUuid, disposition: "skip", taskStatus };
  }

  requireExactKeys(item, CREATE_ITEM_KEYS, "plan_item_invalid");
  if (taskStatus === "deleted") migrationFailure("plan_item_invalid");
  const destination = validateDestination(item.destination);
  if ((taskStatus === "pending" && destination.stateKind !== "backlog")
    || (taskStatus === "completed" && destination.stateKind !== "done")) {
    migrationFailure("plan_item_invalid");
  }
  validateWorkItem(item.workItem, taskUuid, destination);
  return { taskUuid, disposition: "create", taskStatus, destination };
};

const validateEligibleRelation = (value, itemsByTaskUuid) => {
  const relation = requireExactKeys(value, ELIGIBLE_RELATION_KEYS, "plan_relation_invalid");
  const sourceTaskUuid = requirePlanUuid(relation.sourceTaskUuid, "plan_relation_invalid");
  const targetTaskUuid = requirePlanUuid(relation.targetTaskUuid, "plan_relation_invalid");
  const source = itemsByTaskUuid.get(sourceTaskUuid);
  const target = itemsByTaskUuid.get(targetTaskUuid);
  if (!source || !target || source.disposition !== "create" || target.disposition !== "create") {
    migrationFailure("plan_relation_invalid");
  }
  if (relation.relationType !== "blocked_by") migrationFailure("plan_relation_invalid");
  if (
    requireText(relation.workspace, "plan_relation_invalid") !== source.destination.workspace
    || relation.workspace !== target.destination.workspace
    || requirePlanUuid(relation.projectId, "plan_relation_invalid") !== source.destination.projectId
    || relation.projectId !== target.destination.projectId
  ) {
    migrationFailure("plan_relation_invalid");
  }
  return { sourceTaskUuid, targetTaskUuid };
};

const validateSkippedRelation = (value, itemsByTaskUuid) => {
  const relation = requireExactKeys(value, SKIPPED_RELATION_KEYS, "plan_relation_invalid");
  const sourceTaskUuid = requirePlanUuid(relation.sourceTaskUuid, "plan_relation_invalid");
  const targetTaskUuid = requirePlanUuid(relation.targetTaskUuid, "plan_relation_invalid");
  const source = itemsByTaskUuid.get(sourceTaskUuid);
  const target = itemsByTaskUuid.get(targetTaskUuid);
  if (!source || !target || relation.reason !== DELETED_ENDPOINT_REASON) migrationFailure("plan_relation_invalid");
  if (source.disposition === "create" && target.disposition === "create") {
    migrationFailure("plan_relation_invalid");
  }
  return { sourceTaskUuid, targetTaskUuid };
};

const validateSummary = ({ plan, items }) => {
  const summary = requireExactKeys(plan.summary, SUMMARY_KEYS, "plan_summary_invalid");
  const createdItems = items.filter((item) => item.disposition === "create");
  const skippedItems = items.filter((item) => item.disposition === "skip");
  const expected = {
    sourceTasks: items.length,
    creates: createdItems.length,
    taskSkips: skippedItems.length,
    pending: createdItems.filter((item) => item.taskStatus === "pending").length,
    completed: createdItems.filter((item) => item.taskStatus === "completed").length,
    createsByProject: createsByProject(plan.items),
    sourceEdges: plan.eligibleRelations.length + plan.skippedRelations.length,
    eligibleRelations: plan.eligibleRelations.length,
    deletedEndpointSkips: plan.skippedRelations.length,
  };

  for (const [key, expectedValue] of Object.entries(expected)) {
    if (key === "createsByProject") {
      if (JSON.stringify(stableValue(summary[key])) !== JSON.stringify(stableValue(expectedValue))) {
        migrationFailure("plan_summary_invalid");
      }
      continue;
    }
    if (!Number.isSafeInteger(summary[key]) || summary[key] !== expectedValue) {
      migrationFailure("plan_summary_invalid");
    }
  }
};

export const validateMigrationPlan = (plan) => {
  const normalizedPlan = requireExactKeys(plan, PLAN_ROOT_KEYS, "plan_invalid");
  if (normalizedPlan.schemaVersion !== PLAN_SCHEMA_VERSION) migrationFailure("plan_invalid");
  if (normalizedPlan.externalSource !== TASKWARRIOR_EXTERNAL_SOURCE) migrationFailure("plan_invalid");
  if (!Array.isArray(normalizedPlan.items)
    || !Array.isArray(normalizedPlan.eligibleRelations)
    || !Array.isArray(normalizedPlan.skippedRelations)) {
    migrationFailure("plan_invalid");
  }
  if (typeof normalizedPlan.planSha256 !== "string" || !/^[a-f0-9]{64}$/.test(normalizedPlan.planSha256)) {
    migrationFailure("plan_invalid");
  }
  if (migrationPlanSha256(normalizedPlan) !== normalizedPlan.planSha256) {
    migrationFailure("plan_hash_invalid");
  }

  const items = normalizedPlan.items.map(validatePlanItem);
  const itemsByTaskUuid = new Map(items.map((item) => [item.taskUuid, item]));
  if (itemsByTaskUuid.size !== items.length) migrationFailure("plan_item_duplicate");

  const relationKeys = new Set();
  for (const relation of normalizedPlan.eligibleRelations.map((entry) =>
    validateEligibleRelation(entry, itemsByTaskUuid))) {
    const key = relationKeyFor(relation);
    if (relationKeys.has(key)) migrationFailure("plan_relation_duplicate");
    relationKeys.add(key);
  }
  for (const relation of normalizedPlan.skippedRelations.map((entry) =>
    validateSkippedRelation(entry, itemsByTaskUuid))) {
    const key = relationKeyFor(relation);
    if (relationKeys.has(key)) migrationFailure("plan_relation_duplicate");
    relationKeys.add(key);
  }
  validateSummary({ plan: normalizedPlan, items });
  return normalizedPlan;
};

const normalizedObservedWorkItem = (value) => {
  const item = requireRecord(value, "observed_work_item_invalid");
  return {
    id: normalizeUuid(item.id, "observed_work_item_invalid"),
    name: requireText(item.name, "observed_work_item_invalid"),
    description: typeof item.description === "string"
      ? item.description
      : migrationFailure("observed_work_item_invalid"),
    priority: requireText(item.priority, "observed_work_item_invalid"),
    stateId: normalizeUuid(item.stateId, "observed_work_item_invalid"),
    externalId: normalizeUuid(item.externalId, "observed_work_item_invalid"),
    externalSource: requireText(item.externalSource, "observed_work_item_invalid"),
  };
};

export const comparePlannedWorkItem = ({ item, observedWorkItem }) => {
  const plannedItem = requireRecord(item, "plan_item_invalid");
  if (plannedItem.disposition !== "create" || !isRecord(plannedItem.workItem)) {
    migrationFailure("plan_item_invalid");
  }

  const observed = normalizedObservedWorkItem(observedWorkItem);
  const expected = {
    name: plannedItem.workItem.name,
    description: plannedItem.workItem.descriptionStripped,
    priority: plannedItem.workItem.priority,
    stateId: plannedItem.workItem.stateId,
    externalId: plannedItem.workItem.externalId,
    externalSource: plannedItem.workItem.externalSource,
  };
  const differentFields = Object.keys(expected).filter((field) => expected[field] !== observed[field]);

  return {
    taskUuid: plannedItem.taskUuid,
    planeItemId: observed.id,
    matches: differentFields.length === 0,
    differentFields,
  };
};

export const reconcilePlannedItems = ({ plan, observedItemsByTaskUuid }) => {
  const migrationPlan = validateMigrationPlan(plan);
  if (!isRecord(observedItemsByTaskUuid)) migrationFailure("reconciliation_input_invalid");

  const items = migrationPlan.items.map((item) => {
    if (item.disposition === "skip") {
      return { taskUuid: item.taskUuid, status: "skipped", reason: item.reason };
    }
    if (!Object.hasOwn(observedItemsByTaskUuid, item.taskUuid)) {
      return { taskUuid: item.taskUuid, status: "missing" };
    }

    const comparison = comparePlannedWorkItem({
      item,
      observedWorkItem: observedItemsByTaskUuid[item.taskUuid],
    });
    return {
      taskUuid: item.taskUuid,
      planeItemId: comparison.planeItemId,
      status: comparison.matches ? "matched" : "different",
      differentFields: comparison.differentFields,
    };
  });

  return {
    items,
    summary: {
      matched: items.filter((item) => item.status === "matched").length,
      different: items.filter((item) => item.status === "different").length,
      missing: items.filter((item) => item.status === "missing").length,
      skipped: items.filter((item) => item.status === "skipped").length,
    },
  };
};

const normalizedBlockedByIds = (value) => {
  const relations = requireRecord(value, "observed_relation_invalid");
  if (!Array.isArray(relations.blockedByIds)) migrationFailure("observed_relation_invalid");
  return relations.blockedByIds.map((id) => normalizeUuid(id, "observed_relation_invalid"));
};

export const reconcilePlannedRelations = ({
  plan,
  planeItemIdsByTaskUuid,
  observedRelationsByTaskUuid,
}) => {
  const migrationPlan = validateMigrationPlan(plan);
  if (!isRecord(planeItemIdsByTaskUuid) || !isRecord(observedRelationsByTaskUuid)) {
    migrationFailure("reconciliation_input_invalid");
  }

  const eligibleRelations = migrationPlan.eligibleRelations.map((relation) => {
    const sourcePlaneItemId = planeItemIdsByTaskUuid[relation.sourceTaskUuid];
    const targetPlaneItemId = planeItemIdsByTaskUuid[relation.targetTaskUuid];
    if (!sourcePlaneItemId || !targetPlaneItemId || !Object.hasOwn(observedRelationsByTaskUuid, relation.sourceTaskUuid)) {
      return { ...relation, status: "unresolved", reason: "missing_plane_endpoint" };
    }

    const blockedByIds = normalizedBlockedByIds(observedRelationsByTaskUuid[relation.sourceTaskUuid]);
    return {
      ...relation,
      status: blockedByIds.includes(normalizeUuid(targetPlaneItemId, "reconciliation_input_invalid"))
        ? "matched"
        : "missing",
    };
  });
  const skippedRelations = migrationPlan.skippedRelations.map((relation) => ({
    ...relation,
    status: "skipped",
  }));
  const relations = [...eligibleRelations, ...skippedRelations];

  return {
    relations,
    summary: {
      matched: relations.filter((relation) => relation.status === "matched").length,
      missing: relations.filter((relation) => relation.status === "missing").length,
      unresolved: relations.filter((relation) => relation.status === "unresolved").length,
      skipped: relations.filter((relation) => relation.status === "skipped").length,
    },
  };
};

export const buildDryRunReport = (plan) => {
  const migrationPlan = validateMigrationPlan(plan);
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    planSha256: migrationPlan.planSha256,
    summary: migrationPlan.summary,
    plannedCreates: migrationPlan.items
      .filter((item) => item.disposition === "create")
      .map((item) => ({
        taskUuid: item.taskUuid,
        projectKey: item.destination.projectKey,
        stateKind: item.destination.stateKind,
      })),
    skippedTasks: migrationPlan.items
      .filter((item) => item.disposition === "skip")
      .map((item) => ({ taskUuid: item.taskUuid, reason: item.reason })),
    eligibleRelations: migrationPlan.eligibleRelations,
    skippedRelations: migrationPlan.skippedRelations,
  };
};

const RECONCILIATION_REPORT_KEYS = new Set([
  "schemaVersion",
  "planSha256",
  "summary",
  "items",
  "relations",
  "unresolvedRelationAttempts",
]);
const RECONCILIATION_SUMMARY_KEYS = new Set(["task", "relation"]);
const TASK_RECONCILIATION_SUMMARY_KEYS = new Set(["matched", "different", "missing", "skipped"]);
const RELATION_RECONCILIATION_SUMMARY_KEYS = new Set([
  "matched",
  "missing",
  "unresolved",
  "skipped",
  "applyUnresolved",
]);
const MATCHED_ITEM_KEYS = new Set(["taskUuid", "planeItemId", "status", "differentFields"]);
const MISSING_ITEM_KEYS = new Set(["taskUuid", "status"]);
const SKIPPED_ITEM_RESULT_KEYS = new Set(["taskUuid", "status", "reason"]);
const ELIGIBLE_RELATION_RESULT_KEYS = new Set([
  "sourceTaskUuid",
  "targetTaskUuid",
  "workspace",
  "projectId",
  "relationType",
  "status",
]);
const UNRESOLVED_RELATION_RESULT_KEYS = new Set([...ELIGIBLE_RELATION_RESULT_KEYS, "reason"]);
const SKIPPED_RELATION_RESULT_KEYS = new Set(["sourceTaskUuid", "targetTaskUuid", "reason", "status"]);
const UNRESOLVED_RELATION_KEYS = new Set(["sourceTaskUuid", "targetTaskUuid", "reason"]);
const OBSERVED_ITEM_FIELDS = new Set([
  "name",
  "description",
  "priority",
  "stateId",
  "externalId",
  "externalSource",
]);

const normalizedUnresolvedRelation = (value, code = "unresolved_relation_invalid") => {
  const relation = requireExactKeys(value, UNRESOLVED_RELATION_KEYS, code);
  const reason = requireText(relation.reason, code);
  if (!/^[A-Z0-9_:-]+$/.test(reason)) migrationFailure(code);

  return {
    sourceTaskUuid: requirePlanUuid(relation.sourceTaskUuid, code),
    targetTaskUuid: requirePlanUuid(relation.targetTaskUuid, code),
    reason,
  };
};

const differentFieldsFor = (value, status) => {
  if (!Array.isArray(value) || value.some((field) => typeof field !== "string" || !OBSERVED_ITEM_FIELDS.has(field))) {
    migrationFailure("reconciliation_report_invalid");
  }
  if (new Set(value).size !== value.length || (status === "matched" && value.length !== 0)
    || (status === "different" && value.length === 0)) {
    migrationFailure("reconciliation_report_invalid");
  }
  return value;
};

const reconciliationItemFor = ({ value, itemsByTaskUuid }) => {
  const entry = requireRecord(value, "reconciliation_report_invalid");
  const taskUuid = requirePlanUuid(entry.taskUuid, "reconciliation_report_invalid");
  const item = itemsByTaskUuid.get(taskUuid);
  if (!item) migrationFailure("reconciliation_report_invalid");

  if (item.disposition === "skip") {
    const skipped = requireExactKeys(entry, SKIPPED_ITEM_RESULT_KEYS, "reconciliation_report_invalid");
    if (skipped.status !== "skipped" || skipped.reason !== item.reason) {
      migrationFailure("reconciliation_report_invalid");
    }
    return { taskUuid, status: "skipped", reason: item.reason };
  }

  const status = requireText(entry.status, "reconciliation_report_invalid");
  if (status === "missing") {
    requireExactKeys(entry, MISSING_ITEM_KEYS, "reconciliation_report_invalid");
    return { taskUuid, status };
  }
  if (status !== "matched" && status !== "different") migrationFailure("reconciliation_report_invalid");

  const observed = requireExactKeys(entry, MATCHED_ITEM_KEYS, "reconciliation_report_invalid");
  return {
    taskUuid,
    planeItemId: requirePlanUuid(observed.planeItemId, "reconciliation_report_invalid"),
    status,
    differentFields: differentFieldsFor(observed.differentFields, status),
  };
};

const sameEligibleRelation = (entry, relation) =>
  entry.workspace === relation.workspace
  && entry.projectId === relation.projectId
  && entry.relationType === relation.relationType;

const reconciliationRelationFor = ({ value, relationsByKey }) => {
  const entry = requireRecord(value, "reconciliation_report_invalid");
  const sourceTaskUuid = requirePlanUuid(entry.sourceTaskUuid, "reconciliation_report_invalid");
  const targetTaskUuid = requirePlanUuid(entry.targetTaskUuid, "reconciliation_report_invalid");
  const key = relationKeyFor({ sourceTaskUuid, targetTaskUuid });
  const planned = relationsByKey.get(key);
  if (!planned) migrationFailure("reconciliation_report_invalid");

  if (planned.kind === "skipped") {
    const skipped = requireExactKeys(entry, SKIPPED_RELATION_RESULT_KEYS, "reconciliation_report_invalid");
    if (skipped.status !== "skipped" || skipped.reason !== planned.relation.reason) {
      migrationFailure("reconciliation_report_invalid");
    }
    return { ...planned.relation, status: "skipped" };
  }

  const status = requireText(entry.status, "reconciliation_report_invalid");
  const expectedKeys = status === "unresolved"
    ? UNRESOLVED_RELATION_RESULT_KEYS
    : ELIGIBLE_RELATION_RESULT_KEYS;
  const eligible = requireExactKeys(entry, expectedKeys, "reconciliation_report_invalid");
  if (!sameEligibleRelation(eligible, planned.relation)) migrationFailure("reconciliation_report_invalid");
  if (status === "unresolved") {
    if (eligible.reason !== "missing_plane_endpoint") migrationFailure("reconciliation_report_invalid");
  } else if (status !== "matched" && status !== "missing") {
    migrationFailure("reconciliation_report_invalid");
  }

  return {
    ...planned.relation,
    status,
    ...(status === "unresolved" ? { reason: "missing_plane_endpoint" } : {}),
  };
};

const countStatuses = (values, names) => Object.fromEntries(names.map((name) => [
  name,
  values.filter((value) => value.status === name).length,
]));

const requireSummaryCounts = ({ value, keys, expected }) => {
  const summary = requireExactKeys(value, keys, "reconciliation_report_invalid");
  for (const [key, count] of Object.entries(expected)) {
    if (!Number.isSafeInteger(summary[key]) || summary[key] < 0 || summary[key] !== count) {
      migrationFailure("reconciliation_report_invalid");
    }
  }
  return expected;
};

const reconciliationSummaryFor = ({ items, relations, unresolvedRelationAttempts }) => ({
  task: countStatuses(items, ["matched", "different", "missing", "skipped"]),
  relation: {
    ...countStatuses(relations, ["matched", "missing", "unresolved", "skipped"]),
    applyUnresolved: unresolvedRelationAttempts.length,
  },
});

export const validateReconciliationReport = ({ plan, report }) => {
  const migrationPlan = validateMigrationPlan(plan);
  const candidate = requireExactKeys(report, RECONCILIATION_REPORT_KEYS, "reconciliation_report_invalid");
  if (candidate.schemaVersion !== PLAN_SCHEMA_VERSION || candidate.planSha256 !== migrationPlan.planSha256
    || !Array.isArray(candidate.items) || !Array.isArray(candidate.relations)
    || !Array.isArray(candidate.unresolvedRelationAttempts)) {
    migrationFailure("reconciliation_report_invalid");
  }

  const itemsByTaskUuid = new Map(migrationPlan.items.map((item) => [item.taskUuid, item]));
  const items = candidate.items.map((item) => reconciliationItemFor({ value: item, itemsByTaskUuid }));
  if (new Set(items.map((item) => item.taskUuid)).size !== items.length || items.length !== itemsByTaskUuid.size) {
    migrationFailure("reconciliation_report_invalid");
  }

  const relationsByKey = new Map([
    ...migrationPlan.eligibleRelations.map((relation) => [
      relationKeyFor(relation),
      { kind: "eligible", relation },
    ]),
    ...migrationPlan.skippedRelations.map((relation) => [
      relationKeyFor(relation),
      { kind: "skipped", relation },
    ]),
  ]);
  const relations = candidate.relations.map((relation) =>
    reconciliationRelationFor({ value: relation, relationsByKey }));
  if (new Set(relations.map(relationKeyFor)).size !== relations.length || relations.length !== relationsByKey.size) {
    migrationFailure("reconciliation_report_invalid");
  }

  const eligibleRelationKeys = new Set(migrationPlan.eligibleRelations.map(relationKeyFor));
  const unresolvedRelationAttempts = candidate.unresolvedRelationAttempts.map((attempt) => {
    const normalized = normalizedUnresolvedRelation(attempt, "reconciliation_report_invalid");
    if (!eligibleRelationKeys.has(relationKeyFor(normalized))) migrationFailure("reconciliation_report_invalid");
    return normalized;
  });
  const expectedSummary = reconciliationSummaryFor({ items, relations, unresolvedRelationAttempts });
  const summary = requireExactKeys(candidate.summary, RECONCILIATION_SUMMARY_KEYS, "reconciliation_report_invalid");
  requireSummaryCounts({
    value: summary.task,
    keys: TASK_RECONCILIATION_SUMMARY_KEYS,
    expected: expectedSummary.task,
  });
  requireSummaryCounts({
    value: summary.relation,
    keys: RELATION_RECONCILIATION_SUMMARY_KEYS,
    expected: expectedSummary.relation,
  });

  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    planSha256: migrationPlan.planSha256,
    summary: expectedSummary,
    items,
    relations,
    unresolvedRelationAttempts,
  };
};

export const buildReconciliationReport = ({
  plan,
  itemReconciliation,
  relationReconciliation,
  unresolvedRelationAttempts = [],
}) => {
  const migrationPlan = validateMigrationPlan(plan);
  const itemResult = requireRecord(itemReconciliation, "reconciliation_input_invalid");
  const relationResult = requireRecord(relationReconciliation, "reconciliation_input_invalid");
  if (!Array.isArray(itemResult.items) || !isRecord(itemResult.summary)) {
    migrationFailure("reconciliation_input_invalid");
  }
  if (!Array.isArray(relationResult.relations) || !isRecord(relationResult.summary)) {
    migrationFailure("reconciliation_input_invalid");
  }
  if (!Array.isArray(unresolvedRelationAttempts)) migrationFailure("unresolved_relation_invalid");

  return validateReconciliationReport({
    plan: migrationPlan,
    report: {
      schemaVersion: PLAN_SCHEMA_VERSION,
      planSha256: migrationPlan.planSha256,
      summary: {
        task: itemResult.summary,
        relation: {
          ...relationResult.summary,
          applyUnresolved: unresolvedRelationAttempts.length,
        },
      },
      items: itemResult.items,
      relations: relationResult.relations,
      unresolvedRelationAttempts: unresolvedRelationAttempts.map(normalizedUnresolvedRelation),
    },
  });
};
