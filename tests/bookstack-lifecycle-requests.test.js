import assert from "node:assert/strict";
import test from "node:test";
import {
  BOOKSTACK_LIFECYCLE_REQUEST_INTERVAL_MS,
  BOOKSTACK_LIFECYCLE_MAX_WAITING_REQUESTS,
  bookStackLifecycleRequestWasNotDispatched,
  createBookStackLifecycleJsonRequester,
  createBookStackLifecycleRequestScheduler,
} from "../lib/bookstack-lifecycle-requests.ts";
import { createBookStackLifecycleClient } from "../lib/bookstack-lifecycle-client.ts";

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", ...headers },
});

const resource = (overrides = {}) => ({
  id: 1,
  name: "Lifecycle",
  slug: "lifecycle",
  ...overrides,
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const virtualClock = (initial = 0) => {
  let current = initial;
  const waits = [];
  return {
    now: () => current,
    wait: async (milliseconds, signal) => {
      waits.push({ milliseconds, signal });
      current += milliseconds;
    },
    advance: (milliseconds) => { current += milliseconds; },
    get time() { return current; },
    waits,
  };
};

const schedulerFor = (clock) => createBookStackLifecycleRequestScheduler({
  now: clock.now,
  wait: clock.wait,
});

const requestInput = (fetcher, overrides = {}) => ({
  fetcher,
  url: new URL("https://bookstack.example/api/pages"),
  init: { method: "GET" },
  timeoutMs: 60_000,
  maxResponseBytes: 4 * 1024 * 1024,
  failurePrefix: "bookstack",
  ...overrides,
});

const lifecycleClient = (clock, fetch) => createBookStackLifecycleClient({
  origin: "https://bookstack.example",
  tokenId: "test-id",
  tokenSecret: "test-secret",
  fetch,
  requestScheduler: schedulerFor(clock),
});

const notDispatched = (error, code) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, code);
  assert.equal(bookStackLifecycleRequestWasNotDispatched(error), true);
  return true;
};

test("eight concurrent lifecycle-client reads use one injected FIFO lane", async () => {
  const clock = virtualClock();
  const starts = [];
  const client = lifecycleClient(clock, async (url, init = {}) => {
    starts.push({
      at: clock.time,
      pathname: new URL(String(url)).pathname,
      method: init.method ?? "GET",
    });
    return json({ data: [], total: 0 });
  });

  await Promise.all(Array.from({ length: 8 }, () => client.listPages()));

  assert.deepEqual(starts, Array.from({ length: 8 }, (_unused, index) => ({
    at: index * BOOKSTACK_LIFECYCLE_REQUEST_INTERVAL_MS,
    pathname: "/api/pages",
    method: "GET",
  })));
  assert.deepEqual(
    clock.waits.map(({ milliseconds }) => milliseconds),
    Array(7).fill(BOOKSTACK_LIFECYCLE_REQUEST_INTERVAL_MS),
  );
});

