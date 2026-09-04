import {
  isMigrationPreflightError,
  oneIdentityMatch,
} from "./plane-taskwarrior-migration-preflight.ts";
import { isBlankDescription } from "./plane-taskwarrior-description-backfill.ts";
import { TASKWARRIOR_EXTERNAL_SOURCE } from "./plane-taskwarrior-migration.ts";

const CHECKPOINT_SCHEMA_VERSION = 2;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEM_OUTCOMES = new Set(["created", "reused"]);
const BACKFILL_OUTCOMES = new Set(["updated", "skipped"]);
const RELATION_OUTCOMES = new Set(["created", "reused", "unresolved"]);

export type MigrationProgressEvent = {
  phase:
    | "waiting-for-lock"
    | "revalidating-run"
    | "checking-readiness"
    | "readiness-persisted"
    | "checkpoint-loaded"
    | "reconciliation-invalidated"
    | "applying-items"
    | "applying-relations"
    | "applying-backfills"
    | "application-checkpoints-complete"
    | "reconciliation-checkpoint-loaded"
    | "reconciling-items"
    | "reconciling-relations"
    | "building-reconciliation"
    | "reconciliation-persisted";
  completed?: number;
  total?: number;
  projectKey?: string;
  readinessStep?: "project-states" | "external-identities";
  readinessCompleted?: number;
  readinessTotal?: number;
  outcome?: "READY" | "BLOCKED" | "created" | "reused" | "updated" | "skipped" | "unresolved";
};

export type MigrationProgress = (event: MigrationProgressEvent) => void | Promise<void>;

export const reportMigrationProgress = (onProgress: MigrationProgress | undefined, event: MigrationProgressEvent) => {
  try {
    const completion = onProgress?.(event);
    if (completion !== undefined) void Promise.resolve(completion).catch(() => {});
  } catch {
    // Progress reporting is observational and must not affect migration safety.
  }
};

export class MigrationExecutionError extends Error {
  constructor(code) {
    super(code);
    this.name = "MigrationExecutionError";
    this.code = code;
  }
}

export const isMigrationExecutionError = (error) => error instanceof MigrationExecutionError;

const executionFailure = (code) => {
  throw new MigrationExecutionError(code);
};

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const isUuid = (value) => typeof value === "string" && UUID_PATTERN.test(value);

const relationKeyFor = (relation) => `${relation.sourceTaskUuid}:${relation.targetTaskUuid}`;

const createItemsFor = (plan) => {
  if (!isRecord(plan) || !Array.isArray(plan.items)) executionFailure("PLAN_INVALID");
  return plan.items.filter((item) => isRecord(item) && item.disposition === "create");
};

const eligibleRelationsFor = (plan) => {
  if (!isRecord(plan) || !Array.isArray(plan.eligibleRelations)) executionFailure("PLAN_INVALID");
  return plan.eligibleRelations;
};

const backfillUpdatesFor = (plan, backfillPlan) => {
  if (backfillPlan === null || backfillPlan === undefined) return [];
  if (
    !isRecord(backfillPlan)
    || backfillPlan.schemaVersion !== 1
    || backfillPlan.planSha256 !== plan.planSha256
    || !Array.isArray(backfillPlan.updates)
  ) {
    executionFailure("BACKFILL_PLAN_INVALID");
  }

  const taskUuids = new Set();
  return backfillPlan.updates.map((update) => {
    if (
      !isRecord(update)
      || !isUuid(update.taskUuid)
      || typeof update.workspace !== "string"
      || update.workspace.trim() === ""
      || /[\r\n]/.test(update.workspace)
      || !isUuid(update.projectId)
      || !isUuid(update.itemId)
      || isBlankDescription(update.descriptionStripped)
      || taskUuids.has(update.taskUuid)
    ) {
      executionFailure("BACKFILL_PLAN_INVALID");
    }
    taskUuids.add(update.taskUuid);
    return update;
  });
};

export const initialMigrationCheckpoint = (plan) => ({
  schemaVersion: CHECKPOINT_SCHEMA_VERSION,
  planSha256: plan.planSha256,
  planeItemIdsByTaskUuid: {},
  itemOutcomesByTaskUuid: {},
  backfillOutcomesByTaskUuid: {},
  relationOutcomesByKey: {},
  unresolvedRelationAttempts: [],
});

