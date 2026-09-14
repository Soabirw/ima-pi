import { isAbsolute, join, relative, sep } from "node:path";
import { CYCLE_SCHEMA_VERSION, validateCycleState, type CycleState } from "./ima-cycle.ts";

export const CYCLE_STORE_DIRNAME = ".ima-cycle";
export const CYCLE_STORE_FILENAME = "active.json";
export const CYCLE_STORE_GITIGNORE_BODY = "*\n";
export const CYCLE_ROOT_MARKERS = [".git", ".serena"] as const;

type CycleStorePaths = { dir: string; file: string; gitignore: string };
type CycleRootMark = { dir: string; hasMarker: boolean };

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const CYCLE_STATE_KEYS = ["schemaVersion", "source", "lifecycleKey", "implementationMode", "mode", "phase", "status", "reviewAttempts", "reviewCap", "evidence", "blockers", "updatedAt", "stoppedAt", "stoppedPhase", "trackerClosed", "branchId", "lifecycleProvider", "lifecycleProviderAttemptId", "execution"] as const;
const hasOnlyCycleStateKeys = (value: unknown) => {
  const state = object(value);
  return Boolean(state && Object.keys(state).every((key) => (CYCLE_STATE_KEYS as readonly string[]).includes(key)));
};
const validateDurableCycleState = (value: unknown) => {
  if (!hasOnlyCycleStateKeys(value)) return null;
  const validated = validateCycleState(value);
  return validated.valid ? validated.state : null;
};
const isAncestor = (ancestor: string, cwd: string) => {
  const path = relative(ancestor, cwd);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

export const cycleStorePaths = (root: string): CycleStorePaths => {
  const dir = join(root, CYCLE_STORE_DIRNAME);
  return { dir, file: join(dir, CYCLE_STORE_FILENAME), gitignore: join(dir, ".gitignore") };
};

export const serializeCycleRecord = (state: CycleState): string => {
  const validated = validateDurableCycleState(state);
  if (!validated) throw new Error("cycle_state_invalid");
  return JSON.stringify({ schemaVersion: CYCLE_SCHEMA_VERSION, state: validated });
};

export const parseCycleRecord = (text: string): CycleState | null => {
  try {
    const record = object(JSON.parse(text));
    if (!record || record.schemaVersion !== CYCLE_SCHEMA_VERSION) return null;
    return validateDurableCycleState(record.state);
  } catch {
    return null;
  }
};

export const selectProjectRoot = (cwd: string, marks: readonly CycleRootMark[]): string =>
  marks
    .filter(({ dir, hasMarker }) => hasMarker && isAncestor(dir, cwd))
    .sort((left, right) => right.dir.length - left.dir.length)[0]?.dir ?? cwd;
