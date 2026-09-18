import assert from "node:assert/strict";
import test from "node:test";
import {
  PlaneApiError,
  collectCursorPages,
  commentHtmlFromText,
  createPlaneClient,
  descriptionHtmlFromText,
  normalizeComment,
  normalizeCreateWorkItemFields,
  normalizeState,
  parsePlaneBaseUrl,
  parsePlaneProjectReference,
  parsePlaneReference,
  readPlaneConfig,
} from "../skills/plane-api/scripts/plane-client.mjs";
import { runPlaneApi } from "../skills/plane-api/scripts/plane-api.mjs";

const API_KEY = "synthetic-plane-api-key";
const BASE_URL = "https://plane.internal.example";
const REFERENCE = "plane:acme:PROJ-123";
const PROJECT_REFERENCE = "plane:acme:PROJ";
const WORK_ITEM_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const CURRENT_STATE_ID = "33333333-3333-4333-8333-333333333333";
const NEXT_STATE_ID = "44444444-4444-4444-8444-444444444444";
const ASSIGNEE_ID = "55555555-5555-4555-8555-555555555555";
const LABEL_ID = "66666666-6666-4666-8666-666666666666";
const COMMENT_ID = "77777777-7777-4777-8777-777777777777";
const SECOND_WORK_ITEM_ID = "88888888-8888-4888-8888-888888888888";

const project = (overrides = {}) => ({
  id: PROJECT_ID,
  identifier: "PROJ",
  name: "Project",
  archived_at: null,
  ...overrides,
});

const workItem = (overrides = {}) => ({
  id: WORK_ITEM_ID,
  project: PROJECT_ID,
  sequence_id: 123,
  name: "Plane item",
  description_stripped: "Safe description",
  state: CURRENT_STATE_ID,
  priority: "medium",
  assignees: [ASSIGNEE_ID],
  labels: [LABEL_ID],
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T01:00:00Z",
  ...overrides,
});

const workspaceMember = (overrides = {}) => ({
  id: ASSIGNEE_ID,
  ...overrides,
});

const state = (overrides = {}) => ({
  id: NEXT_STATE_ID,
  name: "Started",
  group: "started",
  color: "#f59e0b",
  sequence: 2,
  ...overrides,
});

const comment = (overrides = {}) => ({
  id: COMMENT_ID,
  comment_html: "<p>Safe comment</p>",
  created_by: ASSIGNEE_ID,
  created_at: "2026-09-01T02:00:00Z",
  updated_at: "2026-09-01T02:00:00Z",
  ...overrides,
});

const jsonResponse = (data, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => data,
});

const queuedFetch = (responses) => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (typeof response === "function") return response(url, options);
    if (response === undefined) throw new Error("Unexpected Plane request");
    return response;
  };

  return { calls, fetchImpl };
};

const clientFor = (responses, options = {}) => {
  const queue = queuedFetch(responses);
  return {
    calls: queue.calls,
    client: createPlaneClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetchImpl: queue.fetchImpl,
      requestIntervalMs: 0,
      ...options,
    }),
  };
};

const assertErrorCode = async (promise, code) => {
  await assert.rejects(promise, (error) => error instanceof PlaneApiError && error.code === code);
};

const outputWriter = () => {
  let output = "";
  return {
    writer: { write: (chunk) => { output += chunk; } },
    output: () => output,
  };
};

test("parses only canonical Plane work-item references", async () => {
  assert.deepEqual(parsePlaneReference(REFERENCE), {
    canonical: REFERENCE,
    workspace: "acme",
    projectIdentifier: "PROJ",
    sequenceId: 123,
    workItemIdentifier: "PROJ-123",
  });

  for (const value of [
    "plane:acme:proj-123",
    "plane:acme:PROJ-0",
    "plane:acme:PROJ-123?next=/",
    "plane:acme:PROJ-123/extra",
    "plane:acme:PROJ-123 ",
  ]) {
    assert.throws(() => parsePlaneReference(value), (error) => error.code === "REFERENCE_ERROR");
  }

  const { client, calls } = clientFor([]);
  await assertErrorCode(client.getWorkItem("plane:acme:PROJ-0"), "REFERENCE_ERROR");
  assert.equal(calls.length, 0);
});

