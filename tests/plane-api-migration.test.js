import assert from "node:assert/strict";
import test from "node:test";
import {
  PlaneApiError,
  createPlaneClient,
  normalizeCreateWorkItemInput,
  normalizeWorkItemRelation,
} from "../skills/plane-api/scripts/plane-client.mjs";
import { runPlaneApi } from "../skills/plane-api/scripts/plane-api.mjs";

const API_KEY = "synthetic-plane-migration-key";
const BASE_URL = "https://plane.internal.example";
const WORKSPACE = "ima";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const WORK_ITEM_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ITEM_ID = "33333333-3333-4333-8333-333333333333";
const STATE_ID = "44444444-4444-4444-8444-444444444444";
const EXTERNAL_ID = "55555555-5555-4555-8555-555555555555";

const workItem = (overrides = {}) => ({
  id: WORK_ITEM_ID,
  project: PROJECT_ID,
  sequence_id: 1,
  name: "Migrated task",
  description_stripped: "Taskwarrior provenance",
  state: STATE_ID,
  priority: "high",
  assignees: [],
  labels: [],
  external_id: EXTERNAL_ID,
  external_source: "taskwarrior",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
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
    if (response === undefined) throw new Error("Unexpected request");
    return response;
  };
  return { calls, fetchImpl };
};

const clientFor = (responses) => {
  const queue = queuedFetch(responses);
  return {
    calls: queue.calls,
    client: createPlaneClient({ baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl: queue.fetchImpl }),
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

test("lists idempotency candidates with bounded pagination and redacts configured secrets", async () => {
  const { client, calls } = clientFor([
    jsonResponse({
      results: [workItem({ name: `Migrated ${API_KEY}` })],
      next_page_results: false,
      next_cursor: null,
    }),
  ]);
  const result = await client.listProjectWorkItems({
    workspace: WORKSPACE,
    projectId: PROJECT_ID,
    externalId: EXTERNAL_ID,
    externalSource: "taskwarrior",
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `${BASE_URL}/api/v1/workspaces/${WORKSPACE}/projects/${PROJECT_ID}/work-items/?per_page=100&external_id=${EXTERNAL_ID}&external_source=taskwarrior`,
  );
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers["X-API-Key"], API_KEY);
  assert.equal(result[0].name, "Migrated [REDACTED]");
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
});

test("treats a first-page exact-identity 404 as no match only after route proof", async () => {
  const { client, calls } = clientFor([
    jsonResponse({}, { ok: false, status: 404 }),
    jsonResponse({
      results: [workItem()],
      next_page_results: false,
      next_cursor: null,
    }),
  ]);

  const workItems = await client.listProjectWorkItems({
    workspace: WORKSPACE,
    projectId: PROJECT_ID,
    externalId: EXTERNAL_ID,
    externalSource: "taskwarrior",
  });

  assert.deepEqual(workItems, []);
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].url,
    `${BASE_URL}/api/v1/workspaces/${WORKSPACE}/projects/${PROJECT_ID}/work-items/?per_page=100&external_id=${EXTERNAL_ID}&external_source=taskwarrior`,
  );
  assert.equal(
    calls[1].url,
    `${BASE_URL}/api/v1/workspaces/${WORKSPACE}/projects/${PROJECT_ID}/work-items/?per_page=1`,
  );
  assert.equal(calls[1].url.includes("external_id"), false);
  assert.equal(calls[1].url.includes("external_source"), false);
  assert.equal(JSON.stringify(workItems).includes(API_KEY), false);
});