export const normalizeMigrationCheckpoint = (value, plan, backfillPlan = null) => {
  if (value === null || value === undefined) return initialMigrationCheckpoint(plan);
  if (
    !isRecord(value)
    || (value.schemaVersion !== 1 && value.schemaVersion !== CHECKPOINT_SCHEMA_VERSION)
    || value.planSha256 !== plan.planSha256
  ) {
    executionFailure("CHECKPOINT_INVALID");
  }

  const checkpoint = value.schemaVersion === 1
    ? { ...value, schemaVersion: CHECKPOINT_SCHEMA_VERSION, backfillOutcomesByTaskUuid: {} }
    : value;
  const requiredObjects = [
    checkpoint.planeItemIdsByTaskUuid,
    checkpoint.itemOutcomesByTaskUuid,
    checkpoint.backfillOutcomesByTaskUuid,
    checkpoint.relationOutcomesByKey,
  ];
  if (!requiredObjects.every(isRecord) || !Array.isArray(checkpoint.unresolvedRelationAttempts)) {
    executionFailure("CHECKPOINT_INVALID");
  }

  const plannedItemIds = new Set(createItemsFor(plan).map((item) => item.taskUuid));
  const plannedBackfillTaskUuids = new Set(backfillUpdatesFor(plan, backfillPlan).map((update) => update.taskUuid));
  const plannedRelationKeys = new Set(eligibleRelationsFor(plan).map(relationKeyFor));
  const validItemIds = Object.entries(checkpoint.planeItemIdsByTaskUuid).every(([taskUuid, planeItemId]) =>
    plannedItemIds.has(taskUuid) && isUuid(planeItemId));
  const validItemOutcomes = Object.entries(checkpoint.itemOutcomesByTaskUuid).every(([taskUuid, outcome]) =>
    plannedItemIds.has(taskUuid) && ITEM_OUTCOMES.has(outcome));
  const validBackfillOutcomes = Object.entries(checkpoint.backfillOutcomesByTaskUuid).every(([taskUuid, outcome]) =>
    plannedBackfillTaskUuids.has(taskUuid) && BACKFILL_OUTCOMES.has(outcome));
  const validRelationOutcomes = Object.entries(checkpoint.relationOutcomesByKey).every(([key, outcome]) =>
    plannedRelationKeys.has(key) && RELATION_OUTCOMES.has(outcome));
  const validUnresolvedAttempts = checkpoint.unresolvedRelationAttempts.every((attempt) =>
    isRecord(attempt)
    && plannedRelationKeys.has(`${attempt.sourceTaskUuid}:${attempt.targetTaskUuid}`)
    && typeof attempt.reason === "string"
    && /^[A-Z0-9_:-]+$/.test(attempt.reason));
  if (
    !validItemIds
    || !validItemOutcomes
    || !validBackfillOutcomes
    || !validRelationOutcomes
    || !validUnresolvedAttempts
  ) {
    executionFailure("CHECKPOINT_INVALID");
  }

  return checkpoint;
};

export const checkpointWithMigrationItem = ({ checkpoint, taskUuid, planeItemId, outcome }) => ({
  ...checkpoint,
  planeItemIdsByTaskUuid: {
    ...checkpoint.planeItemIdsByTaskUuid,
    [taskUuid]: planeItemId,
  },
  itemOutcomesByTaskUuid: {
    ...checkpoint.itemOutcomesByTaskUuid,
    [taskUuid]: outcome,
  },
});

export const checkpointWithMigrationBackfill = ({ checkpoint, taskUuid, outcome }) => ({
  ...checkpoint,
  backfillOutcomesByTaskUuid: {
    ...checkpoint.backfillOutcomesByTaskUuid,
    [taskUuid]: outcome,
  },
});

export const checkpointWithMigrationRelation = ({ checkpoint, relation, outcome, reason = null }) => {
  const relationKey = relationKeyFor(relation);
  const unresolvedRelationAttempts = reason === null
    ? checkpoint.unresolvedRelationAttempts
    : [...checkpoint.unresolvedRelationAttempts, {
      sourceTaskUuid: relation.sourceTaskUuid,
      targetTaskUuid: relation.targetTaskUuid,
      reason,
    }];

  return {
    ...checkpoint,
    relationOutcomesByKey: {
      ...checkpoint.relationOutcomesByKey,
      [relationKey]: outcome,
    },
    unresolvedRelationAttempts,
  };
};

