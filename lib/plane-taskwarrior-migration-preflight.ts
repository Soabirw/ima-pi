const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_HASH_PATTERN = /^[a-f0-9]{64}$/;
const PREFLIGHT_SCHEMA_VERSION = 1;

const CAPABILITY_STATUS = Object.freeze({
  READY: "READY",
  BLOCKED: "BLOCKED",
  UNVERIFIED_WRITE: "UNVERIFIED_WRITE",
});

const READ_CAPABILITIES = Object.freeze([
  "representative_work_item",
  "project_states",
  "work_item_relations",
  "external_identity_lookup",
]);

const SAFE_READ_FAILURE_CODES = new Set([
  "CONFIG_ERROR",
  "HTTP_ERROR",
  "PAGINATION_ERROR",
  "PROJECT_ERROR",
  "RESPONSE_ERROR",
  "REPRESENTATIVE_INVALID",
  "REPRESENTATIVE_PROJECT_MISMATCH",
  "STATE_LIST_INVALID",
  "BACKLOG_STATE_MISSING",
  "BACKLOG_STATE_AMBIGUOUS",
  "BACKLOG_STATE_GROUP_INVALID",
  "DONE_STATE_MISSING",
  "DONE_STATE_AMBIGUOUS",
  "DONE_STATE_GROUP_INVALID",
  "RELATION_LIST_INVALID",
  "IDENTITY_LOOKUP_INVALID",
  "IDENTITY_AMBIGUOUS",
  "IDENTITY_SAMPLE_INVALID",
]);

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const isUuid = (value) => typeof value === "string" && UUID_PATTERN.test(value);

const isText = (value) => typeof value === "string" && value.trim() !== "" && !/[\r\n]/.test(value);

const boundedIdentityMatchCount = (count) => Math.min(count, 2);

export class MigrationPreflightError extends Error {
  constructor(code) {
    super(code);
    this.name = "MigrationPreflightError";
    this.code = code;
  }
}

export const isMigrationPreflightError = (error) => error instanceof MigrationPreflightError;

const preflightFail = (code) => {
  throw new MigrationPreflightError(code);
};

const capability = ({ capability: name, status, reason, identityMatchCount }) => ({
  capability: name,
  status,
  ...(reason === undefined ? {} : { reason }),
  ...(identityMatchCount === undefined ? {} : { identityMatchCount }),
});

const readyCapability = (name, identityMatchCount) => capability({
  capability: name,
  status: CAPABILITY_STATUS.READY,
  ...(identityMatchCount === undefined ? {} : { identityMatchCount }),
});

const blockedCapability = (name, reason, identityMatchCount) => capability({
  capability: name,
  status: CAPABILITY_STATUS.BLOCKED,
  reason,
  ...(identityMatchCount === undefined ? {} : { identityMatchCount }),
});

const unverifiedWriteCapability = (name) => capability({
  capability: name,
  status: CAPABILITY_STATUS.UNVERIFIED_WRITE,
  reason: "WRITE_ONLY",
});

const writeCapabilities = () => [
  unverifiedWriteCapability("work_item_creation"),
  unverifiedWriteCapability("relation_creation"),
];

const safeReadFailureReason = (error, fallback) => {
  const code = error instanceof MigrationPreflightError
    ? error.code
    : isRecord(error) && typeof error.code === "string"
      ? error.code
      : null;
  return SAFE_READ_FAILURE_CODES.has(code) ? code : fallback;
};

const destinationScope = (destination) => {
  if (!isRecord(destination)
    || !isText(destination.workspace)
    || !isUuid(destination.projectId)
    || !isUuid(destination.backlogStateId)
    || !isUuid(destination.doneStateId)
    || !isText(destination.representativeReference)) {
    preflightFail("DESTINATION_CONFIGURATION_INVALID");
  }

  return {
    workspace: destination.workspace,
    projectId: destination.projectId.toLowerCase(),
    backlogStateId: destination.backlogStateId.toLowerCase(),
    doneStateId: destination.doneStateId.toLowerCase(),
    representativeReference: destination.representativeReference,
  };
};

const validateRepresentativeWorkItem = ({ workItem, projectId }) => {
  if (!isRecord(workItem) || !isUuid(workItem.id) || !isUuid(workItem.projectId)) {
    preflightFail("REPRESENTATIVE_INVALID");
  }
  if (workItem.projectId.toLowerCase() !== projectId) preflightFail("REPRESENTATIVE_PROJECT_MISMATCH");

  return { id: workItem.id.toLowerCase() };
};

