import assert from "node:assert/strict";
import test from "node:test";
import { createPlaneClient, PlaneApiError } from "../skills/plane-api/scripts/plane-client.mjs";
import { runPlaneApi } from "../skills/plane-api/scripts/plane-api.mjs";

const API_KEY = "synthetic-plane-api-key";
const BASE_URL = "https://plane.internal.example";
const REFERENCE = "plane:acme:PROJ-123";
const WORK_ITEM_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const CURRENT_STATE_ID = "33333333-3333-4333-8333-333333333333";
const ASSIGNEE_ID = "55555555-5555-4555-8555-555555555555";
const LABEL_ID = "66666666-6666-4666-8666-666666666666";

const workItem = (overrides = {}) => ({
  id: WORK_ITEM_ID,
  project: PROJECT_ID,
  sequence_id: 123,
  name: "Plane item",
  description_stripped: "Safe description",
  state: CURRENT_STATE_ID,
  priority: "medium",
  assignees: [ASSIGNEE_ID],
  labels: [LABEL_ID],
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T01:00:00Z",
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
    if (typeof response === "function") return response(url, options);
    if (response === undefined) throw new Error("Unexpected Plane request");
    return response;
  };

  return { calls, fetchImpl };
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

test("serializes queued requests and recovers after a failed request", async () => {
  let currentTime = 0;
  let fetchCalls = 0;
  let activeFetches = 0;
  let maximumActiveFetches = 0;
  let timeoutStarts = 0;
  let resolveFirstFetchStarted;
  let rejectFirstFetch;
  let resolveRateWaitStarted;
  let releaseRateWait;
  const firstFetchStarted = new Promise((resolve) => { resolveFirstFetchStarted = resolve; });
  const firstFetch = new Promise((_resolve, reject) => { rejectFirstFetch = reject; });
  const rateWaitStarted = new Promise((resolve) => { resolveRateWaitStarted = resolve; });
  const rateWait = new Promise((resolve) => { releaseRateWait = resolve; });
  const delays = [];
  const client = createPlaneClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetchImpl: async () => {
      fetchCalls += 1;
      activeFetches += 1;
      maximumActiveFetches = Math.max(maximumActiveFetches, activeFetches);
      try {
        if (fetchCalls === 1) {
          resolveFirstFetchStarted();
          return await firstFetch;
        }
        return jsonResponse(workItem());
      } finally {
        activeFetches -= 1;
      }
    },
    now: () => currentTime,
    waitFor: async (delayMs) => {
      delays.push(delayMs);
      resolveRateWaitStarted();
      await rateWait;
      currentTime += delayMs;
    },
    setTimeoutImpl: () => {
      timeoutStarts += 1;
      return timeoutStarts;
    },
    clearTimeoutImpl: () => {},
  });

  const first = client.getWorkItem(REFERENCE);
  const second = client.getWorkItem(REFERENCE);
  await firstFetchStarted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls, 1);
  assert.equal(timeoutStarts, 1);
  assert.deepEqual(delays, []);

  rejectFirstFetch(new Error(API_KEY));
  const failure = await first.then(
    () => assert.fail("expected request failure"),
    (error) => error,
  );
  assert.equal(failure.code, "HTTP_ERROR");
  assert.doesNotMatch(`${failure.message}\n${failure.stack}`, new RegExp(API_KEY));

  await rateWaitStarted;
  assert.equal(fetchCalls, 1);
  assert.equal(timeoutStarts, 1);
  assert.deepEqual(delays, [1_100]);

  releaseRateWait();
  await second;
  assert.equal(fetchCalls, 2);
  assert.equal(timeoutStarts, 2);
  assert.equal(maximumActiveFetches, 1);
});

test("paces fractional timestamps after a partially elapsed interval", async () => {
  let currentTime = 0.25;
  const delays = [];
  const starts = [];
  const client = createPlaneClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetchImpl: async () => {
      starts.push(currentTime);
      return jsonResponse(workItem());
    },
    requestIntervalMs: 1_000,
    now: () => currentTime,
    waitFor: async (delayMs) => {
      delays.push(delayMs);
      currentTime += delayMs;
    },
  });

  await client.getWorkItem(REFERENCE);
  currentTime = 500.75;
  await client.getWorkItem(REFERENCE);

  assert.deepEqual(delays, [499.5]);
  assert.deepEqual(starts, [0.25, 1_000.25]);
});

