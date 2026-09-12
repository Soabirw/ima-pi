import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { acquireRegistryFileLock } from "./ima-agent-session-lock.ts";
import type { SessionRecord } from "./ima-delegation.ts";

export const CYCLE_AGENT_SESSION_SCHEMA_VERSION = 1;
export const CYCLE_PHASE_CONTEXT_ENTRY = "ima-cycle-phase-context";
const CYCLE_DIRECTORY = ".ima-cycle";
const CYCLE_AGENT_SESSIONS_FILE = "agent-sessions.json";
const DIRECT_AGENT_SESSIONS_FILE = "direct-agent-sessions.json";
const LOCAL_STATE_GITIGNORE = "*\n";
const writeQueues = new Map<string, Promise<void>>();

export type CycleSessionOwner = {
  schemaVersion: 1;
  project: string;
  lifecycleKey: string;
  source: string;
  phase: string;
  dispatchId: string;
};
export type CycleOwnedSessionRecord = {
  schemaVersion: 1;
  owner: CycleSessionOwner;
  record: SessionRecord;
};

type AgentSessionFile = {
  schemaVersion: 1;
  records: CycleOwnedSessionRecord[];
};

type DirectAgentSessionFile = {
  schemaVersion: 1;
  records: SessionRecord[];
};

type SessionFilePaths = {
  root: string;
  directory: string;
  file: string;
};

const PHASE = /^(plan|implementation|test|review|resolution|rereview|document)$/;
const DISPATCH = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/;
const SESSION_STATUS = new Set(["running", "succeeded", "failed", "cancelled"]);
const text = (value: unknown, maximum = 2_048): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum && SAFE_TEXT.test(value);
const inside = (root: string, target: string) => {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
};
const relativeScope = (value: unknown) =>
  typeof value === "string"
  && value.length > 0
  && value.length <= 1_024
  && !value.startsWith("/")
  && !value.includes("\\")
  && value.split("/").every((part) => part && part !== "." && part !== "..");

export const isCycleSessionReference = (reference: unknown) =>
  typeof reference === "string" && reference.startsWith("cycle:");

export function validateCycleSessionOwner(value: unknown): value is CycleSessionOwner {
  const owner = value as CycleSessionOwner | null;
  return Boolean(
    owner
      && owner.schemaVersion === CYCLE_AGENT_SESSION_SCHEMA_VERSION
      && text(owner.project, 256)
      && text(owner.lifecycleKey, 512)
      && owner.lifecycleKey.startsWith("ima-pi:")
      && text(owner.source, 1_024)
      && text(owner.phase, 32)
      && PHASE.test(owner.phase)
      && text(owner.dispatchId, 128)
      && DISPATCH.test(owner.dispatchId),
  );
}

export function cycleSessionOwnerFromEntries(entries: readonly unknown[]): CycleSessionOwner | null {
  for (const entry of [...entries].reverse()) {
    const value = entry as { type?: unknown; customType?: unknown; data?: unknown } | null;
    if (value?.type !== "custom" || value.customType !== CYCLE_PHASE_CONTEXT_ENTRY) continue;
    if (validateCycleSessionOwner(value.data)) return structuredClone(value.data);
  }
  return null;
}

const validSessionRecord = (value: unknown): value is SessionRecord => {
  const record = value as SessionRecord | null;
  return Boolean(
    record
      && text(record.reference, 256)
      && text(record.agent, 128)
      && text(record.role, 128)
      && text(record.resultKind, 128)
      && text(record.provider, 256)
      && text(record.model, 256)
      && (record.thinking === undefined || text(record.thinking, 64))
      && text(record.sessionId, 256)
      && text(record.sessionFile, 2_048)
      && record.sessionFile.startsWith("/")
      && Array.isArray(record.writeScope)
      && record.writeScope.every(relativeScope)
      && text(record.contractFingerprint, 256)
      && SESSION_STATUS.has(record.status)
      && typeof record.fresh === "boolean"
      && typeof record.followUpAllowed === "boolean"
      && text(record.createdAt, 64)
      && text(record.updatedAt, 64),
  );
};