const validateConfiguredState = ({ states, stateId, expectedGroup, prefix }) => {
  const matches = states.filter((state) => state.id === stateId);
  if (matches.length === 0) preflightFail(`${prefix}_STATE_MISSING`);
  if (matches.length > 1) preflightFail(`${prefix}_STATE_AMBIGUOUS`);
  if (matches[0].group !== expectedGroup) preflightFail(`${prefix}_STATE_GROUP_INVALID`);
};

const validateProjectStates = ({ states, scope }) => {
  if (!Array.isArray(states) || states.some((state) => !isRecord(state)
    || !isUuid(state.id)
    || typeof state.group !== "string")) {
    preflightFail("STATE_LIST_INVALID");
  }

  const normalizedStates = states.map((state) => ({
    id: state.id.toLowerCase(),
    group: state.group,
  }));
  validateConfiguredState({
    states: normalizedStates,
    stateId: scope.backlogStateId,
    expectedGroup: "backlog",
    prefix: "BACKLOG",
  });
  validateConfiguredState({
    states: normalizedStates,
    stateId: scope.doneStateId,
    expectedGroup: "completed",
    prefix: "DONE",
  });
};

const validateWorkItemRelations = (relations) => {
  if (!isRecord(relations)
    || !Array.isArray(relations.blockedByIds)
    || relations.blockedByIds.some((workItemId) => !isUuid(workItemId))) {
    preflightFail("RELATION_LIST_INVALID");
  }
};

const plannedIdentityForDestination = ({ plan, projectKey, scope }) => {
  if (!isRecord(plan) || !Array.isArray(plan.items)) preflightFail("IDENTITY_SAMPLE_INVALID");

  const candidates = plan.items
    .filter((item) => isRecord(item)
      && item.disposition === "create"
      && isRecord(item.destination)
      && item.destination.projectKey === projectKey)
    .sort((left, right) => String(left.taskUuid).localeCompare(String(right.taskUuid)));
  const item = candidates[0];
  if (!item) return null;

  if (!isRecord(item.destination)
    || !isRecord(item.workItem)
    || item.destination.workspace !== scope.workspace
    || item.destination.projectId !== scope.projectId
    || !isUuid(item.workItem.externalId)
    || !isText(item.workItem.externalSource)) {
    preflightFail("IDENTITY_SAMPLE_INVALID");
  }

  return {
    externalId: item.workItem.externalId.toLowerCase(),
    externalSource: item.workItem.externalSource,
  };
};

export const exactIdentityMatches = ({ workItems, item }) => {
  if (!Array.isArray(workItems) || !isRecord(item) || !isRecord(item.workItem)) {
    preflightFail("IDENTITY_LOOKUP_INVALID");
  }
  if (!isUuid(item.workItem.externalId) || !isText(item.workItem.externalSource)) {
    preflightFail("IDENTITY_LOOKUP_INVALID");
  }
  if (workItems.some((workItem) => !isRecord(workItem)
    || !isUuid(workItem.id)
    || !isText(workItem.externalId)
    || !isText(workItem.externalSource))) {
    preflightFail("IDENTITY_LOOKUP_INVALID");
  }

  return workItems.filter((workItem) =>
    workItem.externalId.toLowerCase() === item.workItem.externalId.toLowerCase()
    && workItem.externalSource === item.workItem.externalSource);
};

export const oneIdentityMatch = ({ workItems, item }) => {
  const matches = exactIdentityMatches({ workItems, item });
  if (matches.length > 1) preflightFail("IDENTITY_AMBIGUOUS");
  return matches[0] ?? null;
};

const readCapability = async ({
  client,
  method,
  input,
  name,
  fallbackReason,
  validate,
}) => {
  try {
    if (!isRecord(client) || typeof client[method] !== "function") {
      return { capability: blockedCapability(name, "READ_CLIENT_UNAVAILABLE"), value: null };
    }

    const value = await client[method](input);
    return { capability: readyCapability(name), value: validate(value) };
  } catch (error) {
    return {
      capability: blockedCapability(name, safeReadFailureReason(error, fallbackReason)),
      value: null,
    };
  }
};

const identityLookupCapability = async ({ client, scope, identity }) => {
  try {
    if (!isRecord(client) || typeof client.listProjectWorkItems !== "function") {
      return blockedCapability("external_identity_lookup", "READ_CLIENT_UNAVAILABLE");
    }

    const workItems = await client.listProjectWorkItems({
      workspace: scope.workspace,
      projectId: scope.projectId,
      externalId: identity.externalId,
      externalSource: identity.externalSource,
    });
    const matches = exactIdentityMatches({
      workItems,
      item: { workItem: identity },
    });
    const identityMatchCount = boundedIdentityMatchCount(matches.length);
    if (matches.length > 1) {
      return blockedCapability("external_identity_lookup", "IDENTITY_AMBIGUOUS", identityMatchCount);
    }
    return readyCapability("external_identity_lookup", identityMatchCount);
  } catch (error) {
    return blockedCapability(
      "external_identity_lookup",
      safeReadFailureReason(error, "IDENTITY_LOOKUP_FAILED"),
    );
  }
};