test("paces each lifecycle HTTP method and a GET retry at dispatch", async () => {
  const clock = virtualClock();
  const calls = [];
  let pageAttempts = 0;
  const client = lifecycleClient(clock, async (url, init = {}) => {
    const parsed = new URL(String(url));
    const method = init.method ?? "GET";
    calls.push({ at: clock.time, pathname: parsed.pathname, method });
    if (parsed.pathname === "/api/shelves") return json({ data: [], total: 0 });
    if (parsed.pathname === "/api/books/2") return json(resource({ id: 2, name: "Book", slug: "book" }));
    if (parsed.pathname === "/api/pages" && method === "POST") {
      return json(resource({ id: 3, name: "Page", slug: "page" }));
    }
    if (parsed.pathname === "/api/shelves/1" && method === "PUT") {
      return json(resource({ id: 1, name: "Lifecycle", slug: "lifecycle-artifacts", books: [2] }));
    }
    if (parsed.pathname === "/api/shelves/1") {
      return json(resource({ id: 1, name: "Lifecycle", slug: "lifecycle-artifacts", books: [2] }));
    }
    if (parsed.pathname === "/api/pages") {
      pageAttempts += 1;
      return pageAttempts === 1
        ? new Response("retry", { status: 503 })
        : json({ data: [], total: 0 });
    }
    throw new Error("unexpected_synthetic_request");
  });

  await client.listShelves();
  await client.readBook(2);
  await client.createPage("Page", 1, "# Page");
  await client.replaceShelfBooks({ shelfId: 1, shelfName: "Lifecycle", expectedBooks: [2] });
  await client.listPages();

  assert.deepEqual(calls.map(({ at }) => at), [
    0,
    1_100,
    2_200,
    3_300,
    4_400,
    5_500,
    6_600,
  ]);
  assert.deepEqual(calls.map(({ pathname, method }) => ({ pathname, method })), [
    { pathname: "/api/shelves", method: "GET" },
    { pathname: "/api/books/2", method: "GET" },
    { pathname: "/api/pages", method: "POST" },
    { pathname: "/api/shelves/1", method: "PUT" },
    { pathname: "/api/shelves/1", method: "GET" },
    { pathname: "/api/pages", method: "GET" },
    { pathname: "/api/pages", method: "GET" },
  ]);
});

test("retries approved transient GET failures exactly once before returning a safe exhaustion error", async () => {
  const scenarios = [
    ...[500, 502, 503, 504].map((status) => ({
      name: `transient HTTP ${status}`,
      fetch: async () => new Response("upstream", { status }),
      code: "bookstack_http_failed",
    })),
    {
      name: "known transport failure",
      fetch: async () => {
        const error = new Error("synthetic transport detail");
        error.code = "ECONNRESET";
        throw error;
      },
      code: "bookstack_transport_failed",
    },
  ];

  for (const scenario of scenarios) {
    const clock = virtualClock();
    const starts = [];
    const requester = createBookStackLifecycleJsonRequester(schedulerFor(clock));
    let calls = 0;
    await assert.rejects(
      requester(requestInput(async (...args) => {
        calls += 1;
        starts.push(clock.time);
        return scenario.fetch(...args);
      })),
      (error) => {
        assert.ok(error instanceof Error, scenario.name);
        assert.equal(error.message, scenario.code, scenario.name);
        assert.doesNotMatch(error.message, /synthetic transport detail/, scenario.name);
        return true;
      },
      scenario.name,
    );
    assert.equal(calls, 2, scenario.name);
    assert.deepEqual(starts, [0, BOOKSTACK_LIFECYCLE_REQUEST_INTERVAL_MS], scenario.name);
  }
});

test("retries bounded Retry-After forms, rejects excessive delays, and exhausts persistent 429s", async () => {
  const originalDateNow = Date.now;
  const base = Date.UTC(2030, 0, 1, 0, 0, 0);
  Date.now = () => base;
  try {
    const scenarios = [
      { name: "numeric seconds", retryAfter: "3", expectedStart: 3_000 },
      { name: "maximum numeric seconds", retryAfter: "10", expectedStart: 10_000 },
      {
        name: "HTTP date",
        retryAfter: new Date(base + 5_000).toUTCString(),
        expectedStart: 5_000,
      },
      { name: "malformed value", retryAfter: "not-a-date", expectedStart: 1_100 },
    ];
    for (const scenario of scenarios) {
      const clock = virtualClock();
      const starts = [];
      const requester = createBookStackLifecycleJsonRequester(schedulerFor(clock));
      let calls = 0;
      const result = await requester(requestInput(async () => {
        calls += 1;
        starts.push(clock.time);
        return calls === 1
          ? new Response("rate limited", { status: 429, headers: { "retry-after": scenario.retryAfter } })
          : json({ ok: true });
      }));
      assert.deepEqual(result, { ok: true }, scenario.name);
      assert.equal(calls, 2, scenario.name);
      assert.deepEqual(starts, [0, scenario.expectedStart], scenario.name);
    }

    for (const scenario of [
      { name: "excessive numeric delay", retryAfter: "11", expectedCalls: 1 },
      { name: "persistent rate limit", retryAfter: null, expectedCalls: 2 },
    ]) {
      const clock = virtualClock();
      const starts = [];
      const requester = createBookStackLifecycleJsonRequester(schedulerFor(clock));
      let calls = 0;
      await assert.rejects(
        requester(requestInput(async () => {
          calls += 1;
          starts.push(clock.time);
          return new Response("rate limited", {
            status: 429,
            headers: scenario.retryAfter === null ? {} : { "retry-after": scenario.retryAfter },
          });
        })),
        /bookstack_rate_limited/,
        scenario.name,
      );
      assert.equal(calls, scenario.expectedCalls, scenario.name);
      assert.deepEqual(
        starts,
        scenario.expectedCalls === 1 ? [0] : [0, BOOKSTACK_LIFECYCLE_REQUEST_INTERVAL_MS],
        scenario.name,
      );
    }
  } finally {
    Date.now = originalDateNow;
  }
});

