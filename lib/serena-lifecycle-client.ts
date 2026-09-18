import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { McpToolCaller } from "./mcp-client.ts";
import {
  createSerenaMcpSession,
  supportsSerenaMcpLifecycleSchemas,
  type SerenaMcpSession,
} from "./serena-mcp-session.ts";
import {
  MAX_SERENA_LIFECYCLE_MEMORY_BYTES,
  MAX_SERENA_LIFECYCLE_MEMORY_CHARACTERS,
  isSerenaLifecycleMemoryName,
  normalizeSerenaLifecycleProject,
  projectSerenaLifecycleProject,
  type SerenaLifecycleProject,
} from "./serena-lifecycle-record.ts";
import { utf8ByteLength } from "./qdrant-corpus.ts";

export const SERENA_LIFECYCLE_MCP_TIMEOUT_MS = 300_000;
export const MAX_SERENA_LIFECYCLE_MEMORY_NAMES = 10_000;
export const MAX_SERENA_LIFECYCLE_MEMORY_NAME_BYTES = 1_024;

export type SerenaLifecycleClientFailureCode =
  | "aborted"
  | "serena_memory_listing_unverifiable"
  | "serena_memory_read_unavailable"
  | "serena_memory_read_unverifiable"
  | "serena_memory_write_unknown"
  | "serena_project_mismatch"
  | "serena_project_unavailable"
  | "serena_protocol_unsupported"
  | "serena_session_unavailable";

export type SerenaLifecycleClientResult<Data> =
  | { success: true; data: Data }
  | { success: false; code: SerenaLifecycleClientFailureCode };

export type SerenaLifecycleWriteResult =
  | {
    success: true;
    data: undefined;
    dispatch: "dispatched";
    settlement: "settled";
  }
  | {
    success: false;
    code: SerenaLifecycleClientFailureCode;
    dispatch: "not_dispatched";
    settlement: "not_dispatched";
  }
  | {
    success: false;
    code: SerenaLifecycleClientFailureCode;
    dispatch: "dispatched";
    settlement: "unknown";
  };

export type SerenaLifecycleClient = {
  activate: (
    project: unknown,
    signal?: AbortSignal,
  ) => Promise<SerenaLifecycleClientResult<SerenaLifecycleProject>>;
  listMemoryNames: (
    signal?: AbortSignal,
  ) => Promise<SerenaLifecycleClientResult<string[]>>;
  readMemory: (
    memoryName: unknown,
    signal?: AbortSignal,
  ) => Promise<SerenaLifecycleClientResult<string>>;
  writeMemory: (
    input: { memoryName: unknown; content: unknown },
    signal?: AbortSignal,
  ) => Promise<SerenaLifecycleWriteResult>;
  isSupported?: () => boolean;
};

export type SerenaLifecycleProjectInspector = (
  project: SerenaLifecycleProject,
  signal?: AbortSignal,
) => Promise<SerenaLifecycleProject | null>;

export type SerenaLifecycleMemoryInspection = {
  memoryName: string;
  allowMissing: boolean;
};

export type SerenaLifecycleMemoryInspector = (
  project: SerenaLifecycleProject,
  inspection: SerenaLifecycleMemoryInspection,
  signal?: AbortSignal,
) => Promise<SerenaLifecycleProject | null>;

type FilesystemEntry = {
  isDirectory: () => boolean;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
  size: number;
  dev: number;
  ino: number;
};

export type SerenaLifecycleProjectInspectionEffects = {
  lstat: (path: string) => Promise<FilesystemEntry>;
  realpath: (path: string) => Promise<string>;
  readFile: (path: string, encoding: "utf8") => Promise<string>;
  parseYaml: (value: string) => unknown;
  home: () => string;
};

export type SerenaLifecycleProjectInspection = {
  inspectProject: SerenaLifecycleProjectInspector;
  inspectMemory: SerenaLifecycleMemoryInspector;
};

const MAX_PROJECT_CONFIGURATION_BYTES = 256_000;
const MAX_MCP_TEXT_BYTES = 300_000;
const DEFAULT_PROJECT_SERENA_FOLDER_LOCATION = "$projectDir/.serena";
type FilesystemNode = {
  dev: number;
  ino: number;
};

