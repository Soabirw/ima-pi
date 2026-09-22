import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import agentsExtension from "../extensions/agents.ts";
import {
  admitDelegatedVerifications,
  createDelegatedVerificationTool,
  DELEGATED_VERIFICATION_CLEANUP_TIMEOUT_MS,
  DELEGATED_VERIFICATION_MAX_TIMEOUT_MS,
  DELEGATED_VERIFICATION_OUTPUT_MAX_BYTES,
  DELEGATED_VERIFICATION_OUTPUT_MAX_LINES,
  delegatedVerificationToolParameters,
  executeDelegatedVerification,
  projectDelegatedVerificationArgv,
  revalidateDelegatedVerificationSnapshot,
  validateDelegatedVerifications,
} from "../lib/ima-delegated-verification.ts";

const tester = { authority: "test-write", tools: ["read", "test"] };
const writer = { authority: "write", tools: ["read", "test"] };
const reader = { authority: "read", tools: ["read"] };
const verification = (overrides = {}) => ({
  id: "node-test",
  runner: "npm",
  cwd: ".",
  script: "test:playwright",
  args: ["--project=chromium", "--grep=smoke"],
  timeout: 1_000,
  ...overrides,
});

const createProject = async (options = {}) => {
  const root = await mkdtemp(join(tmpdir(), "ima-delegated-verification-"));
  const packageJson = options.packageJson === undefined ? {
    scripts: {
      "test:playwright": "playwright test",
      first: "node first.js",
      second: "node second.js",
    },
  } : options.packageJson;
  if (packageJson !== null) {
    await writeFile(join(root, "package.json"), `${JSON.stringify(packageJson)}\n`);
  }
  if (options.composerJson) {
    await writeFile(join(root, "composer.json"), `${JSON.stringify(options.composerJson)}\n`);
  }
  return root;
};

const admit = (root, verifications, overrides = {}) => admitDelegatedVerifications({
  projectRoot: root,
  assignmentCount: 1,
  verifications,
  agent: tester,
  projectTrusted: true,
  ...overrides,
});

const settledExecutor = async () => ({
  stdout: "verification output",
  stderr: "",
  code: 0,
  killed: false,
});

const createManualTimer = () => {
  const scheduled = [];
  const cancelled = [];
  const timer = {
    schedule: (callback, milliseconds) => {
      const entry = { callback, milliseconds, cancelled: false };
      scheduled.push(entry);
      return entry;
    },
    cancel: (entry) => {
      entry.cancelled = true;
      cancelled.push(entry);
    },
  };
  return { timer, scheduled, cancelled };
};

test("preserves no-capability callers and rejects malformed delegated verification surfaces", async () => {
  assert.deepEqual(
    validateDelegatedVerifications({ verifications: undefined, agent: reader }),
    { valid: true, errors: [] },
  );
  assert.deepEqual(
    await admitDelegatedVerifications({
      projectRoot: "/not-needed-without-verifications",
      assignmentCount: 2,
      verifications: undefined,
      agent: reader,
      projectTrusted: false,
    }),
    { admitted: true, snapshots: [] },
  );

  const deniedAgents = [
    { agent: reader, error: "delegated_verification_role_denied" },
    { agent: { authority: "test-write", tools: ["read"] }, error: "delegated_verification_tool_denied" },
  ];
  for (const scenario of deniedAgents) {
    const result = validateDelegatedVerifications({
      verifications: [verification()],
      agent: scenario.agent,
    });
    assert.equal(result.valid, false, scenario.error);
    assert.ok(result.errors.includes(scenario.error), scenario.error);
  }

  const malformed = [
    { value: [], error: "delegated_verification_list_invalid" },
    { value: [{ ...verification(), id: "bad id" }], error: "delegated_verification_id_invalid" },
    { value: [verification(), verification()], error: "delegated_verification_id_invalid" },
    { value: [{ ...verification(), command: "npm test" }], error: "delegated_verification_shape_invalid" },
    { value: [{ ...verification(), env: { TOKEN: "secret" } }], error: "delegated_verification_shape_invalid" },
    { value: [{ ...verification(), url: "https://example.test" }], error: "delegated_verification_shape_invalid" },
    { value: [{ ...verification(), install: true }], error: "delegated_verification_shape_invalid" },
    { value: [{ ...verification(), args: ["https://example.test/run"] }], error: "delegated_verification_args_invalid" },
    { value: [{ ...verification(), args: ["TOKEN=secret"] }], error: "delegated_verification_args_invalid" },
    { value: [{ ...verification(), args: ["--api-key=secret"] }], error: "delegated_verification_args_invalid" },
  ];
  for (const scenario of malformed) {
    const result = validateDelegatedVerifications({ verifications: scenario.value, agent: tester });
    assert.equal(result.valid, false, scenario.error);
    assert.ok(result.errors.includes(scenario.error), scenario.error);
  }
});

