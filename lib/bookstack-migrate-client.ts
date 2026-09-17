export type BookStackItem = { id: number; name: string; [key: string]: unknown };
type ListResult<T> = { data?: T[]; total?: number };
const MAX_PAGE_SIZE = 500;

export const normalizeBookStackOrigin = (origin: string) => {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("bookstack_origin_invalid");
  }
  return url.origin;
};

const item = (value: unknown): BookStackItem | null => value && typeof value === "object"
  && Number.isInteger((value as { id?: unknown }).id)
  && typeof (value as { name?: unknown }).name === "string"
  ? value as BookStackItem : null;

const bookIds = (value: unknown): number[] | null => {
  if (!Array.isArray(value)) return null;
  const ids = value.map((book) => typeof book === "number" && Number.isSafeInteger(book)
    ? book
    : book && typeof book === "object" && Number.isSafeInteger((book as { id?: unknown }).id)
      ? (book as { id: number }).id
      : null);
  return ids.some((id) => id === null) ? null : ids as number[];
};

export type BookStackClientInput = {
  origin: string;
  tokenId: string;
  tokenSecret: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  requestIntervalMs?: number;
  now?: () => number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void> | void;
};

type BookStackWait = NonNullable<BookStackClientInput["wait"]>;
type ScheduledRequest = {
  issue: (markStarted: () => void) => Promise<Response>;
  resolve: (response: Response | PromiseLike<Response>) => void;
  reject: (error: Error) => void;
  queued: boolean;
  detachAbort: () => void;
};

const DEFAULT_REQUEST_INTERVAL_MS = 1_100;
const MAX_REQUEST_INTERVAL_MS = 120_000;
const MAX_EARLY_WAKES = 100;

const transportFailure = () => new Error("bookstack_transport_failed");

const defaultWait: BookStackWait = (milliseconds, signal) => new Promise<void>((resolve, reject) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let onAbort: () => void = () => undefined;
  const finish = (callback: () => void) => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    try {
      signal?.removeEventListener("abort", onAbort);
    } catch {
      // The caller will fail closed if an injected signal is unusable.
    }
    callback();
  };
  onAbort = () => finish(() => reject(transportFailure()));
  try {
    signal?.addEventListener("abort", onAbort, { once: true });
  } catch {
    finish(() => reject(transportFailure()));
    return;
  }
  if (signal?.aborted) {
    onAbort();
    return;
  }
  try {
    timer = setTimeout(() => finish(() => resolve()), milliseconds);
  } catch {
    finish(() => reject(transportFailure()));
  }
});

const validRequestInterval = (value: unknown) => {
  const intervalMs = value === undefined ? DEFAULT_REQUEST_INTERVAL_MS : value;
  if (typeof intervalMs !== "number" || !Number.isSafeInteger(intervalMs)
    || intervalMs <= 0 || intervalMs > MAX_REQUEST_INTERVAL_MS) {
    throw new Error("bookstack_pacing_invalid");
  }
  return intervalMs;
};

const validNow = (value: unknown): (() => number) => {
  const performanceNow = globalThis.performance?.now;
  const now = value === undefined
    ? typeof performanceNow === "function" ? performanceNow.bind(globalThis.performance) : null
    : value;
  if (typeof now !== "function") throw new Error("bookstack_pacing_invalid");
  return now as () => number;
};

const validWait = (value: unknown): BookStackWait => {
  const wait = value === undefined ? defaultWait : value;
  if (typeof wait !== "function") throw new Error("bookstack_pacing_invalid");
  return wait as BookStackWait;
};

const validAbortSignal = (value: unknown): AbortSignal | undefined => {
  if (value === undefined) return undefined;
  try {
    if (!value || typeof value !== "object") throw new Error();
    const signal = value as AbortSignal;
    if (typeof signal.aborted !== "boolean"
      || typeof signal.addEventListener !== "function"
      || typeof signal.removeEventListener !== "function") {
      throw new Error();
    }
    return signal;
  } catch {
    throw new Error("bookstack_pacing_invalid");
  }
};