test("starts timeouts only at dispatch and retries a timed-out GET once", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];
  let nextTimerId = 0;
  globalThis.setTimeout = (callback, milliseconds) => {
    const timer = { id: nextTimerId++, callback, milliseconds, cleared: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer && typeof timer === "object") timer.cleared = true;
  };

  try {
    const clock = virtualClock();
    const starts = [];
    const firstResponse = deferred();
    let fetches = 0;
    const requester = createBookStackLifecycleJsonRequester(schedulerFor(clock));
    const fetcher = async () => {
      fetches += 1;
      starts.push(clock.time);
      return fetches === 1 ? firstResponse.promise : json({ ok: true });
    };

    const first = requester(requestInput(fetcher));
    const second = requester(requestInput(fetcher, {
      url: new URL("https://bookstack.example/api/books"),
    }));
    assert.deepEqual(starts, [0]);
    assert.deepEqual(timers.map(({ milliseconds }) => milliseconds), [60_000]);

    assert.deepEqual(await second, { ok: true });
    assert.deepEqual(starts, [0, 1_100]);
    assert.deepEqual(timers.map(({ milliseconds }) => milliseconds), [60_000, 60_000]);
    assert.equal(timers[0].cleared, false);
    assert.equal(timers[1].cleared, true);

    timers[0].callback();
    assert.deepEqual(await first, { ok: true });
    assert.deepEqual(starts, [0, 1_100, 2_200]);
    assert.deepEqual(timers.map(({ milliseconds }) => milliseconds), [60_000, 60_000, 60_000]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("cancelling one queued request leaves later work paced and isolated", async () => {
  const clock = virtualClock();
  const scheduler = schedulerFor(clock);
  const firstGate = deferred();
  const starts = [];
  const first = scheduler.schedule({
    start: () => {
      starts.push({ name: "first", at: clock.time });
      return firstGate.promise;
    },
  });
  const controller = new AbortController();
  const cancelled = scheduler.schedule({
    signal: controller.signal,
    start: async () => {
      starts.push({ name: "cancelled", at: clock.time });
      return "cancelled";
    },
  });
  controller.abort(new Error("cancelled before dispatch"));
  const following = scheduler.schedule({
    start: async () => {
      starts.push({ name: "following", at: clock.time });
      return "following";
    },
  });

  await assert.rejects(cancelled, (error) => notDispatched(error, "bookstack_transport_failed"));
  assert.equal(await following, "following");
  firstGate.resolve("first");
  assert.equal(await first, "first");
  assert.deepEqual(starts, [
    { name: "first", at: 0 },
    { name: "following", at: BOOKSTACK_LIFECYCLE_REQUEST_INTERVAL_MS },
  ]);

  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    scheduler.schedule({ signal: preAborted.signal, start: async () => "must not run" }),
    (error) => notDispatched(error, "bookstack_transport_failed"),
  );
});

test("client forwards an operation-local signal through admission and transport without cancelling peers", async () => {
  const clock = virtualClock();
  const lane = schedulerFor(clock);
  const admissions = [];
  const scheduler = {
    schedule: (input) => {
      admissions.push(input.signal);
      return lane.schedule(input);
    },
  };
  const controller = new AbortController();
  const peerController = new AbortController();
  const reason = new Error("operation cancelled");
  let activeSignal;
  let transportAborts = 0;
  let startPage;
  const pageStarted = new Promise((resolve) => { startPage = resolve; });
  const calls = [];
  const client = createBookStackLifecycleClient({
    origin: "https://bookstack.example",
    tokenId: "test-id",
    tokenSecret: "test-secret",
    requestScheduler: scheduler,
    fetch: async (url, init = {}) => {
      const pathname = new URL(String(url)).pathname;
      calls.push(pathname);
      if (pathname !== "/api/pages") return json({ data: [], total: 0 });
      activeSignal = init.signal;
      startPage();
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          transportAborts += 1;
          reject(init.signal?.reason ?? reason);
        }, { once: true });
      });
    },
  });

  const active = client.listPages(controller.signal);
  await pageStarted;
  const queued = client.listChapters(controller.signal);
  controller.abort(reason);
  const peer = client.listBooks(peerController.signal);

  await assert.rejects(active, /bookstack_transport_failed/);
  await assert.rejects(queued, (error) => notDispatched(error, "bookstack_transport_failed"));
  assert.deepEqual(await peer, []);
  assert.equal(admissions[0], controller.signal);
  assert.equal(admissions[1], controller.signal);
  assert.equal(admissions[2], peerController.signal);
  assert.equal(activeSignal?.aborted, true);
  assert.equal(transportAborts, 1);
  assert.deepEqual(calls, ["/api/pages", "/api/books"]);
});