test("parses only canonical Plane project references for creation", () => {
  assert.deepEqual(parsePlaneProjectReference(PROJECT_REFERENCE), {
    canonical: PROJECT_REFERENCE,
    workspace: "acme",
    projectIdentifier: "PROJ",
  });

  for (const value of ["plane:acme:PROJ-1", "plane:acme:proj", "plane:acme:PROJ "]) {
    assert.throws(() => parsePlaneProjectReference(value), (error) => error.code === "REFERENCE_ERROR");
  }
});

test("requires a configured self-hosted base URL and API key", () => {
  assert.equal(parsePlaneBaseUrl("https://plane.internal.example/"), BASE_URL);
  assert.equal(parsePlaneBaseUrl("http://localhost:8080/"), "http://localhost:8080");
  assert.equal(parsePlaneBaseUrl("http://127.0.0.1:8080/"), "http://127.0.0.1:8080");
  assert.equal(parsePlaneBaseUrl("http://[::1]:8080/"), "http://[::1]:8080");
  assert.deepEqual(readPlaneConfig({ PLANE_BASE_URL: BASE_URL, PLANE_API_KEY: API_KEY }), {
    baseUrl: BASE_URL,
    apiKey: API_KEY,
  });

  for (const value of [
    "https://api.plane.so",
    "https://operator:password@plane.internal.example",
    "https://plane.internal.example?target=other",
    "https://plane.internal.example#fragment",
    "http://plane.internal.example",
    "ftp://plane.internal.example",
  ]) {
    assert.throws(() => parsePlaneBaseUrl(value), (error) => error.code === "CONFIG_ERROR");
  }

  assert.throws(
    () => readPlaneConfig({ PLANE_BASE_URL: BASE_URL, PLANE_API_KEY: "\n" }),
    (error) => error.code === "CONFIG_ERROR",
  );
  assert.throws(() => readPlaneConfig({}), (error) => error.code === "CONFIG_ERROR");
});

test("uses the configured API key only in its header and redacts echoed keys", async () => {
  const { client, calls } = clientFor([jsonResponse(workItem({ name: `Item ${API_KEY}` }))]);
  const result = await client.getWorkItem(REFERENCE);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers["X-API-Key"], API_KEY);
  assert.equal(calls[0].options.headers.Accept, "application/json");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(result.name, "Item [REDACTED]");
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
  assert.equal(calls[0].url, `${BASE_URL}/api/v1/workspaces/acme/work-items/PROJ-123/`);
});

test("uses UUID paths after resolving the human reference for states and comments", async () => {
  const states = clientFor([
    jsonResponse(workItem()),
    jsonResponse({ results: [state()], next_page_results: false, next_cursor: null }),
  ]);
  const stateResult = await states.client.listStates(REFERENCE);

  assert.equal(stateResult.workItemId, WORK_ITEM_ID);
  assert.equal(stateResult.states[0].id, NEXT_STATE_ID);
  assert.equal(
    states.calls[1].url,
    `${BASE_URL}/api/v1/workspaces/acme/projects/${PROJECT_ID}/states/?per_page=100`,
  );

  const comments = clientFor([
    jsonResponse(workItem()),
    jsonResponse({ results: [comment()], next_page_results: false, next_cursor: null }),
  ]);
  const commentResult = await comments.client.listComments(REFERENCE);

  assert.equal(commentResult.comments[0].content, "<p>Safe comment</p>");
  assert.equal(
    comments.calls[1].url,
    `${BASE_URL}/api/v1/workspaces/acme/projects/${PROJECT_ID}/work-items/${WORK_ITEM_ID}/comments/?per_page=100`,
  );
});