type CheckedFilesystemEntry = {
  node: FilesystemNode;
  size: number;
};

type MemoryTarget =
  | { state: "absent" }
  | { state: "present"; node: FilesystemNode };

const ownDataRecord = (value: unknown): Record<string, unknown> | null => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => {
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

const ownDataArray = (value: unknown, maximum: number): unknown[] | null => {
  try {
    if (!Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = descriptors.length?.value;
    if (
      !Number.isSafeInteger(length)
      || length < 0
      || length > maximum
      || keys.length !== length + 1
      || keys.some((key) => typeof key !== "string")
      || keys.some((key) => key !== "length" && !/^\d+$/.test(key as string))
      || !descriptors.length
      || descriptors.length.get
      || descriptors.length.set
      || !Object.hasOwn(descriptors.length, "value")
    ) return null;

    const values: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor
        || descriptor.get
        || descriptor.set
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, "value")
      ) return null;
      values.push(descriptor.value);
    }
    return values;
  } catch {
    return null;
  }
};

const text = (value: unknown, maximumBytes: number): string | null =>
  typeof value === "string" && utf8ByteLength(value) <= maximumBytes ? value : null;

const safeMemoryName = (value: unknown): string | null => {
  const candidate = text(value, MAX_SERENA_LIFECYCLE_MEMORY_NAME_BYTES);
  return candidate && candidate.length > 0 && !/[\u0000-\u001f\u007f-\u009f]/.test(candidate)
    ? candidate
    : null;
};

const safeAbsolutePath = (value: unknown, maximumBytes: number): string | null => {
  const candidate = text(value, maximumBytes);
  return candidate
    && candidate.startsWith("/")
    && (candidate.length === 1 || !candidate.endsWith("/"))
    && !/[\u0000-\u001f\u007f-\u009f]/.test(candidate)
    && !candidate.includes("//")
    && !candidate.split("/").some((segment) => segment === "." || segment === "..")
    ? candidate
    : null;
};

const sameProject = (left: SerenaLifecycleProject, right: SerenaLifecycleProject) =>
  left.projectName === right.projectName
  && left.projectPath === right.projectPath
  && left.fingerprint === right.fingerprint;

const clonedProject = (project: SerenaLifecycleProject): SerenaLifecycleProject => ({
  schemaVersion: 1,
  provider: "serena",
  projectName: project.projectName,
  projectPath: project.projectPath,
  fingerprint: project.fingerprint,
});

const success = <Data>(data: Data): SerenaLifecycleClientResult<Data> => ({ success: true, data });
const failure = <Data>(code: SerenaLifecycleClientFailureCode): SerenaLifecycleClientResult<Data> => ({
  success: false,
  code,
});
const writePreDispatchFailure = (code: SerenaLifecycleClientFailureCode): SerenaLifecycleWriteResult => ({
  success: false,
  code,
  dispatch: "not_dispatched",
  settlement: "not_dispatched",
});
const writeUnknown = (code: SerenaLifecycleClientFailureCode): SerenaLifecycleWriteResult => ({
  success: false,
  code,
  dispatch: "dispatched",
  settlement: "unknown",
});
const writeSettled = (): SerenaLifecycleWriteResult => ({
  success: true,
  data: undefined,
  dispatch: "dispatched",
  settlement: "settled",
});
const aborted = (signal?: AbortSignal) => signal?.aborted === true;

export const supportsSerenaLifecycleToolSchemas = (value: unknown): boolean =>
  supportsSerenaMcpLifecycleSchemas(value);

const textToolResponse = (value: unknown): string | null => {
  const response = ownDataRecord(value);
  if (
    !response
    || Object.keys(response).some((key) => key !== "content" && key !== "isError")
    || response.isError === true
    || (Object.hasOwn(response, "isError") && response.isError !== false)
  ) return null;

  const content = ownDataArray(response.content, 1);
  if (!content || content.length !== 1) return null;
  const block = ownDataRecord(content[0]);
  if (
    !block
    || Object.keys(block).length !== 2
    || block.type !== "text"
    || typeof block.text !== "string"
    || utf8ByteLength(block.text) > MAX_MCP_TEXT_BYTES
  ) return null;
  return block.text;
};