export function validateCycleOwnedSessionRecord(value: unknown): value is CycleOwnedSessionRecord {
  const entry = value as CycleOwnedSessionRecord | null;
  return Boolean(
    entry
      && entry.schemaVersion === CYCLE_AGENT_SESSION_SCHEMA_VERSION
      && validateCycleSessionOwner(entry.owner)
      && validSessionRecord(entry.record),
  );
}

const safeFilePaths = async (cwd: string, create: boolean): Promise<SessionFilePaths> => {
  const root = await realpath(cwd);
  const directory = join(root, CYCLE_DIRECTORY);
  if (create) await mkdir(directory, { recursive: true });
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("cycle_agent_session_directory_invalid");
  const canonicalDirectory = await realpath(directory);
  if (!inside(root, canonicalDirectory)) throw new Error("cycle_agent_session_path_invalid");
  return { root, directory: canonicalDirectory, file: join(canonicalDirectory, CYCLE_AGENT_SESSIONS_FILE) };
};

const errorCode = (error: unknown) => (error as { code?: unknown } | null)?.code;

const ensureLocalStateGitignore = async (directory: string) => {
  const path = join(directory, ".gitignore");
  try {
    await writeFile(path, LOCAL_STATE_GITIGNORE, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error("direct_agent_session_gitignore_invalid");
  const canonicalPath = await realpath(path);
  if (!inside(directory, canonicalPath) || await readFile(canonicalPath, "utf8") !== LOCAL_STATE_GITIGNORE) {
    throw new Error("direct_agent_session_gitignore_invalid");
  }
};

const directFilePaths = async (cwd: string, create: boolean): Promise<SessionFilePaths> => {
  const paths = await safeFilePaths(cwd, create);
  return { ...paths, file: join(paths.directory, DIRECT_AGENT_SESSIONS_FILE) };
};

const loadCycleFileAtPaths = async (paths: SessionFilePaths): Promise<AgentSessionFile> => {
  try {
    const details = await lstat(paths.file);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("cycle_agent_session_file_invalid");
    const canonicalFile = await realpath(paths.file);
    if (!inside(paths.directory, canonicalFile)) throw new Error("cycle_agent_session_path_invalid");
    const parsed = JSON.parse(await readFile(canonicalFile, "utf8")) as AgentSessionFile;
    if (parsed?.schemaVersion !== CYCLE_AGENT_SESSION_SCHEMA_VERSION
      || !Array.isArray(parsed.records)
      || !parsed.records.every(validateCycleOwnedSessionRecord)) {
      throw new Error("cycle_agent_session_file_invalid");
    }
    const seen = new Set<string>();
    if (parsed.records.some(({ record }) => seen.has(record.reference) || !seen.add(record.reference))) {
      throw new Error("cycle_agent_session_file_invalid");
    }
    return {
      schemaVersion: CYCLE_AGENT_SESSION_SCHEMA_VERSION,
      records: parsed.records.map((entry) => structuredClone(entry)),
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { schemaVersion: CYCLE_AGENT_SESSION_SCHEMA_VERSION, records: [] };
    throw error;
  }
};

const loadDirectFileAtPaths = async (paths: SessionFilePaths): Promise<DirectAgentSessionFile> => {
  try {
    const details = await lstat(paths.file);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("direct_agent_session_file_invalid");
    const canonicalFile = await realpath(paths.file);
    if (!inside(paths.directory, canonicalFile)) throw new Error("direct_agent_session_path_invalid");
    const parsed = JSON.parse(await readFile(canonicalFile, "utf8")) as DirectAgentSessionFile;
    if (parsed?.schemaVersion !== CYCLE_AGENT_SESSION_SCHEMA_VERSION
      || !Array.isArray(parsed.records)
      || !parsed.records.every((record) => validSessionRecord(record) && !isCycleSessionReference(record.reference))) {
      throw new Error("direct_agent_session_file_invalid");
    }
    const seen = new Set<string>();
    if (parsed.records.some((record) => seen.has(record.reference) || !seen.add(record.reference))) {
      throw new Error("direct_agent_session_file_invalid");
    }
    return {
      schemaVersion: CYCLE_AGENT_SESSION_SCHEMA_VERSION,
      records: parsed.records.map((record) => structuredClone(record)),
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { schemaVersion: CYCLE_AGENT_SESSION_SCHEMA_VERSION, records: [] };
    throw error;
  }
};

const loadCycleFile = async (cwd: string): Promise<AgentSessionFile> => {
  try {
    return await loadCycleFileAtPaths(await safeFilePaths(cwd, false));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { schemaVersion: CYCLE_AGENT_SESSION_SCHEMA_VERSION, records: [] };
    throw error;
  }
};

const loadDirectFile = async (cwd: string): Promise<DirectAgentSessionFile> => {
  try {
    return await loadDirectFileAtPaths(await directFilePaths(cwd, false));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { schemaVersion: CYCLE_AGENT_SESSION_SCHEMA_VERSION, records: [] };
    throw error;
  }
};

const sameOwner = (left: CycleSessionOwner, right: CycleSessionOwner) =>
  left.project === right.project
  && left.lifecycleKey === right.lifecycleKey
  && left.source === right.source
  && left.phase === right.phase
  && left.dispatchId === right.dispatchId;

export const sameCycleSessionLifecycle = (left: CycleSessionOwner, right: CycleSessionOwner) =>
  left.project === right.project
  && left.lifecycleKey === right.lifecycleKey
  && left.source === right.source;

export async function findCycleOwnedSession(input: {
  cwd: string;
  reference: string;
}): Promise<CycleOwnedSessionRecord | null> {
  if (!text(input.reference, 256)) return null;
  const file = await loadCycleFile(input.cwd);
  const entry = file.records.find((item) => item.record.reference === input.reference);
  return entry ? structuredClone(entry) : null;
}

export async function loadCycleOwnedSession(input: {
  cwd: string;
  owner: CycleSessionOwner;
  reference: string;
}): Promise<CycleOwnedSessionRecord | null> {
  if (!validateCycleSessionOwner(input.owner) || !text(input.reference, 256)) return null;
  const entry = await findCycleOwnedSession({ cwd: input.cwd, reference: input.reference });
  return entry && sameCycleSessionLifecycle(entry.owner, input.owner) ? entry : null;
}

export async function loadCycleOwnedSessionRecord(input: {
  cwd: string;
  owner: CycleSessionOwner;
  reference: string;
}): Promise<SessionRecord | null> {
  const entry = await loadCycleOwnedSession(input);
  return entry ? entry.record : null;
}

const writeCycleFile = async (paths: SessionFilePaths, next: AgentSessionFile) => {
  const temporary = join(paths.directory, `.${CYCLE_AGENT_SESSIONS_FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    const temporaryDetails = await lstat(temporary);
    if (!temporaryDetails.isFile() || temporaryDetails.isSymbolicLink()) throw new Error("cycle_agent_session_file_invalid");
    const canonicalTemporary = await realpath(temporary);
    if (!inside(paths.directory, canonicalTemporary)) throw new Error("cycle_agent_session_path_invalid");
    await rename(temporary, paths.file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

const storeCycleOwnedSessionRecordUnsafe = async (input: {
  cwd: string;
  owner: CycleSessionOwner;
  record: SessionRecord;
}): Promise<void> => {
  if (!validateCycleSessionOwner(input.owner) || !validSessionRecord(input.record)) {
    throw new Error("cycle_agent_session_invalid");
  }
  const paths = await safeFilePaths(input.cwd, true);
  const lease = await acquireRegistryFileLock(paths.file);
  if (!lease) throw new Error("cycle_agent_session_busy");
  try {
    const current = await loadCycleFileAtPaths(paths);
    const existing = current.records.find((entry) => entry.record.reference === input.record.reference);
    if (existing && !sameOwner(existing.owner, input.owner)) throw new Error("cycle_agent_session_conflict");
    const updated: CycleOwnedSessionRecord = {
      schemaVersion: CYCLE_AGENT_SESSION_SCHEMA_VERSION,
      owner: structuredClone(input.owner),
      record: structuredClone(input.record),
    };
    const next: AgentSessionFile = {
      schemaVersion: CYCLE_AGENT_SESSION_SCHEMA_VERSION,
      records: existing
        ? current.records.map((entry) => entry.record.reference === input.record.reference ? updated : entry)
        : [...current.records, updated],
    };
    await writeCycleFile(paths, next);
  } finally {
    await lease.release();
  }
};

const queueWrite = async (key: string, operation: () => Promise<void>) => {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const pending = previous.then(operation);
  const settled = pending.catch(() => undefined);
  writeQueues.set(key, settled);
  try {
    await pending;
  } finally {
    if (writeQueues.get(key) === settled) writeQueues.delete(key);
  }
};

export async function storeCycleOwnedSessionRecord(input: {
  cwd: string;
  owner: CycleSessionOwner;
  record: SessionRecord;
}): Promise<void> {
  await queueWrite(resolve(input.cwd), () => storeCycleOwnedSessionRecordUnsafe(input));
}

const directSessionIdentity = (record: SessionRecord) => {
  const { status: _status, updatedAt: _updatedAt, ...identity } = record;
  return identity;
};

const sameDirectSession = (left: SessionRecord, right: SessionRecord) =>
  JSON.stringify(directSessionIdentity(left)) === JSON.stringify(directSessionIdentity(right));

export async function loadDirectSessionRecord(input: {
  cwd: string;
  reference: string;
}): Promise<SessionRecord | null> {
  if (!text(input.reference, 256) || isCycleSessionReference(input.reference)) return null;
  if (await findCycleOwnedSession({ cwd: input.cwd, reference: input.reference })) return null;
  const file = await loadDirectFile(input.cwd);
  const record = file.records.find((item) => item.reference === input.reference);
  return record ? structuredClone(record) : null;
}

const writeDirectFile = async (paths: SessionFilePaths, next: DirectAgentSessionFile) => {
  const temporary = join(paths.directory, `.${DIRECT_AGENT_SESSIONS_FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    const temporaryDetails = await lstat(temporary);
    if (!temporaryDetails.isFile() || temporaryDetails.isSymbolicLink()) throw new Error("direct_agent_session_file_invalid");
    const canonicalTemporary = await realpath(temporary);
    if (!inside(paths.directory, canonicalTemporary)) throw new Error("direct_agent_session_path_invalid");
    await rename(temporary, paths.file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

const storeDirectSessionRecordUnsafe = async (input: {
  cwd: string;
  record: SessionRecord;
}): Promise<void> => {
  if (!validSessionRecord(input.record)
    || isCycleSessionReference(input.record.reference)
    || input.record.status !== "succeeded"
    || !input.record.followUpAllowed) {
    throw new Error("direct_agent_session_invalid");
  }
  const paths = await directFilePaths(input.cwd, true);
  const lease = await acquireRegistryFileLock(paths.file);
  if (!lease) throw new Error("direct_agent_session_busy");
  try {
    await ensureLocalStateGitignore(paths.directory);
    if (await findCycleOwnedSession({ cwd: input.cwd, reference: input.record.reference })) {
      throw new Error("direct_agent_session_cycle_owned");
    }
    const current = await loadDirectFileAtPaths(paths);
    const existing = current.records.find((record) => record.reference === input.record.reference);
    if (existing && !sameDirectSession(existing, input.record)) throw new Error("direct_agent_session_conflict");
    const next: DirectAgentSessionFile = {
      schemaVersion: CYCLE_AGENT_SESSION_SCHEMA_VERSION,
      records: existing
        ? current.records.map((record) => record.reference === input.record.reference
          ? structuredClone(input.record)
          : record)
        : [...current.records, structuredClone(input.record)],
    };
    await writeDirectFile(paths, next);
  } finally {
    await lease.release();
  }
};

export async function storeDirectSessionRecord(input: {
  cwd: string;
  record: SessionRecord;
}): Promise<void> {
  await queueWrite(`${resolve(input.cwd)}:${DIRECT_AGENT_SESSIONS_FILE}`, () => storeDirectSessionRecordUnsafe(input));
}

export const createCycleSessionReference = () => `cycle:${randomUUID()}`;
export const createDirectSessionReference = () => `direct:${randomUUID()}`;
