import {
  PlaneApiError,
  commentHtmlFromText,
  fail,
  isRecord,
  normalizeComment,
  normalizeCreateWorkItemInput,
  normalizeProject,
  normalizeProjectScope,
  normalizeProjectWorkItemLookup,
  normalizeWorkspace,
  normalizeState,
  normalizeWorkItem,
  normalizeWorkItemRelation,
  normalizeWorkItemRelations,
  normalizeWorkItemRelationScope,
  normalizeUuid,
  parsePlaneBaseUrl,
  parsePlaneReference,
  readPlaneApiKey,
  readPlaneConfig,
  validateCreatedWorkItemRelation,
} from "./plane-contract.mjs";
import {
  DEFAULT_REQUEST_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  collectCursorPages,
  createPlaneTransport,
  monotonicNow,
  waitForDuration,
} from "./plane-transport.mjs";

export {
  PlaneApiError,
  commentHtmlFromText,
  escapeHtml,
  normalizeComment,
  normalizeCreateWorkItemInput,
  normalizeProject,
  normalizeState,
  normalizeWorkItem,
  normalizeWorkItemRelation,
  parsePlaneBaseUrl,
  parsePlaneReference,
  readPlaneConfig,
} from "./plane-contract.mjs";

const API_PATH = "/api/v1";
const PAGE_SIZE = 100;

const publicMessages = Object.freeze({
  CONFIG_ERROR: "Plane configuration is missing or invalid.",
  REFERENCE_ERROR: "Plane references must use plane:<workspace>:<PROJECT>-<positive-id>.",
  RESPONSE_ERROR: "Plane returned an invalid response.",
  PAGINATION_ERROR: "Plane pagination could not be completed safely.",
  COMMENT_ERROR: "Plane comments must contain non-whitespace plain text.",
  STATE_ERROR: "Plane state must be one exact state UUID from the selected project.",
  PROJECT_ERROR: "Plane project work-item input is invalid.",
  CREATE_ERROR: "Plane work-item creation input is invalid.",
  RELATION_ERROR: "Plane work-item relation input is invalid.",
  HTTP_ERROR: "Plane request could not be completed.",
});

export { collectCursorPages };

const encodePathSegment = (value) => encodeURIComponent(value);

const pathForHumanReference = (reference) =>
  `workspaces/${encodePathSegment(reference.workspace)}/work-items/${encodePathSegment(reference.workItemIdentifier)}/`;

const pathForWorkspaceProjects = ({ workspace }) =>
  `workspaces/${encodePathSegment(workspace)}/projects/`;

const pathForProjectStates = ({ workspace, projectId }) =>
  `workspaces/${encodePathSegment(workspace)}/projects/${encodePathSegment(projectId)}/states/`;

const pathForComments = (reference, projectId, workItemId) =>
  `workspaces/${encodePathSegment(reference.workspace)}/projects/${encodePathSegment(projectId)}/work-items/${encodePathSegment(workItemId)}/comments/`;

const pathForWorkItem = (reference, projectId, workItemId) =>
  `workspaces/${encodePathSegment(reference.workspace)}/projects/${encodePathSegment(projectId)}/work-items/${encodePathSegment(workItemId)}/`;

const pathForProjectWorkItems = ({ workspace, projectId }) =>
  `workspaces/${encodePathSegment(workspace)}/projects/${encodePathSegment(projectId)}/work-items/`;

const pathForWorkItemRelations = ({ workspace, projectId, workItemId }) =>
  `${pathForProjectWorkItems({ workspace, projectId })}${encodePathSegment(workItemId)}/relations/`;

const paginatedPath = (path, cursor, parameters = {}, pageSize = PAGE_SIZE) => {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE) fail("PAGINATION_ERROR");

  const query = new URLSearchParams({ per_page: String(pageSize) });
  for (const [name, value] of Object.entries(parameters)) query.set(name, value);
  if (cursor !== null) query.set("cursor", cursor);
  return `${path}?${query.toString()}`;
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
  if (!isRecord(rawResponse)) fail("RESPONSE_ERROR");
  const id = normalizeUuid(rawResponse.id);
  const projectId = normalizeUuid(rawResponse.project);

  if (id !== workItem.id || projectId !== workItem.projectId) fail("RESPONSE_ERROR");
  return {
    id,
    projectId,
    stateId: rawResponse.state === null || rawResponse.state === undefined
      ? null
      : normalizeUuid(rawResponse.state),
  };
};

const selectState = (states, stateId) => {
  const normalizedStateId = normalizeUuid(stateId, "STATE_ERROR");
  const matches = states.filter((state) => state.id === normalizedStateId);
  if (matches.length !== 1) fail("STATE_ERROR");
  return matches[0];
};

const isExactLookupNoMatch = (error) =>
  error instanceof PlaneApiError && error.code === "HTTP_ERROR" && error.status === 404;