const activationMatches = (value: string, project: SerenaLifecycleProject) => {
  const firstLineEnd = value.indexOf("\n");
  const firstLine = firstLineEnd === -1 ? value : value.slice(0, firstLineEnd);
  return firstLine === `The project with name '${project.projectName}' at ${project.projectPath} is activated.`;
};

const memoryNames = (value: string): string[] | null => {
  try {
    const listing = ownDataRecord(JSON.parse(value));
    if (
      !listing
      || Object.keys(listing).some((key) => key !== "memories" && key !== "read_only_memories")
    ) return null;

    const memories = Object.hasOwn(listing, "memories")
      ? ownDataArray(listing.memories, MAX_SERENA_LIFECYCLE_MEMORY_NAMES)
      : [];
    const readOnlyMemories = Object.hasOwn(listing, "read_only_memories")
      ? ownDataArray(listing.read_only_memories, MAX_SERENA_LIFECYCLE_MEMORY_NAMES)
      : [];
    if (!memories || !readOnlyMemories) return null;

    const names = [...memories, ...readOnlyMemories];
    if (
      names.length > MAX_SERENA_LIFECYCLE_MEMORY_NAMES
      || !names.every((name) => safeMemoryName(name))
    ) return null;
    const normalized = names as string[];
    return new Set(normalized).size === normalized.length ? [...normalized] : null;
  } catch {
    return null;
  }
};

const projectNameFromConfiguration = (value: Record<string, unknown>): string | null =>
  text(value.project_name, 256);

const registeredProjectPaths = (value: Record<string, unknown>): string[] | null => {
  const paths = ownDataArray(value.projects, MAX_SERENA_LIFECYCLE_MEMORY_NAMES);
  if (!paths) return null;
  const normalized = paths.map((path) => safeAbsolutePath(path, 4_096));
  return normalized.some((path) => path === null)
    || new Set(normalized).size !== normalized.length
    ? null
    : normalized as string[];
};

const hasDefaultProjectSerenaFolderLocation = (value: Record<string, unknown>) =>
  !Object.hasOwn(value, "project_serena_folder_location")
  || value.project_serena_folder_location === DEFAULT_PROJECT_SERENA_FOLDER_LOCATION;

const hasNoIgnoredMemoryPatterns = (value: Record<string, unknown>) => {
  if (!Object.hasOwn(value, "ignored_memory_patterns")) return true;
  const patterns = ownDataArray(value.ignored_memory_patterns, MAX_SERENA_LIFECYCLE_MEMORY_NAMES);
  return patterns !== null && patterns.length === 0;
};

const filesystemNode = (entry: FilesystemEntry): FilesystemNode | null =>
  Number.isSafeInteger(entry.dev)
  && entry.dev >= 0
  && Number.isSafeInteger(entry.ino)
  && entry.ino >= 0
  ? { dev: entry.dev, ino: entry.ino }
  : null;

const sameFilesystemNode = (left: FilesystemNode, right: FilesystemNode) =>
  left.dev === right.dev && left.ino === right.ino;

const checkedFilesystemEntry = async (
  effects: SerenaLifecycleProjectInspectionEffects,
  path: string,
  type: "directory" | "file",
): Promise<CheckedFilesystemEntry | null> => {
  const check = async (): Promise<CheckedFilesystemEntry | null> => {
    const entry = await effects.lstat(path);
    const valid = type === "directory" ? entry.isDirectory() : entry.isFile();
    const node = filesystemNode(entry);
    return valid && !entry.isSymbolicLink() && node
      ? { node, size: entry.size }
      : null;
  };

  const before = await check();
  if (!before || await effects.realpath(path) !== path) return null;
  const after = await check();
  return after && sameFilesystemNode(before.node, after.node) ? after : null;
};

