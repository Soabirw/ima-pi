import {
  TASKWARRIOR_EXTERNAL_SOURCE,
  normalizeTaskwarriorTask,
} from "./plane-taskwarrior-migration.ts";
import { isBlankDescription } from "./plane-taskwarrior-description-backfill.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_HASH_PATTERN = /^[a-f0-9]{64}$/;
const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const PREPARATION_READINESS_SCHEMA_VERSION = 1;
const PREPARATION_SOURCE_SCHEMA_VERSION = 3;
const WRITE_ONLY_REASON = "WRITE_ONLY";
const DEFERRED_RELATIONS_REASON = "DEFERRED_TO_TASK_B";

export const HISTORY_POLICIES = Object.freeze({
  pendingAndCompleted: "pending-and-completed",
  pendingOnly: "pending-only",
});

const planningFailure = (code) => {
  throw new Error(`plane_taskwarrior_planning_${code}`);
};

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const isUuid = (value) => typeof value === "string" && UUID_PATTERN.test(value);

const requireText = (value, code) => {
  if (typeof value !== "string" || value.trim() === "") planningFailure(code);
  return value;
};

const requireUuid = (value, code) => {
  if (!isUuid(value)) planningFailure(code);
  return value.toLowerCase();
};

const projectKeyFor = (project) => project ?? "(none)";

const sameProject = (left, right) => left === right;

const sortBy = (values, selector) => [...values].sort((left, right) =>
  selector(left).localeCompare(selector(right)));

const taskCounts = (tasks) => ({
  total: tasks.length,
  pending: tasks.filter((task) => task.status === "pending").length,
  completed: tasks.filter((task) => task.status === "completed").length,
  deleted: tasks.filter((task) => task.status === "deleted").length,
});

const normalizedTasks = (tasks) => {
  if (!Array.isArray(tasks)) planningFailure("tasks_invalid");

  const normalized = tasks.map(normalizeTaskwarriorTask);
  const taskUuids = normalized.map((task) => task.uuid);
  if (new Set(taskUuids).size !== taskUuids.length) planningFailure("task_uuid_duplicate");

  return sortBy(normalized, (task) => `${projectKeyFor(task.project)}\u0000${task.uuid}`);
};

const historyPolicyFor = (value) => {
  if (!Object.values(HISTORY_POLICIES).includes(value)) planningFailure("history_policy_invalid");
  return value;
};

const taskwarriorProjectFor = (value) => {
  if (value === null) return null;
  return requireText(value, "task_project_invalid");
};

const destinationFor = (value) => {
  if (!isRecord(value)) planningFailure("destination_invalid");

  return {
    workspace: requireText(value.workspace, "destination_invalid"),
    projectId: requireUuid(value.projectId, "destination_invalid"),
    projectKey: requireText(value.projectKey, "destination_invalid"),
    projectName: requireText(value.projectName, "destination_invalid"),
    backlogStateId: requireUuid(value.backlogStateId, "destination_invalid"),
    doneStateId: requireUuid(value.doneStateId, "destination_invalid"),
  };
};

const decisionFor = (value) => {
  if (!isRecord(value)) planningFailure("decision_invalid");

  const taskwarriorProject = taskwarriorProjectFor(value.taskwarriorProject);
  if (value.action !== "migrate" && value.action !== "skip") planningFailure("decision_action_invalid");
  if (!Array.isArray(value.taskUuids) || value.taskUuids.length === 0) {
    planningFailure("decision_tasks_invalid");
  }

  const taskUuids = value.taskUuids.map((taskUuid) => requireUuid(taskUuid, "decision_tasks_invalid"));
  if (new Set(taskUuids).size !== taskUuids.length) planningFailure("decision_tasks_duplicate");

  if (value.action === "skip") {
    return { taskwarriorProject, action: value.action, taskUuids };
  }

  return {
    taskwarriorProject,
    action: value.action,
    taskUuids,
    historyPolicy: historyPolicyFor(value.historyPolicy),
    destination: destinationFor(value.destination),
  };
};

