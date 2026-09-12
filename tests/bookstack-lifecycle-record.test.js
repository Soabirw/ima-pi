import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCorpusLifecycleRecord } from "../lib/ima-context.ts";
import { parseLifecycleSearchRecords } from "../lib/ima-cycle.ts";
import {
  chapterSelectorFor,
  createLifecycleRecord,
  lifecycleRecordProjection,
  parseLifecycleRecord,
  validateProjectSlug,
} from "../lib/bookstack-lifecycle-record.ts";

const sourceRef = "taskwarrior:shared-dev-memory:cc4755dd-67bf-49a6-8e2d-6563d080dde1";
const identity = {
  project: "shared-dev-memory",
  lifecycleKey: "shared-dev-memory:manual:test",
  lifecycleRootMemoryId: "root",
  taskwarriorProject: "shared-dev-memory",
  taskwarriorTask: "T13",
  taskwarriorUuid: "cc4755dd-67bf-49a6-8e2d-6563d080dde1",
  jiraKey: "",
  sourceRefs: [sourceRef],
  priorArtifactIds: [],
};
const placement = {
  projectSlug: "shared-dev-memory",
  sourceRef,
  lifecycleKey: identity.lifecycleKey,
  shelfId: 1,
  shelfSlug: "lifecycle-artifacts",
  bookId: 2,
  bookSlug: "shared-dev-memory",
  chapterId: 3,
  chapterSlug: "taskwarrior-cc4755dd-67bf-49a6-8e2d-6563d080dde1",
};
const request = { type: "plan", identity, summary: "Approved plan", artifact: "# Plan\n\nApproved." };

const validProjection = (record) => {
  const projection = lifecycleRecordProjection(record);
  assert.deepEqual(normalizeCorpusLifecycleRecord({
    lifecycleKey: record.lifecycleKey,
    record: projection,
  }), {
    id: record.artifactId,
    recordKey: record.recordKey,
    content: record.artifact,
  });
  return projection;
};

test("record round-trip binds the exact envelope, control, identity, summary, and artifact", () => {
  const record = createLifecycleRecord({ request, placement });
  assert.match(record.pageMarkdown, /^---\nschema: ima-memory\/v1/m);
  assert.equal(parseLifecycleRecord(record.pageMarkdown)?.pageMarkdown, record.pageMarkdown);

  for (const changed of [
    record.pageMarkdown.replace(sourceRef, "taskwarrior:shared-dev-memory:00000000-0000-0000-0000-000000000000"),
    record.pageMarkdown.replace('"priorArtifactIds":[]', '"priorArtifactIds":["changed"]'),
    record.pageMarkdown.replace('"summary":"Approved plan"', '"summary":"Changed summary"'),
    record.pageMarkdown.replace('{"schemaVersion":1', '{"extra":true,"schemaVersion":1'),
    record.pageMarkdown.replace("schema: ima-memory/v1", "schema: other/v1"),
    record.pageMarkdown.replace("\n\n# Plan", "\n\n\n# Plan"),
    record.pageMarkdown.replace("Approved.", "Changed."),
  ]) assert.equal(parseLifecycleRecord(changed), null);
  assert.equal(parseLifecycleRecord("x".repeat(512_001)), null);
});

test("reconstruction sentinel in valid metadata or payload round-trips", () => {
  for (const requestValue of [
    { ...request, identity: { ...identity, lifecycleRootMemoryId: "ima-bookstack-original-payload" } },
    { ...request, artifact: "# ima-bookstack-original-payload" },
  ]) {
    const record = createLifecycleRecord({ request: requestValue, placement });
    assert.equal(parseLifecycleRecord(record.pageMarkdown)?.pageMarkdown, record.pageMarkdown);
  }
});

