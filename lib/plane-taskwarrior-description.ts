const migrationFailure = (code) => {
  throw new Error(`plane_taskwarrior_migration_${code}`);
};

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const compareCodeUnits = (left, right) => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const displayValue = (value) => value ?? "none";

const dependencyText = (dependencies) => (
  Array.isArray(dependencies) && dependencies.length > 0 ? dependencies.join(", ") : "none"
);

const annotationSection = (annotations) => {
  if (annotations.length === 0) return null;

  const annotationText = annotations
    .map(({ entry, description }) => `entry: ${entry}\n${description}`)
    .join("\n\n");
  return `--- Taskwarrior annotations ---\n${annotationText}`;
};

export const buildHistoricalTaskwarriorWorkItemDescription = (task) => [
  task.description,
  "",
  "--- Taskwarrior provenance ---",
  `Taskwarrior UUID: ${task.uuid}`,
  `entry: ${task.entry}`,
  `modified: ${task.modified}`,
  `end: ${task.end ?? "none"}`,
].join("\n");

export const normalizeTaskwarriorAnnotations = (value) => {
  if (!isRecord(value)) migrationFailure("task_annotations_invalid");

  const { annotations, normalizeTimestamp } = value;
  if (annotations === null || annotations === undefined) return Object.freeze([]);
  if (!Array.isArray(annotations) || typeof normalizeTimestamp !== "function") {
    migrationFailure("task_annotations_invalid");
  }

  const normalizedAnnotations = annotations.map((annotation) => {
    if (!isRecord(annotation)) migrationFailure("task_annotation_invalid");

    const entry = normalizeTimestamp(annotation.entry);
    if (typeof entry !== "string" || entry === "") {
      migrationFailure("task_annotation_timestamp_invalid");
    }
    if (typeof annotation.description !== "string" || annotation.description.trim() === "") {
      migrationFailure("task_annotation_description_invalid");
    }

    return Object.freeze({ entry, description: annotation.description });
  });

  return Object.freeze(normalizedAnnotations.sort((left, right) => (
    compareCodeUnits(left.entry, right.entry)
    || compareCodeUnits(left.description, right.description)
  )));
};

export const buildTaskwarriorWorkItemDescription = (task) => {
  const annotations = Array.isArray(task.annotations) ? task.annotations : [];

  return [
    displayValue(task.description),
    annotationSection(annotations),
    [
      "--- Taskwarrior task details ---",
      `project: ${displayValue(task.project)}`,
      `status: ${displayValue(task.status)}`,
      `priority: ${displayValue(task.priority)}`,
      `wait: ${displayValue(task.wait)}`,
      `depends: ${dependencyText(task.depends)}`,
    ].join("\n"),
    [
      "--- Taskwarrior provenance ---",
      `Taskwarrior UUID: ${displayValue(task.uuid)}`,
      `entry: ${displayValue(task.entry)}`,
      `modified: ${displayValue(task.modified)}`,
      `end: ${displayValue(task.end)}`,
    ].join("\n"),
  ].filter((section) => section !== null).join("\n\n");
};