test("keeps route, cursor, and unrelated 404 failures blocking", async () => {
  const lookup = {
    workspace: WORKSPACE,
    projectId: PROJECT_ID,
    externalId: EXTERNAL_ID,
    externalSource: "taskwarrior",
  };
  const scenarios = [
    {
      name: "forbidden route proof",
      responses: [
        jsonResponse({}, { ok: false, status: 404 }),
        jsonResponse({}, { ok: false, status: 403 }),
      ],
      expectedCode: "HTTP_ERROR",
      expectedCalls: 2,
    },
    {
      name: "not-found route proof",
      responses: [
        jsonResponse({}, { ok: false, status: 404 }),
        jsonResponse({}, { ok: false, status: 404 }),
      ],
      expectedCode: "HTTP_ERROR",
      expectedCalls: 2,
    },
    {
      name: "malformed route proof",
      responses: [
        jsonResponse({}, { ok: false, status: 404 }),
        jsonResponse({ results: [] }),
      ],
      expectedCode: "RESPONSE_ERROR",
      expectedCalls: 2,
    },
    {
      name: "project-mismatched route proof",
      responses: [
        jsonResponse({}, { ok: false, status: 404 }),
        jsonResponse({
          results: [workItem({ project: "66666666-6666-4666-8666-666666666666" })],
          next_page_results: false,
          next_cursor: null,
        }),
      ],
      expectedCode: "RESPONSE_ERROR",
      expectedCalls: 2,
    },
    {
      name: "cursor-page 404",
      responses: [
        jsonResponse({
          results: [workItem()],
          next_page_results: true,
          next_cursor: "next-page",
        }),
        jsonResponse({}, { ok: false, status: 404 }),
      ],
      expectedCode: "HTTP_ERROR",
      expectedCalls: 2,
    },
  ];

  for (const scenario of scenarios) {
    const { client, calls } = clientFor(scenario.responses);
    await assertErrorCode(client.listProjectWorkItems(lookup), scenario.expectedCode);
    assert.equal(calls.length, scenario.expectedCalls, scenario.name);
  }

  const unrelated = clientFor([jsonResponse({}, { ok: false, status: 404 })]);
  await assertErrorCode(unrelated.client.createProjectWorkItem({
    workspace: WORKSPACE,
    projectId: PROJECT_ID,
    input: {
      name: "Migrated task",
      descriptionStripped: "Taskwarrior provenance",
      priority: "high",
      stateId: STATE_ID,
      externalId: EXTERNAL_ID,
      externalSource: "taskwarrior",
    },
  }), "HTTP_ERROR");
  assert.equal(unrelated.calls.length, 1);
});

test("rejects under-constrained identity lookups before fetch", async () => {
  const { client, calls } = clientFor([]);
  await assertErrorCode(client.listProjectWorkItems({
    workspace: WORKSPACE,
    projectId: PROJECT_ID,
    externalId: EXTERNAL_ID,
  }), "PROJECT_ERROR");
  assert.equal(calls.length, 0);
});

test("lists validated project states directly for migration preflight", async () => {
  const { client, calls } = clientFor([
    jsonResponse({
      results: [{
        id: STATE_ID,
        name: "Backlog",
        group: "backlog",
        color: null,
        sequence: 1,
      }],
      next_page_results: false,
      next_cursor: null,
    }),
  ]);

  const states = await client.listProjectStates({ workspace: WORKSPACE, projectId: PROJECT_ID });
  assert.deepEqual(states, [{
    id: STATE_ID,
    name: "Backlog",
    group: "backlog",
    color: null,
    sequence: 1,
  }]);
  assert.equal(
    calls[0].url,
    `${BASE_URL}/api/v1/workspaces/${WORKSPACE}/projects/${PROJECT_ID}/states/?per_page=100`,
  );

  const invalid = clientFor([]);
  await assertErrorCode(invalid.client.listProjectStates({ workspace: WORKSPACE }), "PROJECT_ERROR");
  assert.equal(invalid.calls.length, 0);
});

test("creates only a normalized migration work item and validates the returned identity", async () => {
  const { client, calls } = clientFor([jsonResponse(workItem())]);
  const input = {
    name: "Migrated task",
    descriptionStripped: "Taskwarrior provenance",
    priority: "high",
    stateId: STATE_ID,
    externalId: EXTERNAL_ID,
    externalSource: "taskwarrior",
  };
  const created = await client.createProjectWorkItem({
    workspace: WORKSPACE,
    projectId: PROJECT_ID,
    input,
  });

  assert.equal(created.id, WORK_ITEM_ID);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.redirect, "error");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    name: "Migrated task",
    description_stripped: "Taskwarrior provenance",
    priority: "high",
    state: STATE_ID,
    external_id: EXTERNAL_ID,
    external_source: "taskwarrior",
  });

  const invalid = clientFor([]);
  await assertErrorCode(invalid.client.createProjectWorkItem({
    workspace: WORKSPACE,
    projectId: PROJECT_ID,
    input: { ...input, completedAt: "2026-09-01T00:00:00Z" },
  }), "CREATE_ERROR");
  assert.equal(invalid.calls.length, 0);

  const mismatched = clientFor([jsonResponse(workItem({ external_source: "other" }))]);
  await assertErrorCode(mismatched.client.createProjectWorkItem({
    workspace: WORKSPACE,
    projectId: PROJECT_ID,
    input,
  }), "RESPONSE_ERROR");
});