export const isMigrationCheckpointComplete = ({ plan, backfillPlan = null, checkpoint }) => {
  const normalized = normalizeMigrationCheckpoint(checkpoint, plan, backfillPlan);
  const itemsComplete = createItemsFor(plan).every((item) =>
    isUuid(normalized.planeItemIdsByTaskUuid[item.taskUuid])
    && ITEM_OUTCOMES.has(normalized.itemOutcomesByTaskUuid[item.taskUuid]));
  const backfillsComplete = backfillUpdatesFor(plan, backfillPlan).every((update) =>
    BACKFILL_OUTCOMES.has(normalized.backfillOutcomesByTaskUuid[update.taskUuid]));
  const relationsComplete = eligibleRelationsFor(plan).every((relation) =>
    ITEM_OUTCOMES.has(normalized.relationOutcomesByKey[relationKeyFor(relation)]));
  return itemsComplete && backfillsComplete && relationsComplete;
};

export const migrationCheckpointSummary = ({ checkpoint, plan, backfillPlan = null }) => {
  const normalized = normalizeMigrationCheckpoint(checkpoint, plan, backfillPlan);
  const itemOutcomes = Object.values(normalized.itemOutcomesByTaskUuid);
  const backfillOutcomes = Object.values(normalized.backfillOutcomesByTaskUuid);
  const relationOutcomes = Object.values(normalized.relationOutcomesByKey);

  return {
    createdItems: itemOutcomes.filter((outcome) => outcome === "created").length,
    reusedItems: itemOutcomes.filter((outcome) => outcome === "reused").length,
    updatedItems: backfillOutcomes.filter((outcome) => outcome === "updated").length,
    skippedBackfills: backfillOutcomes.filter((outcome) => outcome === "skipped").length,
    createdRelations: relationOutcomes.filter((outcome) => outcome === "created").length,
    reusedRelations: relationOutcomes.filter((outcome) => outcome === "reused").length,
    unresolvedRelations: relationOutcomes.filter((outcome) => outcome === "unresolved").length,
    skippedRelations: Array.isArray(plan.skippedRelations) ? plan.skippedRelations.length : 0,
  };
};

const errorCodeFor = (error, toErrorCode) => {
  if (isMigrationExecutionError(error) || isMigrationPreflightError(error)) return error.code;
  const code = typeof toErrorCode === "function" ? toErrorCode(error) : null;
  return typeof code === "string" && /^[A-Z0-9_:-]+$/.test(code) ? code : "PLANE_ERROR";
};

const resolveMigrationItem = async ({ client, item, checkpoint }) => {
  if (!isRecord(client) || typeof client.listProjectWorkItems !== "function"
    || typeof client.createProjectWorkItem !== "function") {
    executionFailure("CLIENT_UNAVAILABLE");
  }

  const workItems = await client.listProjectWorkItems({
    workspace: item.destination.workspace,
    projectId: item.destination.projectId,
    externalId: item.workItem.externalId,
    externalSource: item.workItem.externalSource,
  });
  const existing = oneIdentityMatch({ workItems, item });
  const checkpointId = checkpoint.planeItemIdsByTaskUuid[item.taskUuid];

  if (checkpointId && (!existing || existing.id !== checkpointId)) executionFailure("CHECKPOINT_MISMATCH");
  if (existing) return { planeItemId: existing.id, outcome: "reused" };
  if (checkpointId) executionFailure("CHECKPOINT_MISSING");

  const created = await client.createProjectWorkItem({
    workspace: item.destination.workspace,
    projectId: item.destination.projectId,
    input: item.workItem,
  });
  if (!isRecord(created) || !isUuid(created.id)) executionFailure("ITEM_CREATE_RESPONSE_INVALID");
  return { planeItemId: created.id, outcome: "created" };
};

const applyMigrationItems = async ({ client, plan, checkpoint, artifactApi, run, toErrorCode, onProgress }) => {
  const items = createItemsFor(plan);
  reportMigrationProgress(onProgress, {
    phase: "applying-items",
    completed: 0,
    total: items.length,
  });

  let currentCheckpoint = checkpoint;
  for (const [index, item] of items.entries()) {
    let resolved;
    try {
      resolved = await resolveMigrationItem({ client, item, checkpoint: currentCheckpoint });
    } catch (error) {
      if (isMigrationExecutionError(error) || isMigrationPreflightError(error)) throw error;
      executionFailure(`ITEM_CREATE_${errorCodeFor(error, toErrorCode)}`);
    }

    currentCheckpoint = checkpointWithMigrationItem({
      checkpoint: currentCheckpoint,
      taskUuid: item.taskUuid,
      planeItemId: resolved.planeItemId,
      outcome: resolved.outcome,
    });
    await artifactApi.writeCheckpoint({ run, value: currentCheckpoint });
    reportMigrationProgress(onProgress, {
      phase: "applying-items",
      completed: index + 1,
      total: items.length,
      outcome: resolved.outcome,
    });
  }
  return currentCheckpoint;
};