const blockedDestinationReport = ({ projectKey, reason }) => ({
  projectKey,
  capabilities: [
    ...READ_CAPABILITIES.map((name) => blockedCapability(name, reason)),
    ...writeCapabilities(),
  ],
});

const preflightDestination = async ({ client, plan, projectKey, destination }) => {
  let scope;
  try {
    scope = destinationScope(destination);
  } catch (error) {
    return blockedDestinationReport({
      projectKey,
      reason: safeReadFailureReason(error, "DESTINATION_CONFIGURATION_INVALID"),
    });
  }

  const representative = await readCapability({
    client,
    method: "getWorkItem",
    input: scope.representativeReference,
    name: "representative_work_item",
    fallbackReason: "REPRESENTATIVE_READ_FAILED",
    validate: (workItem) => validateRepresentativeWorkItem({ workItem, projectId: scope.projectId }),
  });
  const states = await readCapability({
    client,
    method: "listProjectStates",
    input: { workspace: scope.workspace, projectId: scope.projectId },
    name: "project_states",
    fallbackReason: "STATE_READ_FAILED",
    validate: (value) => validateProjectStates({ states: value, scope }),
  });
  const relations = representative.value === null
    ? { capability: blockedCapability("work_item_relations", "REPRESENTATIVE_UNAVAILABLE"), value: null }
    : await readCapability({
      client,
      method: "listWorkItemRelations",
      input: {
        workspace: scope.workspace,
        projectId: scope.projectId,
        workItemId: representative.value.id,
      },
      name: "work_item_relations",
      fallbackReason: "RELATION_READ_FAILED",
      validate: validateWorkItemRelations,
    });

  let identity;
  let identityReason;
  try {
    identity = plannedIdentityForDestination({ plan, projectKey, scope });
  } catch (error) {
    identity = null;
    identityReason = safeReadFailureReason(error, "IDENTITY_SAMPLE_INVALID");
  }
  const identityCapability = identityReason
    ? blockedCapability("external_identity_lookup", identityReason)
    : identity === null
      ? blockedCapability("external_identity_lookup", "IDENTITY_SAMPLE_MISSING")
      : await identityLookupCapability({ client, scope, identity });

  return {
    projectKey,
    capabilities: [
      representative.capability,
      states.capability,
      relations.capability,
      identityCapability,
      ...writeCapabilities(),
    ],
  };
};

const preflightOutcome = (destinations) => destinations.some((destination) =>
  destination.capabilities.some(({ status }) => status === CAPABILITY_STATUS.BLOCKED))
  ? CAPABILITY_STATUS.BLOCKED
  : CAPABILITY_STATUS.READY;

const planHashForReport = (plan) =>
  isRecord(plan) && typeof plan.planSha256 === "string" && PLAN_HASH_PATTERN.test(plan.planSha256)
    ? plan.planSha256
    : "UNKNOWN";

const destinationEntries = (destinations) => {
  if (!isRecord(destinations)) return [];
  return Object.entries(destinations)
    .filter(([projectKey]) => /^[A-Z][A-Z0-9_]*$/.test(projectKey))
    .sort(([left], [right]) => left.localeCompare(right));
};

const buildReport = ({ plan, destinations }) => ({
  schemaVersion: PREFLIGHT_SCHEMA_VERSION,
  planSha256: planHashForReport(plan),
  outcome: preflightOutcome(destinations),
  destinations,
});

export const incompletePreflightReport = ({ plan, destinations, reason = "PREFLIGHT_INCOMPLETE" }) => {
  const entries = destinationEntries(destinations);
  const reports = entries.length === 0
    ? [blockedDestinationReport({ projectKey: "UNAVAILABLE", reason })]
    : entries.map(([projectKey]) => blockedDestinationReport({ projectKey, reason }));
  return buildReport({ plan, destinations: reports });
};

export const runMigrationPreflight = async ({ client, plan, destinations }) => {
  const entries = destinationEntries(destinations);
  if (entries.length === 0) return incompletePreflightReport({ plan, destinations });

  const reports = [];
  for (const [projectKey, destination] of entries) {
    try {
      reports.push(await preflightDestination({ client, plan, projectKey, destination }));
    } catch {
      reports.push(blockedDestinationReport({ projectKey, reason: "PREFLIGHT_INCOMPLETE" }));
    }
  }
  return buildReport({ plan, destinations: reports });
};
