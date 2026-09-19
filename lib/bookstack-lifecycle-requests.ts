import {
  discardBookStackResponse,
  parseBookStackJsonResponse,
  type BookStackJsonRequestInput,
  type BookStackJsonRequester,
} from "./bookstack-http.ts";

export const BOOKSTACK_LIFECYCLE_REQUEST_INTERVAL_MS = 1_100;
export const BOOKSTACK_LIFECYCLE_MAX_WAITING_REQUESTS = 64;
export const BOOKSTACK_LIFECYCLE_MAX_QUEUE_RESIDENCE_MS = 120_000;
export const BOOKSTACK_LIFECYCLE_MAX_RETRY_AFTER_MS = 10_000;

const MAX_READ_ATTEMPTS = 2;
const MAX_EARLY_WAKES = 100;
const TRANSIENT_TRANSPORT_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const SAFE_BOOKSTACK_FAILURE_CODES = new Set([
  "bookstack_access_denied",
  "bookstack_http_failed",
  "bookstack_rate_limited",
  "bookstack_response_invalid",
  "bookstack_response_too_large",
  "bookstack_transport_failed",
]);
const REQUEST_NOT_DISPATCHED = Symbol("bookstack-request-not-dispatched");
const RETRYABLE_TRANSPORT = Symbol("bookstack-retryable-transport");

type Wait = (milliseconds: number, signal?: AbortSignal) => Promise<void> | void;
type Clock = () => number;
type ScheduledRequest = {
  start: () => Promise<unknown>;
  signal?: AbortSignal;
  queuedAt: number;
  earliestStartAt: number;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  queued: boolean;
  earlyWakes: number;
  detachAbort: () => void;
};
type ActiveAttempt = {
  response: Response;
  close: () => void;
  timedOut: () => boolean;
  timeout: Promise<never>;
  cancelled: Promise<never>;
};
type RetryAfter =
  | { status: "delay"; milliseconds: number }
  | { status: "excessive" }
  | null;

export type BookStackLifecycleRequestScheduler = {
  schedule: <Value>(input: {
    start: () => Promise<Value>;
    signal?: AbortSignal;
    minimumDelayMs?: number;
  }) => Promise<Value>;
};

export type BookStackLifecycleRequestSchedulerInput = {
  now?: Clock;
  wait?: Wait;
};

const failure = (input: {
  code: "bookstack_rate_limited" | "bookstack_transport_failed";
  notDispatched?: boolean;
  retryableTransport?: boolean;
}) => {
  const error = new Error(input.code);
  if (input.notDispatched) {
    Object.defineProperty(error, REQUEST_NOT_DISPATCHED, { value: true });
  }
  if (input.retryableTransport) {
    Object.defineProperty(error, RETRYABLE_TRANSPORT, { value: true });
  }
  return error;
};

const transportFailure = (input: {
  notDispatched?: boolean;
  retryableTransport?: boolean;
} = {}) => failure({ code: "bookstack_transport_failed", ...input });
const rateLimited = (notDispatched = false) => failure({
  code: "bookstack_rate_limited",
  ...(notDispatched ? { notDispatched: true } : {}),
});

const errorCode = (error: unknown) => {
  try {
    if (!(error instanceof Error) || typeof error.message !== "string") return null;
    return SAFE_BOOKSTACK_FAILURE_CODES.has(error.message) ? error.message : null;
  } catch {
    return null;
  }
};

const hasMarker = (error: unknown, marker: symbol) => {
  try {
    return Boolean(error && typeof error === "object"
      && Object.getOwnPropertyDescriptor(error, marker)?.value === true);
  } catch {
    return false;
  }
};

export const bookStackLifecycleRequestWasNotDispatched = (error: unknown) =>
  hasMarker(error, REQUEST_NOT_DISPATCHED);

const isRetryableTransport = (error: unknown) => hasMarker(error, RETRYABLE_TRANSPORT);

const safeFailure = (error: unknown, fallback = "bookstack_transport_failed") => {
  const code = errorCode(error);
  if (code === "bookstack_rate_limited") {
    return rateLimited(bookStackLifecycleRequestWasNotDispatched(error));
  }
  if (code === "bookstack_transport_failed") {
    return transportFailure({
      ...(bookStackLifecycleRequestWasNotDispatched(error) ? { notDispatched: true } : {}),
      ...(isRetryableTransport(error) ? { retryableTransport: true } : {}),
    });
  }
  return new Error(code ?? fallback);
};