const blockedByIdsFrom = (value) => {
  if (!isRecord(value) || !Array.isArray(value.blockedByIds) || value.blockedByIds.some((id) => !isUuid(id))) {
    executionFailure("RELATION_LOOKUP_INVALID");
  }
  return value.blockedByIds;
};

const applyMigrationRelations = async ({ client, plan, checkpoint, artifactApi, run, toErrorCode, onProgress }) => {
  if (!isRecord(client) || typeof client.listWorkItemRelations !== "function"
    || typeof client.createWorkItemRelation !== "function") {
    executionFailure("CLIENT_UNAVAILABLE");
  }

  const relations = eligibleRelationsFor(plan);
  reportMigrationProgress(onProgress, {
    phase: "applying-relations",
    completed: 0,
    total: relations.length,
  });

  let currentCheckpoint = checkpoint;
  for (const [index, relation] of relations.entries()) {
    const sourcePlaneItemId = currentCheckpoint.planeItemIdsByTaskUuid[relation.sourceTaskUuid];
    const targetPlaneItemId = currentCheckpoint.planeItemIdsByTaskUuid[relation.targetTaskUuid];
    let outcome;

    if (!sourcePlaneItemId || !targetPlaneItemId) {
      outcome = "unresolved";
      currentCheckpoint = checkpointWithMigrationRelation({
        checkpoint: currentCheckpoint,
        relation,
        outcome,
        reason: "MISSING_PLANE_ENDPOINT",
      });
    } else {
      try {
        const existing = await client.listWorkItemRelations({
          workspace: relation.workspace,
          projectId: relation.projectId,
          workItemId: sourcePlaneItemId,
        });
        outcome = blockedByIdsFrom(existing).includes(targetPlaneItemId) ? "reused" : "created";
        if (outcome === "created") {
          await client.createWorkItemRelation({
            workspace: relation.workspace,
            projectId: relation.projectId,
            workItemId: sourcePlaneItemId,
            relation: { relationType: relation.relationType, issueIds: [targetPlaneItemId] },
          });
        }
        currentCheckpoint = checkpointWithMigrationRelation({ checkpoint: currentCheckpoint, relation, outcome });
      } catch (error) {
        outcome = "unresolved";
        currentCheckpoint = checkpointWithMigrationRelation({
          checkpoint: currentCheckpoint,
          relation,
          outcome,
          reason: errorCodeFor(error, toErrorCode),
        });
      }
    }

    await artifactApi.writeCheckpoint({ run, value: currentCheckpoint });
    reportMigrationProgress(onProgress, {
      phase: "applying-relations",
      completed: index + 1,
      total: relations.length,
      outcome,
    });
  }
  return currentCheckpoint;
};

export const applyMigrationBackfills = async ({
  client,
  plan,
  backfillPlan = null,
  checkpoint,
  artifactApi,
  run,
  toErrorCode,
  onProgress,
}) => {
  const updates = backfillUpdatesFor(plan, backfillPlan);
  if (updates.length === 0) return checkpoint;
  if (!isRecord(client) || typeof client.listProjectWorkItems !== "function"
    || typeof client.updateProjectWorkItemDescription !== "function") {
    executionFailure("CLIENT_UNAVAILABLE");
  }

  reportMigrationProgress(onProgress, {
    phase: "applying-backfills",
    completed: 0,
    total: updates.length,
  });

  let currentCheckpoint = checkpoint;
  for (const [index, update] of updates.entries()) {
    let outcome;
    try {
      const workItems = await client.listProjectWorkItems({
        workspace: update.workspace,
        projectId: update.projectId,
        externalId: update.taskUuid,
        externalSource: TASKWARRIOR_EXTERNAL_SOURCE,
      });
      const existing = oneIdentityMatch({
        workItems,
        item: {
          workItem: {
            externalId: update.taskUuid,
            externalSource: TASKWARRIOR_EXTERNAL_SOURCE,
          },
        },
      });
      if (
        !existing
        || existing.id !== update.itemId
        || existing.projectId !== update.projectId
        || typeof existing.description !== "string"
      ) {
        executionFailure("BACKFILL_ITEM_MISSING");
      }

      if (isBlankDescription(existing.description)) {
        await client.updateProjectWorkItemDescription({
          workspace: update.workspace,
          projectId: update.projectId,
          workItemId: update.itemId,
          descriptionStripped: update.descriptionStripped,
        });
        outcome = "updated";
      } else {
        outcome = "skipped";
      }
    } catch (error) {
      if (isMigrationExecutionError(error) || isMigrationPreflightError(error)) throw error;
      executionFailure(`BACKFILL_${errorCodeFor(error, toErrorCode)}`);
    }

    currentCheckpoint = checkpointWithMigrationBackfill({
      checkpoint: currentCheckpoint,
      taskUuid: update.taskUuid,
      outcome,
    });
    await artifactApi.writeCheckpoint({ run, value: currentCheckpoint });
    reportMigrationProgress(onProgress, {
      phase: "applying-backfills",
      completed: index + 1,
      total: updates.length,
      outcome,
    });
  }
  return currentCheckpoint;
};