const treatmentFor = (historyPolicy) => historyPolicy === HISTORY_POLICIES.pendingOnly
  ? "Migrate pending only"
  : "Migrate pending and completed history";

const projectMappingFor = ({ taskwarriorProject, tasks, destination, historyPolicy }) => {
  const counts = taskCounts(tasks);
  return {
    taskwarriorProject,
    ...counts,
    migrate: true,
    workspace: destination.workspace,
    projectName: destination.projectName,
    projectKey: destination.projectKey,
    treatment: treatmentFor(historyPolicy),
    notes: null,
  };
};

const policyTasksFor = ({ taskUuids, tasks, historyPolicy }) => {
  const selectedUuids = new Set(taskUuids);
  const selectedTasks = tasks.filter((task) => selectedUuids.has(task.uuid));
  return historyPolicy === HISTORY_POLICIES.pendingOnly
    ? selectedTasks.filter((task) => task.status === "pending")
    : selectedTasks;
};

const stateOrder = (left, right) => {
  const leftSequence = left.sequence ?? Number.MAX_SAFE_INTEGER;
  const rightSequence = right.sequence ?? Number.MAX_SAFE_INTEGER;
  if (leftSequence !== rightSequence) return leftSequence - rightSequence;
  return left.id.localeCompare(right.id);
};

const compatibilityFailure = (reason) => ({ compatible: false, reason });

const readinessCapability = (capability, status, extra = {}) => ({ capability, status, ...extra });

const readinessDiscoveryFor = (discovered, projectId) => {
  if (!Array.isArray(discovered)) return null;

  return discovered.find((entry) =>
    isRecord(entry)
    && isRecord(entry.project)
    && typeof entry.project.id === "string"
    && entry.project.id.toLowerCase() === projectId) ?? null;
};

const stateCapabilityFor = (discovery) => {
  if (!isRecord(discovery) || !isRecord(discovery.compatibility)) {
    return readinessCapability("project_states", "BLOCKED", { reason: "DISCOVERY_EVIDENCE_INVALID" });
  }

  if (discovery.compatibility.compatible !== true) {
    const reason = typeof discovery.compatibility.reason === "string"
      ? discovery.compatibility.reason
      : "DESTINATION_INCOMPATIBLE";
    return readinessCapability("project_states", "BLOCKED", { reason });
  }

  return readinessCapability("project_states", "READY");
};

const identityCapabilityFor = (discovery) => {
  if (!isRecord(discovery) || !isRecord(discovery.identityLookup)) {
    return readinessCapability("external_identity_lookup", "BLOCKED", { reason: "DISCOVERY_EVIDENCE_INVALID" });
  }

  if (discovery.identityLookup.status !== "ready") {
    return readinessCapability("external_identity_lookup", "BLOCKED", { reason: "IDENTITY_DISCOVERY_FAILED" });
  }

  const itemCount = discovery.identityLookup.itemCount;
  if (!Number.isSafeInteger(itemCount) || itemCount < 0) {
    return readinessCapability("external_identity_lookup", "BLOCKED", { reason: "DISCOVERY_EVIDENCE_INVALID" });
  }

  return readinessCapability("external_identity_lookup", "READY", { identityMatchCount: itemCount });
};

export const analyzeTaskwarriorInventory = (tasks) => {
  const normalized = normalizedTasks(tasks);
  const byProject = new Map();

  for (const task of normalized) {
    const projectTasks = byProject.get(projectKeyFor(task.project)) ?? [];
    byProject.set(projectKeyFor(task.project), [...projectTasks, task]);
  }

  const projects = sortBy([...byProject.values()].map((projectTasks) => {
    const counts = taskCounts(projectTasks);
    const eligibleTasks = projectTasks.filter((task) => task.status !== "deleted");
    return {
      taskwarriorProject: projectTasks[0]?.project ?? null,
      ...counts,
      eligibleTaskUuids: eligibleTasks.map((task) => task.uuid),
    };
  }), (project) => projectKeyFor(project.taskwarriorProject));

  const eligibleTasks = normalized.filter((task) => task.status !== "deleted");
  return {
    projects,
    eligibleTasks,
    deletedCount: normalized.length - eligibleTasks.length,
  };
};