test("same artifact identity with a different summary produces different full page evidence", () => {
  const original = createLifecycleRecord({ request, placement });
  const changed = createLifecycleRecord({
    request: { ...request, summary: "Changed summary" },
    placement,
  });
  assert.equal(changed.artifactId, original.artifactId);
  assert.notEqual(changed.pageMarkdown, original.pageMarkdown);
  assert.equal(parseLifecycleRecord(changed.pageMarkdown)?.summary, "Changed summary");
  const newPayload = createLifecycleRecord({
    request: { ...request, artifact: "# Revised plan" },
    placement,
  });
  assert.notEqual(newPayload.artifactId, original.artifactId);
  assert.equal(parseLifecycleRecord(newPayload.pageMarkdown)?.artifactId, newPayload.artifactId);
});

test("direct projections satisfy context and cycle consumers without injected authority fields", () => {
  const record = createLifecycleRecord({ request, placement });
  const projection = validProjection(record);
  assert.equal(projection.lifecycleKey, identity.lifecycleKey);
  const parsed = parseLifecycleSearchRecords({ results: [projection] }, {
    lifecycleKey: identity.lifecycleKey,
    phase: "plan",
    jiraKey: "",
    taskwarriorUuid: identity.taskwarriorUuid,
  });
  assert.equal(parsed.records[0].verified, true);
  assert.equal(parseLifecycleSearchRecords({ results: [projection] }, {
    lifecycleKey: "other",
    phase: "plan",
    jiraKey: "",
    taskwarriorUuid: identity.taskwarriorUuid,
  }).records[0].verified, false);
});

test("Jira and Plane projections pass existing context and cycle consumers", () => {
  const cases = [
    {
      sourceRef: "jira:FNR-3014",
      identity: {
        ...identity,
        taskwarriorProject: "",
        taskwarriorTask: "",
        taskwarriorUuid: "",
        jiraKey: "FNR-3014",
        sourceRefs: ["jira:FNR-3014"],
      },
      chapterSlug: "fnr-3014",
      selection: { jiraKey: "FNR-3014", taskwarriorUuid: "" },
    },
    {
      sourceRef: "plane:ima:SKYNET-94",
      identity: {
        ...identity,
        taskwarriorProject: "",
        taskwarriorTask: "",
        taskwarriorUuid: "",
        jiraKey: "",
        planeWorkspace: "ima",
        planeWorkItem: "SKYNET-94",
        sourceRefs: ["plane:ima:SKYNET-94"],
      },
      chapterSlug: "skynet-94",
      selection: {
        jiraKey: "",
        taskwarriorUuid: "",
        planeWorkspace: "ima",
        planeWorkItem: "SKYNET-94",
      },
    },
  ];
  for (const item of cases) {
    const itemPlacement = {
      ...placement,
      sourceRef: item.sourceRef,
      chapterSlug: item.chapterSlug,
    };
    const record = createLifecycleRecord({
      request: { ...request, identity: item.identity },
      placement: itemPlacement,
    });
    const projection = validProjection(record);
    const parsed = parseLifecycleSearchRecords({ results: [projection] }, {
      lifecycleKey: identity.lifecycleKey,
      phase: "plan",
      ...item.selection,
    });
    assert.equal(parsed.records[0].verified, true);
  }
});

test("placement selectors and source-bound placement fail closed", () => {
  assert.equal(validateProjectSlug("ima-pi"), "ima-pi");
  assert.throws(() => validateProjectSlug("IMA PI"), /bookstack_project_slug_invalid/);
  assert.equal(chapterSelectorFor({ sourceRef, lifecycleKey: identity.lifecycleKey }), placement.chapterSlug);
  assert.match(chapterSelectorFor({
    sourceRef: "lifecycle:shared-dev-memory:manual:test",
    lifecycleKey: identity.lifecycleKey,
  }), /^lifecycle-[a-f0-9]{64}$/);
  assert.throws(() => createLifecycleRecord({
    request,
    placement: { ...placement, bookSlug: "ima-pi" },
  }), /bookstack_placement_invalid/);
});