test("collects bounded state and comment cursor pages", async () => {
  const states = clientFor([
    jsonResponse(workItem()),
    jsonResponse({ results: [state()], next_page_results: true, next_cursor: "state-cursor" }),
    jsonResponse({ results: [state({ id: CURRENT_STATE_ID, name: "Todo" })], next_page_results: false, next_cursor: null }),
  ]);
  const stateResult = await states.client.listStates(REFERENCE);

  assert.equal(stateResult.states.length, 2);
  assert.equal(states.calls[2].url.endsWith("?per_page=100&cursor=state-cursor"), true);

  const comments = clientFor([
    jsonResponse(workItem()),
    jsonResponse({ results: [comment()], next_page_results: true, next_cursor: "comment-cursor" }),
    jsonResponse({ results: [comment({ id: ASSIGNEE_ID })], next_page_results: false, next_cursor: null }),
  ]);
  const commentResult = await comments.client.listComments(REFERENCE);

  assert.equal(commentResult.comments.length, 2);
  assert.equal(comments.calls[2].url.endsWith("?per_page=100&cursor=comment-cursor"), true);

  await assertErrorCode(collectCursorPages({
    fetchPage: async () => ({ results: [], next_page_results: true, next_cursor: "repeat" }),
    normalizeItem: (item) => item,
    maxPages: 3,
  }), "PAGINATION_ERROR");
  await assertErrorCode(collectCursorPages({
    fetchPage: async () => ({ results: [], next_page_results: true, next_cursor: "next" }),
    normalizeItem: (item) => item,
    maxPages: 1,
  }), "PAGINATION_ERROR");
});

test("accepts terminal pages that retain an unused next cursor", async () => {
  const states = clientFor([
    jsonResponse(workItem()),
    jsonResponse({ results: [state()], next_page_results: false, next_cursor: "terminal-state-cursor" }),
  ]);
  const stateResult = await states.client.listStates(REFERENCE);

  assert.equal(stateResult.states.length, 1);
  assert.equal(states.calls.length, 2);

  const comments = clientFor([
    jsonResponse(workItem()),
    jsonResponse({ results: [comment()], next_page_results: false, next_cursor: "terminal-comment-cursor" }),
  ]);
  const commentResult = await comments.client.listComments(REFERENCE);

  assert.equal(commentResult.comments.length, 1);
  assert.equal(comments.calls.length, 2);
});

test("normalizes stable external fields and converts plain text to escaped comment HTML", () => {
  assert.deepEqual(normalizeState(state()), {
    id: NEXT_STATE_ID,
    name: "Started",
    group: "started",
    color: "#f59e0b",
    sequence: 2,
  });
  assert.deepEqual(normalizeComment(comment()), {
    id: COMMENT_ID,
    content: "<p>Safe comment</p>",
    authorId: ASSIGNEE_ID,
    createdAt: "2026-09-01T02:00:00Z",
    updatedAt: "2026-09-01T02:00:00Z",
  });
  assert.equal(commentHtmlFromText(`<tag>&"'`), "<p>&lt;tag&gt;&amp;&quot;&#39;</p>");
  assert.throws(() => commentHtmlFromText(" \n "), (error) => error.code === "COMMENT_ERROR");
});

test("converts a plain-text work-item description to escaped multiline HTML", () => {
  const html = descriptionHtmlFromText(`<tag>&"'\nSecond line\n\nFinal paragraph`);

  assert.equal(html, "<p>&lt;tag&gt;&amp;&quot;&#39;<br>Second line</p><p>Final paragraph</p>");
  assert.equal(html.includes("<tag>"), false);
  assert.equal(descriptionHtmlFromText(""), "");
  assert.throws(() => descriptionHtmlFromText(null), (error) => error.code === "CREATE_ERROR");
});

