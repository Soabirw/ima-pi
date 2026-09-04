const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const PROJECT_IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const REFERENCE_PATTERN = /^plane:([A-Za-z0-9][A-Za-z0-9._~-]*):([A-Z][A-Z0-9_]*)-([1-9]\d*)$/;
const LOOPBACK_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const WORK_ITEM_PRIORITIES = new Set(["high", "medium", "low", "none"]);
const RELATION_TYPES = new Set(["blocked_by"]);
const CREATE_WORK_ITEM_KEYS = new Set([
  "name",
  "descriptionStripped",
  "priority",
  "stateId",
  "externalId",
  "externalSource",
]);
const RELATION_KEYS = new Set(["relationType", "issueIds"]);
const RELATION_TARGET_KEYS = new Set(["issue_id", "project_id"]);

export class PlaneApiError extends Error {
  constructor(code, status = null) {
    super(code);
    this.name = "PlaneApiError";
    this.code = code;
    this.status = status;
  }
}

export const fail = (code) => {
  throw new PlaneApiError(code);
};

export const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export const requireRecord = (value, code = "RESPONSE_ERROR") => {
  if (!isRecord(value)) fail(code);
  return value;
};

export const normalizeUuid = (value, code = "RESPONSE_ERROR") => {
  const candidate = typeof value === "string" ? value : isRecord(value) ? value.id : null;
  if (typeof candidate !== "string" || !UUID_PATTERN.test(candidate)) fail(code);
  return candidate.toLowerCase();
};

export const optionalUuid = (value) => {
  if (value === null || value === undefined) return null;
  return normalizeUuid(value);
};

export const requireText = (value, code = "RESPONSE_ERROR") => {
  if (typeof value !== "string" || value.trim() === "") fail(code);
  return value;
};

export const optionalText = (value, code = "RESPONSE_ERROR") => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") fail(code);
  return value;
};

export const normalizeIdList = (value, code = "RESPONSE_ERROR") => {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) fail(code);
  return value.map((entry) => normalizeUuid(entry, code));
};

export const normalizePositiveSequenceId = (value, code = "RESPONSE_ERROR") => {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^[1-9]\d*$/.test(text)) fail(code);

  const sequenceId = Number(text);
  if (!Number.isSafeInteger(sequenceId)) fail(code);
  return sequenceId;
};

export const normalizeOptionalSequence = (value) => {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value)) fail("RESPONSE_ERROR");
  return value;
};

const requireExactKeys = (value, allowedKeys, code) => {
  const record = requireRecord(value, code);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) fail(code);
  return record;
};

export const normalizeWorkspace = (value, code = "PROJECT_ERROR") => {
  if (typeof value !== "string" || !WORKSPACE_PATTERN.test(value)) fail(code);
  return value;
};

const referenceFrom = (reference) => {
  if (reference === null || reference === undefined) return null;
  if (typeof reference === "string") return parsePlaneReference(reference);
  if (!isRecord(reference) || typeof reference.canonical !== "string") fail("REFERENCE_ERROR");
  return parsePlaneReference(reference.canonical);
};

export const parsePlaneReference = (reference) => {
  if (typeof reference !== "string") fail("REFERENCE_ERROR");

  const match = REFERENCE_PATTERN.exec(reference);
  if (!match || !WORKSPACE_PATTERN.test(match[1]) || !PROJECT_IDENTIFIER_PATTERN.test(match[2])) {
    fail("REFERENCE_ERROR");
  }

  const sequenceId = normalizePositiveSequenceId(match[3], "REFERENCE_ERROR");
  const workspace = match[1];
  const projectIdentifier = match[2];
  const workItemIdentifier = `${projectIdentifier}-${sequenceId}`;

  return {
    canonical: `plane:${workspace}:${workItemIdentifier}`,
    workspace,
    projectIdentifier,
    sequenceId,
    workItemIdentifier,
  };
};