const validateProjectWorkItemRouteProbe = ({ page, projectId }) => {
  if (!isRecord(page) || !Array.isArray(page.results) || typeof page.next_page_results !== "boolean") {
    fail("RESPONSE_ERROR");
  }
  if (
    page.next_page_results
    && (typeof page.next_cursor !== "string" || page.next_cursor.trim() === "")
  ) {
    fail("RESPONSE_ERROR");
  }

  const workItems = page.results.map((rawWorkItem) => normalizeWorkItem(rawWorkItem));
  if (workItems.some((workItem) => workItem.projectId !== projectId)) fail("RESPONSE_ERROR");
};

const firstPageForExactLookup = ({ page, cursor, lookup }) => {
  if (cursor !== null || !isRecord(page) || Object.hasOwn(page, "results")) return page;

  const workItem = normalizeWorkItem(page);
  if (
    workItem.projectId !== lookup.projectId
    || workItem.externalId !== lookup.externalId
    || workItem.externalSource !== lookup.externalSource
  ) {
    fail("RESPONSE_ERROR");
  }

  return { results: [page], next_page_results: false };
};

const workspaceRequest = (value) => {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "workspace")) {
    fail("PROJECT_ERROR");
  }

  return { workspace: normalizeWorkspace(value.workspace) };
};

const projectExternalSourceLookup = (value) => {
  const allowedKeys = new Set(["workspace", "projectId", "externalSource"]);
  if (!isRecord(value) || Object.keys(value).some((key) => !allowedKeys.has(key))) {
    fail("PROJECT_ERROR");
  }

  const externalSource = value.externalSource;
  if (typeof externalSource !== "string" || externalSource.trim() === "" || /[\r\n]/.test(externalSource)) {
    fail("PROJECT_ERROR");
  }

  return {
    ...normalizeProjectScope({ workspace: value.workspace, projectId: value.projectId }),
    externalSource,
  };
};

const projectWorkItemRequest = (value) => {
  if (!isRecord(value) || Object.keys(value).some((key) => !new Set(["workspace", "projectId", "input"]).has(key))) {
    fail("CREATE_ERROR");
  }
  return {
    ...normalizeProjectScope({ workspace: value.workspace, projectId: value.projectId }),
    input: normalizeCreateWorkItemInput(value.input),
  };
};

const relationMutationRequest = (value) => {
  if (!isRecord(value) || Object.keys(value).some((key) => !new Set(["workspace", "projectId", "workItemId", "relation"]).has(key))) {
    fail("RELATION_ERROR");
  }
  return {
    ...normalizeWorkItemRelationScope({
      workspace: value.workspace,
      projectId: value.projectId,
      workItemId: value.workItemId,
    }),
    relation: normalizeWorkItemRelation(value.relation),
  };
};