test("rechecks remaining pacing delay after an early wait completion", async () => {
  let currentTime = 0;
  let waitCount = 0;
  const delays = [];
  const starts = [];
  const client = createPlaneClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetchImpl: async () => {
      starts.push(currentTime);
      return jsonResponse(workItem());
    },
    requestIntervalMs: 1_000,
    now: () => currentTime,
    waitFor: async (delayMs) => {
      waitCount += 1;
      delays.push(delayMs);
      currentTime += waitCount === 1 ? delayMs / 2 : delayMs;
    },
  });

  await client.getWorkItem(REFERENCE);
  await client.getWorkItem(REFERENCE);

  assert.deepEqual(delays, [1_000, 500]);
  assert.deepEqual(starts, [0, 1_000]);
});

test("uses a monotonic default clock rather than Date.now", async () => {
  const dateNow = Date.now;
  Date.now = () => { throw new Error("wall clock must not be read"); };

  try {
    const client = createPlaneClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      requestIntervalMs: 1,
      fetchImpl: async () => jsonResponse(workItem()),
    });
    await client.getWorkItem(REFERENCE);
    await client.getWorkItem(REFERENCE);
  } finally {
    Date.now = dateNow;
  }
});

test("recovers from a pacing failure without poisoning the request queue", async () => {
  let currentTime = 0;
  let waitAttempts = 0;
  let fetches = 0;
  const client = createPlaneClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetchImpl: async () => {
      fetches += 1;
      return jsonResponse(workItem());
    },
    now: () => currentTime,
    waitFor: async (delayMs) => {
      waitAttempts += 1;
      if (waitAttempts === 1) throw new Error("synthetic pacing failure");
      currentTime += delayMs;
    },
  });

  await client.getWorkItem(REFERENCE);
  await assert.rejects(client.getWorkItem(REFERENCE), /synthetic pacing failure/);
  await client.getWorkItem(REFERENCE);

  assert.equal(fetches, 2);
  assert.equal(waitAttempts, 2);
});

test("rejects authenticated redirects without a second request or secret output", async () => {
  const redirected = queuedFetch([
    (_url, options) => {
      assert.equal(options.redirect, "error");
      throw new Error(`redirected ${API_KEY}`);
    },
  ]);
  const client = createPlaneClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetchImpl: redirected.fetchImpl,
    requestIntervalMs: 0,
  });
  await assertErrorCode(client.getWorkItem(REFERENCE), "HTTP_ERROR");
  assert.equal(redirected.calls.length, 1);

  const stdout = outputWriter();
  const stderr = outputWriter();
  let requestCount = 0;
  const exitCode = await runPlaneApi({
    argv: ["plane:get", REFERENCE],
    env: { PLANE_BASE_URL: BASE_URL, PLANE_API_KEY: API_KEY },
    stdout: stdout.writer,
    stderr: stderr.writer,
    fetchImpl: async (_url, options) => {
      requestCount += 1;
      assert.equal(options.redirect, "error");
      throw new Error(`redirected ${API_KEY}`);
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(requestCount, 1);
  assert.deepEqual(JSON.parse(stderr.output()), {
    success: false,
    error: { code: "HTTP_ERROR", message: "Plane request could not be completed." },
  });
  assert.equal(stderr.output().includes(API_KEY), false);
  assert.equal(stdout.output(), "");
});

test("maps HTTP, network, timeout, and invalid JSON failures without exposing secrets", async () => {
  for (const response of [
    jsonResponse({}, { ok: false, status: 404 }),
    jsonResponse({}, { ok: false, status: 500 }),
    new Error(API_KEY),
    { ok: true, status: 200, json: async () => { throw new Error(API_KEY); } },
  ]) {
    const queue = queuedFetch([response]);
    const client = createPlaneClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetchImpl: queue.fetchImpl,
      requestIntervalMs: 0,
    });
    await assertErrorCode(client.getWorkItem(REFERENCE), response.ok === true ? "RESPONSE_ERROR" : "HTTP_ERROR");
  }

  let triggerTimeout;
  const timeoutClient = createPlaneClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    setTimeoutImpl: (callback) => {
      triggerTimeout = callback;
      return 1;
    },
    clearTimeoutImpl: () => {},
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error(API_KEY)));
      triggerTimeout();
    }),
  });
  await assertErrorCode(timeoutClient.getWorkItem(REFERENCE), "HTTP_ERROR");

  const stdout = outputWriter();
  const stderr = outputWriter();
  const exitCode = await runPlaneApi({
    argv: ["plane:get", REFERENCE],
    env: { PLANE_BASE_URL: BASE_URL, PLANE_API_KEY: API_KEY },
    stdout: stdout.writer,
    stderr: stderr.writer,
    fetchImpl: async () => { throw new Error(API_KEY); },
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(JSON.parse(stderr.output()), {
    success: false,
    error: { code: "HTTP_ERROR", message: "Plane request could not be completed." },
  });
  assert.equal(stderr.output().includes(API_KEY), false);
  assert.equal(stdout.output(), "");
});