test("caps waiting work at 64 requests without dropping the active request", async () => {
  const clock = virtualClock();
  const scheduler = schedulerFor(clock);
  const firstGate = deferred();
  const starts = [];
  const first = scheduler.schedule({
    start: () => {
      starts.push(clock.time);
      return firstGate.promise;
    },
  });
  const waiting = Array.from({ length: BOOKSTACK_LIFECYCLE_MAX_WAITING_REQUESTS }, (_unused, index) =>
    scheduler.schedule({
      start: async () => {
        starts.push(clock.time);
        return index;
      },
    }));
  const overflow = scheduler.schedule({ start: async () => "must not dispatch" });

  assert.deepEqual(starts, [0]);
  await assert.rejects(overflow, (error) => notDispatched(error, "bookstack_rate_limited"));
  firstGate.resolve("first");
  assert.equal(await first, "first");
  assert.deepEqual(await Promise.all(waiting), Array.from({ length: 64 }, (_unused, index) => index));
  assert.equal(starts.length, BOOKSTACK_LIFECYCLE_MAX_WAITING_REQUESTS + 1);
  assert.deepEqual(starts.slice(0, 3), [0, 1_100, 2_200]);
});

test("expires an over-residence request without dispatching it", async () => {
  let current = 0;
  const waitStarted = deferred();
  const releaseWait = deferred();
  const scheduler = createBookStackLifecycleRequestScheduler({
    now: () => current,
    wait: () => {
      waitStarted.resolve();
      return releaseWait.promise;
    },
  });
  const firstGate = deferred();
  const starts = [];
  const first = scheduler.schedule({
    start: () => {
      starts.push("first");
      return firstGate.promise;
    },
  });
  const expired = scheduler.schedule({
    start: async () => {
      starts.push("expired");
      return "expired";
    },
  });

  await waitStarted.promise;
  current = 120_000;
  releaseWait.resolve();
  await assert.rejects(expired, (error) => notDispatched(error, "bookstack_rate_limited"));
  assert.deepEqual(starts, ["first"]);
  firstGate.resolve("first");
  assert.equal(await first, "first");
});

