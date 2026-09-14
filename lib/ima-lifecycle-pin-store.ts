import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  projectLifecycleProviderPin,
  projectLifecycleProviderPinAttempt,
  sameLifecycleProviderPin,
  type LifecycleProviderPin,
  type LifecycleProviderPinAttempt,
} from "./ima-lifecycle-pin.ts";
import { normalizeLifecycleRecordKey } from "./ima-lifecycle.ts";

export const LIFECYCLE_PIN_STORE_DIRECTORY = ".ima-cycle";
export const LIFECYCLE_PIN_STORE_FILENAME = "provider-pins.json";
export const LIFECYCLE_PIN_STORE_LOCK_FILENAME = ".provider-pins.lock";
export const LIFECYCLE_PIN_STORE_GITIGNORE_FILENAME = ".gitignore";
export const LIFECYCLE_PIN_STORE_GITIGNORE_BODY = "*\n";
export const LIFECYCLE_PIN_STORE_SCHEMA_VERSION = 1;

const MAX_PIN_REGISTRY_BYTES = 256 * 1024;
const MAX_PIN_REGISTRY_ENTRIES = 256;

type PinRegistryEntry =
  | { status: "pending"; attempt: LifecycleProviderPinAttempt }
  | { status: "pinned"; pin: LifecycleProviderPin };

type PinRegistry = {
  schemaVersion: 1;
  entries: PinRegistryEntry[];
};

type PinStorePaths = {
  directory: string;
  registry: string;
  lock: string;
  gitignore: string;
};

export type ResolveLifecyclePinProjectRoot = (cwd: string) => Promise<string>;

export type LifecyclePinLoadResult =
  | { status: "absent" }
  | { status: "pinned"; pin: LifecycleProviderPin }
  | { status: "pending"; attempt: LifecycleProviderPinAttempt }
  | { status: "corrupt" }
  | { status: "conflicting" }
  | { status: "inaccessible" };

export type LifecyclePinBeginResult =
  | { status: "started"; attempt: LifecycleProviderPinAttempt }
  | { status: "pinned"; pin: LifecycleProviderPin }
  | { status: "pending"; attempt: LifecycleProviderPinAttempt }
  | { status: "blocked"; code: string };

export type LifecyclePinWritingResult =
  | { status: "writing"; attempt: LifecycleProviderPinAttempt }
  | { status: "blocked"; code: string };

export type LifecyclePinConfirmResult =
  | { status: "pinned"; pin: LifecycleProviderPin }
  | { status: "blocked"; code: string };

export type LifecyclePinAbandonResult =
  | { status: "cleared" }
  | { status: "blocked"; code: string };

const object = (value: unknown): Record<string, unknown> | null => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => typeof key !== "string") || keys.some((key) => {
      const descriptor = descriptors[key as string];
      return !descriptor
        || descriptor.get
        || descriptor.set
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, "value");
    })) return null;
    return Object.fromEntries(keys.map((key) => [key, descriptors[key as string].value]));
  } catch {
    return null;
  }
};

const dataArray = (value: unknown, maximum: number): unknown[] | null => {
  try {
    if (!Array.isArray(value) || value.length > maximum) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length !== value.length + 1
      || keys.some((key) => typeof key !== "string")
      || keys.some((key) => key !== "length" && !/^\d+$/.test(key as string))
      || !descriptors.length
      || descriptors.length.get
      || descriptors.length.set
      || !Object.hasOwn(descriptors.length, "value")
    ) return null;
    const entries: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        return null;
      }
      entries.push(descriptor.value);
    }
    return entries;
  } catch {
    return null;
  }
};

const isInside = (root: string, path: string) => {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (
    fromRoot !== ".."
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot)
  );
};

const errorCode = (error: unknown) =>
  error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : "";

const isMissing = (error: unknown) => errorCode(error) === "ENOENT";

const lifecycleKey = (value: unknown): string | null => {
  const key = normalizeLifecycleRecordKey(value);
  return key && key === value ? key : null;
};