const valueFor = (value: unknown, key: PropertyKey): unknown => {
  try {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && !descriptor.get && !descriptor.set ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
};

const transientTransportFailure = (error: unknown) => {
  const direct = valueFor(error, "code");
  const cause = valueFor(error, "cause");
  const nested = valueFor(cause, "code");
  return (typeof direct === "string" && TRANSIENT_TRANSPORT_CODES.has(direct))
    || (typeof nested === "string" && TRANSIENT_TRANSPORT_CODES.has(nested));
};

const aborted = (signal?: AbortSignal) => {
  try {
    return signal?.aborted === true;
  } catch {
    return true;
  }
};

const defaultNow = () => globalThis.performance.now();
const defaultWait: Wait = (milliseconds, signal) => new Promise((resolve) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    try {
      signal?.removeEventListener("abort", finish);
    } catch {
      // The local lane remains safe if cancellation cleanup is unavailable.
    }
    resolve();
  };
  try {
    if (signal?.aborted) {
      finish();
      return;
    }
    signal?.addEventListener("abort", finish, { once: true });
    timer = setTimeout(finish, milliseconds);
  } catch {
    finish();
  }
});

const validMinimumDelay = (value: unknown) => Number.isSafeInteger(value)
  && Number(value) >= 0
  && Number(value) <= BOOKSTACK_LIFECYCLE_MAX_QUEUE_RESIDENCE_MS
  ? Number(value)
  : null;

export const createBookStackLifecycleRequestScheduler = (
  input: BookStackLifecycleRequestSchedulerInput = {},
): BookStackLifecycleRequestScheduler => {
  const now = input.now ?? defaultNow;
  const wait = input.wait ?? defaultWait;
  if (typeof now !== "function" || typeof wait !== "function") {
    throw new Error("bookstack_request_scheduler_invalid");
  }

  const queue: ScheduledRequest[] = [];
  let draining = false;
  let lastStartedAt: number | null = null;
  let lastObservedAt: number | null = null;
  let wakeWait: (() => void) | null = null;

  const observeNow = () => {
    try {
      const value = now();
      if (!Number.isFinite(value) || value < 0
        || lastObservedAt !== null && value < lastObservedAt) return null;
      lastObservedAt = value;
      return value;
    } catch {
      return null;
    }
  };

  const wake = () => {
    const resolve = wakeWait;
    wakeWait = null;
    resolve?.();
  };

  const remove = (entry: ScheduledRequest) => {
    const index = queue.indexOf(entry);
    if (index < 0) return false;
    queue.splice(index, 1);
    entry.queued = false;
    entry.detachAbort();
    return true;
  };

  const waitFor = async (milliseconds: number) => {
    const controller = new AbortController();
    let wasWoken = false;
    let resolveWake: (() => void) | null = null;
    const woken = new Promise<"woken">((resolve) => {
      resolveWake = () => resolve("woken");
    });
    const wakeRequest = () => {
      wasWoken = true;
      try {
        controller.abort();
      } catch {
        // The wake promise still releases the lane when a controller misbehaves.
      }
      resolveWake?.();
    };
    wakeWait = wakeRequest;
    const waited = Promise.resolve()
      .then(() => wait(milliseconds, controller.signal))
      .then(
        () => "elapsed" as const,
        () => "failed" as const,
      );
    const outcome = await Promise.race([waited, woken]);
    if (wakeWait === wakeRequest) wakeWait = null;
    return wasWoken ? "woken" : outcome;
  };

  const attachAbort = (entry: ScheduledRequest) => {
    const signal = entry.signal;
    if (!signal) return true;
    try {
      if (typeof signal.addEventListener !== "function"
        || typeof signal.removeEventListener !== "function"
        || aborted(signal)) return false;
      const onAbort = () => {
        if (!remove(entry)) return;
        entry.reject(transportFailure({ notDispatched: true }));
        wake();
      };
      entry.detachAbort = () => {
        try {
          signal.removeEventListener("abort", onAbort);
        } catch {
          // A malformed external signal cannot change the local request result.
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (aborted(signal)) {
        entry.detachAbort();
        return false;
      }
      return true;
    } catch {
      entry.detachAbort();
      return false;
    }
  };

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const entry = queue[0];
        if (!entry) continue;
        if (aborted(entry.signal)) {
          remove(entry);
          entry.reject(transportFailure({ notDispatched: true }));
          continue;
        }
        const observedAt = observeNow();
        if (observedAt === null) {
          remove(entry);
          entry.reject(transportFailure({ notDispatched: true }));
          continue;
        }
        const residence = observedAt - entry.queuedAt;
        if (!Number.isFinite(residence) || residence < 0) {
          remove(entry);
          entry.reject(transportFailure({ notDispatched: true }));
          continue;
        }
        if (residence >= BOOKSTACK_LIFECYCLE_MAX_QUEUE_RESIDENCE_MS) {
          remove(entry);
          entry.reject(rateLimited(true));
          continue;
        }
        const pacedAt = lastStartedAt === null
          ? observedAt
          : lastStartedAt + BOOKSTACK_LIFECYCLE_REQUEST_INTERVAL_MS;
        const dueAt = Math.max(pacedAt, entry.earliestStartAt);
        if (!Number.isFinite(dueAt)) {
          remove(entry);
          entry.reject(transportFailure({ notDispatched: true }));
          continue;
        }
        if (dueAt > observedAt) {
          const outcome = await waitFor(dueAt - observedAt);
          if (outcome === "failed") {
            remove(entry);
            entry.reject(transportFailure({ notDispatched: true }));
            continue;
          }
          if (outcome === "elapsed") {
            const afterWait = observeNow();
            if (afterWait === null) {
              remove(entry);
              entry.reject(transportFailure({ notDispatched: true }));
              continue;
            }
            entry.earlyWakes = afterWait < dueAt ? entry.earlyWakes + 1 : 0;
            if (entry.earlyWakes > MAX_EARLY_WAKES) {
              remove(entry);
              entry.reject(transportFailure({ notDispatched: true }));
            }
          }
          continue;
        }
        remove(entry);
        if (aborted(entry.signal)) {
          entry.reject(transportFailure({ notDispatched: true }));
          continue;
        }
        lastStartedAt = observedAt;
        try {
          const started = entry.start();
          const recordedAt = observeNow();
          if (recordedAt !== null) lastStartedAt = recordedAt;
          entry.resolve(started);
        } catch (error) {
          entry.reject(safeFailure(error));
        }
      }
    } finally {
      draining = false;
      if (queue.length > 0) void drain();
    }
  };

  return {
    schedule: <Value>(request: {
      start: () => Promise<Value>;
      signal?: AbortSignal;
      minimumDelayMs?: number;
    }) => {
      const delay = validMinimumDelay(request.minimumDelayMs ?? 0);
      const queuedAt = observeNow();
      if (delay === null || queuedAt === null || typeof request.start !== "function") {
        return Promise.reject(transportFailure({ notDispatched: true }));
      }
      if (aborted(request.signal)) {
        return Promise.reject(transportFailure({ notDispatched: true }));
      }
      if (queue.length >= BOOKSTACK_LIFECYCLE_MAX_WAITING_REQUESTS) {
        return Promise.reject(rateLimited(true));
      }
      return new Promise<Value>((resolve, reject) => {
        const earliestStartAt = queuedAt + delay;
        if (!Number.isFinite(earliestStartAt)) {
          reject(transportFailure({ notDispatched: true }));
          return;
        }
        const entry: ScheduledRequest = {
          start: () => request.start(),
          signal: request.signal,
          queuedAt,
          earliestStartAt,
          resolve: (value) => resolve(value as Value),
          reject,
          queued: true,
          earlyWakes: 0,
          detachAbort: () => undefined,
        };
        if (!attachAbort(entry)) {
          entry.queued = false;
          reject(transportFailure({ notDispatched: true }));
          return;
        }
        queue.push(entry);
        void drain();
      });
    },
  };
};