const createRequestStartSchedule = (input: {
  intervalMs: number;
  now: () => number;
  wait: BookStackWait;
  signal?: AbortSignal;
}) => {
  const pending: ScheduledRequest[] = [];
  const signal = input.signal;
  let draining = false;
  let scheduleFailed = false;
  let lastStartedAt: number | null = null;
  let lastObservedAt: number | null = null;

  const checkCancellation = () => {
    if (signal?.aborted) throw transportFailure();
  };

  const observeNow = () => {
    let observed: unknown;
    try {
      observed = input.now();
    } catch {
      throw transportFailure();
    }
    if (typeof observed !== "number" || !Number.isFinite(observed) || observed < 0
      || (lastObservedAt !== null && observed < lastObservedAt)) {
      throw transportFailure();
    }
    lastObservedAt = observed;
    return observed;
  };

  const waitForDelay = async (delayMs: number) => {
    if (!Number.isFinite(delayMs) || delayMs <= 0) {
      if (delayMs === 0) return;
      throw transportFailure();
    }
    checkCancellation();
    const pendingWait = Promise.resolve().then(() => {
      checkCancellation();
      return input.wait(delayMs, signal);
    });
    if (!signal) {
      try {
        await pendingWait;
      } catch {
        throw transportFailure();
      }
      return;
    }

    let rejectAbort: ((reason?: unknown) => void) | undefined;
    const onAbort = () => rejectAbort?.(transportFailure());
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    try {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      await Promise.race([pendingWait, aborted]);
    } catch {
      throw transportFailure();
    } finally {
      try {
        signal.removeEventListener("abort", onAbort);
      } catch {
        // The caller will fail closed if an injected signal is unusable.
      }
    }
    checkCancellation();
  };

  const waitForDueStart = async () => {
    let earlyWakes = 0;
    if (scheduleFailed) throw transportFailure();
    if (lastStartedAt === null) return;
    for (;;) {
      checkCancellation();
      const observed = observeNow();
      const elapsed = observed - lastStartedAt;
      const delayMs = input.intervalMs - elapsed;
      if (!Number.isFinite(elapsed) || elapsed < 0 || !Number.isFinite(delayMs)) {
        throw transportFailure();
      }
      if (delayMs <= 0) return;
      if (earlyWakes >= MAX_EARLY_WAKES) throw transportFailure();
      earlyWakes += 1;
      await waitForDelay(delayMs);
      checkCancellation();
    }
  };

  const recordRequestStart = () => {
    checkCancellation();
    const startedAt = observeNow();
    if (lastStartedAt !== null) {
      const elapsed = startedAt - lastStartedAt;
      if (!Number.isFinite(elapsed) || elapsed < input.intervalMs) throw transportFailure();
    }
    lastStartedAt = startedAt;
  };

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (pending.length > 0) {
        const entry = pending.shift();
        if (!entry) continue;
        entry.queued = false;
        try {
          await waitForDueStart();
          checkCancellation();
        } catch {
          if (!signal?.aborted) scheduleFailed = true;
          entry.reject(transportFailure());
          entry.detachAbort();
          continue;
        }
        let requestStarted = false;
        try {
          const response = entry.issue(() => {
            recordRequestStart();
            requestStarted = true;
          });
          if (!requestStarted) throw transportFailure();
          entry.resolve(response);
        } catch {
          if (!requestStarted && !signal?.aborted) scheduleFailed = true;
          entry.reject(transportFailure());
        }
        entry.detachAbort();
      }
    } finally {
      draining = false;
      if (pending.length > 0) void drain();
    }
  };

  return (issue: (markStarted: () => void) => Promise<Response>) => {
    if (scheduleFailed || signal?.aborted) return Promise.reject(transportFailure());
    return new Promise<Response>((resolve, reject) => {
      const entry: ScheduledRequest = {
        issue,
        resolve,
        reject,
        queued: false,
        detachAbort: () => undefined,
      };
      const onAbort = () => {
        if (!entry.queued) return;
        const index = pending.indexOf(entry);
        if (index < 0) return;
        pending.splice(index, 1);
        entry.queued = false;
        entry.detachAbort();
        reject(transportFailure());
      };
      if (signal) {
        entry.detachAbort = () => {
          try {
            signal.removeEventListener("abort", onAbort);
          } catch {
            // The caller will fail closed if an injected signal is unusable.
          }
        };
        try {
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) {
            entry.detachAbort();
            reject(transportFailure());
            return;
          }
        } catch {
          entry.detachAbort();
          reject(transportFailure());
          return;
        }
      }
      entry.queued = true;
      pending.push(entry);
      void drain();
    });
  };
};

export type BookStackClient = ReturnType<typeof createBookStackClient>;

