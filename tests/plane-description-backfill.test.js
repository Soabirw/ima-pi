import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkItem, PlaneApiError } from "../skills/plane-api/scripts/plane-client.mjs";
import {
  applyMigrationBackfills,
  initialMigrationCheckpoint,
  MigrationExecutionError,
} from "../lib/plane-taskwarrior-migration-execution.ts";
import { isBlankDescription } from "../lib/plane-taskwarrior-description-backfill.ts";

const TASK_UUID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_ID = "33333333-3333-4333-8333-333333333333";
const STATE_ID = "44444444-4444-4444-8444-444444444444";
const PLAN_HASH = "a".repeat(64);

const rawWorkItem = (overrides = {}) => ({
  id: ITEM_ID,
  project: PROJECT_ID,
  sequence_id: 1,
  name: "Migrated task",
  description_stripped: "",
  state: STATE_ID,
  priority: "medium",
  assignees: [],
  labels: [],
  external_id: TASK_UUID,
  external_source: "taskwarrior",
  ...overrides,
});

const plan = {
  planSha256: PLAN_HASH,
  items: [],
  eligibleRelations: [],
  skippedRelations: [],
};
const backfillPlan = {
  schemaVersion: 1,
  planSha256: PLAN_HASH,
  updates: [{
    taskUuid: TASK_UUID,
    workspace: "ima",
    projectId: PROJECT_ID,
    itemId: ITEM_ID,
    descriptionStripped: "Taskwarrior provenance",
  }],
};

const applyBackfill = async (client) => applyMigrationBackfills({
  client,
  plan,
  backfillPlan,
  checkpoint: initialMigrationCheckpoint(plan),
  artifactApi: { writeCheckpoint: async () => {} },
  run: { path: ".ima/test" },
  toErrorCode: (error) => error instanceof PlaneApiError ? error.code : "PLANE_ERROR",
});

test("treats HTML-only human content as nonblank and does not overwrite it", async () => {
  const existing = normalizeWorkItem(rawWorkItem({
    description_stripped: undefined,
    description_html: "<p>Human <strong>requirements</strong></p>",
  }));
  let updateCalls = 0;
  const checkpoint = await applyBackfill({
    listProjectWorkItems: async () => [existing],
    updateProjectWorkItemDescription: async () => { updateCalls += 1; },
  });

  assert.equal(isBlankDescription(existing.description), false);
  assert.equal(updateCalls, 0);
  assert.equal(checkpoint.backfillOutcomesByTaskUuid[TASK_UUID], "skipped");
});

test("keeps verified empty supported descriptions eligible for a backfill", async () => {
  const existing = normalizeWorkItem(rawWorkItem());
  const updates = [];
  const checkpoint = await applyBackfill({
    listProjectWorkItems: async () => [existing],
    updateProjectWorkItemDescription: async (request) => { updates.push(request); },
  });

  assert.equal(isBlankDescription(existing.description), true);
  assert.deepEqual(updates, [{
    workspace: "ima",
    projectId: PROJECT_ID,
    workItemId: ITEM_ID,
    descriptionStripped: "Taskwarrior provenance",
  }]);
  assert.equal(checkpoint.backfillOutcomesByTaskUuid[TASK_UUID], "updated");
});

test("stops before a backfill write when description normalization fails", async () => {
  for (const overrides of [
    { description_stripped: undefined, description_html: "<script>unrecoverable</script>" },
    { description_stripped: undefined, description_html: "<p> </p>", description_binary: "opaque" },
    { description_stripped: undefined, description_html: "<!-- no content -->", description_binary: "opaque" },
  ]) {
    let updateCalls = 0;
    await assert.rejects(
      applyBackfill({
        listProjectWorkItems: async () => [normalizeWorkItem(rawWorkItem(overrides))],
        updateProjectWorkItemDescription: async () => { updateCalls += 1; },
      }),
      (error) => error instanceof MigrationExecutionError && error.code === "BACKFILL_DESCRIPTION_ERROR",
    );
    assert.equal(updateCalls, 0);
  }
});
