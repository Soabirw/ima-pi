import assert from "node:assert/strict";
import test from "node:test";
import { createBookStackClient } from "../lib/bookstack-migrate-client.ts";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

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

const clientInput = (overrides = {}) => {
  const clock = virtualClock();
  return {
    origin: "https://bookstack.example",
    tokenId: "test-id",
    tokenSecret: "synthetic-token-secret",
    now: clock.now,
    wait: clock.wait,
    ...overrides,
  };
};

const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

const boundedTransportFailure = (error) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, "bookstack_transport_failed");
  assert.doesNotMatch(error.message, /synthetic-token-secret/);
  return true;
};

const expectTransportFailure = (promise) => assert.rejects(promise, boundedTransportFailure);

const listPagesWithLengths = async (lengths) => {
  const clock = virtualClock();
  const offsets = [];
  const client = createBookStackClient(clientInput({
    requestIntervalMs: 10,
    now: clock.now,
    wait: clock.wait,
    fetch: async (url) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      offsets.push(offset);
      const length = lengths[offset / 500] ?? 0;
      return json({
        data: Array.from({ length }, (_, index) => ({
          id: offset + index + 1,
          name: `page-${offset + index + 1}`,
        })),
      });
    },
  }));
  return { pages: await client.listPages(), offsets, clock };
};

test("uses a fixed HTTPS origin, token auth, JSON, and redirect denial", async () => {
  const calls = [];
  const client = createBookStackClient(clientInput({
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return json({ data: [{ id: 7, name: "Lifecycle Artifacts" }] });
    },
  }));
  assert.deepEqual(await client.listShelves(), [{ id: 7, name: "Lifecycle Artifacts" }]);
  assert.equal(calls[0].url, "https://bookstack.example/api/shelves?count=500&offset=0");
  assert.equal(calls[0].options.headers.authorization, "Token test-id:synthetic-token-secret");
  assert.equal(calls[0].options.redirect, "error");
  assert.throws(() => createBookStackClient(clientInput({ origin: "http://bookstack.example" })), /bookstack_origin_invalid/);
  assert.throws(() => createBookStackClient(clientInput({ origin: "https://id:secret@bookstack.example" })), /bookstack_origin_invalid/);
});

test("distinguishes absent and ambiguous shelf names", async () => {
  const ambiguous = createBookStackClient(clientInput({
    fetch: async () => json({ data: [{ id: 1, name: "x" }, { id: 2, name: "x" }] }),
  }));
  await assert.rejects(ambiguous.resolveShelf("x"), /bookstack_identity_ambiguous/);
  const absent = createBookStackClient(clientInput({ fetch: async () => json({ data: [] }) }));
  await assert.rejects(absent.resolveShelf("x"), /bookstack_shelf_absent/);
});

test("updates Shelf membership then verifies it through an explicit read-back", async () => {
  const calls = [];
  const client = createBookStackClient(clientInput({
    fetch: async (_url, options = {}) => {
      calls.push(options.method ?? "GET");
      if (options.method === "PUT") return json({ id: 7, name: "Lifecycle Artifacts" });
      return json({ id: 7, name: "Lifecycle Artifacts", books: [{ id: 3 }, { id: 5 }] });
    },
  }));
  await client.replaceShelfBooks(7, "Lifecycle Artifacts", [3, 5]);
  assert.deepEqual(calls, ["PUT", "GET"]);
});

test("accepts the empty success response used by Page deletion", async () => {
  const calls = [];
  const client = createBookStackClient(clientInput({
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(null, { status: 204 });
    },
  }));
  await client.deletePage(42);
  assert.equal(calls[0].options.method, "DELETE");
});

test("preserves the production 1,100 ms default between request starts", async () => {
  const clock = virtualClock();
  const starts = [];
  const client = createBookStackClient(clientInput({
    now: clock.now,
    wait: clock.wait,
    fetch: async () => {
      starts.push(clock.time);
      return json({ data: [] });
    },
  }));

  await Promise.all([client.listShelves(), client.listShelves()]);

  assert.deepEqual(starts, [0, 1_100]);
  assert.deepEqual(clock.waits.map(({ milliseconds }) => milliseconds), [1_100]);
});