export function createBookStackClient(input: BookStackClientInput) {
  const origin = normalizeBookStackOrigin(input.origin);
  if (!input.tokenId || !input.tokenSecret || /[\r\n]/.test(input.tokenId + input.tokenSecret)) {
    throw new Error("bookstack_credentials_invalid");
  }
  const fetcher = input.fetch ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error("bookstack_timeout_invalid");
  }
  const signal = validAbortSignal(input.signal);
  const scheduleRequestStart = createRequestStartSchedule({
    intervalMs: validRequestInterval(input.requestIntervalMs),
    now: validNow(input.now),
    wait: validWait(input.wait),
    signal,
  });
  const request = async (path: string, options: RequestInit = {}, expectJson = true) => {
    let response: Response;
    try {
      response = await scheduleRequestStart((markStarted) => {
        if (signal?.aborted) throw transportFailure();
        const requestSignal = signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs);
        const url = new URL(`/api/${path.replace(/^\//, "")}`, `${origin}/`);
        const requestOptions: RequestInit = {
          ...options,
          redirect: "error" as const,
          signal: options.signal ?? requestSignal,
          headers: {
            accept: "application/json",
            authorization: `Token ${input.tokenId}:${input.tokenSecret}`,
            ...(options.body ? { "content-type": "application/json" } : {}),
            ...(options.headers ?? {}),
          },
        };
        if (signal?.aborted) throw transportFailure();
        markStarted();
        if (signal?.aborted) throw transportFailure();
        return fetcher(url, requestOptions);
      });
    } catch {
      throw new Error("bookstack_transport_failed");
    }
    if (!response.ok) throw new Error(`bookstack_http_${response.status}`);
    if (!expectJson) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) throw new Error("bookstack_response_invalid");
    try {
      return await response.json();
    } catch {
      throw new Error("bookstack_response_invalid");
    }
  };
  const list = async (resource: string) => {
    const collected: BookStackItem[] = [];
    for (let offset = 0; ; offset += MAX_PAGE_SIZE) {
      const query = new URLSearchParams({ count: String(MAX_PAGE_SIZE), offset: String(offset) });
      const response = await request(`${resource}?${query}`) as ListResult<unknown>;
      if (!Array.isArray(response.data)) throw new Error("bookstack_response_invalid");
      const entries = response.data.map(item);
      if (entries.some((entry) => entry === null)) throw new Error("bookstack_response_invalid");
      collected.push(...entries as BookStackItem[]);
      if (response.data.length < MAX_PAGE_SIZE) return collected;
      if (collected.length > 10_000) throw new Error("bookstack_page_limit");
    }
  };
  const create = async (resource: string, body: Record<string, unknown>) => {
    const result = item(await request(resource, { method: "POST", body: JSON.stringify(body) }));
    if (!result) throw new Error("bookstack_response_invalid");
    return result;
  };
  const read = async (resource: string, id: number) => {
    const result = item(await request(`${resource}/${id}`));
    if (!result || result.id !== id) throw new Error("bookstack_response_invalid");
    return result;
  };
  const resolveShelf = async (name: string) => {
    const matches = (await list("shelves")).filter((shelf) => shelf.name === name);
    if (matches.length === 0) throw new Error("bookstack_shelf_absent");
    if (matches.length > 1) throw new Error("bookstack_identity_ambiguous");
    return matches[0];
  };
  return {
    listShelves: () => list("shelves"),
    resolveShelf,
    listBooks: () => list("books"),
    listChapters: () => list("chapters"),
    listPages: () => list("pages"),
    readShelf: (id: number) => read("shelves", id),
    createBook: (name: string) => create("books", { name }),
    replaceShelfBooks: async (shelfId: number, name: string, books: number[]) => {
      const expectedBooks = [...new Set(books)];
      const updated = item(await request(`shelves/${shelfId}`, {
        method: "PUT",
        body: JSON.stringify({ name, books: expectedBooks }),
      }));
      if (!updated || updated.id !== shelfId || updated.name !== name) {
        throw new Error("bookstack_response_invalid");
      }
      const readBack = await read("shelves", shelfId);
      const observedBooks = bookIds(readBack.books);
      if (!observedBooks || observedBooks.length !== expectedBooks.length
        || expectedBooks.some((id) => !observedBooks.includes(id))) {
        throw new Error("bookstack_shelf_membership_invalid");
      }
    },
    createChapter: (name: string, bookId: number, description: string) =>
      create("chapters", { name, book_id: bookId, description }),
    createPage: (name: string, chapterId: number, markdown: string) =>
      create("pages", { name, chapter_id: chapterId, markdown }),
    readPage: (id: number) => read("pages", id),
    deletePage: async (id: number) => {
      await request(`pages/${id}`, { method: "DELETE" }, false);
    },
  };
}