const processBookStackLifecycleRequestScheduler = createBookStackLifecycleRequestScheduler();

const startFetch = (input: BookStackJsonRequestInput): Promise<ActiveAttempt> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let fetchInvoked = false;
  let detachAbort = () => undefined;
  let rejectTimeout: (reason?: unknown) => void = () => undefined;
  let rejectAbort: (reason?: unknown) => void = () => undefined;
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const abortFailure = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const close = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    detachAbort();
    detachAbort = () => undefined;
  };
  try {
    if (aborted(input.signal)) throw transportFailure({ notDispatched: true });
    if (input.signal) {
      if (typeof input.signal.addEventListener !== "function"
        || typeof input.signal.removeEventListener !== "function") {
        throw transportFailure({ notDispatched: true });
      }
      const onAbort = () => rejectAbort(transportFailure());
      detachAbort = () => {
        try {
          input.signal?.removeEventListener("abort", onAbort);
        } catch {
          // The request has a bounded local cancellation result either way.
        }
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
      if (aborted(input.signal)) throw transportFailure({ notDispatched: true });
    }
    const timeout = new AbortController();
    timer = setTimeout(() => {
      timedOut = true;
      try {
        timeout.abort();
      } catch {
        // The timeout remains authoritative even if an injected controller misbehaves.
      }
      rejectTimeout(transportFailure({ retryableTransport: true }));
    }, input.timeoutMs);
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeout.signal])
      : timeout.signal;
    if (aborted(input.signal)) throw transportFailure({ notDispatched: true });
    fetchInvoked = true;
    const pending = input.fetcher(input.url, {
      ...input.init,
      redirect: "error",
      signal,
    });
    return Promise.race([Promise.resolve(pending), timeoutFailure, abortFailure]).then(
      (response) => ({
        response,
        close,
        timedOut: () => timedOut,
        timeout: timeoutFailure,
        cancelled: abortFailure,
      }),
      (error) => {
        close();
        if (timedOut) throw transportFailure({ retryableTransport: true });
        if (aborted(input.signal)) throw transportFailure();
        if (transientTransportFailure(error)) {
          throw transportFailure({ retryableTransport: true });
        }
        throw transportFailure();
      },
    );
  } catch (error) {
    close();
    if (errorCode(error) === "bookstack_transport_failed") throw safeFailure(error);
    throw transportFailure({ ...(fetchInvoked ? {} : { notDispatched: true }) });
  }
};