test("fails closed after bounded early wakes without dispatching later work", async () => {
  let waits = 0;
  const scheduler = createBookStackLifecycleRequestScheduler({
    now: () => 0,
    wait: async () => { waits += 1; },
  });
  let starts = 0;
  await scheduler.schedule({ start: async () => { starts += 1; return "first"; } });
  await assert.rejects(
    scheduler.schedule({ start: async () => { starts += 1; return "late"; } }),
    (error) => notDispatched(error, "bookstack_transport_failed"),
  );
  assert.equal(waits, 101);
  assert.equal(starts, 1);
});

test("slow responses do not block the lane and idle time does not create a burst", async () => {
  const clock = virtualClock();
  const scheduler = schedulerFor(clock);
  const firstGate = deferred();
  const starts = [];
  const first = scheduler.schedule({
    start: () => {
      starts.push(clock.time);
      return firstGate.promise;
    },
  });
  const second = scheduler.schedule({
    start: async () => {
      starts.push(clock.time);
      return "second";
    },
  });
  assert.equal(await second, "second");

  clock.advance(10_000);
  const third = scheduler.schedule({
    start: async () => {
      starts.push(clock.time);
      return "third";
    },
  });
  const fourth = scheduler.schedule({
    start: async () => {
      starts.push(clock.time);
      return "fourth";
    },
  });
  assert.deepEqual(await Promise.all([third, fourth]), ["third", "fourth"]);
  firstGate.resolve("first");
  assert.equal(await first, "first");

  assert.deepEqual(starts, [0, 1_100, 11_100, 12_200]);
});

test("REVIEW-003 discards every unconsumed early response failure without retrying or stopping peers", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];
  let nextTimerId = 0;
  globalThis.setTimeout = (callback, milliseconds) => {
    const timer = { id: nextTimerId++, callback, milliseconds, cleared: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer && typeof timer === "object") timer.cleared = true;
  };

  try {
    const cases = [
      { name: "401", status: 401, headers: {}, code: "bookstack_access_denied" },
      { name: "403", status: 403, headers: {}, code: "bookstack_access_denied" },
      { name: "404", status: 404, headers: {}, code: "bookstack_http_failed" },
      { name: "invalid content type", status: 200, headers: { "content-type": "text/plain" }, code: "bookstack_response_invalid" },
      {
        name: "oversized declared response",
        status: 200,
        headers: { "content-type": "application/json", "content-length": String(4 * 1024 * 1024 + 1) },
        code: "bookstack_response_too_large",
      },
    ];

    for (const scenario of cases) {
      const clock = virtualClock();
      const requester = createBookStackLifecycleJsonRequester(schedulerFor(clock));
      let cancellations = 0;
      let attempts = 0;
      const response = new Response(new ReadableStream({
        pull: () => new Promise(() => undefined),
        cancel: () => { cancellations += 1; },
      }), {
        status: scenario.status,
        headers: scenario.headers,
      });

      await assert.rejects(
        requester(requestInput(async () => {
          attempts += 1;
          return response;
        })),
        new RegExp(scenario.code),
        scenario.name,
      );
      await Promise.resolve();
      assert.equal(attempts, 1, scenario.name);
      assert.equal(cancellations, 1, scenario.name);
      assert.equal(timers.at(-1)?.cleared, true, scenario.name);

      const unrelated = await requester(requestInput(async () => json({ unrelated: true }), {
        url: new URL(`https://bookstack.example/api/unrelated-${scenario.name.replaceAll(" ", "-")}`),
      }));
      assert.deepEqual(unrelated, { unrelated: true }, scenario.name);
      assert.equal(timers.at(-1)?.cleared, true, `${scenario.name} cleanup`);
    }

    let successfulCancellation = 0;
    const successfulResponse = new Response(new ReadableStream({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ consumed: true })));
        controller.close();
      },
      cancel: () => { successfulCancellation += 1; },
    }), { headers: { "content-type": "application/json" } });
    const successfulRequester = createBookStackLifecycleJsonRequester(schedulerFor(virtualClock()));
    assert.deepEqual(
      await successfulRequester(requestInput(async () => successfulResponse)),
      { consumed: true },
    );
    assert.equal(successfulCancellation, 0);
    assert.equal(timers.every((timer) => timer.cleared), true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