const readConfiguration = async (
  effects: SerenaLifecycleProjectInspectionEffects,
  path: string,
): Promise<Record<string, unknown> | null> => {
  const before = await checkedFilesystemEntry(effects, path, "file");
  if (
    !before
    || !Number.isSafeInteger(before.size)
    || before.size < 0
    || before.size > MAX_PROJECT_CONFIGURATION_BYTES
  ) return null;

  const source = await effects.readFile(path, "utf8");
  if (typeof source !== "string" || utf8ByteLength(source) > MAX_PROJECT_CONFIGURATION_BYTES) return null;
  const after = await checkedFilesystemEntry(effects, path, "file");
  if (!after || !sameFilesystemNode(before.node, after.node) || before.size !== after.size) return null;
  return ownDataRecord(effects.parseYaml(source));
};

const memoryTarget = async (
  effects: SerenaLifecycleProjectInspectionEffects,
  path: string,
): Promise<MemoryTarget | null> => {
  let first: FilesystemEntry;
  try {
    first = await effects.lstat(path);
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === "ENOENT"
      ? { state: "absent" }
      : null;
  }

  const firstNode = filesystemNode(first);
  if (!first.isFile() || first.isSymbolicLink() || !firstNode) return null;
  try {
    if (await effects.realpath(path) !== path) return null;
    const second = await effects.lstat(path);
    const secondNode = filesystemNode(second);
    return second.isFile()
      && !second.isSymbolicLink()
      && secondNode
      && sameFilesystemNode(firstNode, secondNode)
      ? { state: "present", node: secondNode }
      : null;
  } catch {
    return null;
  }
};

const sameMemoryTarget = (left: MemoryTarget, right: MemoryTarget) => {
  if (left.state === "absent" || right.state === "absent") {
    return left.state === right.state;
  }
  return sameFilesystemNode(left.node, right.node);
};

const checkedMemoryTarget = async (input: {
  effects: SerenaLifecycleProjectInspectionEffects;
  memoriesDirectory: string;
  inspection: SerenaLifecycleMemoryInspection;
}): Promise<boolean> => {
  if (!isSerenaLifecycleMemoryName(input.inspection.memoryName)) return false;
  const directoryBefore = await checkedFilesystemEntry(
    input.effects,
    input.memoriesDirectory,
    "directory",
  );
  if (!directoryBefore) return false;

  const targetPath = join(input.memoriesDirectory, `${input.inspection.memoryName}.md`);
  const targetBefore = await memoryTarget(input.effects, targetPath);
  if (!targetBefore || (targetBefore.state === "absent" && !input.inspection.allowMissing)) {
    return false;
  }

  const directoryAfter = await checkedFilesystemEntry(
    input.effects,
    input.memoriesDirectory,
    "directory",
  );
  if (!directoryAfter || !sameFilesystemNode(directoryBefore.node, directoryAfter.node)) return false;

  const targetAfter = await memoryTarget(input.effects, targetPath);
  if (!targetAfter || !sameMemoryTarget(targetBefore, targetAfter)) return false;

  const directoryFinal = await checkedFilesystemEntry(
    input.effects,
    input.memoriesDirectory,
    "directory",
  );
  if (!directoryFinal || !sameFilesystemNode(directoryBefore.node, directoryFinal.node)) {
    return false;
  }

  const targetFinal = await memoryTarget(input.effects, targetPath);
  if (!targetFinal || !sameMemoryTarget(targetBefore, targetFinal)) return false;

  const directoryLast = await checkedFilesystemEntry(
    input.effects,
    input.memoriesDirectory,
    "directory",
  );
  return Boolean(
    directoryLast
    && sameFilesystemNode(directoryBefore.node, directoryLast.node),
  );
};

const defaultProjectInspectionEffects: SerenaLifecycleProjectInspectionEffects = {
  lstat,
  realpath,
  readFile,
  parseYaml: (value) => parse(value, {
    maxAliasCount: 0,
    merge: false,
    schema: "core",
    strict: true,
    uniqueKeys: true,
  }),
  home: homedir,
};