const discardAttempt = (attempt: ActiveAttempt) => {
  discardBookStackResponse(attempt.response);
  attempt.close();
};

const responseStatus = (response: Response) => {
  try {
    return Number.isSafeInteger(response.status) ? response.status : null;
  } catch {
    return null;
  }
};

const retryAfterHeader = (response: Response) => {
  try {
    const value = response.headers.get("retry-after");
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
};

const retryAfter = (value: string | null): RetryAfter => {
  if (value === null) return null;
  const candidate = value.trim();
  if (/^\d+$/.test(candidate)) {
    const normalized = candidate.replace(/^0+/, "") || "0";
    if (normalized.length > 2) return { status: "excessive" };
    const milliseconds = Number(normalized) * 1_000;
    return milliseconds <= BOOKSTACK_LIFECYCLE_MAX_RETRY_AFTER_MS
      ? { status: "delay", milliseconds }
      : { status: "excessive" };
  }
  if (!/[A-Za-z]/.test(candidate)) return null;
  const timestamp = Date.parse(candidate);
  if (!Number.isFinite(timestamp)) return null;
  const now = Date.now();
  if (!Number.isFinite(now)) return null;
  const milliseconds = Math.max(0, timestamp - now);
  return milliseconds <= BOOKSTACK_LIFECYCLE_MAX_RETRY_AFTER_MS
    ? { status: "delay", milliseconds }
    : { status: "excessive" };
};

const isGet = (init: RequestInit) => {
  try {
    return (init.method ?? "GET").toUpperCase() === "GET";
  } catch {
    return false;
  }
};

const retryableStatus = (status: number) => [429, 500, 502, 503, 504].includes(status);

export const createBookStackLifecycleJsonRequester = (
  scheduler: BookStackLifecycleRequestScheduler = processBookStackLifecycleRequestScheduler,
): BookStackJsonRequester => async (input) => {
  const attempts = isGet(input.init) ? MAX_READ_ATTEMPTS : 1;
  let minimumDelayMs = 0;

  for (let attemptNumber = 0; attemptNumber < attempts; attemptNumber += 1) {
    let attempt: ActiveAttempt;
    try {
      attempt = await scheduler.schedule({
        start: () => startFetch(input),
        signal: input.signal,
        minimumDelayMs,
      });
    } catch (error) {
      if (attemptNumber + 1 < attempts && isRetryableTransport(error)) {
        minimumDelayMs = BOOKSTACK_LIFECYCLE_REQUEST_INTERVAL_MS;
        continue;
      }
      throw safeFailure(error);
    }

    const status = responseStatus(attempt.response);
    if (status === null) {
      discardAttempt(attempt);
      throw new Error("bookstack_response_invalid");
    }
    if (retryableStatus(status)) {
      const delay = retryAfter(retryAfterHeader(attempt.response));
      discardAttempt(attempt);
      if (attemptNumber + 1 < attempts && delay?.status !== "excessive") {
        minimumDelayMs = Math.max(
          BOOKSTACK_LIFECYCLE_REQUEST_INTERVAL_MS,
          delay?.milliseconds ?? 0,
        );
        continue;
      }
      throw status === 429 ? rateLimited() : new Error("bookstack_http_failed");
    }

    try {
      const value = await Promise.race([
        parseBookStackJsonResponse({
          response: attempt.response,
          maxResponseBytes: input.maxResponseBytes,
          failurePrefix: input.failurePrefix,
        }),
        attempt.timeout,
        attempt.cancelled,
      ]);
      attempt.close();
      return value;
    } catch (error) {
      const timedOut = attempt.timedOut();
      discardAttempt(attempt);
      if (timedOut) {
        if (attemptNumber + 1 < attempts) {
          minimumDelayMs = BOOKSTACK_LIFECYCLE_REQUEST_INTERVAL_MS;
          continue;
        }
        throw transportFailure();
      }
      if (aborted(input.signal)) throw transportFailure();
      throw safeFailure(error, "bookstack_response_invalid");
    }
  }

  throw new Error("bookstack_transport_failed");
};