test("uses one FIFO schedule for concurrent mixed methods", async () => {
  const clock = virtualClock();
  const starts = [];
  const calls = [];
  const client = createBookStackClient(clientInput({
    requestIntervalMs: 10,
    now: clock.now,
    wait: clock.wait,
    fetch: async (url, options = {}) => {
      const path = new URL(url).pathname;
      const method = options.method ?? "GET";
      starts.push(clock.time);
      calls.push({ path, method });
      if (path === "/api/shelves") return json({ data: [] });
      if (path === "/api/books" && method === "POST") return json({ id: 1, name: "book" });
      if (path === "/api/pages/42" && method === "GET") return json({ id: 42, name: "page" });
      if (path === "/api/pages/42" && method === "DELETE") return new Response(null, { status: 204 });
      throw new Error("synthetic_unexpected_request");
    },
  }));

  await Promise.all([
    client.listShelves(),
    client.createBook("book"),
    client.readPage(42),
    client.deletePage(42),
  ]);

  assert.deepEqual(starts, [0, 10, 20, 30]);
  assert.deepEqual(calls, [
    { path: "/api/shelves", method: "GET" },
    { path: "/api/books", method: "POST" },
    { path: "/api/pages/42", method: "GET" },
    { path: "/api/pages/42", method: "DELETE" },
  ]);
});

test("does not accumulate idle request credits", async () => {
  const clock = virtualClock();
  const starts = [];
  const client = createBookStackClient(clientInput({
    requestIntervalMs: 10,
    now: clock.now,
    wait: clock.wait,
    fetch: async () => {
      starts.push(clock.time);
      return json({ data: [] });
    },
  }));

  await client.listShelves();
  clock.advance(50);
  await Promise.all([client.listShelves(), client.listShelves()]);

  assert.deepEqual(starts, [0, 50, 60]);
  assert.deepEqual(clock.waits.map(({ milliseconds }) => milliseconds), [10]);
});

test("paginates 500, 500, remainder, and exact multiple catalog pages", async () => {
  const remainder = await listPagesWithLengths([500, 500, 66]);
  assert.equal(remainder.pages.length, 1_066);
  assert.deepEqual(remainder.offsets, [0, 500, 1_000]);

  const exactMultiple = await listPagesWithLengths([500, 500, 0]);
  assert.equal(exactMultiple.pages.length, 1_000);
  assert.deepEqual(exactMultiple.offsets, [0, 500, 1_000]);
});

test("rechecks the monotonic clock after each early virtual wake", async () => {
  let current = 0;
  const waits = [];
  const starts = [];
  const client = createBookStackClient(clientInput({
    requestIntervalMs: 10,
    now: () => current,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      current += Math.min(3, milliseconds);
    },
    fetch: async () => {
      starts.push(current);
      return json({ data: [] });
    },
  }));

  await client.listShelves();
  await client.listShelves();

  assert.deepEqual(waits, [10, 7, 4, 1]);
  assert.deepEqual(starts, [0, 10]);
});

test("fails closed after the bounded number of early wakes", async () => {
  let current = 0;
  let waits = 0;
  let fetches = 0;
  const client = createBookStackClient(clientInput({
    requestIntervalMs: 10,
    now: () => current,
    wait: async () => { waits += 1; },
    fetch: async () => {
      fetches += 1;
      return json({ data: [] });
    },
  }));

  await client.listShelves();
  await expectTransportFailure(client.listShelves());

  assert.equal(waits, 100);
  assert.equal(fetches, 1);
  current += 10;
  await expectTransportFailure(client.listShelves());
  assert.equal(fetches, 1);
});

test("rejects zero, negative, fractional, non-finite, and excessive intervals without fetching", () => {
  const intervals = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 120_001];
  for (const requestIntervalMs of intervals) {
    let fetches = 0;
    assert.throws(() => createBookStackClient(clientInput({
      requestIntervalMs,
      fetch: async () => {
        fetches += 1;
        return json({ data: [] });
      },
    })), /bookstack_pacing_invalid/);
    assert.equal(fetches, 0, `interval ${String(requestIntervalMs)} must fail before fetch`);
  }
});

test("rejects malformed timing dependencies and fails closed at a malformed signal boundary", async () => {
  for (const timingDependency of [{ now: null }, { wait: null }]) {
    let fetches = 0;
    assert.throws(() => createBookStackClient(clientInput({
      ...timingDependency,
      fetch: async () => {
        fetches += 1;
        return json({ data: [] });
      },
    })), /bookstack_pacing_invalid/);
    assert.equal(fetches, 0);
  }

  let fetches = 0;
  const malformedSignal = {
    aborted: false,
    addEventListener: () => { throw new Error("synthetic-token-secret"); },
    removeEventListener: () => undefined,
  };
  const client = createBookStackClient(clientInput({
    requestIntervalMs: 10,
    now: () => 0,
    wait: async () => undefined,
    signal: malformedSignal,
    fetch: async () => {
      fetches += 1;
      return json({ data: [] });
    },
  }));

  await expectTransportFailure(client.listShelves());
  assert.equal(fetches, 0);
});