test("creates a work item with only the required name", async () => {
  const { client, calls } = clientFor([
    jsonResponse({ results: [project()], next_page_results: false, next_cursor: null }),
    jsonResponse(workItem({ sequence_id: 124, name: "Created item" })),
  ]);
  const result = await client.createWorkItem(PROJECT_REFERENCE, { name: "Created item" });

  assert.deepEqual(result, {
    reference: "plane:acme:PROJ-124",
    workItemId: WORK_ITEM_ID,
    sequenceId: 124,
    name: "Created item",
    stateId: CURRENT_STATE_ID,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${BASE_URL}/api/v1/workspaces/acme/projects/?per_page=100`);
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.redirect, "error");
  assert.equal(calls[1].url, `${BASE_URL}/api/v1/workspaces/acme/projects/${PROJECT_ID}/work-items/`);
  assert.deepEqual(JSON.parse(calls[1].options.body), { name: "Created item" });
});

test("creates a work item with an escaped description and allowlisted priority", async () => {
  const { client, calls } = clientFor([
    jsonResponse({ results: [project()], next_page_results: false, next_cursor: null }),
    jsonResponse(workItem({ sequence_id: 124 })),
  ]);
  await client.createWorkItem(PROJECT_REFERENCE, {
    name: "Created item",
    description: "<script>unsafe</script>",
    priority: "high",
  });

  assert.deepEqual(JSON.parse(calls[1].options.body), {
    name: "Created item",
    description_html: "<p>&lt;script&gt;unsafe&lt;/script&gt;</p>",
    description_stripped: "<script>unsafe</script>",
    priority: "high",
  });
});

test("fails closed before a create write for invalid input or ambiguous projects", async () => {
  const invalidReference = clientFor([]);
  await assertErrorCode(invalidReference.client.createWorkItem("plane:acme:PROJ-1", { name: "Item" }), "REFERENCE_ERROR");
  assert.equal(invalidReference.calls.length, 0);

  const invalidPriority = clientFor([]);
  await assertErrorCode(invalidPriority.client.createWorkItem(PROJECT_REFERENCE, { name: "Item", priority: "urgent" }), "CREATE_ERROR");
  assert.equal(invalidPriority.calls.length, 0);
  assert.throws(
    () => normalizeCreateWorkItemFields({ name: "Item", unsupported: true }),
    (error) => error.code === "CREATE_ERROR",
  );

  for (const projects of [[], [project(), project({ id: ASSIGNEE_ID })], [project({ archived_at: "2026-09-01T00:00:00Z" })]]) {
    const candidate = clientFor([jsonResponse({ results: projects, next_page_results: false, next_cursor: null })]);
    await assertErrorCode(candidate.client.createWorkItem(PROJECT_REFERENCE, { name: "Item" }), "PROJECT_ERROR");
    assert.equal(candidate.calls.length, 1);
  }
});

test("requires the created work item to belong to the resolved project", async () => {
  const { client, calls } = clientFor([
    jsonResponse({ results: [project()], next_page_results: false, next_cursor: null }),
    jsonResponse(workItem({ project: ASSIGNEE_ID, sequence_id: 124 })),
  ]);

  await assertErrorCode(client.createWorkItem(PROJECT_REFERENCE, { name: "Item" }), "RESPONSE_ERROR");
  assert.equal(calls.length, 2);
});

test("CLI creates a work item and rejects a missing title", async () => {
  const queue = queuedFetch([
    jsonResponse({ results: [project()], next_page_results: false, next_cursor: null }),
    jsonResponse(workItem({ sequence_id: 124, name: "Created item" })),
  ]);
  const stdout = outputWriter();
  const stderr = outputWriter();
  const exitCode = await runPlaneApi({
    argv: ["plane:create", PROJECT_REFERENCE, "Created item"],
    env: { PLANE_BASE_URL: BASE_URL, PLANE_API_KEY: API_KEY },
    stdout: stdout.writer,
    stderr: stderr.writer,
    fetchImpl: queue.fetchImpl,
  });

  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(stdout.output()).data.reference, "plane:acme:PROJ-124");
  assert.equal(stderr.output(), "");

  const missingTitle = outputWriter();
  assert.equal(await runPlaneApi({
    argv: ["plane:create", PROJECT_REFERENCE],
    stderr: missingTitle.writer,
  }), 2);
  assert.equal(JSON.parse(missingTitle.output()).error.code, "USAGE_ERROR");
});

test("creates a comment only after rereading the selected work item", async () => {
  const { client, calls } = clientFor([
    jsonResponse(workItem()),
    jsonResponse(comment()),
  ]);
  const result = await client.createComment(REFERENCE, "<safe & plain>");

  assert.deepEqual(result, {
    reference: REFERENCE,
    workItemId: WORK_ITEM_ID,
    commentId: COMMENT_ID,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.redirect, "error");
  assert.equal(
    calls[1].url,
    `${BASE_URL}/api/v1/workspaces/acme/projects/${PROJECT_ID}/work-items/${WORK_ITEM_ID}/comments/`,
  );
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    comment_html: "<p>&lt;safe &amp; plain&gt;</p>",
  });
});

test("updates only a validated state after reading the item and project states", async () => {
  const { client, calls } = clientFor([
    jsonResponse(workItem()),
    jsonResponse({ results: [state()], next_page_results: false, next_cursor: null }),
    jsonResponse(workItem({ state: NEXT_STATE_ID })),
  ]);
  const result = await client.setState(REFERENCE, NEXT_STATE_ID);

  assert.deepEqual(result, {
    reference: REFERENCE,
    workItemId: WORK_ITEM_ID,
    stateId: NEXT_STATE_ID,
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].options.method, "PATCH");
  assert.equal(calls[2].options.redirect, "error");
  assert.equal(
    calls[2].url,
    `${BASE_URL}/api/v1/workspaces/acme/projects/${PROJECT_ID}/work-items/${WORK_ITEM_ID}/`,
  );
  assert.deepEqual(JSON.parse(calls[2].options.body), { state: NEXT_STATE_ID });
});

test("requires the PATCH response to confirm the selected state", async () => {
  const { state: omittedState, ...withoutState } = workItem();
  for (const [label, patchResponse] of [
    ["missing", withoutState],
    ["null", workItem({ state: null })],
    ["malformed", workItem({ state: "not-a-uuid" })],
    ["mismatched", workItem({ state: CURRENT_STATE_ID })],
  ]) {
    const { client, calls } = clientFor([
      jsonResponse(workItem()),
      jsonResponse({ results: [state()], next_page_results: false, next_cursor: null }),
      jsonResponse(patchResponse),
    ]);

    await assertErrorCode(client.setState(REFERENCE, NEXT_STATE_ID), "RESPONSE_ERROR");
    assert.equal(calls.length, 3, label);
  }
  assert.equal(omittedState, CURRENT_STATE_ID);
});

test("rejects unknown states and malformed responses before a dependent write", async () => {
  const unknownState = clientFor([
    jsonResponse(workItem()),
    jsonResponse({ results: [state({ id: CURRENT_STATE_ID })], next_page_results: false, next_cursor: null }),
  ]);
  await assertErrorCode(unknownState.client.setState(REFERENCE, NEXT_STATE_ID), "STATE_ERROR");
  assert.equal(unknownState.calls.length, 2);

  const malformedItem = clientFor([jsonResponse(workItem({ id: "not-a-uuid" }))]);
  await assertErrorCode(malformedItem.client.listComments(REFERENCE), "RESPONSE_ERROR");
  assert.equal(malformedItem.calls.length, 1);
});

test("assigns preflight-unassigned items only after all project cursor pages are read", async () => {
  const secondWorkItem = workItem({
    id: SECOND_WORK_ITEM_ID,
    sequence_id: 124,
    assignees: [],
  });
  const alreadyAssignedWorkItem = workItem({
    id: LABEL_ID,
    sequence_id: 125,
    assignees: [LABEL_ID],
  });
  const { client, calls } = clientFor([
    jsonResponse({ results: [project()], next_page_results: false, next_cursor: null }),
    jsonResponse([workspaceMember()]),
    jsonResponse({
      results: [workItem({ assignees: [] }), alreadyAssignedWorkItem],
      next_page_results: true,
      next_cursor: "second-page",
    }),
    jsonResponse({ results: [secondWorkItem], next_page_results: false, next_cursor: null }),
    jsonResponse(workItem({ assignees: [] })),
    jsonResponse(workItem({ assignees: [ASSIGNEE_ID] })),
    jsonResponse(secondWorkItem),
    jsonResponse(workItem({
      id: SECOND_WORK_ITEM_ID,
      sequence_id: 124,
      assignees: [ASSIGNEE_ID],
    })),
  ]);

  const result = await client.assignUnassigned(PROJECT_REFERENCE, ASSIGNEE_ID);

  assert.deepEqual(result, {
    projectReference: PROJECT_REFERENCE,
    memberId: ASSIGNEE_ID,
    assignedCount: 2,
    assignedReferences: [REFERENCE, "plane:acme:PROJ-124"],
    skippedChangedReferences: [],
  });
  assert.deepEqual(
    calls.slice(0, 4).map((call) => call.options.method),
    ["GET", "GET", "GET", "GET"],
  );
  assert.deepEqual(
    calls.slice(4).map((call) => call.options.method),
    ["GET", "PATCH", "GET", "PATCH"],
  );
  assert.equal(calls[1].url, `${BASE_URL}/api/v1/workspaces/acme/members/`);
  assert.equal(
    calls[2].url,
    `${BASE_URL}/api/v1/workspaces/acme/projects/${PROJECT_ID}/work-items/?per_page=100`,
  );
  assert.equal(
    calls[3].url.endsWith("?per_page=100&cursor=second-page"), true);

  const patchCalls = calls.filter((call) => call.options.method === "PATCH");
  assert.equal(patchCalls.length, 2);
  assert.deepEqual(
    patchCalls.map((call) => call.url),
    [
      `${BASE_URL}/api/v1/workspaces/acme/projects/${PROJECT_ID}/work-items/${WORK_ITEM_ID}/`,
      `${BASE_URL}/api/v1/workspaces/acme/projects/${PROJECT_ID}/work-items/${SECOND_WORK_ITEM_ID}/`,
    ],
  );
  assert.deepEqual(
    patchCalls.map((call) => JSON.parse(call.options.body)),
    [{ assignees: [ASSIGNEE_ID] }, { assignees: [ASSIGNEE_ID] }],
  );
});

test("requires literal assignment confirmation before configuration or network access", async () => {
  for (const argv of [
    ["plane:assign-unassigned", PROJECT_REFERENCE, ASSIGNEE_ID],
    ["plane:assign-unassigned", PROJECT_REFERENCE, ASSIGNEE_ID, "Confirm"],
    ["plane:assign-unassigned", PROJECT_REFERENCE, ASSIGNEE_ID, "confirm", "extra"],
  ]) {
    const stdout = outputWriter();
    const stderr = outputWriter();
    let fetchCalls = 0;
    const env = new Proxy({}, {
      get: () => { throw new Error("configuration must not be read"); },
    });
    const exitCode = await runPlaneApi({
      argv,
      env,
      stdout: stdout.writer,
      stderr: stderr.writer,
      fetchImpl: async () => { fetchCalls += 1; },
    });

    assert.equal(exitCode, 2);
    assert.equal(JSON.parse(stderr.output()).error.code, "USAGE_ERROR");
    assert.equal(stdout.output(), "");
    assert.equal(fetchCalls, 0);
  }
});

test("fails closed for invalid or ambiguous target members before project-item writes", async () => {
  const invalidReference = clientFor([]);
  await assertErrorCode(
    invalidReference.client.assignUnassigned("plane:acme:PROJ-1", ASSIGNEE_ID),
    "REFERENCE_ERROR",
  );
  assert.equal(invalidReference.calls.length, 0);

  const invalidMemberId = clientFor([]);
  await assertErrorCode(
    invalidMemberId.client.assignUnassigned(PROJECT_REFERENCE, "not-a-uuid"),
    "MEMBER_ERROR",
  );
  assert.equal(invalidMemberId.calls.length, 0);

  for (const members of [
    [],
    [workspaceMember(), workspaceMember()],
    [{ id: { id: ASSIGNEE_ID } }],
    [workspaceMember(), { id: { id: LABEL_ID } }],
    { results: [workspaceMember()] },
  ]) {
    const { client, calls } = clientFor([
      jsonResponse({ results: [project()], next_page_results: false, next_cursor: null }),
      jsonResponse(members),
    ]);

    await assertErrorCode(client.assignUnassigned(PROJECT_REFERENCE, ASSIGNEE_ID), "MEMBER_ERROR");
    assert.equal(calls.length, 2);
    assert.equal(calls.some((call) => call.options.method === "PATCH"), false);
  }
});

test("fails before a write when preflight assignees are absent or malformed", async () => {
  const { assignees: omittedAssignees, ...withoutAssignees } = workItem();

  for (const rawWorkItem of [
    withoutAssignees,
    workItem({ assignees: null }),
    workItem({ assignees: "not-an-array" }),
    workItem({ assignees: ["not-a-uuid"] }),
    workItem({ project: LABEL_ID, assignees: [] }),
  ]) {
    const { client, calls } = clientFor([
      jsonResponse({ results: [project()], next_page_results: false, next_cursor: null }),
      jsonResponse([workspaceMember()]),
      jsonResponse({ results: [rawWorkItem], next_page_results: false, next_cursor: null }),
    ]);

    await assertErrorCode(client.assignUnassigned(PROJECT_REFERENCE, ASSIGNEE_ID), "RESPONSE_ERROR");
    assert.equal(calls.length, 3);
    assert.equal(calls.some((call) => call.options.method === "PATCH"), false);
  }

  assert.deepEqual(omittedAssignees, [ASSIGNEE_ID]);
});

test("skips an item assigned between preflight and its reread", async () => {
  const { client, calls } = clientFor([
    jsonResponse({ results: [project()], next_page_results: false, next_cursor: null }),
    jsonResponse([workspaceMember()]),
    jsonResponse({ results: [workItem({ assignees: [] })], next_page_results: false, next_cursor: null }),
    jsonResponse(workItem({ assignees: [LABEL_ID] })),
  ]);

  const result = await client.assignUnassigned(PROJECT_REFERENCE, ASSIGNEE_ID);

  assert.deepEqual(result, {
    projectReference: PROJECT_REFERENCE,
    memberId: ASSIGNEE_ID,
    assignedCount: 0,
    assignedReferences: [],
    skippedChangedReferences: [REFERENCE],
  });
  assert.equal(calls.length, 4);
  assert.equal(calls.some((call) => call.options.method === "PATCH"), false);
});

test("fails before PATCH when a reread changes identity or lacks explicit assignees", async () => {
  for (const rereadWorkItem of [
    workItem({ id: SECOND_WORK_ITEM_ID, assignees: [] }),
    workItem({ project: LABEL_ID, assignees: [] }),
    workItem({ assignees: null }),
  ]) {
    const { client, calls } = clientFor([
      jsonResponse({ results: [project()], next_page_results: false, next_cursor: null }),
      jsonResponse([workspaceMember()]),
      jsonResponse({ results: [workItem({ assignees: [] })], next_page_results: false, next_cursor: null }),
      jsonResponse(rereadWorkItem),
    ]);

    await assertErrorCode(client.assignUnassigned(PROJECT_REFERENCE, ASSIGNEE_ID), "RESPONSE_ERROR");
    assert.equal(calls.length, 4);
    assert.equal(calls.some((call) => call.options.method === "PATCH"), false);
  }
});

test("requires each assignment PATCH response to confirm only the target member", async () => {
  const { assignees: omittedAssignees, ...withoutAssignees } = workItem();

  for (const patchResponse of [
    withoutAssignees,
    workItem({ assignees: [] }),
    workItem({ assignees: [LABEL_ID] }),
    workItem({ assignees: [ASSIGNEE_ID, ASSIGNEE_ID] }),
  ]) {
    const { client, calls } = clientFor([
      jsonResponse({ results: [project()], next_page_results: false, next_cursor: null }),
      jsonResponse([workspaceMember()]),
      jsonResponse({ results: [workItem({ assignees: [] })], next_page_results: false, next_cursor: null }),
      jsonResponse(workItem({ assignees: [] })),
      jsonResponse(patchResponse),
    ]);

    await assertErrorCode(client.assignUnassigned(PROJECT_REFERENCE, ASSIGNEE_ID), "RESPONSE_ERROR");
    assert.equal(calls.length, 5);
    assert.deepEqual(JSON.parse(calls[4].options.body), { assignees: [ASSIGNEE_ID] });
  }

  assert.deepEqual(omittedAssignees, [ASSIGNEE_ID]);
});

test("CLI emits the confirmed assignment envelope", async () => {
  const queue = queuedFetch([
    jsonResponse({ results: [project()], next_page_results: false, next_cursor: null }),
    jsonResponse([workspaceMember()]),
    jsonResponse({ results: [workItem({ assignees: [] })], next_page_results: false, next_cursor: null }),
    jsonResponse(workItem({ assignees: [] })),
    jsonResponse(workItem({ assignees: [ASSIGNEE_ID] })),
  ]);
  const stdout = outputWriter();
  const stderr = outputWriter();
  const exitCode = await runPlaneApi({
    argv: ["plane:assign-unassigned", PROJECT_REFERENCE, ASSIGNEE_ID, "confirm"],
    env: { PLANE_BASE_URL: BASE_URL, PLANE_API_KEY: API_KEY },
    stdout: stdout.writer,
    stderr: stderr.writer,
    fetchImpl: queue.fetchImpl,
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(stdout.output()), {
    success: true,
    data: {
      projectReference: PROJECT_REFERENCE,
      memberId: ASSIGNEE_ID,
      assignedCount: 1,
      assignedReferences: [REFERENCE],
      skippedChangedReferences: [],
    },
  });
  assert.equal(stderr.output(), "");
  assert.deepEqual(JSON.parse(queue.calls[4].options.body), { assignees: [ASSIGNEE_ID] });
});

test("CLI emits stable envelopes without a write-level confirmation flag", async () => {
  const queue = queuedFetch([jsonResponse(workItem()), jsonResponse(comment())]);
  const stdout = outputWriter();
  const stderr = outputWriter();
  const exitCode = await runPlaneApi({
    argv: ["plane:comment", REFERENCE, "approved", "plain", "text"],
    env: { PLANE_BASE_URL: BASE_URL, PLANE_API_KEY: API_KEY },
    stdout: stdout.writer,
    stderr: stderr.writer,
    fetchImpl: queue.fetchImpl,
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(stdout.output()), {
    success: true,
    data: {
      reference: REFERENCE,
      workItemId: WORK_ITEM_ID,
      commentId: COMMENT_ID,
    },
  });
  assert.equal(stderr.output(), "");
  assert.deepEqual(JSON.parse(queue.calls[1].options.body), {
    comment_html: "<p>approved plain text</p>",
  });
});

test("CLI reports unsupported commands and invalid arity as usage errors", async () => {
  for (const argv of [["plane:delete", REFERENCE], ["plane:set-state", REFERENCE]]) {
    const stdout = outputWriter();
    const stderr = outputWriter();
    const exitCode = await runPlaneApi({ argv, stdout: stdout.writer, stderr: stderr.writer });

    assert.equal(exitCode, 2);
    assert.equal(JSON.parse(stderr.output()).error.code, "USAGE_ERROR");
    assert.equal(stdout.output(), "");
  }
});

test("CLI treats inherited command names as unsupported before configuration or fetch", async () => {
  for (const commandName of ["__proto__", "constructor", "toString"]) {
    const stdout = outputWriter();
    const stderr = outputWriter();
    let fetchCalls = 0;
    const env = new Proxy({}, {
      get: () => { throw new Error("configuration must not be read"); },
    });
    const exitCode = await runPlaneApi({
      argv: [commandName],
      env,
      stdout: stdout.writer,
      stderr: stderr.writer,
      fetchImpl: async () => { fetchCalls += 1; },
    });

    assert.equal(exitCode, 2);
    assert.equal(JSON.parse(stderr.output()).error.code, "USAGE_ERROR");
    assert.equal(stdout.output(), "");
    assert.equal(fetchCalls, 0);
  }
});