export const createSerenaLifecycleProjectInspection = (
  supplied: Partial<SerenaLifecycleProjectInspectionEffects> = {},
): SerenaLifecycleProjectInspection => {
  const effects = { ...defaultProjectInspectionEffects, ...supplied };

  const inspect = async (
    value: SerenaLifecycleProject,
    inspection: SerenaLifecycleMemoryInspection | undefined,
    signal?: AbortSignal,
  ): Promise<SerenaLifecycleProject | null> => {
    try {
      const project = projectSerenaLifecycleProject(value);
      if (!project || aborted(signal)) return null;

      const home = safeAbsolutePath(effects.home(), 4_096);
      if (!home) return null;
      const userConfigurationPath = join(home, ".serena", "serena_config.yml");
      const userConfiguration = await readConfiguration(effects, userConfigurationPath);
      if (
        aborted(signal)
        || !userConfiguration
        || !hasDefaultProjectSerenaFolderLocation(userConfiguration)
        || !hasNoIgnoredMemoryPatterns(userConfiguration)
      ) return null;
      const registered = registeredProjectPaths(userConfiguration);
      if (!registered || !registered.includes(project.projectPath)) return null;

      const root = await checkedFilesystemEntry(effects, project.projectPath, "directory");
      if (!root || aborted(signal)) return null;

      const managedDirectory = join(project.projectPath, ".serena");
      const managed = await checkedFilesystemEntry(effects, managedDirectory, "directory");
      if (!managed || aborted(signal)) return null;

      const configurationPath = join(managedDirectory, "project.yml");
      const configuration = await readConfiguration(effects, configurationPath);
      if (
        aborted(signal)
        || !configuration
        || !hasDefaultProjectSerenaFolderLocation(configuration)
        || !hasNoIgnoredMemoryPatterns(configuration)
        || projectNameFromConfiguration(configuration) !== project.projectName
      ) return null;

      const memoriesDirectory = join(managedDirectory, "memories");
      const memories = await checkedFilesystemEntry(effects, memoriesDirectory, "directory");
      if (!memories || aborted(signal)) return null;

      const rootAfter = await checkedFilesystemEntry(effects, project.projectPath, "directory");
      const managedAfter = await checkedFilesystemEntry(effects, managedDirectory, "directory");
      const memoriesAfter = await checkedFilesystemEntry(effects, memoriesDirectory, "directory");
      if (
        aborted(signal)
        || !rootAfter
        || !managedAfter
        || !memoriesAfter
        || !sameFilesystemNode(root.node, rootAfter.node)
        || !sameFilesystemNode(managed.node, managedAfter.node)
        || !sameFilesystemNode(memories.node, memoriesAfter.node)
      ) return null;

      if (inspection) {
        const safeTarget = await checkedMemoryTarget({
          effects,
          memoriesDirectory,
          inspection,
        });
        if (!safeTarget || aborted(signal)) return null;

        const rootFinal = await checkedFilesystemEntry(effects, project.projectPath, "directory");
        const managedFinal = await checkedFilesystemEntry(effects, managedDirectory, "directory");
        if (
          !rootFinal
          || !managedFinal
          || !sameFilesystemNode(root.node, rootFinal.node)
          || !sameFilesystemNode(managed.node, managedFinal.node)
        ) return null;
      }

      return clonedProject(project);
    } catch {
      return null;
    }
  };

  return {
    inspectProject: (project, signal) => inspect(project, undefined, signal),
    inspectMemory: (project, inspection, signal) => inspect(project, inspection, signal),
  };
};

const existingProjectInspection = createSerenaLifecycleProjectInspection();

export const inspectExistingSerenaLifecycleProject = existingProjectInspection.inspectProject;
export const inspectExistingSerenaLifecycleMemory = existingProjectInspection.inspectMemory;

const validTimeout = (value: unknown): number | null =>
  Number.isInteger(value) && Number(value) > 0 && Number(value) <= SERENA_LIFECYCLE_MCP_TIMEOUT_MS
    ? Number(value)
    : null;