test("lists and creates only blocked_by relations with UUID endpoints", async () => {
  const relations = clientFor([jsonResponse({ blocked_by: [TARGET_ITEM_ID] })]);
  const listed = await relations.client.listWorkItemRelations({
    workspace: WORKSPACE,
    projectId: PROJECT_ID,
    workItemId: WORK_ITEM_ID,
  });

  assert.deepEqual(listed.blockedByIds, [TARGET_ITEM_ID]);
  assert.equal(
    relations.calls[0].url,
    `${BASE_URL}/api/v1/workspaces/${WORKSPACE}/projects/${PROJECT_ID}/work-items/${WORK_ITEM_ID}/relations/`,
  );

  const created = clientFor([jsonResponse([[{ id: TARGET_ITEM_ID, relation_type: "blocked_by" }]])]);
  const result = await created.client.createWorkItemRelation({
    workspace: WORKSPACE,
    projectId: PROJECT_ID,
    workItemId: WORK_ITEM_ID,
    relation: { relationType: "blocked_by", issueIds: [TARGET_ITEM_ID] },
  });
  assert.deepEqual(result, {
    workItemId: WORK_ITEM_ID,
    relationType: "blocked_by",
    issueIds: [TARGET_ITEM_ID],
  });
  assert.deepEqual(JSON.parse(created.calls[0].options.body), {
    relation_type: "blocked_by",
    issues: [TARGET_ITEM_ID],
  });

  assert.throws(
    () => normalizeWorkItemRelation({ relationType: "blocking", issueIds: [TARGET_ITEM_ID] }),
    (error) => error.code === "RELATION_ERROR",
  );
  assert.throws(
    () => normalizeCreateWorkItemInput({ name: "Task" }),
    (error) => error.code === "CREATE_ERROR",
  );
});

test("fails closed when the relation list omits or corrupts blocked_by", async () => {
  for (const response of [{}, { blocked_by: null }]) {
    const { client } = clientFor([jsonResponse(response)]);
    await assertErrorCode(client.listWorkItemRelations({
      workspace: WORKSPACE,
      projectId: PROJECT_ID,
      workItemId: WORK_ITEM_ID,
    }), "RESPONSE_ERROR");
  }

  const empty = clientFor([jsonResponse({ blocked_by: [] })]);
  const result = await empty.client.listWorkItemRelations({
    workspace: WORKSPACE,
    projectId: PROJECT_ID,
    workItemId: WORK_ITEM_ID,
  });
  assert.deepEqual(result.blockedByIds, []);
});

test("fails malformed relation responses without a credential leak", async () => {
  const { client } = clientFor([jsonResponse([[{ id: WORK_ITEM_ID, relation_type: "blocked_by" }]])]);
  await assertErrorCode(client.createWorkItemRelation({
    workspace: WORKSPACE,
    projectId: PROJECT_ID,
    workItemId: WORK_ITEM_ID,
    relation: { relationType: "blocked_by", issueIds: [TARGET_ITEM_ID] },
  }), "RESPONSE_ERROR");
});

test("keeps migration commands out of the general Plane CLI before configuration or fetch", async () => {
  const stdout = outputWriter();
  const stderr = outputWriter();
  let fetchCalls = 0;
  const env = new Proxy({}, {
    get: () => { throw new Error("configuration must not be read"); },
  });
  const exitCode = await runPlaneApi({
    argv: ["plane:migrate", "anything"],
    env,
    stdout: stdout.writer,
    stderr: stderr.writer,
    fetchImpl: async () => { fetchCalls += 1; },
  });

  assert.equal(exitCode, 2);
  assert.equal(JSON.parse(stderr.output()).error.code, "USAGE_ERROR");
  assert.equal(stdout.output(), "");
  assert.equal(fetchCalls, 0);
});