export const createPlaneClient = ({
  baseUrl,
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  requestIntervalMs = DEFAULT_REQUEST_INTERVAL_MS,
  now = monotonicNow,
  waitFor = waitForDuration,
  createAbortController = () => new AbortController(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) => {
  const normalizedBaseUrl = parsePlaneBaseUrl(baseUrl);
  const normalizedApiKey = readPlaneApiKey(apiKey);
  if (typeof fetchImpl !== "function" || typeof createAbortController !== "function") fail("CONFIG_ERROR");
  if (typeof now !== "function" || typeof waitFor !== "function") fail("CONFIG_ERROR");
  if (typeof setTimeoutImpl !== "function" || typeof clearTimeoutImpl !== "function") fail("CONFIG_ERROR");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) fail("CONFIG_ERROR");
  if (!Number.isSafeInteger(requestIntervalMs) || requestIntervalMs < 0) fail("CONFIG_ERROR");

  const apiBaseUrl = `${normalizedBaseUrl}${API_PATH}/`;
  const requestJson = createPlaneTransport({
    apiBaseUrl,
    apiKey: normalizedApiKey,
    fetchImpl,
    timeoutMs,
    requestIntervalMs,
    now,
    waitFor,
    createAbortController,
    setTimeoutImpl,
    clearTimeoutImpl,
  });

  const resolveWorkItem = async (referenceValue) => {
    const reference = parsePlaneReference(referenceValue);
    const rawWorkItem = await requestJson({ path: pathForHumanReference(reference) });

    return {
      reference,
      workItem: normalizeWorkItem(rawWorkItem, reference),
    };
  };

  const listWorkspaceProjects = (scopeInput) => {
    const scope = workspaceRequest(scopeInput);
    return collectCursorPages({
      fetchPage: (cursor) => requestJson({
        path: paginatedPath(pathForWorkspaceProjects(scope), cursor),
      }),
      normalizeItem: normalizeProject,
    });
  };

  const listProjectStates = (scopeInput) => {
    const scope = normalizeProjectScope(scopeInput);
    return collectCursorPages({
      fetchPage: (cursor) => requestJson({
        path: paginatedPath(pathForProjectStates(scope), cursor),
      }),
      normalizeItem: normalizeState,
    });
  };

  const listProjectItemsByExternalSource = async (lookupInput) => {
    const lookup = projectExternalSourceLookup(lookupInput);
    const workItems = await collectCursorPages({
      fetchPage: (cursor) => requestJson({
        path: paginatedPath(pathForProjectWorkItems(lookup), cursor, {
          external_source: lookup.externalSource,
        }),
      }),
      normalizeItem: (rawWorkItem) => {
        const workItem = normalizeWorkItem(rawWorkItem);
        if (workItem.projectId !== lookup.projectId) fail("RESPONSE_ERROR");
        return workItem;
      },
    });

    // Some self-hosted Plane deployments ignore the external_source query parameter.
    return workItems.filter((workItem) => workItem.externalSource === lookup.externalSource);
  };

  const proveProjectWorkItemListRoute = async (lookup) => {
    const page = await requestJson({
      path: paginatedPath(pathForProjectWorkItems(lookup), null, {}, 1),
    });
    validateProjectWorkItemRouteProbe({ page, projectId: lookup.projectId });
  };

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
      const states = await listProjectStates({
        workspace: reference.workspace,
        projectId: workItem.projectId,
      });

      return redactSecret({
        reference: reference.canonical,
        workItemId: workItem.id,
        states,
      }, normalizedApiKey);
    },

    listWorkspaceProjects: async (scopeInput) =>
      redactSecret(await listWorkspaceProjects(scopeInput), normalizedApiKey),

    listProjectStates: async (scopeInput) =>
      redactSecret(await listProjectStates(scopeInput), normalizedApiKey),

    listProjectItemsByExternalSource: async (lookupInput) =>
      redactSecret(await listProjectItemsByExternalSource(lookupInput), normalizedApiKey),

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
      const states = await listProjectStates({
        workspace: reference.workspace,
        projectId: workItem.projectId,
      });
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

    listProjectWorkItems: async (lookupInput) => {
      const lookup = normalizeProjectWorkItemLookup(lookupInput);
      const workItems = await collectCursorPages({
        fetchPage: async (cursor) => {
          try {
            const page = await requestJson({
              path: paginatedPath(pathForProjectWorkItems(lookup), cursor, {
                external_id: lookup.externalId,
                external_source: lookup.externalSource,
              }),
            });
            return firstPageForExactLookup({ page, cursor, lookup });
          } catch (error) {
            if (cursor !== null || !isExactLookupNoMatch(error)) throw error;

            await proveProjectWorkItemListRoute(lookup);
            return { results: [], next_page_results: false };
          }
        },
        normalizeItem: (rawWorkItem) => {
          const workItem = normalizeWorkItem(rawWorkItem);
          if (workItem.projectId !== lookup.projectId) fail("RESPONSE_ERROR");
          return workItem;
        },
      });

      return redactSecret(workItems, normalizedApiKey);
    },

    createProjectWorkItem: async (requestInput) => {
      const request = projectWorkItemRequest(requestInput);
      const rawWorkItem = await requestJson({
        path: pathForProjectWorkItems(request),
        method: "POST",
        body: {
          name: request.input.name,
          description_stripped: request.input.descriptionStripped,
          priority: request.input.priority,
          state: request.input.stateId,
          external_id: request.input.externalId,
          external_source: request.input.externalSource,
        },
      });
      const workItem = normalizeWorkItem(rawWorkItem);
      if (
        workItem.projectId !== request.projectId
        || workItem.externalId !== request.input.externalId
        || workItem.externalSource !== request.input.externalSource
      ) {
        fail("RESPONSE_ERROR");
      }

      return redactSecret(workItem, normalizedApiKey);
    },

    listWorkItemRelations: async (scopeInput) => {
      const scope = normalizeWorkItemRelationScope(scopeInput);
      const rawRelations = await requestJson({ path: pathForWorkItemRelations(scope) });
      return redactSecret(normalizeWorkItemRelations(rawRelations, scope.projectId), normalizedApiKey);
    },

    createWorkItemRelation: async (requestInput) => {
      const request = relationMutationRequest(requestInput);
      const rawResponse = await requestJson({
        path: pathForWorkItemRelations(request),
        method: "POST",
        body: {
          relation_type: request.relation.relationType,
          issues: request.relation.issueIds,
        },
      });
      validateCreatedWorkItemRelation(rawResponse, request.relation);

      return redactSecret({
        workItemId: request.workItemId,
        relationType: request.relation.relationType,
        issueIds: request.relation.issueIds,
      }, normalizedApiKey);
    },
  });
};
