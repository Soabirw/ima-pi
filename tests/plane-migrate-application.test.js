import assert from "node:assert/strict";
import test from "node:test";
import {
  runPlaneMigrationApply,
  runPlaneMigrationReconcile,
  runPlaneMigrationStatus,
} from "../extensions/plane-migrate.ts";

const PLAN_HASH = "a".repeat(64);
const relativeRunPath = ".ima/plane-taskwarrior-migrate/synthetic";
const inspectedRun = {
  run: { relativeRunPath },
  plan: {
    planSha256: PLAN_HASH,
    summary: { creates: 2, eligibleRelations: 1, taskSkips: 0 },
  },
};

const context = ({
  mode = "tui",
  hasUI = true,
  confirm = async () => true,
  input = async () => "confirm",
  throwFirstNotify = false,
} = {}) => {
  const notifications = [];
  const statusUpdates = [];
  const widgetUpdates = [];
  let notifyCalls = 0;
  return {
    notifications,
    statusUpdates,
    widgetUpdates,
    ctx: {
      mode,
      cwd: "/synthetic",
      hasUI,
      ui: {
        confirm,
        input,
        notify: (message, level) => {
          notifications.push({ message, level });
          notifyCalls += 1;
          if (throwFirstNotify && notifyCalls === 1) throw new Error("synthetic notification failure");
        },
        setStatus: (key, text) => statusUpdates.push({ key, text }),
        setWidget: (key, content) => widgetUpdates.push({ key, content }),
      },
    },
  };
};

test("stops non-TUI application before inspecting a prepared run", async () => {
  const { ctx } = context({ mode: "print" });
  let dependencyReads = 0;
  const dependencies = new Proxy({}, {
    get: () => {
      dependencyReads += 1;
      throw new Error("application dependencies must not be read");
    },
  });

  const result = await runPlaneMigrationApply({
    ctx,
    relativeRunPath,
    dependencies,
  });

  assert.deepEqual(result, { status: "blocked", code: "INTERACTIVE_ONLY" });
  assert.equal(dependencyReads, 0);
});

test("cancels review and rejects nonliteral confirmation before applying", async () => {
  let applications = 0;
  const dependencies = {
    artifactApi: {},
    inspectPreparedRun: async () => inspectedRun,
    applyPreparedRun: async () => { applications += 1; return { state: "applied", relativeRunPath }; },
  };
  const cancelled = context({ confirm: async () => false });

  const cancelledResult = await runPlaneMigrationApply({
    ctx: cancelled.ctx,
    relativeRunPath,
    dependencies,
  });
  assert.deepEqual(cancelledResult, { status: "cancelled" });

  const rejected = context({ input: async () => "Confirm" });
  const rejectedResult = await runPlaneMigrationApply({
    ctx: rejected.ctx,
    relativeRunPath,
    dependencies,
  });
  assert.deepEqual(rejectedResult, { status: "blocked", code: "CONFIRMATION_INVALID" });
  assert.equal(applications, 0);
});

test("cancels dismissed literal confirmation without applying", async () => {
  let applications = 0;
  const { ctx } = context({ input: async () => undefined });

  const result = await runPlaneMigrationApply({
    ctx,
    relativeRunPath,
    dependencies: {
      artifactApi: {},
      inspectPreparedRun: async () => inspectedRun,
      applyPreparedRun: async () => {
        applications += 1;
        return { state: "applied", relativeRunPath };
      },
    },
  });

  assert.deepEqual(result, { status: "cancelled" });
  assert.equal(applications, 0);
});

test("reviews the full hash and passes it only after literal confirmation", async () => {
  let reviewText = "";
  let inputCalls = 0;
  let applicationInput;
  const { ctx } = context({
    confirm: async (_title, detail) => {
      reviewText = detail;
      return true;
    },
    input: async () => {
      inputCalls += 1;
      return "confirm";
    },
  });
  const dependencies = {
    env: {},
    artifactApi: {},
    createClient: () => { throw new Error("application spy only"); },
    readConfig: () => { throw new Error("application spy only"); },
    inspectPreparedRun: async () => inspectedRun,
    applyPreparedRun: async (input) => {
      applicationInput = input;
      return { state: "applied", relativeRunPath };
    },
  };

  const result = await runPlaneMigrationApply({ ctx, relativeRunPath, dependencies });

  assert.equal(result.state, "applied");
  assert.equal(inputCalls, 1);
  assert.equal(reviewText.includes(PLAN_HASH), true);
  assert.equal(applicationInput.reviewedPlanSha256, PLAN_HASH);
  assert.equal(applicationInput.relativeRunPath, relativeRunPath);
});

test("shows and clears activity while status reads local artifacts", async () => {
  const statusContext = context();
  let resolveStatus;
  const status = runPlaneMigrationStatus({
    ctx: statusContext.ctx,
    relativeRunPath,
    dependencies: {
      artifactApi: {},
      readPreparedStatus: () => new Promise((resolve) => { resolveStatus = resolve; }),
    },
  });

  assert.deepEqual(statusContext.statusUpdates, [{
    key: "ima-plane-migrate",
    text: "Reading local migration artifacts.",
  }]);
  assert.deepEqual(statusContext.widgetUpdates, [{
    key: "ima-plane-migrate-progress",
    content: ["Plane migration: Reading local migration artifacts."],
  }]);
  assert.deepEqual(statusContext.notifications, [{
    message: "Reading local Plane migration status.",
    level: "info",
  }]);

  resolveStatus({ relativeRunPath, state: "partially-applied", readiness: "BLOCKED" });
  const result = await status;
  assert.equal(result.state, "partially-applied");
  assert.deepEqual(statusContext.statusUpdates.at(-1), {
    key: "ima-plane-migrate",
    text: undefined,
  });
  assert.deepEqual(statusContext.widgetUpdates.at(-1), {
    key: "ima-plane-migrate-progress",
    content: undefined,
  });
});

