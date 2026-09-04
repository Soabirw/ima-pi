import { performance } from "node:perf_hooks";
import { PlaneApiError, fail, isRecord } from "./plane-contract.mjs";

export const REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_REQUEST_INTERVAL_MS = 1_100;
const MAX_PAGE_COUNT = 100;

export const collectCursorPages = async ({ fetchPage, normalizeItem, maxPages = MAX_PAGE_COUNT }) => {
  if (typeof fetchPage !== "function" || typeof normalizeItem !== "function") fail("PAGINATION_ERROR");
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) fail("PAGINATION_ERROR");

  const items = [];
  const seenCursors = new Set();
  let cursor = null;

  for (let pageCount = 0; pageCount < maxPages; pageCount += 1) {
    const page = await fetchPage(cursor);
    if (!isRecord(page) || !Array.isArray(page.results)) fail("RESPONSE_ERROR");

    items.push(...page.results.map(normalizeItem));

    if (page.next_page_results === false) return items;
    if (page.next_page_results !== true || typeof page.next_cursor !== "string" || page.next_cursor.trim() === "") {
      fail("PAGINATION_ERROR");
    }
    if (seenCursors.has(page.next_cursor)) fail("PAGINATION_ERROR");

    seenCursors.add(page.next_cursor);
    cursor = page.next_cursor;
  }

  fail("PAGINATION_ERROR");
};

export const waitForDuration = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const monotonicNow = () => performance.now();

const createRequestRateLimiter = ({ intervalMs, now, waitFor }) => {
  let lastRequestStartedAt = null;
  let queue = Promise.resolve();

  const currentTime = () => {
    const timestamp = now();
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp < 0) {
      fail("CONFIG_ERROR");
    }
    return timestamp;
  };

  const waitForRequestSlot = async () => {
    if (lastRequestStartedAt === null) return;

    while (true) {
      const elapsedMs = Math.max(0, currentTime() - lastRequestStartedAt);
      const remainingMs = intervalMs - elapsedMs;
      if (remainingMs <= 0) return;
      await waitFor(remainingMs);
    }
  };

  return (request) => {
    const scheduled = queue.then(async () => {
      await waitForRequestSlot();
      lastRequestStartedAt = currentTime();
      return request();
    });
    queue = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  };
};

export const createPlaneTransport = ({
  apiBaseUrl,
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  requestIntervalMs = DEFAULT_REQUEST_INTERVAL_MS,
  now = monotonicNow,
  waitFor = waitForDuration,
  createAbortController = () => new AbortController(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) => {
  if (typeof apiBaseUrl !== "string" || typeof apiKey !== "string") fail("CONFIG_ERROR");
  if (typeof fetchImpl !== "function" || typeof createAbortController !== "function") fail("CONFIG_ERROR");
  if (typeof now !== "function" || typeof waitFor !== "function") fail("CONFIG_ERROR");
  if (typeof setTimeoutImpl !== "function" || typeof clearTimeoutImpl !== "function") fail("CONFIG_ERROR");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) fail("CONFIG_ERROR");
  if (!Number.isSafeInteger(requestIntervalMs) || requestIntervalMs < 0) fail("CONFIG_ERROR");

  const rateLimitRequest = createRequestRateLimiter({
    intervalMs: requestIntervalMs,
    now,
    waitFor,
  });

  const requestJsonUnpaced = async ({ path, method = "GET", body }) => {
    const abortController = createAbortController();
    if (!abortController?.signal || typeof abortController.abort !== "function") fail("CONFIG_ERROR");

    const timeout = setTimeoutImpl(() => abortController.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(new URL(path, apiBaseUrl), {
          method,
          headers: {
            Accept: "application/json",
            "X-API-Key": apiKey,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal: abortController.signal,
        });
      } catch {
        fail("HTTP_ERROR");
      }

      if (!isRecord(response) || typeof response.ok !== "boolean") fail("RESPONSE_ERROR");
      if (!response.ok) throw new PlaneApiError("HTTP_ERROR", response.status);
      if (typeof response.json !== "function") fail("RESPONSE_ERROR");

      try {
        return await response.json();
      } catch {
        fail("RESPONSE_ERROR");
      }
    } finally {
      clearTimeoutImpl(timeout);
    }
  };

  return (request) => rateLimitRequest(() => requestJsonUnpaced(request));
};
