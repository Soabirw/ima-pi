const API_PATH = "/api/v1";
const REQUEST_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 100;
const MAX_PAGE_COUNT = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const PROJECT_IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const REFERENCE_PATTERN = /^plane:([A-Za-z0-9][A-Za-z0-9._~-]*):([A-Z][A-Z0-9_]*)-([1-9]\d*)$/;
const LOOPBACK_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const publicMessages = Object.freeze({
  CONFIG_ERROR: "Plane configuration is missing or invalid.",
  REFERENCE_ERROR: "Plane references must use plane:<workspace>:<PROJECT>-<positive-id>.",
  RESPONSE_ERROR: "Plane returned an invalid response.",
  PAGINATION_ERROR: "Plane pagination could not be completed safely.",
  COMMENT_ERROR: "Plane comments must contain non-whitespace plain text.",
  STATE_ERROR: "Plane state must be one exact state UUID from the selected project.",
  HTTP_ERROR: "Plane request could not be completed.",
});

export class PlaneApiError extends Error {
  constructor(code, status = null) {
    super(code);
    this.name = "PlaneApiError";
    this.code = code;
    this.status = status;
  }
}

const fail = (code) => {
  throw new PlaneApiError(code);
};

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const requireRecord = (value) => {
  if (!isRecord(value)) fail("RESPONSE_ERROR");
  return value;
};

const normalizeUuid = (value, code = "RESPONSE_ERROR") => {
  const candidate = typeof value === "string" ? value : isRecord(value) ? value.id : null;
  if (typeof candidate !== "string" || !UUID_PATTERN.test(candidate)) fail(code);
  return candidate.toLowerCase();
};

const optionalUuid = (value) => {
  if (value === null || value === undefined) return null;
  return normalizeUuid(value);
};

const requireText = (value, code = "RESPONSE_ERROR") => {
  if (typeof value !== "string" || value.trim() === "") fail(code);
  return value;
};

const optionalText = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") fail("RESPONSE_ERROR");
  return value;
};

const normalizeIdList = (value) => {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) fail("RESPONSE_ERROR");
  return value.map((entry) => normalizeUuid(entry));
};

const normalizePositiveSequenceId = (value, code = "RESPONSE_ERROR") => {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^[1-9]\d*$/.test(text)) fail(code);

  const sequenceId = Number(text);
  if (!Number.isSafeInteger(sequenceId)) fail(code);
  return sequenceId;
};

const normalizeOptionalSequence = (value) => {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value)) fail("RESPONSE_ERROR");
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

const readApiKey = (apiKey) => {
  if (typeof apiKey !== "string" || apiKey.trim() === "" || /[\r\n]/.test(apiKey)) {
    fail("CONFIG_ERROR");
  }
  return apiKey.trim();
};

export const readPlaneConfig = (env = process.env) => {
  if (!isRecord(env)) fail("CONFIG_ERROR");

  return {
    baseUrl: parsePlaneBaseUrl(env.PLANE_BASE_URL),
    apiKey: readApiKey(env.PLANE_API_KEY),
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
    createdAt: optionalText(workItem.created_at),
    updatedAt: optionalText(workItem.updated_at),
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

export const collectCursorPages = async ({ fetchPage, normalizeItem, maxPages = MAX_PAGE_COUNT }) => {
  if (typeof fetchPage !== "function" || typeof normalizeItem !== "function") fail("PAGINATION_ERROR");
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) fail("PAGINATION_ERROR");

  const items = [];
  const seenCursors = new Set();
  let cursor = null;

  for (let pageCount = 0; pageCount < maxPages; pageCount += 1) {
    const page = requireRecord(await fetchPage(cursor));
    if (!Array.isArray(page.results)) fail("RESPONSE_ERROR");

    items.push(...page.results.map(normalizeItem));

    if (page.next_page_results === false) return items;

    if (page.next_page_results !== true || typeof page.next_cursor !== "string" || page.next_cursor.trim() === "") {
      fail("PAGINATION_ERROR");
    }
    if (seenCursors.has(page.next_cursor)) fail("PAGINATION_ERROR");

    seenCursors.add(page.next_cursor);
    cursor = page.next_cursor;
  }

  fail("PAGINATION_ERROR");
};

const encodePathSegment = (value) => encodeURIComponent(value);

const pathForHumanReference = (reference) =>
  `workspaces/${encodePathSegment(reference.workspace)}/work-items/${encodePathSegment(reference.workItemIdentifier)}/`;

const pathForProjectStates = (reference, projectId) =>
  `workspaces/${encodePathSegment(reference.workspace)}/projects/${encodePathSegment(projectId)}/states/`;

const pathForComments = (reference, projectId, workItemId) =>
  `workspaces/${encodePathSegment(reference.workspace)}/projects/${encodePathSegment(projectId)}/work-items/${encodePathSegment(workItemId)}/comments/`;

const pathForWorkItem = (reference, projectId, workItemId) =>
  `workspaces/${encodePathSegment(reference.workspace)}/projects/${encodePathSegment(projectId)}/work-items/${encodePathSegment(workItemId)}/`;

const paginatedPath = (path, cursor) => {
  const parameters = new URLSearchParams({ per_page: String(PAGE_SIZE) });
  if (cursor !== null) parameters.set("cursor", cursor);
  return `${path}?${parameters.toString()}`;
};

const redactSecret = (value, apiKey) => {
  if (typeof value === "string") return value.split(apiKey).join("[REDACTED]");
  if (Array.isArray(value)) return value.map((entry) => redactSecret(entry, apiKey));
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactSecret(entry, apiKey)]),
  );
};