test("clears activity when initial notifications fail before operations start", async () => {
  const cases = [
    {
      name: "status",
      run: runPlaneMigrationStatus,
      expectedCode: "STATUS_FAILED",
      dependencies: (calls) => ({
        artifactApi: {},
        readPreparedStatus: async () => { calls.prepared += 1; },
      }),
    },
    {
      name: "apply",
      run: runPlaneMigrationApply,
      expectedCode: "APPLICATION_FAILED",
      dependencies: (calls) => ({
        artifactApi: {},
        createClient: () => { calls.client += 1; },
        readConfig: () => { calls.config += 1; },
        inspectPreparedRun: async () => { calls.prepared += 1; },
        applyPreparedRun: async () => { calls.migration += 1; },
      }),
    },
    {
      name: "reconcile",
      run: runPlaneMigrationReconcile,
      expectedCode: "RECONCILIATION_FAILED",
      dependencies: (calls) => ({
        env: {},
        artifactApi: {},
        createClient: () => { calls.client += 1; },
        readConfig: () => { calls.config += 1; },
        reconcilePreparedRun: async () => { calls.migration += 1; },
      }),
    },
  ];

  for (const operation of cases) {
    const calls = { prepared: 0, client: 0, config: 0, migration: 0 };
    const operationContext = context({ throwFirstNotify: true });
    const result = await operation.run({
      ctx: operationContext.ctx,
      relativeRunPath,
      dependencies: operation.dependencies(calls),
    });

    assert.deepEqual(result, { status: "blocked", code: operation.expectedCode }, operation.name);
    assert.deepEqual(operationContext.statusUpdates.at(-1), {
      key: "ima-plane-migrate",
      text: undefined,
    }, operation.name);
    assert.deepEqual(operationContext.widgetUpdates.at(-1), {
      key: "ima-plane-migrate-progress",
      content: undefined,
    }, operation.name);
    assert.deepEqual(calls, { prepared: 0, client: 0, config: 0, migration: 0 }, operation.name);
  }
});

test("turns durable prepared-run progress into live migration activity", async () => {
  const applicationContext = context();
  let applicationInput;
  const result = await runPlaneMigrationApply({
    ctx: applicationContext.ctx,
    relativeRunPath,
    dependencies: {
      env: {},
      artifactApi: {},
      createClient: () => {},
      readConfig: () => ({}),
      inspectPreparedRun: async () => inspectedRun,
      applyPreparedRun: async (input) => {
        applicationInput = input;
        input.onProgress({
          phase: "checking-readiness",
          completed: 0,
          total: 1,
          projectKey: "DEST",
          readinessStep: "external-identities",
          readinessCompleted: 1,
          readinessTotal: 2,
        });
        input.onProgress({ phase: "checking-readiness", completed: 1, total: 1 });
        input.onProgress({ phase: "applying-items", completed: 1, total: 2, outcome: "created" });
        input.onProgress({ phase: "application-checkpoints-complete" });
        return { state: "applied", relativeRunPath };
      },
    },
  });

  assert.equal(result.state, "applied");
  assert.deepEqual(applicationContext.notifications.slice(0, 2), [
    { message: "Inspecting the prepared Plane migration.", level: "info" },
    {
      message: "Plane migration application started; live progress is shown above the editor and in the status bar.",
      level: "info",
    },
  ]);
  assert.equal(typeof applicationInput.onProgress, "function");
  assert.equal(applicationContext.statusUpdates.some(({ text }) =>
    text === "Checking live destination readiness (0/1): DEST identity checks (1/2)."), true);
  assert.equal(applicationContext.widgetUpdates.some(({ content }) =>
    JSON.stringify(content) === JSON.stringify([
      "Plane migration: Checking live destination readiness (0/1): DEST identity checks (1/2).",
    ])), true);
  assert.equal(applicationContext.statusUpdates.some(({ text }) =>
    text === "Checking live destination readiness (1/1)."), true);
  assert.equal(applicationContext.statusUpdates.some(({ text }) =>
    text === "Applying work items (1/2); created."), true);
  assert.equal(applicationContext.statusUpdates.some(({ text }) =>
    text === "All migration checkpoints are saved."), true);
  assert.deepEqual(applicationContext.statusUpdates.at(-1), {
    key: "ima-plane-migrate",
    text: undefined,
  });
  assert.deepEqual(applicationContext.widgetUpdates.at(-1), {
    key: "ima-plane-migrate-progress",
    content: undefined,
  });
});

test("routes reconciliation through the guarded operation", async () => {
  const reconcileContext = context();
  let reconcileInput;
  const reconciled = await runPlaneMigrationReconcile({
    ctx: reconcileContext.ctx,
    relativeRunPath,
    dependencies: {
      env: {},
      artifactApi: {},
      createClient: () => {},
      readConfig: () => ({}),
      reconcilePreparedRun: async (input) => {
        reconcileInput = input;
        return { relativeRunPath, state: "reconciled" };
      },
    },
  });
  assert.equal(reconciled.state, "reconciled");
  assert.equal(reconcileInput.relativeRunPath, relativeRunPath);
  assert.equal(typeof reconcileInput.onProgress, "function");
});