export const createSerenaLifecycleClient = (input: {
  call: McpToolCaller;
  advertisedTools?: unknown;
  project: unknown;
  inspectProject?: SerenaLifecycleProjectInspector;
  inspectMemory?: SerenaLifecycleMemoryInspector;
  timeoutMs?: number;
  initialization?: unknown;
  mcpSession?: SerenaMcpSession;
}): SerenaLifecycleClient => {
  const project = normalizeSerenaLifecycleProject(input.project);
  const createdSession = input.mcpSession === undefined
    ? createSerenaMcpSession({
      call: input.call,
      advertisedTools: input.advertisedTools,
      initialization: input.initialization,
    })
    : null;
  const mcpSession = input.mcpSession
    ?? (createdSession?.success ? createdSession.session : null);
  const sessionFailure = createdSession && !createdSession.success
    ? createdSession.code
    : null;
  const unsupported = (): SerenaLifecycleClientFailureCode =>
    sessionFailure ?? "serena_protocol_unsupported";
  const supported = Boolean(
    mcpSession
    && mcpSession.capabilities.lifecycleSupported
    && (input.mcpSession !== undefined || supportsSerenaLifecycleToolSchemas(input.advertisedTools)),
  );
  const timeoutMs = validTimeout(input.timeoutMs ?? SERENA_LIFECYCLE_MCP_TIMEOUT_MS);
  const inspectProject = input.inspectProject ?? inspectExistingSerenaLifecycleProject;
  const inspectMemory = input.inspectMemory ?? inspectExistingSerenaLifecycleMemory;

  const unavailable = <Data>(code: SerenaLifecycleClientFailureCode): SerenaLifecycleClientResult<Data> =>
    failure(code);

  const prepareSession = async (
    signal?: AbortSignal,
  ): Promise<SerenaLifecycleClientFailureCode | null> => {
    if (!mcpSession || !supported || !timeoutMs) return unsupported();
    try {
      const prepared = await mcpSession.prepare(timeoutMs, signal);
      return prepared.success ? null : prepared.code;
    } catch {
      return aborted(signal) ? "aborted" : "serena_session_unavailable";
    }
  };

  const activate = async (
    value: unknown,
    signal?: AbortSignal,
  ): Promise<SerenaLifecycleClientResult<SerenaLifecycleProject>> => {
    const expected = normalizeSerenaLifecycleProject(value);
    if (!project || !expected || !sameProject(project, expected)) {
      return unavailable("serena_project_mismatch");
    }
    if (!supported || !timeoutMs) return unavailable(unsupported());
    if (aborted(signal)) return unavailable("aborted");

    let inspected: SerenaLifecycleProject | null;
    try {
      inspected = projectSerenaLifecycleProject(
        await inspectProject(clonedProject(project), signal),
      );
    } catch {
      inspected = null;
    }
    if (aborted(signal)) return unavailable("aborted");
    if (!inspected || !sameProject(inspected, project)) {
      return unavailable("serena_project_unavailable");
    }

    const preparationFailure = await prepareSession(signal);
    if (preparationFailure) return unavailable(preparationFailure);

    let response: unknown;
    try {
      response = await mcpSession!.activateProject(project.projectPath, timeoutMs, signal);
    } catch {
      return unavailable(aborted(signal) ? "aborted" : "serena_project_unavailable");
    }
    if (aborted(signal)) return unavailable("aborted");
    const receipt = textToolResponse(response);
    return receipt && activationMatches(receipt, project)
      ? success(clonedProject(project))
      : unavailable("serena_project_unavailable");
  };

  const listMemoryNames = async (
    signal?: AbortSignal,
  ): Promise<SerenaLifecycleClientResult<string[]>> => {
    if (!project || !supported || !timeoutMs) return unavailable(unsupported());
    if (aborted(signal)) return unavailable("aborted");

    let inspected: SerenaLifecycleProject | null;
    try {
      inspected = projectSerenaLifecycleProject(
        await inspectProject(clonedProject(project), signal),
      );
    } catch {
      inspected = null;
    }
    if (aborted(signal)) return unavailable("aborted");
    if (!inspected || !sameProject(inspected, project)) {
      return unavailable("serena_project_unavailable");
    }

    const preparationFailure = await prepareSession(signal);
    if (preparationFailure) return unavailable(preparationFailure);

    let response: unknown;
    try {
      response = await mcpSession!.listMemories(timeoutMs, signal);
    } catch {
      return unavailable(aborted(signal) ? "aborted" : "serena_memory_listing_unverifiable");
    }
    if (aborted(signal)) return unavailable("aborted");
    const names = textToolResponse(response);
    const parsed = names === null ? null : memoryNames(names);
    return parsed ? success(parsed) : unavailable("serena_memory_listing_unverifiable");
  };

  const readMemory = async (
    value: unknown,
    signal?: AbortSignal,
  ): Promise<SerenaLifecycleClientResult<string>> => {
    const memoryName = isSerenaLifecycleMemoryName(value) ? value : null;
    if (!memoryName) return unavailable("serena_memory_read_unverifiable");
    if (!project || !supported || !timeoutMs) return unavailable(unsupported());
    if (aborted(signal)) return unavailable("aborted");

    let inspected: SerenaLifecycleProject | null;
    try {
      inspected = projectSerenaLifecycleProject(await inspectMemory(
        clonedProject(project),
        { memoryName, allowMissing: false },
        signal,
      ));
    } catch {
      inspected = null;
    }
    if (aborted(signal)) return unavailable("aborted");
    if (!inspected || !sameProject(inspected, project)) {
      return unavailable("serena_memory_read_unavailable");
    }

    const preparationFailure = await prepareSession(signal);
    if (preparationFailure) return unavailable(preparationFailure);

    let response: unknown;
    try {
      response = await mcpSession!.readMemory(memoryName, timeoutMs, signal);
    } catch {
      return unavailable(aborted(signal) ? "aborted" : "serena_memory_read_unavailable");
    }
    if (aborted(signal)) return unavailable("aborted");
    const content = textToolResponse(response);
    return content === null || content.length > MAX_SERENA_LIFECYCLE_MEMORY_CHARACTERS
      || utf8ByteLength(content) > MAX_SERENA_LIFECYCLE_MEMORY_BYTES
      ? unavailable("serena_memory_read_unverifiable")
      : success(content);
  };

  const writeMemory = async (
    value: { memoryName: unknown; content: unknown },
    signal?: AbortSignal,
  ): Promise<SerenaLifecycleWriteResult> => {
    const writeInput = ownDataRecord(value);
    if (!writeInput) return writePreDispatchFailure("serena_memory_write_unknown");

    const memoryName = isSerenaLifecycleMemoryName(writeInput.memoryName)
      ? writeInput.memoryName
      : null;
    const content = typeof writeInput.content === "string"
      && writeInput.content.length <= MAX_SERENA_LIFECYCLE_MEMORY_CHARACTERS
      && utf8ByteLength(writeInput.content) <= MAX_SERENA_LIFECYCLE_MEMORY_BYTES
      ? writeInput.content
      : null;
    if (!memoryName || content === null) return writePreDispatchFailure("serena_memory_write_unknown");
    if (!project || !supported || !timeoutMs) return writePreDispatchFailure(unsupported());
    if (aborted(signal)) return writePreDispatchFailure("aborted");

    let inspected: SerenaLifecycleProject | null;
    try {
      inspected = projectSerenaLifecycleProject(await inspectMemory(
        clonedProject(project),
        { memoryName, allowMissing: true },
        signal,
      ));
    } catch {
      inspected = null;
    }
    if (aborted(signal)) return writePreDispatchFailure("aborted");
    if (!inspected || !sameProject(inspected, project)) {
      return writePreDispatchFailure("serena_memory_write_unknown");
    }

    const preparationFailure = await prepareSession(signal);
    if (preparationFailure) return writePreDispatchFailure(preparationFailure);

    let response: unknown;
    try {
      response = await mcpSession!.writeMemory({ memoryName, content }, timeoutMs, signal);
    } catch {
      return writeUnknown(aborted(signal) ? "aborted" : "serena_memory_write_unknown");
    }
    if (aborted(signal)) return writeUnknown("aborted");
    const receipt = textToolResponse(response);
    return receipt === `Memory ${memoryName} written.`
      ? writeSettled()
      : writeUnknown("serena_memory_write_unknown");
  };

  return {
    activate,
    listMemoryNames,
    readMemory,
    writeMemory,
    isSupported: () => supported && timeoutMs !== null,
  };
};