const publicError = (error) => {
  if (!(error instanceof PlaneApiError) || !Object.hasOwn(publicMessages, error.code)) {
    return { code: "HTTP_ERROR", message: publicMessages.HTTP_ERROR };
  }

  if (error.code === "HTTP_ERROR" && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) {
    return {
      code: "HTTP_ERROR",
      message: `Plane request failed with HTTP status ${error.status}.`,
    };
  }

  return { code: error.code, message: publicMessages[error.code] };
};

export const toPublicPlaneError = publicError;

const mutationIdentityFrom = (rawResponse, workItem) => {
  const response = requireRecord(rawResponse);
  const id = normalizeUuid(response.id);
  const projectId = normalizeUuid(response.project);

  if (id !== workItem.id || projectId !== workItem.projectId) fail("RESPONSE_ERROR");
  return { id, projectId, stateId: optionalUuid(response.state) };
};

const selectState = (states, stateId) => {
  const normalizedStateId = normalizeUuid(stateId, "STATE_ERROR");
  const matches = states.filter((state) => state.id === normalizedStateId);
  if (matches.length !== 1) fail("STATE_ERROR");
  return matches[0];
};

export const createPlaneClient = ({
  baseUrl,
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  createAbortController = () => new AbortController(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) => {
  const normalizedBaseUrl = parsePlaneBaseUrl(baseUrl);
  const normalizedApiKey = readApiKey(apiKey);
  if (typeof fetchImpl !== "function" || typeof createAbortController !== "function") fail("CONFIG_ERROR");
  if (typeof setTimeoutImpl !== "function" || typeof clearTimeoutImpl !== "function") fail("CONFIG_ERROR");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) fail("CONFIG_ERROR");

  const apiBaseUrl = `${normalizedBaseUrl}${API_PATH}/`;

  const requestJson = async ({ path, method = "GET", body }) => {
    const abortController = createAbortController();
    if (!abortController?.signal || typeof abortController.abort !== "function") fail("CONFIG_ERROR");

    const timeout = setTimeoutImpl(() => abortController.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(new URL(path, apiBaseUrl), {
          method,
          headers: {
            Accept: "application/json",
            "X-API-Key": normalizedApiKey,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal: abortController.signal,
        });
      } catch {
        fail("HTTP_ERROR");
      }

      if (!isRecord(response) || typeof response.ok !== "boolean") fail("RESPONSE_ERROR");
      if (!response.ok) throw new PlaneApiError("HTTP_ERROR", response.status);
      if (typeof response.json !== "function") fail("RESPONSE_ERROR");

      try {
        return await response.json();
      } catch {
        fail("RESPONSE_ERROR");
      }
    } finally {
      clearTimeoutImpl(timeout);
    }
  };

  const resolveWorkItem = async (referenceValue) => {
    const reference = parsePlaneReference(referenceValue);
    const rawWorkItem = await requestJson({ path: pathForHumanReference(reference) });

    return {
      reference,
      workItem: normalizeWorkItem(rawWorkItem, reference),
    };
  };

  const listProjectStates = (reference, projectId) =>
    collectCursorPages({
      fetchPage: (cursor) => requestJson({
        path: paginatedPath(pathForProjectStates(reference, projectId), cursor),
      }),
      normalizeItem: normalizeState,
    });

  const listWorkItemComments = (reference, projectId, workItemId) =>
    collectCursorPages({
      fetchPage: (cursor) => requestJson({
        path: paginatedPath(pathForComments(reference, projectId, workItemId), cursor),
      }),
      normalizeItem: normalizeComment,
    });

  return Object.freeze({
    getWorkItem: async (referenceValue) => {
      const { workItem } = await resolveWorkItem(referenceValue);
      return redactSecret(workItem, normalizedApiKey);
    },

    listStates: async (referenceValue) => {
      const { reference, workItem } = await resolveWorkItem(referenceValue);
      const states = await listProjectStates(reference, workItem.projectId);

      return redactSecret({
        reference: reference.canonical,
        workItemId: workItem.id,
        states,
      }, normalizedApiKey);
    },

    listComments: async (referenceValue) => {
      const { reference, workItem } = await resolveWorkItem(referenceValue);
      const comments = await listWorkItemComments(reference, workItem.projectId, workItem.id);

      return redactSecret({
        reference: reference.canonical,
        workItemId: workItem.id,
        comments,
      }, normalizedApiKey);
    },

    createComment: async (referenceValue, text) => {
      const commentHtml = commentHtmlFromText(text);
      const { reference, workItem } = await resolveWorkItem(referenceValue);
      const rawComment = await requestJson({
        path: pathForComments(reference, workItem.projectId, workItem.id),
        method: "POST",
        body: { comment_html: commentHtml },
      });
      const comment = normalizeComment(rawComment);

      return redactSecret({
        reference: reference.canonical,
        workItemId: workItem.id,
        commentId: comment.id,
      }, normalizedApiKey);
    },

    setState: async (referenceValue, stateId) => {
      const { reference, workItem } = await resolveWorkItem(referenceValue);
      const states = await listProjectStates(reference, workItem.projectId);
      const state = selectState(states, stateId);
      const rawResponse = await requestJson({
        path: pathForWorkItem(reference, workItem.projectId, workItem.id),
        method: "PATCH",
        body: { state: state.id },
      });
      const responseIdentity = mutationIdentityFrom(rawResponse, workItem);

      if (responseIdentity.stateId !== null && responseIdentity.stateId !== state.id) {
        fail("RESPONSE_ERROR");
      }

      return redactSecret({
        reference: reference.canonical,
        workItemId: workItem.id,
        stateId: state.id,
      }, normalizedApiKey);
    },
  });
};
