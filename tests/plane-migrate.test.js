import assert from "node:assert/strict";
import test from "node:test";
import { runPlaneMigrationPreparation } from "../extensions/plane-migrate.ts";

const TASK_A_PENDING = "11111111-1111-4111-8111-111111111111";
const TASK_A_COMPLETED = "22222222-2222-4222-8222-222222222222";
const TASK_A_DELETED = "33333333-3333-4333-8333-333333333333";
const TASK_B_PENDING = "44444444-4444-4444-8444-444444444444";
const PLANE_PROJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BACKLOG_STATE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const COMPLETED_STATE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const task = ({ uuid, project, status, depends = [] }) => ({
  uuid,
  project,
  status,
  description: `Task ${uuid}`,
  priority: "M",
  entry: "20260901T000000Z",
  modified: "20260902T000000Z",
  ...(status === "completed" || status === "deleted" ? { end: "20260903T000000Z" } : {}),
  ...(depends.length > 0 ? { depends } : {}),
});

const sourceTasks = () => [
  task({ uuid: TASK_A_PENDING, project: "alpha", status: "pending", depends: [TASK_A_COMPLETED] }),
  task({ uuid: TASK_A_COMPLETED, project: "alpha", status: "completed" }),
  task({ uuid: TASK_A_DELETED, project: "alpha", status: "deleted" }),
  task({ uuid: TASK_B_PENDING, project: "beta", status: "pending" }),
];

const project = (id, identifier) => ({ id, identifier, name: identifier, archivedAt: null });

test("stops non-TUI preparation before configuration, export, discovery, or artifact effects", async () => {
  const notifications = [];
  let dependencyReads = 0;
  const dependencies = new Proxy({}, {
    get: () => {
      dependencyReads += 1;
      throw new Error("non-TUI preparation must not read dependencies");
    },
  });

  const result = await runPlaneMigrationPreparation({
    ctx: {
      mode: "print",
      hasUI: true,
      ui: { notify: (message, level) => notifications.push({ message, level }) },
    },
    dependencies,
  });

  assert.deepEqual(result, { status: "blocked", code: "INTERACTIVE_ONLY" });
  assert.equal(dependencyReads, 0);
  assert.deepEqual(notifications, [{
    message: "Plane migration preparation requires interactive TUI mode.",
    level: "warning",
  }]);
});

test("does not query or offer explicitly archived Plane projects", async () => {
  const readCalls = [];
  const artifactCalls = [];
  const archivedProject = { ...project(PLANE_PROJECT_A, "DEST"), archivedAt: "2026-09-03T00:00:00Z" };
  const client = {
    listWorkspaceProjects: async () => {
      readCalls.push("projects");
      return [archivedProject];
    },
    listProjectStates: async () => {
      readCalls.push("states");
      throw new Error("archived projects must not be queried");
    },
    listProjectItemsByExternalSource: async () => {
      readCalls.push("identity");
      throw new Error("archived projects must not be queried");
    },
  };

  const result = await runPlaneMigrationPreparation({
    ctx: {
      mode: "tui",
      cwd: "/synthetic",
      hasUI: true,
      ui: {
        select: async (_label, options) => options[0],
        notify: () => {},
      },
    },
    dependencies: {
      env: {
        PLANE_BASE_URL: "https://plane.internal.example",
        PLANE_API_KEY: "synthetic-plane-api-key",
        PLANE_WORKSPACE: "ima",
      },
      readConfig: () => ({}),
      createClient: () => client,
      execFile: async () => ({ stdout: JSON.stringify(sourceTasks()) }),
      artifactApi: {
        createMigrationRun: async () => artifactCalls.push("create"),
        writeRunArtifact: async () => artifactCalls.push("write"),
      },
    },
  });

  assert.deepEqual(result, { status: "blocked", code: "NO_COMPATIBLE_DESTINATION" });
  assert.deepEqual(readCalls, ["projects"]);
  assert.deepEqual(artifactCalls, []);
});

