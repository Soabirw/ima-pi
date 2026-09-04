import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTaskwarriorWorkItemDescription,
  normalizeTaskwarriorAnnotations,
} from "../lib/plane-taskwarrior-description.ts";
import { normalizeTaskwarriorTimestamp } from "../lib/plane-taskwarrior-migration.ts";

const FIRST_DEPENDENCY = "00000000-0000-4000-8000-000000000001";
const SECOND_DEPENDENCY = "00000000-0000-4000-8000-000000000002";
const TASK_UUID = "00000000-0000-4000-8000-000000000003";

const normalizeAnnotations = (annotations) => normalizeTaskwarriorAnnotations({
  annotations,
  normalizeTimestamp: normalizeTaskwarriorTimestamp,
});

const normalizedTask = (overrides = {}) => ({
  uuid: TASK_UUID,
  project: "ima-pi.plane",
  status: "pending",
  description: "Migrate task details",
  priority: "high",
  entry: "2026-09-01T00:00:00.000Z",
  modified: "2026-09-02T00:00:00.000Z",
  end: null,
  wait: "2026-09-03T00:00:00.000Z",
  depends: [FIRST_DEPENDENCY, SECOND_DEPENDENCY],
  annotations: normalizeAnnotations([]),
  ...overrides,
});

test("normalizes absent Taskwarrior annotations to an immutable empty list", () => {
  const annotations = normalizeAnnotations(undefined);
  const nullAnnotations = normalizeAnnotations(null);

  assert.deepEqual(annotations, []);
  assert.equal(Object.isFrozen(annotations), true);
  assert.deepEqual(
    [nullAnnotations, Object.isFrozen(nullAnnotations)],
    [[], true],
  );
});

test("normalizes and deterministically sorts copied annotation records", () => {
  const annotations = normalizeAnnotations([
    { entry: "20260902T000000Z", description: "Zulu" },
    { entry: "20260901T000000Z", description: "Bravo" },
    { entry: "20260901T000000Z", description: "Alpha" },
  ]);

  assert.deepEqual(annotations, [
    { entry: "2026-09-01T00:00:00.000Z", description: "Alpha" },
    { entry: "2026-09-01T00:00:00.000Z", description: "Bravo" },
    { entry: "2026-09-02T00:00:00.000Z", description: "Zulu" },
  ]);
  assert.equal(Object.isFrozen(annotations), true);
  assert.equal(annotations.every(Object.isFrozen), true);
});

test("orders equal-timestamp annotations by code units regardless of input order", () => {
  const first = normalizeAnnotations([
    { entry: "20260901T000000Z", description: "ä" },
    { entry: "20260901T000000Z", description: "z" },
  ]);
  const second = normalizeAnnotations([
    { entry: "20260901T000000Z", description: "z" },
    { entry: "20260901T000000Z", description: "ä" },
  ]);

  assert.deepEqual(first.map((annotation) => annotation.description), ["z", "ä"]);
  assert.equal(
    buildTaskwarriorWorkItemDescription(normalizedTask({ annotations: first })),
    buildTaskwarriorWorkItemDescription(normalizedTask({ annotations: second })),
  );
});

test("preserves multiline Taskwarrior annotation text", () => {
  const annotationText = "Lifecycle unit: detail migration\n\nChecklist:\n[ ] Preserve all text";
  const [annotation] = normalizeAnnotations([
    { entry: "20260901T184804Z", description: annotationText },
  ]);

  assert.equal(annotation.description, annotationText);
});

test("rejects malformed Taskwarrior annotation input", () => {
  assert.throws(() => normalizeAnnotations({}), /task_annotations_invalid/);
  assert.throws(() => normalizeAnnotations([null]), /task_annotation_invalid/);
  assert.throws(
    () => normalizeAnnotations([{ entry: "invalid", description: "Valid text" }]),
    /timestamp_invalid/,
  );
  assert.throws(
    () => normalizeAnnotations([{ entry: "20260901T000000Z", description: " \n " }]),
    /task_annotation_description_invalid/,
  );
});

test("renders annotations, approved task metadata, and provenance", () => {
  const annotations = normalizeAnnotations([
    { entry: "20260901T184804Z", description: "Business outcome:\nPlane detail persists" },
  ]);
  const description = buildTaskwarriorWorkItemDescription(normalizedTask({ annotations }));

  assert.equal(description.includes("--- Taskwarrior annotations ---"), true);
  assert.equal(description.includes("entry: 2026-09-01T18:48:04.000Z"), true);
  assert.equal(description.includes("Business outcome:\nPlane detail persists"), true);
  assert.equal(description.includes("project: ima-pi.plane"), true);
  assert.equal(description.includes("status: pending"), true);
  assert.equal(description.includes("priority: high"), true);
  assert.equal(description.includes("wait: 2026-09-03T00:00:00.000Z"), true);
  assert.equal(description.includes(`depends: ${FIRST_DEPENDENCY}, ${SECOND_DEPENDENCY}`), true);
  assert.equal(description.includes("--- Taskwarrior provenance ---"), true);
  assert.equal(description.includes(`Taskwarrior UUID: ${TASK_UUID}`), true);
});

test("renders absent optional values as none", () => {
  const description = buildTaskwarriorWorkItemDescription(normalizedTask({
    project: null,
    wait: null,
    depends: [],
  }));

  assert.equal(description.includes("project: none"), true);
  assert.equal(description.includes("wait: none"), true);
  assert.equal(description.includes("depends: none"), true);
  assert.equal(description.includes("end: none"), true);
});

test("renders dependencies in their normalized sorted order", () => {
  const description = buildTaskwarriorWorkItemDescription(normalizedTask());

  assert.equal(
    description.includes(`depends: ${FIRST_DEPENDENCY}, ${SECOND_DEPENDENCY}`),
    true,
  );
});

test("does not mutate annotation or task input", () => {
  const sourceAnnotations = [
    { entry: "20260901T184804Z", description: "Original annotation" },
  ];
  const originalAnnotations = structuredClone(sourceAnnotations);
  const annotations = normalizeAnnotations(sourceAnnotations);
  const task = normalizedTask({ annotations });
  const originalTask = structuredClone(task);

  buildTaskwarriorWorkItemDescription(task);

  assert.deepEqual(sourceAnnotations, originalAnnotations);
  assert.deepEqual(task, originalTask);
});