export const indexExistingIdentities = (observedItemsByProject) => {
  if (!Array.isArray(observedItemsByProject)) planningFailure("observed_items_invalid");

  const occurrencesByTaskUuid = new Map();
  for (const observedProject of observedItemsByProject) {
    if (!isRecord(observedProject) || !isRecord(observedProject.project) || !Array.isArray(observedProject.items)) {
      planningFailure("observed_items_invalid");
    }

    const projectId = requireUuid(observedProject.project.id, "observed_items_invalid");
    for (const item of observedProject.items) {
      if (!isRecord(item)) planningFailure("observed_item_invalid");
      const taskUuid = requireUuid(item.externalId, "observed_item_invalid");
      const itemId = requireUuid(item.id, "observed_item_invalid");
      if (typeof item.description !== "string" || item.externalSource !== TASKWARRIOR_EXTERNAL_SOURCE) {
        planningFailure("observed_item_invalid");
      }
      if (item.projectId !== undefined && requireUuid(item.projectId, "observed_item_invalid") !== projectId) {
        planningFailure("observed_item_invalid");
      }

      const occurrences = occurrencesByTaskUuid.get(taskUuid) ?? [];
      occurrencesByTaskUuid.set(taskUuid, [...occurrences, {
        projectId,
        itemId,
        description: item.description,
      }]);
    }
  }

  const existingByTaskUuid = {};
  const backfillByTaskUuid = {};
  const ambiguous = [];
  for (const [taskUuid, occurrences] of sortBy([...occurrencesByTaskUuid.entries()], ([uuid]) => uuid)) {
    if (occurrences.length === 1) {
      const [{ projectId, itemId, description }] = occurrences;
      if (isBlankDescription(description)) {
        backfillByTaskUuid[taskUuid] = { projectId, itemId };
      } else {
        existingByTaskUuid[taskUuid] = { projectId, itemId };
      }
      continue;
    }

    ambiguous.push({
      taskUuid,
      projectIds: sortBy([...new Set(occurrences.map(({ projectId }) => projectId))], (projectId) => projectId),
      itemIds: sortBy([...new Set(occurrences.map(({ itemId }) => itemId))], (itemId) => itemId),
    });
  }

  return { existingByTaskUuid, backfillByTaskUuid, ambiguous };
};

export const projectsNeedingDecisions = ({
  inventory,
  existingByTaskUuid,
  backfillByTaskUuid = {},
  historyPolicyDefault,
}) => {
  if (!isRecord(inventory) || !Array.isArray(inventory.projects) || !Array.isArray(inventory.eligibleTasks)) {
    planningFailure("inventory_invalid");
  }
  if (!isRecord(existingByTaskUuid) || !isRecord(backfillByTaskUuid)) {
    planningFailure("identity_index_invalid");
  }
  const defaultHistoryPolicy = historyPolicyFor(historyPolicyDefault);

  return inventory.projects.flatMap((project) => {
    const taskwarriorProject = taskwarriorProjectFor(project.taskwarriorProject);
    const projectTasks = inventory.eligibleTasks.filter((task) =>
      sameProject(task.project, taskwarriorProject));
    const insertTasks = projectTasks.filter((task) =>
      !Object.hasOwn(existingByTaskUuid, task.uuid) && !Object.hasOwn(backfillByTaskUuid, task.uuid));
    const updateTasks = projectTasks.filter((task) => Object.hasOwn(backfillByTaskUuid, task.uuid));
    if (insertTasks.length === 0 && updateTasks.length === 0) return [];

    return [{
      taskwarriorProject,
      sourceCounts: {
        total: project.total,
        pending: project.pending,
        completed: project.completed,
        deleted: project.deleted,
      },
      insertTaskUuids: insertTasks.map((task) => task.uuid),
      updateTaskUuids: updateTasks.map((task) => task.uuid),
      insertPending: insertTasks.filter((task) => task.status === "pending").length,
      insertCompleted: insertTasks.filter((task) => task.status === "completed").length,
      updatePending: updateTasks.filter((task) => task.status === "pending").length,
      updateCompleted: updateTasks.filter((task) => task.status === "completed").length,
      historyPolicyDefault: defaultHistoryPolicy,
    }];
  });
};