test("cancels interactive preparation after review without artifacts or Plane mutations", async () => {
  const notifications = [];
  const readCalls = [];
  const artifactCalls = [];
  let taskExports = 0;
  let reviewCalls = 0;
  const client = {
    listWorkspaceProjects: async ({ workspace }) => {
      readCalls.push("projects");
      assert.equal(workspace, "ima");
      return [project(PLANE_PROJECT_A, "DEST")];
    },
    listProjectStates: async ({ workspace, projectId }) => {
      readCalls.push("states");
      assert.equal(workspace, "ima");
      assert.equal(projectId, PLANE_PROJECT_A);
      return [
        { id: BACKLOG_STATE, group: "backlog", sequence: 1 },
        { id: COMPLETED_STATE, group: "completed", sequence: 2 },
      ];
    },
    listProjectItemsByExternalSource: async ({ workspace, projectId, externalSource }) => {
      readCalls.push("identity");
      assert.equal(workspace, "ima");
      assert.equal(projectId, PLANE_PROJECT_A);
      assert.equal(externalSource, "taskwarrior");
      return [];
    },
  };

  const result = await runPlaneMigrationPreparation({
    ctx: {
      mode: "tui",
      cwd: "/synthetic",
      hasUI: true,
      ui: {
        select: async (_label, options) => options[0],
        confirm: async () => {
          reviewCalls += 1;
          return false;
        },
        notify: (message, level) => notifications.push({ message, level }),
      },
    },
    dependencies: {
      env: {
        PLANE_BASE_URL: "https://plane.internal.example",
        PLANE_API_KEY: "synthetic-plane-api-key",
        PLANE_WORKSPACE: "ima",
      },
      readConfig: () => ({}),
      createClient: () => client,
      execFile: async (command, args) => {
        taskExports += 1;
        assert.equal(command, "task");
        assert.deepEqual(args, ["export"]);
        return { stdout: JSON.stringify(sourceTasks()) };
      },
      artifactApi: {
        createMigrationRun: async () => artifactCalls.push("create"),
        writeRunArtifact: async () => artifactCalls.push("write"),
      },
    },
  });

  assert.deepEqual(result, { status: "cancelled" });
  assert.equal(taskExports, 1);
  assert.equal(reviewCalls, 1);
  assert.deepEqual([...readCalls].sort(), ["identity", "projects", "states"]);
  assert.deepEqual(artifactCalls, []);
  assert.deepEqual(notifications, [{
    message: "Plane migration preparation cancelled.",
    level: "info",
  }]);
});

test("writes canonical preparation artifacts after the reviewed confirmation", async () => {
  const events = [];
  const writes = new Map();
  const client = {
    listWorkspaceProjects: async () => [project(PLANE_PROJECT_A, "DEST")],
    listProjectStates: async () => [
      { id: BACKLOG_STATE, group: "backlog", sequence: 1 },
      { id: COMPLETED_STATE, group: "completed", sequence: 2 },
    ],
    listProjectItemsByExternalSource: async () => [],
  };
  const artifactNames = {
    source: "source.json",
    plan: "plan.json",
    dryRunReport: "dry-run-report.json",
    preflightReport: "preflight-report.json",
  };

  const result = await runPlaneMigrationPreparation({
    ctx: {
      mode: "tui",
      cwd: "/synthetic",
      hasUI: true,
      ui: {
        select: async (_label, options) => options[0],
        confirm: async () => {
          events.push("confirm");
          return true;
        },
        notify: () => {},
      },
    },
    dependencies: {
      env: {
        PLANE_BASE_URL: "https://plane.internal.example",
        PLANE_API_KEY: "synthetic-plane-api-key",
        PLANE_WORKSPACE: "ima",
      },
      readConfig: () => ({}),
      createClient: () => client,
      execFile: async () => ({ stdout: JSON.stringify(sourceTasks()) }),
      artifactApi: {
        MIGRATION_ARTIFACTS: artifactNames,
        createMigrationRun: async () => {
          events.push("create");
          return { relativeRunPath: ".ima/plane-taskwarrior-migrate/synthetic" };
        },
        writeRunArtifact: async ({ name, value }) => {
          events.push(name);
          writes.set(name, value);
        },
      },
      clock: () => new Date("2026-09-04T00:00:00.000Z"),
    },
  });

  const source = writes.get(artifactNames.source);
  const plan = writes.get(artifactNames.plan);
  const dryRunReport = writes.get(artifactNames.dryRunReport);
  const readiness = writes.get(artifactNames.preflightReport);
  assert.equal(result.status, "prepared");
  assert.deepEqual(events, [
    "confirm",
    "create",
    artifactNames.source,
    artifactNames.plan,
    artifactNames.dryRunReport,
    artifactNames.preflightReport,
  ]);
  assert.equal(source.schemaVersion, 2);
  assert.deepEqual(source.tasks.map((entry) => entry.uuid), [
    TASK_A_PENDING,
    TASK_A_COMPLETED,
    TASK_A_DELETED,
    TASK_B_PENDING,
  ]);
  assert.equal(plan.planSha256, dryRunReport.planSha256);
  assert.equal(plan.planSha256, readiness.planSha256);
});