test("fails closed on throwing, non-finite, and backward clocks", async () => {
  for (const now of [
    () => { throw new Error("synthetic-token-secret"); },
    () => Number.NaN,
  ]) {
    let fetches = 0;
    const client = createBookStackClient(clientInput({
      requestIntervalMs: 10,
      now,
      wait: async () => undefined,
      fetch: async () => {
        fetches += 1;
        return json({ data: [] });
      },
    }));
    await expectTransportFailure(client.listShelves());
    assert.equal(fetches, 0);
  }

  const readings = [10, 5];
  let fetches = 0;
  const backward = createBookStackClient(clientInput({
    requestIntervalMs: 10,
    now: () => readings.shift(),
    wait: async () => undefined,
    fetch: async () => {
      fetches += 1;
      return json({ data: [] });
    },
  }));
  await backward.listShelves();
  await expectTransportFailure(backward.listShelves());
  assert.equal(fetches, 1);
});

test("fails closed on a rejected wait and does not issue a later request", async () => {
  let fetches = 0;
  const client = createBookStackClient(clientInput({
    requestIntervalMs: 10,
    now: () => 0,
    wait: async () => { throw new Error("synthetic-token-secret"); },
    fetch: async () => {
      fetches += 1;
      return json({ data: [] });
    },
  }));

  await client.listShelves();
  await expectTransportFailure(client.listShelves());
  await expectTransportFailure(client.listShelves());
  assert.equal(fetches, 1);
});

test("rejects cancellation before queueing without issuing fetch or leaking credentials", async () => {
  const controller = new AbortController();
  controller.abort();
  let fetches = 0;
  const client = createBookStackClient(clientInput({
    requestIntervalMs: 10,
    now: () => 0,
    wait: async () => undefined,
    signal: controller.signal,
    fetch: async () => {
      fetches += 1;
      return json({ data: [] });
    },
  }));

  await expectTransportFailure(client.listShelves());
  assert.equal(fetches, 0);
});

test("cancels requests while one is waiting and another remains queued without issuing either", async () => {
  const controller = new AbortController();
  const waitStarted = deferred();
  const releaseWait = deferred();
  const signals = [];
  let fetches = 0;
  const client = createBookStackClient(clientInput({
    requestIntervalMs: 10,
    now: () => 0,
    wait: (_milliseconds, signal) => {
      signals.push(signal);
      waitStarted.resolve();
      return releaseWait.promise;
    },
    signal: controller.signal,
    fetch: async () => {
      fetches += 1;
      return json({ data: [] });
    },
  }));

  await client.listShelves();
  const waiting = client.listShelves();
  const queued = client.listShelves();
  await waitStarted.promise;
  controller.abort();
  releaseWait.resolve();

  await expectTransportFailure(waiting);
  await expectTransportFailure(queued);
  assert.deepEqual(signals, [controller.signal]);
  assert.equal(fetches, 1);
});

test("cancels after a virtual wait completes and before request issuance", async () => {
  const controller = new AbortController();
  const clock = virtualClock();
  let fetches = 0;
  const client = createBookStackClient(clientInput({
    requestIntervalMs: 10,
    now: clock.now,
    wait: async (milliseconds) => {
      clock.advance(milliseconds);
      controller.abort();
    },
    signal: controller.signal,
    fetch: async () => {
      fetches += 1;
      return json({ data: [] });
    },
  }));

  await client.listShelves();
  await expectTransportFailure(client.listShelves());
  assert.equal(fetches, 1);
});

test("does not invoke fetch when cancellation occurs at the final request-start boundary", async () => {
  const controller = new AbortController();
  let current = 0;
  let clockReads = 0;
  let fetches = 0;
  const client = createBookStackClient(clientInput({
    requestIntervalMs: 10,
    now: () => {
      clockReads += 1;
      if (clockReads === 4) controller.abort();
      return current;
    },
    wait: async (milliseconds) => { current += milliseconds; },
    signal: controller.signal,
    fetch: async (_url, options) => {
      fetches += 1;
      if (options.signal.aborted) throw new Error("synthetic_fetch_aborted");
      return json({ data: [] });
    },
  }));

  await client.listShelves();
  await expectTransportFailure(client.listShelves());
  assert.equal(fetches, 1);
});

test("starts each network timeout when its request is issued, not while it is queued", async () => {
  const originalTimeout = AbortSignal.timeout;
  const clock = virtualClock();
  const timeoutStarts = [];
  const starts = [];
  try {
    AbortSignal.timeout = () => {
      timeoutStarts.push(clock.time);
      return new AbortController().signal;
    };
    const client = createBookStackClient(clientInput({
      requestIntervalMs: 10,
      timeoutMs: 25,
      now: clock.now,
      wait: clock.wait,
      fetch: async () => {
        starts.push(clock.time);
        return json({ data: [] });
      },
    }));

    await Promise.all([client.listShelves(), client.listShelves()]);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }

  assert.deepEqual(starts, [0, 10]);
  assert.deepEqual(timeoutStarts, [0, 10]);
});