const pinStorePaths = (root: string): PinStorePaths => {
  const directory = join(root, LIFECYCLE_PIN_STORE_DIRECTORY);
  return {
    directory,
    registry: join(directory, LIFECYCLE_PIN_STORE_FILENAME),
    lock: join(directory, LIFECYCLE_PIN_STORE_LOCK_FILENAME),
    gitignore: join(directory, LIFECYCLE_PIN_STORE_GITIGNORE_FILENAME),
  };
};

const clone = <Value>(value: Value): Value | null => {
  try {
    return structuredClone(value);
  } catch {
    return null;
  }
};

const registryEntry = (value: unknown): PinRegistryEntry | null => {
  const entry = object(value);
  if (!entry || typeof entry.status !== "string") return null;
  const keys = Object.keys(entry);
  if (entry.status === "pending" && keys.length === 2 && keys.includes("attempt")) {
    const attempt = projectLifecycleProviderPinAttempt(entry.attempt);
    return attempt ? { status: "pending", attempt } : null;
  }
  if (entry.status === "pinned" && keys.length === 2 && keys.includes("pin")) {
    const pin = projectLifecycleProviderPin(entry.pin);
    return pin ? { status: "pinned", pin } : null;
  }
  return null;
};

export const parseLifecyclePinRegistry = (value: unknown): PinRegistry | null => {
  const registry = object(value);
  if (!registry || registry.schemaVersion !== LIFECYCLE_PIN_STORE_SCHEMA_VERSION) return null;
  const values = dataArray(registry.entries, MAX_PIN_REGISTRY_ENTRIES);
  if (Object.keys(registry).length !== 2 || !values) return null;
  const entries = values.map(registryEntry);
  if (entries.some((entry) => entry === null)) return null;
  const projected = entries as PinRegistryEntry[];
  const keys = projected.map((entry) => entry.status === "pinned"
    ? entry.pin.lifecycleKey
    : entry.attempt.lifecycleKey);
  if (new Set(keys).size !== keys.length) return null;
  const detached = clone(projected);
  return detached ? { schemaVersion: 1, entries: detached } : null;
};

export const serializeLifecyclePinRegistry = (value: PinRegistry): string | null => {
  const registry = parseLifecyclePinRegistry(value);
  if (!registry) return null;
  const serialized = `${JSON.stringify(registry)}\n`;
  return Buffer.byteLength(serialized, "utf8") <= MAX_PIN_REGISTRY_BYTES
    ? serialized
    : null;
};

const resolvePinStoreRoot = async (
  cwd: string,
  resolveProjectRoot: ResolveLifecyclePinProjectRoot,
): Promise<string | null> => {
  try {
    const resolved = await resolveProjectRoot(cwd);
    if (typeof resolved !== "string" || !isAbsolute(resolved)) return null;
    const before = await lstat(resolved);
    if (!before.isDirectory() || before.isSymbolicLink()) return null;
    const root = await realpath(resolved);
    const after = await lstat(root);
    return after.isDirectory() && !after.isSymbolicLink() && root === resolve(resolved)
      ? root
      : null;
  } catch {
    return null;
  }
};

const verifyDirectory = async (
  root: string,
  path: string,
  create: boolean,
): Promise<boolean> => {
  try {
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    const before = await lstat(path);
    if (!before.isDirectory() || before.isSymbolicLink()) return false;
    const canonical = await realpath(path);
    if (!isInside(root, canonical)) return false;
    const after = await lstat(canonical);
    return after.isDirectory() && !after.isSymbolicLink();
  } catch {
    return false;
  }
};

const safeRegularFile = async (
  root: string,
  path: string,
): Promise<string | null> => {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) return null;
    const canonical = await realpath(path);
    if (!isInside(root, canonical)) return null;
    const after = await lstat(canonical);
    return after.isFile() && !after.isSymbolicLink() && after.nlink === 1 ? canonical : null;
  } catch {
    return null;
  }
};

