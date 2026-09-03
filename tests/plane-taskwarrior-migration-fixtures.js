const uuidFor = (number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;

export const DESTINATIONS = Object.freeze({
  WEB: Object.freeze({
    workspace: "ima",
    projectId: "0f641e48-5146-477d-9089-3a1ffc51169b",
    backlogStateId: "b6a6c51a-16fb-42fd-81fd-9d28949b7cc1",
    doneStateId: "122f911f-9199-4688-b6fb-e5a19a948a3c",
  }),
  SKYNET: Object.freeze({
    workspace: "ima",
    projectId: "1ed41e2e-c344-4205-9763-b9e7e1dba3a8",
    backlogStateId: "cde5138f-0070-4279-9940-18e55cc9f6d6",
    doneStateId: "e91a7f90-127d-4ae4-b1cf-bc2819a384b3",
  }),
});

const worksheetRow = ({
  project,
  total,
  pending,
  completed,
  deleted,
  migrate,
  workspace = "",
  projectName = "",
  projectKey = "",
  treatment,
}) => `| ${project} | ${total} | ${pending} | ${completed} | ${deleted} | ${migrate} | ${workspace} | ${projectName} | ${projectKey} | ${treatment} | |`;

export const migrationWorksheet = () => [
  "# Taskwarrior-to-Plane Project Mapping",
  "",
  "| Taskwarrior project | Total | Pending | Completed | Deleted | Migrate? | Plane workspace | Plane project name | Plane project key | Migration treatment | Notes |",
  "|---|---:|---:|---:|---:|---|---|---|---|---|---|",
  worksheetRow({
    project: "web-project",
    total: 76,
    pending: 20,
    completed: 56,
    deleted: 0,
    migrate: "Y",
    workspace: "ima",
    projectName: "Web",
    projectKey: "WEB",
    treatment: "Migrate pending and completed history",
  }),
  worksheetRow({
    project: "skynet-project",
    total: 176,
    pending: 37,
    completed: 139,
    deleted: 0,
    migrate: "Y",
    workspace: "ima",
    projectName: "Skynet",
    projectKey: "SKYNET",
    treatment: "Migrate pending and completed history",
  }),
  worksheetRow({
    project: "deleted-project",
    total: 20,
    pending: 0,
    completed: 0,
    deleted: 20,
    migrate: "N",
    treatment: "Skip — deleted-only project",
  }),
].join("\n");

const taskFor = ({ number, project, status, depends = [] }) => ({
  uuid: uuidFor(number),
  project,
  status,
  description: `Task ${number}`,
  priority: ["H", "M", "L", undefined][number % 4],
  entry: "20260901T000000Z",
  modified: "20260902T000000Z",
  ...(status === "completed" || status === "deleted" ? { end: "20260903T000000Z" } : {}),
  ...(depends.length > 0 ? { depends } : {}),
});

const appendWithinProjectEdges = (tasks, start, count, edgeCount) => {
  const edges = Array.from({ length: edgeCount }, (_, edgeIndex) => ({
    sourceIndex: start + (edgeIndex % count),
    targetIndex: start + ((edgeIndex % count + 1 + Math.floor(edgeIndex / count)) % count),
  }));
  return tasks.map((task, taskIndex) => ({
    ...task,
    ...(edges.some((edge) => edge.sourceIndex === taskIndex)
      ? { depends: edges.filter((edge) => edge.sourceIndex === taskIndex).map((edge) => tasks[edge.targetIndex].uuid) }
      : {}),
  }));
};

const appendSkippedEdges = (tasks) => tasks.map((task, index) => {
  const deletedStart = 252;
  const deletedToDeleted = index >= deletedStart && index < deletedStart + 9
    ? [tasks[deletedStart + ((index - deletedStart + 1) % 20)].uuid]
    : [];
  const deletedToCompleted = index === deletedStart + 9 ? [tasks[0].uuid] : [];
  const completedToDeleted = index === 1 ? [tasks[deletedStart + 10].uuid] : [];
  const extraDependencies = [...deletedToDeleted, ...deletedToCompleted, ...completedToDeleted];
  if (extraDependencies.length === 0) return task;

  return {
    ...task,
    depends: [...(task.depends ?? []), ...extraDependencies],
  };
});

export const migrationTasks = () => {
  const webTasks = Array.from({ length: 76 }, (_, index) => taskFor({
    number: index + 1,
    project: "web-project",
    status: index < 20 ? "pending" : "completed",
  }));
  const skynetTasks = Array.from({ length: 176 }, (_, index) => taskFor({
    number: index + 77,
    project: "skynet-project",
    status: index < 37 ? "pending" : "completed",
  }));
  const deletedTasks = Array.from({ length: 20 }, (_, index) => taskFor({
    number: index + 253,
    project: "deleted-project",
    status: "deleted",
  }));
  const withEligibleEdges = appendWithinProjectEdges(
    appendWithinProjectEdges([...webTasks, ...skynetTasks, ...deletedTasks], 0, 76, 90),
    76,
    176,
    217,
  );

  return appendSkippedEdges(withEligibleEdges);
};

export const migrationFixture = () => ({
  worksheet: migrationWorksheet(),
  tasks: migrationTasks(),
  destinations: DESTINATIONS,
});

export const normalizedPlaneItemFor = (item, id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") => ({
  id,
  name: item.workItem.name,
  description: item.workItem.descriptionStripped,
  priority: item.workItem.priority,
  stateId: item.workItem.stateId,
  externalId: item.workItem.externalId,
  externalSource: item.workItem.externalSource,
});