export const destinationCompatibility = ({ project, states }) => {
  if (!isRecord(project) || !isUuid(project.id)) return compatibilityFailure("PROJECT_INVALID");
  if (!Array.isArray(states)) return compatibilityFailure("STATE_LIST_INVALID");

  const normalizedStates = [];
  for (const state of states) {
    if (!isRecord(state) || !isUuid(state.id) || (state.group !== null && typeof state.group !== "string")) {
      return compatibilityFailure("STATE_LIST_INVALID");
    }
    if (state.sequence !== null && state.sequence !== undefined && !Number.isSafeInteger(state.sequence)) {
      return compatibilityFailure("STATE_LIST_INVALID");
    }
    normalizedStates.push({
      id: state.id.toLowerCase(),
      group: state.group,
      sequence: state.sequence ?? null,
    });
  }

  const backlogState = normalizedStates.filter((state) => state.group === "backlog").sort(stateOrder)[0];
  if (!backlogState) return compatibilityFailure("BACKLOG_STATE_MISSING");

  const completedState = normalizedStates.filter((state) => state.group === "completed").sort(stateOrder)[0];
  if (!completedState) return compatibilityFailure("COMPLETED_STATE_MISSING");

  return {
    compatible: true,
    backlogStateId: backlogState.id,
    doneStateId: completedState.id,
  };
};

export const decisionsToPlanInputs = ({ decisions, tasks }) => {
  if (!Array.isArray(decisions)) planningFailure("decisions_invalid");

  const eligibleTasks = normalizedTasks(tasks).filter((task) => task.status !== "deleted");
  const taskByUuid = new Map(eligibleTasks.map((task) => [task.uuid, task]));
  const decisionProjects = new Set();
  const selectedTaskUuids = new Set();
  const selectedTasks = [];
  const projectMappings = [];
  const destinations = {};

  const normalizedDecisions = sortBy(
    decisions.map(decisionFor),
    (decision) => projectKeyFor(decision.taskwarriorProject),
  );
  for (const rawDecision of normalizedDecisions) {
    const projectKey = projectKeyFor(rawDecision.taskwarriorProject);
    if (decisionProjects.has(projectKey)) planningFailure("decision_project_duplicate");
    decisionProjects.add(projectKey);

    const decisionTasks = rawDecision.taskUuids.map((taskUuid) => taskByUuid.get(taskUuid));
    if (decisionTasks.some((task) => !task || !sameProject(task.project, rawDecision.taskwarriorProject))) {
      planningFailure("decision_tasks_invalid");
    }
    if (rawDecision.taskUuids.some((taskUuid) => selectedTaskUuids.has(taskUuid))) {
      planningFailure("decision_tasks_duplicate");
    }
    rawDecision.taskUuids.forEach((taskUuid) => selectedTaskUuids.add(taskUuid));

    if (rawDecision.action === "skip") continue;

    const policyTasks = policyTasksFor({
      taskUuids: rawDecision.taskUuids,
      tasks: decisionTasks,
      historyPolicy: rawDecision.historyPolicy,
    });
    if (policyTasks.length === 0) planningFailure("decision_tasks_empty");

    const existingDestination = destinations[rawDecision.destination.projectKey];
    if (
      existingDestination
      && (
        existingDestination.workspace !== rawDecision.destination.workspace
        || existingDestination.projectId !== rawDecision.destination.projectId
        || existingDestination.backlogStateId !== rawDecision.destination.backlogStateId
        || existingDestination.doneStateId !== rawDecision.destination.doneStateId
      )
    ) {
      planningFailure("destination_conflict");
    }

    destinations[rawDecision.destination.projectKey] = {
      workspace: rawDecision.destination.workspace,
      projectId: rawDecision.destination.projectId,
      backlogStateId: rawDecision.destination.backlogStateId,
      doneStateId: rawDecision.destination.doneStateId,
    };
    projectMappings.push(projectMappingFor({
      taskwarriorProject: rawDecision.taskwarriorProject,
      tasks: policyTasks,
      destination: rawDecision.destination,
      historyPolicy: rawDecision.historyPolicy,
    }));
    selectedTasks.push(...policyTasks);
  }

  const includedTaskUuids = new Set(selectedTasks.map((task) => task.uuid));
  const tasksWithSelectedDependencies = selectedTasks.map((task) => ({
    ...task,
    depends: task.depends.filter((dependency) => includedTaskUuids.has(dependency)),
  }));

  return {
    projectMappings: sortBy(projectMappings, (mapping) => projectKeyFor(mapping.taskwarriorProject)),
    destinations: Object.fromEntries(sortBy(Object.entries(destinations), ([projectKey]) => projectKey)),
    tasks: sortBy(tasksWithSelectedDependencies, (task) => task.uuid),
  };
};