export const applyMigrationPlan = async ({
  client,
  plan,
  backfillPlan = null,
  checkpoint,
  artifactApi,
  run,
  toErrorCode,
  onProgress,
}) => {
  const itemCheckpoint = await applyMigrationItems({
    client,
    plan,
    checkpoint,
    artifactApi,
    run,
    toErrorCode,
    onProgress,
  });
  const relationCheckpoint = await applyMigrationRelations({
    client,
    plan,
    checkpoint: itemCheckpoint,
    artifactApi,
    run,
    toErrorCode,
    onProgress,
  });
  const backfillCheckpoint = await applyMigrationBackfills({
    client,
    plan,
    backfillPlan,
    checkpoint: relationCheckpoint,
    artifactApi,
    run,
    toErrorCode,
    onProgress,
  });
  reportMigrationProgress(onProgress, { phase: "application-checkpoints-complete" });
  return backfillCheckpoint;
};

export const observeMigrationPlan = async ({ client, plan, onProgress }) => {
  if (!isRecord(client) || typeof client.listProjectWorkItems !== "function"
    || typeof client.listWorkItemRelations !== "function") {
    executionFailure("CLIENT_UNAVAILABLE");
  }

  const items = createItemsFor(plan);
  reportMigrationProgress(onProgress, {
    phase: "reconciling-items",
    completed: 0,
    total: items.length,
  });

  const observedItemsByTaskUuid = {};
  const planeItemIdsByTaskUuid = {};
  for (const [index, item] of items.entries()) {
    const workItems = await client.listProjectWorkItems({
      workspace: item.destination.workspace,
      projectId: item.destination.projectId,
      externalId: item.workItem.externalId,
      externalSource: item.workItem.externalSource,
    });
    const match = oneIdentityMatch({ workItems, item });
    if (match) {
      observedItemsByTaskUuid[item.taskUuid] = match;
      planeItemIdsByTaskUuid[item.taskUuid] = match.id;
    }
    reportMigrationProgress(onProgress, {
      phase: "reconciling-items",
      completed: index + 1,
      total: items.length,
    });
  }

  const relationsBySourceTaskUuid = new Map();
  for (const relation of eligibleRelationsFor(plan)) {
    if (!relationsBySourceTaskUuid.has(relation.sourceTaskUuid)) {
      relationsBySourceTaskUuid.set(relation.sourceTaskUuid, relation);
    }
  }
  const relationSources = [...relationsBySourceTaskUuid.entries()];
  reportMigrationProgress(onProgress, {
    phase: "reconciling-relations",
    completed: 0,
    total: relationSources.length,
  });

  const observedRelationsByTaskUuid = {};
  for (const [index, [sourceTaskUuid, relation]] of relationSources.entries()) {
    const sourcePlaneItemId = planeItemIdsByTaskUuid[sourceTaskUuid];
    if (sourcePlaneItemId) {
      observedRelationsByTaskUuid[sourceTaskUuid] = await client.listWorkItemRelations({
        workspace: relation.workspace,
        projectId: relation.projectId,
        workItemId: sourcePlaneItemId,
      });
    }
    reportMigrationProgress(onProgress, {
      phase: "reconciling-relations",
      completed: index + 1,
      total: relationSources.length,
    });
  }

  return {
    observedItemsByTaskUuid,
    planeItemIdsByTaskUuid,
    observedRelationsByTaskUuid,
  };
};