const ensureGitignore = async (
  root: string,
  path: string,
): Promise<boolean> => {
  try {
    await writeFile(path, LIFECYCLE_PIN_STORE_GITIGNORE_BODY, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") return false;
  }
  const file = await safeRegularFile(root, path);
  if (!file) return false;
  try {
    return await readFile(file, "utf8") === LIFECYCLE_PIN_STORE_GITIGNORE_BODY;
  } catch {
    return false;
  }
};

const registryConflict = (value: unknown): boolean => {
  const registry = object(value);
  const values = registry ? dataArray(registry.entries, MAX_PIN_REGISTRY_ENTRIES) : null;
  if (!registry || registry.schemaVersion !== LIFECYCLE_PIN_STORE_SCHEMA_VERSION || !values) return false;
  const entries = values.map(registryEntry);
  if (entries.some((entry) => entry === null)) return false;
  const keys = (entries as PinRegistryEntry[]).map((entry) => entry.status === "pinned"
    ? entry.pin.lifecycleKey
    : entry.attempt.lifecycleKey);
  return new Set(keys).size !== keys.length;
};

const readRegistry = async (
  root: string,
  paths: PinStorePaths,
): Promise<{ status: "absent"; registry: PinRegistry } | { status: "ready"; registry: PinRegistry } | { status: "corrupt" | "conflicting" | "inaccessible" }> => {
  let details;
  try {
    details = await lstat(paths.registry);
  } catch (error) {
    return isMissing(error)
      ? { status: "absent", registry: { schemaVersion: 1, entries: [] } }
      : { status: "inaccessible" };
  }
  if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_PIN_REGISTRY_BYTES) {
    return { status: "corrupt" };
  }
  const file = await safeRegularFile(root, paths.registry);
  if (!file) return { status: "corrupt" };
  try {
    const source = await readFile(file, "utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_PIN_REGISTRY_BYTES) {
      return { status: "corrupt" };
    }
    const value = JSON.parse(source);
    const registry = parseLifecyclePinRegistry(value);
    return registry
      ? { status: "ready", registry }
      : registryConflict(value) ? { status: "conflicting" } : { status: "corrupt" };
  } catch {
    return { status: "corrupt" };
  }
};

const entryFor = (registry: PinRegistry, key: string): PinRegistryEntry | null =>
  registry.entries.find((entry) => (entry.status === "pinned"
    ? entry.pin.lifecycleKey
    : entry.attempt.lifecycleKey) === key) ?? null;