const canonicalValue = (value) => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) planningFailure("source_value_invalid");

  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  );
};

const sourceProjectFor = (value) => {
  if (!isRecord(value) || !Object.hasOwn(value, "archivedAt")) {
    planningFailure("source_project_invalid");
  }

  const archivedAt = value.archivedAt === null
    ? null
    : requireText(value.archivedAt, "source_project_invalid");
  return {
    id: requireUuid(value.id, "source_project_invalid"),
    identifier: requireText(value.identifier, "source_project_invalid"),
    name: requireText(value.name, "source_project_invalid"),
    archivedAt,
  };
};

const sourceCompatibilityFor = (value) => {
  if (!isRecord(value) || typeof value.compatible !== "boolean") {
    planningFailure("source_compatibility_invalid");
  }
  if (!value.compatible) {
    return { compatible: false, reason: requireText(value.reason, "source_compatibility_invalid") };
  }

  return {
    compatible: true,
    backlogStateId: requireUuid(value.backlogStateId, "source_compatibility_invalid"),
    doneStateId: requireUuid(value.doneStateId, "source_compatibility_invalid"),
  };
};

const sourceIdentityLookupFor = (value) => {
  if (!isRecord(value)) planningFailure("source_identity_invalid");
  if (value.status === "failed") return { status: "failed" };
  if (value.status !== "ready" || !Number.isSafeInteger(value.itemCount) || value.itemCount < 0) {
    planningFailure("source_identity_invalid");
  }

  return { status: "ready", itemCount: value.itemCount };
};

const sourceStateFor = (value) => {
  if (
    !isRecord(value)
    || !Object.hasOwn(value, "group")
    || !Object.hasOwn(value, "sequence")
    || (value.group !== null && typeof value.group !== "string")
    || (value.sequence !== null && !Number.isSafeInteger(value.sequence))
  ) {
    planningFailure("source_state_invalid");
  }

  return {
    id: requireUuid(value.id, "source_state_invalid"),
    group: value.group,
    sequence: value.sequence,
  };
};

const sourceItemFor = (value, projectId) => {
  if (!isRecord(value) || value.externalSource !== TASKWARRIOR_EXTERNAL_SOURCE) {
    planningFailure("source_item_invalid");
  }

  const item = {
    id: requireUuid(value.id, "source_item_invalid"),
    projectId: requireUuid(value.projectId, "source_item_invalid"),
    externalId: requireUuid(value.externalId, "source_item_invalid"),
    externalSource: value.externalSource,
  };
  if (item.projectId !== projectId) planningFailure("source_item_invalid");
  return item;
};