test("admits parent-selected six-minute verification timeouts and rejects longer adapter values", async () => {
  const root = await createProject();
  try {
    const sixMinuteVerification = verification({
      id: "six-minute",
      timeout: DELEGATED_VERIFICATION_MAX_TIMEOUT_MS,
    });
    const tooLongVerification = verification({
      id: "too-long",
      timeout: 360_001,
    });
    assert.equal(DELEGATED_VERIFICATION_MAX_TIMEOUT_MS, 360_000);
    assert.deepEqual(
      validateDelegatedVerifications({ verifications: [sixMinuteVerification], agent: tester }),
      { valid: true, errors: [] },
    );
    assert.deepEqual(
      validateDelegatedVerifications({ verifications: [tooLongVerification], agent: tester }),
      { valid: false, errors: ["delegated_verification_timeout_invalid"] },
    );

    const admission = await admit(root, [sixMinuteVerification]);
    assert.equal(admission.admitted, true);
    assert.equal(admission.snapshots[0].timeout, DELEGATED_VERIFICATION_MAX_TIMEOUT_MS);

    const tools = [];
    agentsExtension({
      registerTool: (tool) => tools.push(tool),
      registerCommand: () => undefined,
      on: () => undefined,
    });
    const delegate = tools.find((tool) => tool.name === "ima_delegate");
    const sixMinuteRequest = {
      title: "Six-minute verification",
      assignments: [{
        id: "six-minute",
        agent: "tester",
        goal: "Verify the implementation.",
        context: "Human-approved bounded verification.",
        paths: ["tests/delegated-verification.test.js"],
        constraints: [],
        nonGoals: [],
        expectedOutput: "Verification result.",
        writeScope: ["tests/delegated-verification.test.js"],
        verifications: [sixMinuteVerification],
      }],
    };
    assert.ok(delegate);
    assert.equal(Check(delegate.parameters, sixMinuteRequest), true);
    assert.equal(Check(delegate.parameters, {
      ...sixMinuteRequest,
      assignments: [{
        ...sixMinuteRequest.assignments[0],
        verifications: [tooLongVerification],
      }],
    }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("admits trusted manifest snapshots and projects only fixed npm and Composer argv", async () => {
  const root = await createProject({
    composerJson: {
      scripts: {
        test: ["phpunit", "--colors=always"],
      },
    },
  });
  try {
    const npm = verification();
    const composer = verification({
      id: "composer-test",
      runner: "composer",
      script: "test",
      args: ["--filter=unit"],
    });
    const admission = await admit(root, [npm, composer]);
    assert.equal(admission.admitted, true);
    assert.equal(admission.snapshots.length, 2);
    assert.equal(Object.isFrozen(admission.snapshots), true);
    assert.equal(Object.isFrozen(admission.snapshots[0].args), true);
    assert.deepEqual(projectDelegatedVerificationArgv(admission.snapshots[0]), {
      command: "npm",
      args: ["run", "test:playwright", "--", "--project=chromium", "--grep=smoke"],
    });
    assert.deepEqual(projectDelegatedVerificationArgv(admission.snapshots[1]), {
      command: "composer",
      args: ["run-script", "test", "--", "--filter=unit"],
    });
    assert.deepEqual(
      await revalidateDelegatedVerificationSnapshot({
        projectRoot: root,
        snapshot: admission.snapshots[0],
      }),
      { valid: true },
    );

    for (const scenario of [
      { assignmentCount: 2, projectTrusted: true, error: "delegated_verification_assignment_count_invalid" },
      { assignmentCount: 1, projectTrusted: false, error: "delegated_verification_project_untrusted" },
    ]) {
      const result = await admit(root, [npm], scenario);
      assert.deepEqual(result, { admitted: false, error: scenario.error });
    }

    const writerAdmission = await admitDelegatedVerifications({
      projectRoot: root,
      assignmentCount: 1,
      verifications: [npm],
      agent: writer,
      projectTrusted: true,
    });
    assert.equal(writerAdmission.admitted, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed on missing, symlinked, absent-script, and drifted manifests before execution", async () => {
  const root = await createProject();
  const missing = await createProject({ packageJson: null });
  const symlinkRoot = await createProject({ packageJson: null });
  const outside = await createProject();
  try {
    const noManifest = await admit(missing, [verification()]);
    assert.equal(noManifest.admitted, false);

    const absentScript = await admit(root, [verification({ script: "not-declared" })]);
    assert.deepEqual(absentScript, {
      admitted: false,
      error: "delegated_verification_manifest_script_invalid",
    });

    await mkdir(join(root, "real-cwd"));
    await symlink("real-cwd", join(root, "linked-cwd"));
    const symlinkedCwd = await admit(root, [verification({ cwd: "linked-cwd" })]);
    assert.deepEqual(symlinkedCwd, {
      admitted: false,
      error: "delegated_verification_cwd_symlink_or_invalid",
    });

    await symlink(join(outside, "package.json"), join(symlinkRoot, "package.json"));
    const symlinkedManifest = await admit(symlinkRoot, [verification()]);
    assert.deepEqual(symlinkedManifest, {
      admitted: false,
      error: "delegated_verification_manifest_invalid",
    });

    const admission = await admit(root, [verification()]);
    assert.equal(admission.admitted, true);
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: { "test:playwright": "playwright test --changed" },
    }));
    assert.deepEqual(
      await revalidateDelegatedVerificationSnapshot({
        projectRoot: root,
        snapshot: admission.snapshots[0],
      }),
      { valid: false, error: "delegated_verification_manifest_drift" },
    );
    let executions = 0;
    await assert.rejects(
      executeDelegatedVerification({
        id: "node-test",
        projectRoot: root,
        snapshots: admission.snapshots,
        executor: async () => {
          executions += 1;
          return settledExecutor();
        },
      }),
      { message: "delegated_verification_manifest_drift" },
    );
    assert.equal(executions, 0);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(missing, { recursive: true, force: true }),
      rm(symlinkRoot, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("exposes only one admitted id per tool call and serializes approved verification execution", async () => {
  const root = await createProject();
  try {
    const admission = await admit(root, [
      verification({ id: "first", script: "first", args: [] }),
      verification({ id: "second", script: "second", args: [] }),
    ]);
    assert.equal(admission.admitted, true);

    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    let signalFirstStart;
    const firstStarted = new Promise((resolve) => { signalFirstStart = resolve; });
    const starts = [];
    let executions = 0;
    let tail = Promise.resolve();
    const queue = (effect) => {
      const next = tail.then(effect, effect);
      tail = next.then(() => undefined, () => undefined);
      return next;
    };
    const tool = createDelegatedVerificationTool({
      projectRoot: root,
      snapshots: admission.snapshots,
      queue,
      executor: async (command, args) => {
        executions += 1;
        starts.push({ command, args });
        if (args[1] === "first") {
          signalFirstStart();
          await firstGate;
        }
        return settledExecutor();
      },
    });

    assert.equal(Check(delegatedVerificationToolParameters, { id: "first" }), true);
    assert.equal(
      Check(delegatedVerificationToolParameters, {
        id: "first",
        timeout: DELEGATED_VERIFICATION_MAX_TIMEOUT_MS,
      }),
      false,
    );
    await assert.rejects(
      tool.execute("extra-field", { id: "first", rawCommand: "npm test" }, undefined),
      { message: "delegated_verification_input_invalid" },
    );
    await assert.rejects(
      tool.execute("timeout-override", {
        id: "first",
        timeout: DELEGATED_VERIFICATION_MAX_TIMEOUT_MS,
      }, undefined),
      { message: "delegated_verification_input_invalid" },
    );
    await assert.rejects(
      tool.execute("unknown-id", { id: "not-approved" }, undefined),
      { message: "delegated_verification_id_unavailable" },
    );
    assert.equal(executions, 0);

    const first = tool.execute("first-call", { id: "first" }, undefined);
    await firstStarted;
    const second = tool.execute("second-call", { id: "second" }, undefined);
    await Promise.resolve();
    assert.deepEqual(starts.map(({ args }) => args[1]), ["first"]);
    releaseFirst();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(firstResult.details.status, "passed");
    assert.equal(secondResult.details.status, "passed");
    assert.deepEqual(starts, [
      { command: "npm", args: ["run", "first", "--"] },
      { command: "npm", args: ["run", "second", "--"] },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns settled nonzero results with bounded redacted output", async () => {
  const root = await createProject();
  try {
    const admission = await admit(root, [verification()]);
    assert.equal(admission.admitted, true);
    const unsafe = [];
    const outcome = await executeDelegatedVerification({
      id: "node-test",
      projectRoot: root,
      snapshots: admission.snapshots,
      executor: async () => ({
        stdout: `${"x".repeat(DELEGATED_VERIFICATION_OUTPUT_MAX_BYTES + 512)}\ntoken=top-secret`,
        stderr: "Bearer very-secret-value",
        code: 7,
        killed: false,
      }),
      onUnsafe: (reason) => unsafe.push(reason),
    });

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.exitCode, 7);
    assert.equal(outcome.outputTruncated, true);
    assert.ok(outcome.outputBytes > DELEGATED_VERIFICATION_OUTPUT_MAX_BYTES);
    assert.ok(Buffer.byteLength(outcome.output, "utf8") <= DELEGATED_VERIFICATION_OUTPUT_MAX_BYTES);
    assert.ok(outcome.output.split("\n").length <= DELEGATED_VERIFICATION_OUTPUT_MAX_LINES);
    assert.match(outcome.output, /token=\[redacted\]/i);
    assert.match(outcome.output, /Bearer \[redacted\]/);
    assert.doesNotMatch(outcome.output, /top-secret|very-secret-value/);
    assert.deepEqual(unsafe, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redacts structured fields and complete authorization headers before truncation in both tool channels", async () => {
  const root = await createProject();
  try {
    const admission = await admit(root, [verification()]);
    assert.equal(admission.admitted, true);
    const quotedToken = 'placeholder token with spaces and \\"escaped\\" text';
    const quotedPassword = 'placeholder password with spaces and \\\\ slash';
    const headerValues = [
      "basic-placeholder",
      "bearer-placeholder",
      "digest-placeholder",
      "negotiate-placeholder",
      "oauth-placeholder",
    ];
    const tool = createDelegatedVerificationTool({
      projectRoot: root,
      snapshots: admission.snapshots,
      queue: (effect) => effect(),
      executor: async () => ({
        stdout: [
          "diagnostic ".repeat(DELEGATED_VERIFICATION_OUTPUT_MAX_BYTES + 128),
          `{"token":"${quotedToken}"}`,
          "Authorization: Basic basic-placeholder",
          "Authorization: Bearer bearer-placeholder",
          'Authorization: Digest username="diagnostic", response="digest-placeholder"',
        ].join("\n"),
        stderr: [
          `{"password":"${quotedPassword}"}`,
          "Proxy-Authorization: Negotiate negotiate-placeholder",
          "Authorization: OAuth oauth-placeholder",
        ].join("\n"),
        code: 1,
        killed: false,
      }),
    });

    const result = await tool.execute("structured-redaction", { id: "node-test" }, undefined);
    assert.equal(result.details.status, "failed");
    assert.equal(result.details.outputTruncated, true);
    assert.equal(
      result.content[0].text,
      `Verification node-test: failed (exit 1)\n${result.details.output}`,
    );
    assert.match(result.details.output, /"token":"\[redacted\]"/);
    assert.match(result.details.output, /"password":"\[redacted\]"/);
    assert.match(result.details.output, /Authorization: Basic \[redacted\]/);
    assert.match(result.details.output, /Authorization: Bearer \[redacted\]/);
    assert.match(result.details.output, /Authorization: Digest \[redacted\]/);
    assert.match(result.details.output, /Proxy-Authorization: Negotiate \[redacted\]/);
    assert.match(result.details.output, /Authorization: OAuth \[redacted\]/);
    for (const value of [quotedToken, quotedPassword, ...headerValues]) {
      assert.equal(result.details.output.includes(value), false);
      assert.equal(result.content[0].text.includes(value), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("latches a cancelled pending executor before bounded cleanup and observes late rejection", async () => {
  const root = await createProject();
  const unhandled = [];
  const observeUnhandled = (reason) => { unhandled.push(reason); };
  process.on("unhandledRejection", observeUnhandled);
  try {
    const admission = await admit(root, [verification()]);
    assert.equal(admission.admitted, true);
    const controller = new AbortController();
    const clock = createManualTimer();
    const unsafe = [];
    let executions = 0;
    let settled = 0;
    let rejectExecutor;
    let signalStarted;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    const outcome = executeDelegatedVerification({
      id: "node-test",
      projectRoot: root,
      snapshots: admission.snapshots,
      signal: controller.signal,
      timer: clock.timer,
      executor: async () => new Promise((_resolve, reject) => {
        executions += 1;
        rejectExecutor = reject;
        signalStarted();
      }),
      onUnsafe: (reason) => unsafe.push(reason),
      onExecutionSettled: () => { settled += 1; },
    });

    await started;
    controller.abort();
    for (let attempt = 0; attempt < 4 && clock.scheduled.length < 2; attempt += 1) await Promise.resolve();
    assert.deepEqual(unsafe, ["delegated_verification_cancelled"]);
    assert.equal(executions, 1);
    assert.equal(settled, 0);
    assert.equal(clock.scheduled.length, 2);
    assert.equal(clock.scheduled[1].milliseconds, DELEGATED_VERIFICATION_CLEANUP_TIMEOUT_MS);
    clock.scheduled[1].callback();
    await assert.rejects(outcome, { message: "delegated_verification_process_cleanup_unverified" });
    assert.deepEqual(unsafe, [
      "delegated_verification_cancelled",
      "delegated_verification_process_cleanup_unverified",
    ]);
    assert.equal(settled, 0);

    rejectExecutor(new Error("late executor rejection"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.equal(settled, 0);
  } finally {
    process.off("unhandledRejection", observeUnhandled);
    await rm(root, { recursive: true, force: true });
  }
});

test("returns the original timeout only after delayed cleanup settlement", async () => {
  const root = await createProject();
  try {
    const admission = await admit(root, [verification()]);
    assert.equal(admission.admitted, true);
    const clock = createManualTimer();
    const unsafe = [];
    let executions = 0;
    let settled = 0;
    let resolveExecutor;
    let signalStarted;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    const outcome = executeDelegatedVerification({
      id: "node-test",
      projectRoot: root,
      snapshots: admission.snapshots,
      timer: clock.timer,
      executor: async () => new Promise((resolve) => {
        executions += 1;
        resolveExecutor = resolve;
        signalStarted();
      }),
      onUnsafe: (reason) => unsafe.push(reason),
      onExecutionSettled: () => { settled += 1; },
    });

    await started;
    clock.scheduled[0].callback();
    for (let attempt = 0; attempt < 4 && clock.scheduled.length < 2; attempt += 1) await Promise.resolve();
    assert.deepEqual(unsafe, ["delegated_verification_timeout"]);
    assert.equal(executions, 1);
    assert.equal(settled, 0);
    assert.equal(clock.scheduled.length, 2);
    resolveExecutor({ stdout: "", stderr: "", code: 0, killed: false });
    await assert.rejects(outcome, { message: "delegated_verification_timeout" });
    assert.deepEqual(unsafe, ["delegated_verification_timeout"]);
    assert.equal(settled, 1);
    assert.equal(clock.scheduled[1].cancelled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("marks cancelled, timed-out, and uncertain processes unsafe after their execution boundary", async () => {
  const root = await createProject();
  try {
    const admission = await admit(root, [verification()]);
    assert.equal(admission.admitted, true);
    const snapshot = admission.snapshots[0];

    const controller = new AbortController();
    let signalCancellationStart;
    const cancellationStarted = new Promise((resolve) => { signalCancellationStart = resolve; });
    const cancellationUnsafe = [];
    const cancellation = executeDelegatedVerification({
      id: snapshot.id,
      projectRoot: root,
      snapshots: [snapshot],
      signal: controller.signal,
      executor: async (_command, _args, options) => new Promise((resolve) => {
        signalCancellationStart();
        options.signal.addEventListener("abort", () => resolve({
          stdout: "",
          stderr: "",
          code: 0,
          killed: false,
        }), { once: true });
      }),
      onUnsafe: (reason) => cancellationUnsafe.push(reason),
    });
    await cancellationStarted;
    controller.abort();
    await assert.rejects(cancellation, { message: "delegated_verification_cancelled" });
    assert.deepEqual(cancellationUnsafe, ["delegated_verification_cancelled"]);

    const timeoutUnsafe = [];
    const scheduledTimeouts = [];
    const cancelledTimeouts = [];
    let timeoutCallback;
    let timeoutExecutions = 0;
    let timeoutAborts = 0;
    let timeoutSettled = 0;
    await assert.rejects(
      executeDelegatedVerification({
        id: snapshot.id,
        projectRoot: root,
        snapshots: [snapshot],
        timer: {
          schedule: (callback, milliseconds) => {
            timeoutCallback = callback;
            scheduledTimeouts.push(milliseconds);
            return callback;
          },
          cancel: (timer) => { cancelledTimeouts.push(timer); },
        },
        executor: async (_command, _args, options) => new Promise((resolve) => {
          timeoutExecutions += 1;
          options.signal.addEventListener("abort", () => {
            timeoutAborts += 1;
            resolve({
              stdout: "",
              stderr: "",
              code: 0,
              killed: true,
            });
          }, { once: true });
          timeoutCallback();
        }),
        onUnsafe: (reason) => timeoutUnsafe.push(reason),
        onExecutionSettled: () => { timeoutSettled += 1; },
      }),
      { message: "delegated_verification_timeout" },
    );
    assert.deepEqual(scheduledTimeouts, [snapshot.timeout, DELEGATED_VERIFICATION_CLEANUP_TIMEOUT_MS]);
    assert.equal(timeoutExecutions, 1);
    assert.equal(timeoutAborts, 1);
    assert.equal(cancelledTimeouts.length, 2);
    assert.equal(timeoutSettled, 1);
    assert.deepEqual(timeoutUnsafe, ["delegated_verification_timeout"]);

    const uncertainUnsafe = [];
    await assert.rejects(
      executeDelegatedVerification({
        id: snapshot.id,
        projectRoot: root,
        snapshots: [snapshot],
        executor: async () => ({ stdout: "", stderr: "", code: 0 }),
        onUnsafe: (reason) => uncertainUnsafe.push(reason),
      }),
      { message: "delegated_verification_process_uncertain" },
    );
    assert.deepEqual(uncertainUnsafe, ["delegated_verification_process_uncertain"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