const acquireRegistryLock = async (
  root: string,
  paths: PinStorePaths,
): Promise<{ path: string; token: string } | null> => {
  const token = randomUUID();
  try {
    await writeFile(paths.lock, token, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") return null;
    return null;
  }
  const lock = await safeRegularFile(root, paths.lock);
  if (!lock) {
    await unlink(paths.lock).catch(() => undefined);
    return null;
  }
  try {
    return await readFile(lock, "utf8") === token ? { path: lock, token } : null;
  } catch {
    return null;
  }
};

const releaseRegistryLock = async (
  lock: { path: string; token: string },
): Promise<boolean> => {
  try {
    if (await readFile(lock.path, "utf8") !== lock.token) return false;
    await unlink(lock.path);
    return true;
  } catch {
    return false;
  }
};

const writeRegistry = async (
  root: string,
  paths: PinStorePaths,
  registry: PinRegistry,
): Promise<boolean> => {
  const serialized = serializeLifecyclePinRegistry(registry);
  if (!serialized) return false;
  const temporary = join(paths.directory, `.${LIFECYCLE_PIN_STORE_FILENAME}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!await safeRegularFile(root, temporary)) return false;
    const existing = await readRegistry(root, paths);
    if (existing.status === "corrupt" || existing.status === "conflicting" || existing.status === "inaccessible") return false;
    await rename(temporary, paths.registry);
    return Boolean(await safeRegularFile(root, paths.registry));
  } catch {
    return false;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
};

const prepareStore = async (
  cwd: string,
  resolveProjectRoot: ResolveLifecyclePinProjectRoot,
  create: boolean,
): Promise<{ root: string; paths: PinStorePaths } | null> => {
  const root = await resolvePinStoreRoot(cwd, resolveProjectRoot);
  if (!root) return null;
  const paths = pinStorePaths(root);
  if (!await verifyDirectory(root, paths.directory, create)) return null;
  if (create && !await ensureGitignore(root, paths.gitignore)) return null;
  return { root, paths };
};

export const loadLifecyclePinStateWith = (
  resolveProjectRoot: ResolveLifecyclePinProjectRoot,
) => async (
  cwd: string,
  lifecycleKeyValue: unknown,
): Promise<LifecyclePinLoadResult> => {
  const key = lifecycleKey(lifecycleKeyValue);
  if (!key) return { status: "corrupt" };
  const root = await resolvePinStoreRoot(cwd, resolveProjectRoot);
  if (!root) return { status: "inaccessible" };
  const paths = pinStorePaths(root);
  try {
    await lstat(paths.directory);
  } catch (error) {
    return isMissing(error) ? { status: "absent" } : { status: "inaccessible" };
  }
  if (!await verifyDirectory(root, paths.directory, false)) return { status: "inaccessible" };
  const read = await readRegistry(root, paths);
  if (read.status === "corrupt" || read.status === "conflicting" || read.status === "inaccessible") return read;
  const entry = entryFor(read.registry, key);
  if (!entry) return { status: "absent" };
  return entry.status === "pinned"
    ? { status: "pinned", pin: entry.pin }
    : { status: "pending", attempt: entry.attempt };
};

export const beginLifecyclePinWith = (
  resolveProjectRoot: ResolveLifecyclePinProjectRoot,
) => async (
  cwd: string,
  attemptValue: unknown,
): Promise<LifecyclePinBeginResult> => {
  const attempt = projectLifecycleProviderPinAttempt(attemptValue);
  if (!attempt || attempt.status !== "authorized") return { status: "blocked", code: "lifecycle_pin_attempt_invalid" };
  const store = await prepareStore(cwd, resolveProjectRoot, true);
  if (!store) return { status: "blocked", code: "lifecycle_pin_store_inaccessible" };
  const lock = await acquireRegistryLock(store.root, store.paths);
  if (!lock) return { status: "blocked", code: "lifecycle_pin_store_busy" };
  try {
    const read = await readRegistry(store.root, store.paths);
    if (read.status === "corrupt" || read.status === "conflicting" || read.status === "inaccessible") {
      return { status: "blocked", code: `lifecycle_pin_store_${read.status}` };
    }
    const existing = entryFor(read.registry, attempt.lifecycleKey);
    if (existing?.status === "pinned") return { status: "pinned", pin: existing.pin };
    if (existing?.status === "pending") return { status: "pending", attempt: existing.attempt };
    const next: PinRegistry = {
      schemaVersion: 1,
      entries: [...read.registry.entries, { status: "pending", attempt }],
    };
    return await writeRegistry(store.root, store.paths, next)
      ? { status: "started", attempt }
      : { status: "blocked", code: "lifecycle_pin_store_write_failed" };
  } finally {
    await releaseRegistryLock(lock);
  }
};

export const markLifecyclePinAttemptWritingWith = (
  resolveProjectRoot: ResolveLifecyclePinProjectRoot,
) => async (
  cwd: string,
  attemptValue: unknown,
): Promise<LifecyclePinWritingResult> => {
  const attempt = projectLifecycleProviderPinAttempt(attemptValue);
  if (!attempt || attempt.status !== "authorized") {
    return { status: "blocked", code: "lifecycle_pin_attempt_invalid" };
  }
  const store = await prepareStore(cwd, resolveProjectRoot, true);
  if (!store) return { status: "blocked", code: "lifecycle_pin_store_inaccessible" };
  const lock = await acquireRegistryLock(store.root, store.paths);
  if (!lock) return { status: "blocked", code: "lifecycle_pin_store_busy" };
  try {
    const read = await readRegistry(store.root, store.paths);
    if (read.status === "corrupt" || read.status === "conflicting" || read.status === "inaccessible") {
      return { status: "blocked", code: `lifecycle_pin_store_${read.status}` };
    }
    const existing = entryFor(read.registry, attempt.lifecycleKey);
    if (
      !existing
      || existing.status !== "pending"
      || existing.attempt.attemptId !== attempt.attemptId
      || existing.attempt.provider !== attempt.provider
      || existing.attempt.status !== "authorized"
    ) return { status: "blocked", code: "lifecycle_pin_attempt_conflict" };
    const writing: LifecycleProviderPinAttempt = { ...existing.attempt, status: "writing" };
    const next: PinRegistry = {
      schemaVersion: 1,
      entries: read.registry.entries.map((entry) => entry === existing
        ? { status: "pending" as const, attempt: writing }
        : entry),
    };
    return await writeRegistry(store.root, store.paths, next)
      ? { status: "writing", attempt: writing }
      : { status: "blocked", code: "lifecycle_pin_store_write_failed" };
  } finally {
    await releaseRegistryLock(lock);
  }
};

export const confirmLifecyclePinWith = (
  resolveProjectRoot: ResolveLifecyclePinProjectRoot,
) => async (
  cwd: string,
  attemptValue: unknown,
  pinValue: unknown,
): Promise<LifecyclePinConfirmResult> => {
  const attempt = projectLifecycleProviderPinAttempt(attemptValue);
  const pin = projectLifecycleProviderPin(pinValue);
  if (
    !attempt
    || attempt.status !== "writing"
    || !pin
    || attempt.lifecycleKey !== pin.lifecycleKey
    || attempt.provider !== pin.provider
  ) return { status: "blocked", code: "lifecycle_pin_confirmation_invalid" };
  const store = await prepareStore(cwd, resolveProjectRoot, true);
  if (!store) return { status: "blocked", code: "lifecycle_pin_store_inaccessible" };
  const lock = await acquireRegistryLock(store.root, store.paths);
  if (!lock) return { status: "blocked", code: "lifecycle_pin_store_busy" };
  try {
    const read = await readRegistry(store.root, store.paths);
    if (read.status === "corrupt" || read.status === "conflicting" || read.status === "inaccessible") {
      return { status: "blocked", code: `lifecycle_pin_store_${read.status}` };
    }
    const existing = entryFor(read.registry, pin.lifecycleKey);
    if (existing?.status === "pinned") {
      return sameLifecycleProviderPin(existing.pin, pin)
        ? { status: "pinned", pin: existing.pin }
        : { status: "blocked", code: "lifecycle_pin_conflict" };
    }
    if (
      !existing
      || existing.attempt.attemptId !== attempt.attemptId
      || existing.attempt.provider !== attempt.provider
      || existing.attempt.status !== "writing"
    ) return { status: "blocked", code: "lifecycle_pin_attempt_conflict" };
    const next: PinRegistry = {
      schemaVersion: 1,
      entries: read.registry.entries.map((entry) => entry === existing
        ? { status: "pinned" as const, pin }
        : entry),
    };
    return await writeRegistry(store.root, store.paths, next)
      ? { status: "pinned", pin }
      : { status: "blocked", code: "lifecycle_pin_store_write_failed" };
  } finally {
    await releaseRegistryLock(lock);
  }
};

export const abandonLifecyclePinAttemptWith = (
  resolveProjectRoot: ResolveLifecyclePinProjectRoot,
) => async (
  cwd: string,
  attemptValue: unknown,
): Promise<LifecyclePinAbandonResult> => {
  const attempt = projectLifecycleProviderPinAttempt(attemptValue);
  if (!attempt) return { status: "blocked", code: "lifecycle_pin_attempt_invalid" };
  const store = await prepareStore(cwd, resolveProjectRoot, true);
  if (!store) return { status: "blocked", code: "lifecycle_pin_store_inaccessible" };
  const lock = await acquireRegistryLock(store.root, store.paths);
  if (!lock) return { status: "blocked", code: "lifecycle_pin_store_busy" };
  try {
    const read = await readRegistry(store.root, store.paths);
    if (read.status === "corrupt" || read.status === "conflicting" || read.status === "inaccessible") {
      return { status: "blocked", code: `lifecycle_pin_store_${read.status}` };
    }
    const existing = entryFor(read.registry, attempt.lifecycleKey);
    if (!existing) return { status: "cleared" };
    if (
      existing.status !== "pending"
      || existing.attempt.attemptId !== attempt.attemptId
      || existing.attempt.provider !== attempt.provider
    ) return { status: "blocked", code: "lifecycle_pin_attempt_conflict" };
    const next: PinRegistry = {
      schemaVersion: 1,
      entries: read.registry.entries.filter((entry) => entry !== existing),
    };
    return await writeRegistry(store.root, store.paths, next)
      ? { status: "cleared" }
      : { status: "blocked", code: "lifecycle_pin_store_write_failed" };
  } finally {
    await releaseRegistryLock(lock);
  }
};

export const lifecyclePinStorePaths = pinStorePaths;