const sourceDiscoveryFor = (value) => {
  if (!isRecord(value) || !Array.isArray(value.states) || !Array.isArray(value.items)) {
    planningFailure("source_discovery_invalid");
  }

  const project = sourceProjectFor(value.project);
  return {
    project,
    compatibility: sourceCompatibilityFor(value.compatibility),
    identityLookup: sourceIdentityLookupFor(value.identityLookup),
    states: sortBy(value.states.map(sourceStateFor), (state) => state.id),
    items: sortBy(
      value.items.map((item) => sourceItemFor(item, project.id)),
      (item) => `${item.externalId}\u0000${item.id}`,
    ),
  };
};

const canonicalDecisionFor = (value) => {
  const decision = decisionFor(value);
  return {
    ...decision,
    taskUuids: sortBy(decision.taskUuids, (taskUuid) => taskUuid),
  };
};

const sourceTasksFor = (tasks) => {
  if (!Array.isArray(tasks)) planningFailure("tasks_invalid");

  const taskUuids = new Set();
  const sourceTasks = tasks.map((task) => {
    const normalizedTask = normalizeTaskwarriorTask(task);
    if (taskUuids.has(normalizedTask.uuid)) planningFailure("task_uuid_duplicate");
    taskUuids.add(normalizedTask.uuid);
    return { uuid: normalizedTask.uuid, task: canonicalValue(task) };
  });

  return sortBy(sourceTasks, (entry) => entry.uuid).map((entry) => entry.task);
};

export const buildPreparationSource = ({ workspace, decisions, discovered, tasks }) => {
  const normalizedWorkspace = requireText(workspace, "source_workspace_invalid");
  if (!WORKSPACE_PATTERN.test(normalizedWorkspace)) planningFailure("source_workspace_invalid");
  if (!Array.isArray(decisions) || !Array.isArray(discovered)) {
    planningFailure("source_input_invalid");
  }

  return canonicalValue({
    schemaVersion: PREPARATION_SOURCE_SCHEMA_VERSION,
    backfillPlanRequired: true,
    workspace: normalizedWorkspace,
    decisions: sortBy(
      decisions.map(canonicalDecisionFor),
      (decision) => projectKeyFor(decision.taskwarriorProject),
    ),
    discovered: sortBy(
      discovered.map(sourceDiscoveryFor),
      (entry) => `${entry.project.id}\u0000${entry.project.identifier}`,
    ),
    tasks: sourceTasksFor(tasks),
  });
};

export const buildPreparationReadinessReport = ({ decisions, discovered, planSha256 }) => {
  if (!PLAN_HASH_PATTERN.test(planSha256)) planningFailure("plan_hash_invalid");
  if (!Array.isArray(decisions)) planningFailure("decisions_invalid");

  const destinations = new Map();
  for (const decision of decisions.map(decisionFor)) {
    if (decision.action !== "migrate") continue;
    destinations.set(decision.destination.projectId, decision.destination);
  }
  const reports = sortBy([...destinations.values()], (destination) => destination.projectKey).map((destination) => {
    const discovery = readinessDiscoveryFor(discovered, destination.projectId);
    const capabilities = [
      stateCapabilityFor(discovery),
      identityCapabilityFor(discovery),
      readinessCapability("work_item_creation", "UNVERIFIED_WRITE", { reason: WRITE_ONLY_REASON }),
      readinessCapability("work_item_relations", "UNVERIFIED_WRITE", { reason: DEFERRED_RELATIONS_REASON }),
      readinessCapability("relation_creation", "UNVERIFIED_WRITE", { reason: WRITE_ONLY_REASON }),
    ];

    return { projectKey: destination.projectKey, capabilities };
  });

  return {
    schemaVersion: PREPARATION_READINESS_SCHEMA_VERSION,
    planSha256,
    outcome: reports.some((report) => report.capabilities.some((capability) => capability.status === "BLOCKED"))
      ? "BLOCKED"
      : "READY",
    destinations: reports,
  };
};
