import assert from "node:assert/strict";
import test from "node:test";
import {
  PlaneApiError,
  createPlaneClient,
} from "../skills/plane-api/scripts/plane-client.mjs";

const API_KEY = "synthetic-plane-migration-key";
const BASE_URL = "https://plane.internal.example";
const WORKSPACE = "ima";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_PROJECT_ID = "99999999-9999-4999-8999-999999999999";
const WORK_ITEM_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ITEM_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_WORK_ITEM_ID = "66666666-6666-4666-8666-666666666666";
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

const workspaceProject = (overrides = {}) => ({
  id: PROJECT_ID,
  identifier: "DEST",
  name: "Destination",
  archived_at: null,
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
    client: createPlaneClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetchImpl: queue.fetchImpl,
      requestIntervalMs: 0,
    }),
  };
};

const assertErrorCode = async (promise, code) => {
  await assert.rejects(promise, (error) => error instanceof PlaneApiError && error.code === code);
};

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

test("lists token-scoped workspace projects with pagination, redirect rejection, and secret redaction", async () => {
  const { client, calls } = clientFor([
    jsonResponse({
      results: [workspaceProject({ name: `Destination ${API_KEY}` })],
      next_page_results: true,
      next_cursor: "next-projects",
    }),
    jsonResponse({
      results: [workspaceProject({ id: SECOND_PROJECT_ID, identifier: "SECOND", name: "Second" })],
      next_page_results: false,
      next_cursor: null,
    }),
  ]);

  const projects = await client.listWorkspaceProjects({ workspace: WORKSPACE });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${BASE_URL}/api/v1/workspaces/${WORKSPACE}/projects/?per_page=100`);
  assert.equal(calls[1].url, `${BASE_URL}/api/v1/workspaces/${WORKSPACE}/projects/?per_page=100&cursor=next-projects`);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(projects[0].name, "Destination [REDACTED]");
  assert.equal(projects[0].archivedAt, null);
  assert.equal(JSON.stringify(projects).includes(API_KEY), false);
});

test("requires explicit archive metadata before accepting a workspace project", async () => {
  const missingArchive = workspaceProject();
  delete missingArchive.archived_at;
  const invalidProjects = [
    missingArchive,
    workspaceProject({ archived_at: undefined }),
    workspaceProject({ archived_at: "" }),
    workspaceProject({ archived_at: 0 }),
  ];

  for (const rawProject of invalidProjects) {
    const { client } = clientFor([jsonResponse({
      results: [rawProject],
      next_page_results: false,
      next_cursor: null,
    })]);
    await assertErrorCode(client.listWorkspaceProjects({ workspace: WORKSPACE }), "RESPONSE_ERROR");
  }

  const archived = clientFor([jsonResponse({
    results: [workspaceProject({ archived_at: "2026-09-03T00:00:00Z" })],
    next_page_results: false,
    next_cursor: null,
  })]);
  const projects = await archived.client.listWorkspaceProjects({ workspace: WORKSPACE });
  assert.deepEqual(projects, [{
    id: PROJECT_ID,
    identifier: "DEST",
    name: "Destination",
    archivedAt: "2026-09-03T00:00:00Z",
  }]);
});

test("lists source-filtered project items with pagination and validates their project identity", async () => {
  const { client, calls } = clientFor([
    jsonResponse({
      results: [workItem({ name: `Migrated ${API_KEY}` })],
      next_page_results: true,
      next_cursor: "next-items",
    }),
    jsonResponse({
      results: [workItem({ id: TARGET_ITEM_ID, external_id: "77777777-7777-4777-8777-777777777777" })],
      next_page_results: false,
      next_cursor: null,
    }),
  ]);

  const items = await client.listProjectItemsByExternalSource({
    workspace: WORKSPACE,
    projectId: PROJECT_ID,
    externalSource: "taskwarrior",
  });

  const sourceItemsUrl = [
    `${BASE_URL}/api/v1/workspaces/${WORKSPACE}/projects/${PROJECT_ID}`,
    "/work-items/?per_page=100&external_source=taskwarrior",
  ].join("");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, sourceItemsUrl);
  assert.equal(calls[1].url.endsWith("&cursor=next-items"), true);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(items[0].name, "Migrated [REDACTED]");
  assert.equal(JSON.stringify(items).includes(API_KEY), false);

  const invalid = clientFor([]);
  await assertErrorCode(invalid.client.listProjectItemsByExternalSource({
    workspace: WORKSPACE,
    projectId: "invalid",
    externalSource: "taskwarrior",
  }), "PROJECT_ERROR");
  assert.equal(invalid.calls.length, 0);

  const mismatched = clientFor([jsonResponse({
    results: [workItem({ project: SECOND_PROJECT_ID })],
    next_page_results: false,
    next_cursor: null,
  })]);
  await assertErrorCode(mismatched.client.listProjectItemsByExternalSource({
    workspace: WORKSPACE,
    projectId: PROJECT_ID,
    externalSource: "taskwarrior",
  }), "RESPONSE_ERROR");
});

test("filters source items when a Plane server ignores the source query", async () => {
  const { client, calls } = clientFor([
    jsonResponse({
      results: [
        workItem({
          id: TARGET_ITEM_ID,
          external_id: null,
          external_source: null,
        }),
        workItem({
          id: OTHER_WORK_ITEM_ID,
          external_id: null,
          external_source: "other-source",
        }),
      ],
      next_page_results: true,
      next_cursor: "next-unfiltered-items",
    }),
    jsonResponse({
      results: [workItem()],
      next_page_results: false,
      next_cursor: null,
    }),
  ]);

  const items = await client.listProjectItemsByExternalSource({
    workspace: WORKSPACE,
    projectId: PROJECT_ID,
    externalSource: "taskwarrior",
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.endsWith("&external_source=taskwarrior"), true);
  assert.equal(
    calls[1].url,
    `${BASE_URL}/api/v1/workspaces/${WORKSPACE}/projects/${PROJECT_ID}`
      + "/work-items/?per_page=100&external_source=taskwarrior&cursor=next-unfiltered-items",
  );
  assert.deepEqual(items.map(({ id, externalSource }) => ({ id, externalSource })), [{
    id: WORK_ITEM_ID,
    externalSource: "taskwarrior",
  }]);
});

test("validates project identity before filtering ignored source responses", async () => {
  const { client } = clientFor([jsonResponse({
    results: [workItem({
      project: SECOND_PROJECT_ID,
      external_source: "other-source",
    })],
    next_page_results: false,
    next_cursor: null,
  })]);

  await assertErrorCode(client.listProjectItemsByExternalSource({
    workspace: WORKSPACE,
    projectId: PROJECT_ID,
    externalSource: "taskwarrior",
  }), "RESPONSE_ERROR");
});
