import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SessionRecord } from "./ima-delegation.ts";

export const CYCLE_AGENT_SESSION_SCHEMA_VERSION = 1;
export const CYCLE_PHASE_CONTEXT_ENTRY = "ima-cycle-phase-context";
const CYCLE_DIRECTORY = ".ima-cycle";
const CYCLE_AGENT_SESSIONS_FILE = "agent-sessions.json";
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

const safeFilePaths = async (cwd: string, create: boolean) => {
  const root = await realpath(cwd);
  const directory = join(root, CYCLE_DIRECTORY);
  if (create) await mkdir(directory, { recursive: true });
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("cycle_agent_session_directory_invalid");
  const canonicalDirectory = await realpath(directory);
  if (!inside(root, canonicalDirectory)) throw new Error("cycle_agent_session_path_invalid");
  return { root, directory: canonicalDirectory, file: join(canonicalDirectory, CYCLE_AGENT_SESSIONS_FILE) };
};

const loadFile = async (cwd: string): Promise<AgentSessionFile> => {
  let paths;
  try {
    paths = await safeFilePaths(cwd, false);
  } catch (error: any) {
    if (error?.code === "ENOENT") return { schemaVersion: CYCLE_AGENT_SESSION_SCHEMA_VERSION, records: [] };
    throw error;
  }
  try {
    const details = await lstat(paths.file);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("cycle_agent_session_file_invalid");
    const canonicalFile = await realpath(paths.file);
    if (!inside(paths.directory, canonicalFile)) throw new Error("cycle_agent_session_path_invalid");
    const parsed = JSON.parse(await readFile(canonicalFile, "utf8")) as AgentSessionFile;
    if (parsed?.schemaVersion !== CYCLE_AGENT_SESSION_SCHEMA_VERSION || !Array.isArray(parsed.records) || !parsed.records.every(validateCycleOwnedSessionRecord)) {
      throw new Error("cycle_agent_session_file_invalid");
    }
    const seen = new Set<string>();
    if (parsed.records.some(({ record }) => seen.has(record.reference) || !seen.add(record.reference))) throw new Error("cycle_agent_session_file_invalid");
    return { schemaVersion: CYCLE_AGENT_SESSION_SCHEMA_VERSION, records: parsed.records.map((entry) => structuredClone(entry)) };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { schemaVersion: CYCLE_AGENT_SESSION_SCHEMA_VERSION, records: [] };
    throw error;
  }
};

const sameOwner = (left: CycleSessionOwner, right: CycleSessionOwner) =>
  left.project === right.project
  && left.lifecycleKey === right.lifecycleKey
  && left.source === right.source
  && left.phase === right.phase
  && left.dispatchId === right.dispatchId;
const sameLifecycle = (left: CycleSessionOwner, right: CycleSessionOwner) =>
  left.project === right.project
  && left.lifecycleKey === right.lifecycleKey
  && left.source === right.source;

export async function loadCycleOwnedSession(input: {
  cwd: string;
  owner: CycleSessionOwner;
  reference: string;
}): Promise<CycleOwnedSessionRecord | null> {
  if (!validateCycleSessionOwner(input.owner) || !text(input.reference, 256)) return null;
  const file = await loadFile(input.cwd);
  const entry = file.records.find((item) => item.record.reference === input.reference && sameLifecycle(item.owner, input.owner));
  return entry ? structuredClone(entry) : null;
}

export async function loadCycleOwnedSessionRecord(input: {
  cwd: string;
  owner: CycleSessionOwner;
  reference: string;
}): Promise<SessionRecord | null> {
  const entry = await loadCycleOwnedSession(input);
  return entry ? entry.record : null;
}

const storeCycleOwnedSessionRecordUnsafe = async (input: {
  cwd: string;
  owner: CycleSessionOwner;
  record: SessionRecord;
}): Promise<void> => {
  if (!validateCycleSessionOwner(input.owner) || !validSessionRecord(input.record)) throw new Error("cycle_agent_session_invalid");
  const paths = await safeFilePaths(input.cwd, true);
  const current = await loadFile(input.cwd);
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

export async function storeCycleOwnedSessionRecord(input: {
  cwd: string;
  owner: CycleSessionOwner;
  record: SessionRecord;
}): Promise<void> {
  const key = resolve(input.cwd);
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const operation = previous.then(() => storeCycleOwnedSessionRecordUnsafe(input));
  const settled = operation.catch(() => undefined);
  writeQueues.set(key, settled);
  try {
    await operation;
  } finally {
    if (writeQueues.get(key) === settled) writeQueues.delete(key);
  }
}

export const createCycleSessionReference = () => `cycle:${randomUUID()}`;