export const parsePlaneBaseUrl = (baseUrl) => {
  if (typeof baseUrl !== "string" || baseUrl.trim() === "" || /\s/.test(baseUrl)) {
    fail("CONFIG_ERROR");
  }

  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    fail("CONFIG_ERROR");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const allowsHttp = url.protocol === "http:" && LOOPBACK_HTTP_HOSTS.has(hostname);
  if (url.protocol !== "https:" && !allowsHttp) fail("CONFIG_ERROR");
  if (url.username || url.password || url.search || url.hash || hostname === "api.plane.so") {
    fail("CONFIG_ERROR");
  }

  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path === "/" ? "" : path}`;
};

export const readPlaneApiKey = (apiKey) => {
  if (typeof apiKey !== "string" || apiKey.trim() === "" || /[\r\n]/.test(apiKey)) {
    fail("CONFIG_ERROR");
  }
  return apiKey.trim();
};

export const readPlaneConfig = (env = process.env) => {
  if (!isRecord(env)) fail("CONFIG_ERROR");

  return {
    baseUrl: parsePlaneBaseUrl(env.PLANE_BASE_URL),
    apiKey: readPlaneApiKey(env.PLANE_API_KEY),
  };
};

export const escapeHtml = (text) => {
  if (typeof text !== "string") fail("COMMENT_ERROR");

  return text.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]);
};

export const commentHtmlFromText = (text) => {
  if (typeof text !== "string" || text.trim() === "") fail("COMMENT_ERROR");
  return `<p>${escapeHtml(text)}</p>`;
};

const descriptionFrom = (workItem) => {
  const strippedDescription = optionalText(workItem.description_stripped);
  if (strippedDescription !== null) return strippedDescription;
  return optionalText(workItem.description) ?? "";
};

export const normalizeWorkItem = (rawWorkItem, reference = null) => {
  const workItem = requireRecord(rawWorkItem);
  const parsedReference = referenceFrom(reference);
  const sequenceId = normalizePositiveSequenceId(workItem.sequence_id);

  if (parsedReference && sequenceId !== parsedReference.sequenceId) fail("RESPONSE_ERROR");

  return {
    id: normalizeUuid(workItem.id),
    projectId: normalizeUuid(workItem.project),
    reference: parsedReference?.canonical ?? null,
    workspace: parsedReference?.workspace ?? null,
    identifier: parsedReference?.workItemIdentifier ?? null,
    sequenceId,
    name: requireText(workItem.name),
    description: descriptionFrom(workItem),
    stateId: optionalUuid(workItem.state),
    priority: optionalText(workItem.priority),
    assigneeIds: normalizeIdList(workItem.assignees),
    labelIds: normalizeIdList(workItem.labels),
    externalId: optionalText(workItem.external_id),
    externalSource: optionalText(workItem.external_source),
    createdAt: optionalText(workItem.created_at),
    updatedAt: optionalText(workItem.updated_at),
  };
};

export const normalizeProject = (rawProject) => {
  const project = requireRecord(rawProject);
  if (!Object.hasOwn(project, "archived_at")) fail("RESPONSE_ERROR");

  const identifier = requireText(project.identifier);
  if (!PROJECT_IDENTIFIER_PATTERN.test(identifier)) fail("RESPONSE_ERROR");
  const archivedAt = project.archived_at === null
    ? null
    : requireText(project.archived_at);

  return {
    id: normalizeUuid(project.id),
    identifier,
    name: requireText(project.name),
    archivedAt,
  };
};

export const normalizeState = (rawState) => {
  const state = requireRecord(rawState);

  return {
    id: normalizeUuid(state.id),
    name: requireText(state.name),
    group: optionalText(state.group),
    color: optionalText(state.color),
    sequence: normalizeOptionalSequence(state.sequence),
  };
};

const commentContentFrom = (comment) => {
  for (const value of [comment.comment_html, comment.comment, comment.body, comment.name]) {
    if (value === null || value === undefined) continue;
    return optionalText(value);
  }
  return null;
};

export const normalizeComment = (rawComment) => {
  const comment = requireRecord(rawComment);

  return {
    id: normalizeUuid(comment.id),
    content: commentContentFrom(comment),
    authorId: optionalUuid(comment.created_by),
    createdAt: optionalText(comment.created_at),
    updatedAt: optionalText(comment.updated_at),
  };
};

export const normalizeProjectScope = (value) => {
  const scope = requireExactKeys(value, new Set(["workspace", "projectId"]), "PROJECT_ERROR");
  return {
    workspace: normalizeWorkspace(scope.workspace),
    projectId: normalizeUuid(scope.projectId, "PROJECT_ERROR"),
  };
};

export const normalizeProjectWorkItemLookup = (value) => {
  const lookup = requireExactKeys(
    value,
    new Set(["workspace", "projectId", "externalId", "externalSource"]),
    "PROJECT_ERROR",
  );
  const scope = normalizeProjectScope({ workspace: lookup.workspace, projectId: lookup.projectId });
  const externalId = normalizeUuid(lookup.externalId, "PROJECT_ERROR");
  const externalSource = requireText(lookup.externalSource, "PROJECT_ERROR");
  if (/[\r\n]/.test(externalSource)) fail("PROJECT_ERROR");

  return { ...scope, externalId, externalSource };
};

export const normalizeCreateWorkItemInput = (value) => {
  const input = requireExactKeys(value, CREATE_WORK_ITEM_KEYS, "CREATE_ERROR");
  if (typeof input.descriptionStripped !== "string") fail("CREATE_ERROR");
  if (typeof input.priority !== "string" || !WORK_ITEM_PRIORITIES.has(input.priority)) {
    fail("CREATE_ERROR");
  }

  const externalSource = requireText(input.externalSource, "CREATE_ERROR");
  if (/[\r\n]/.test(externalSource)) fail("CREATE_ERROR");

  return {
    name: requireText(input.name, "CREATE_ERROR"),
    descriptionStripped: input.descriptionStripped,
    priority: input.priority,
    stateId: normalizeUuid(input.stateId, "CREATE_ERROR"),
    externalId: normalizeUuid(input.externalId, "CREATE_ERROR"),
    externalSource,
  };
};

export const normalizeWorkItemRelationScope = (value) => {
  const scope = requireExactKeys(
    value,
    new Set(["workspace", "projectId", "workItemId"]),
    "RELATION_ERROR",
  );
  return {
    workspace: normalizeWorkspace(scope.workspace, "RELATION_ERROR"),
    projectId: normalizeUuid(scope.projectId, "RELATION_ERROR"),
    workItemId: normalizeUuid(scope.workItemId, "RELATION_ERROR"),
  };
};

export const normalizeWorkItemRelation = (value) => {
  const relation = requireExactKeys(value, RELATION_KEYS, "RELATION_ERROR");
  if (typeof relation.relationType !== "string" || !RELATION_TYPES.has(relation.relationType)) {
    fail("RELATION_ERROR");
  }
  if (!Array.isArray(relation.issueIds) || relation.issueIds.length !== 1) fail("RELATION_ERROR");

  return {
    relationType: relation.relationType,
    issueIds: relation.issueIds.map((issueId) => normalizeUuid(issueId, "RELATION_ERROR")),
  };
};

const normalizeRelationTargetId = (value, projectId) => {
  if (projectId === undefined || !isRecord(value)) return normalizeUuid(value);

  const target = requireExactKeys(value, RELATION_TARGET_KEYS, "RESPONSE_ERROR");
  const targetProjectId = normalizeUuid(target.project_id);
  if (targetProjectId !== projectId) fail("RESPONSE_ERROR");
  return normalizeUuid(target.issue_id);
};

const normalizeRelationTargetIds = (value, projectId) => {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) fail("RESPONSE_ERROR");
  return value.map((entry) => normalizeRelationTargetId(entry, projectId));
};

const optionalRelationIds = (relations, key, projectId) => {
  if (!Object.hasOwn(relations, key)) return [];
  return normalizeRelationTargetIds(relations[key], projectId);
};

export const normalizeWorkItemRelations = (rawRelations, projectId = undefined) => {
  const relations = requireRecord(rawRelations);
  if (!Object.hasOwn(relations, "blocked_by") || !Array.isArray(relations.blocked_by)) {
    fail("RESPONSE_ERROR");
  }
  const normalizedProjectId = projectId === undefined ? undefined : normalizeUuid(projectId);

  return {
    blockingIds: optionalRelationIds(relations, "blocking", normalizedProjectId),
    blockedByIds: normalizeRelationTargetIds(relations.blocked_by, normalizedProjectId),
    duplicateIds: optionalRelationIds(relations, "duplicate", normalizedProjectId),
    relatesToIds: optionalRelationIds(relations, "relates_to", normalizedProjectId),
    startAfterIds: optionalRelationIds(relations, "start_after", normalizedProjectId),
    startBeforeIds: optionalRelationIds(relations, "start_before", normalizedProjectId),
    finishAfterIds: optionalRelationIds(relations, "finish_after", normalizedProjectId),
    finishBeforeIds: optionalRelationIds(relations, "finish_before", normalizedProjectId),
  };
};

const relationResponseRecords = (value) => {
  if (!Array.isArray(value)) return [value];
  return value.flat(Infinity);
};

export const validateCreatedWorkItemRelation = (rawResponse, relationInput) => {
  const relation = normalizeWorkItemRelation(relationInput);
  const records = relationResponseRecords(rawResponse);
  if (records.length === 0 || records.some((record) => !isRecord(record))) fail("RESPONSE_ERROR");

  const targetId = relation.issueIds[0];
  const matchesTarget = records.some((record) =>
    record.relation_type === relation.relationType && normalizeUuid(record.id) === targetId);
  if (!matchesTarget) fail("RESPONSE_ERROR");

  return relation;
};
