import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { truncateTail } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const DELEGATED_VERIFICATION_MAX_ITEMS = 4;
export const DELEGATED_VERIFICATION_MAX_ARGS = 16;
export const DELEGATED_VERIFICATION_MAX_TIMEOUT_MS = 360_000;
export const DELEGATED_VERIFICATION_MIN_TIMEOUT_MS = 1_000;
export const DELEGATED_VERIFICATION_CLEANUP_TIMEOUT_MS = 1_000;
export const DELEGATED_VERIFICATION_MAX_MANIFEST_BYTES = 256 * 1024;
export const DELEGATED_VERIFICATION_OUTPUT_MAX_LINES = 200;
export const DELEGATED_VERIFICATION_OUTPUT_MAX_BYTES = 16 * 1024;
export const DELEGATED_VERIFICATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type DelegatedVerificationRunner = "npm" | "composer";
export type DelegatedVerification = {
  id: string;
  runner: DelegatedVerificationRunner;
  cwd: string;
  script: string;
  args: string[];
  timeout: number;
};

export type DelegatedVerificationAgent = {
  authority: string;
  tools: readonly string[];
};

export type DelegatedVerificationFilesystem = {
  lstat: typeof lstat;
  readFile: typeof readFile;
  realpath: typeof realpath;
};

export type DelegatedVerificationSnapshot = Readonly<{
  id: string;
  runner: DelegatedVerificationRunner;
  relativeCwd: string;
  cwd: string;
  manifestPath: string;
  manifestHash: string;
  script: string;
  scriptHash: string;
  args: readonly string[];
  timeout: number;
  manifestIdentity: Readonly<{
    device: number;
    inode: number;
    size: number;
    modifiedAt: number;
  }>;
}>;

export type DelegatedVerificationExecutor = (
  command: string,
  args: string[],
  options: { cwd: string; signal: AbortSignal; timeout: number },
) => Promise<{
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}>;

export type DelegatedVerificationTimer = {
  schedule: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  cancel: (timer: ReturnType<typeof setTimeout>) => void;
};

export type DelegatedVerificationExecution = {
  id: string;
  status: "passed" | "failed";
  exitCode: number;
  output: string;
  outputTruncated: boolean;
  outputBytes: number;
  outputLines: number;
};

export type DelegatedVerificationAdmission =
  | { admitted: true; snapshots: readonly DelegatedVerificationSnapshot[] }
  | { admitted: false; error: string };

const verificationFilesystem: DelegatedVerificationFilesystem = { lstat, readFile, realpath };
const verificationTimer: DelegatedVerificationTimer = {
  schedule: (callback, milliseconds) => setTimeout(callback, milliseconds),
  cancel: (timer) => clearTimeout(timer),
};
const verificationRunners = new Set<DelegatedVerificationRunner>(["npm", "composer"]);
const verificationAuthorities = new Set(["write", "test-write"]);
const verificationKeys = new Set(["id", "runner", "cwd", "script", "args", "timeout"]);
const manifestNameFor = (runner: DelegatedVerificationRunner) => runner === "npm" ? "package.json" : "composer.json";
const outputTruncationNotice = "[Verification output truncated.]";
const outputTruncationNoticeBytes = Buffer.byteLength(outputTruncationNotice, "utf8");

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown) => typeof value === "string" ? value : "";
const noControlCharacters = (value: string) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const within = (root: string, target: string) => {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
};
const normalizedCwd = (value: unknown) => {
  const path = string(value);
  if (path === ".") return path;
  if (!path || path.length > 1_024 || path.startsWith("/") || path.includes("\\") || path.endsWith("/")) return "";
  const segments = path.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..") ? path : "";
};
const validVerificationId = (value: unknown) => {
  const id = string(value);
  return id.length <= 64 && DELEGATED_VERIFICATION_ID_PATTERN.test(id);
};
const validScriptName = (value: unknown) => {
  const name = string(value);
  return name.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(name);
};
const sensitiveArgument = (value: string) => /(?:^|[-_])(api[-_]?key|token|secret|password|passwd|authorization|credential|auth)(?:[-_=]|$)/i.test(value);
const validArgument = (value: unknown) => {
  const argument = string(value);
  return argument.length > 0
    && argument.length <= 256
    && argument.trim() === argument
    && noControlCharacters(argument)
    && !argument.includes("\\")
    && !/[;&|`$<>]/.test(argument)
    && !/(?:^|=)\//.test(argument)
    && !/:\//.test(argument)
    && !/(?:^|\/)\.\.(?:\/|$)/.test(argument)
    && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(argument)
    && !/[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(argument)
    && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument)
    && !sensitiveArgument(argument);
};
const validTimeout = (value: unknown) => Number.isInteger(value)
  && value >= DELEGATED_VERIFICATION_MIN_TIMEOUT_MS
  && value <= DELEGATED_VERIFICATION_MAX_TIMEOUT_MS;
const validManifestIdentity = (value: unknown) => object(value)
  && ["device", "inode", "size", "modifiedAt"].every((key) =>
    typeof value[key] === "number" && Number.isFinite(value[key]));
const validSnapshot = (value: unknown): value is DelegatedVerificationSnapshot => object(value)
  && validVerificationId(value.id)
  && verificationRunners.has(value.runner as DelegatedVerificationRunner)
  && Boolean(normalizedCwd(value.relativeCwd))
  && typeof value.cwd === "string"
  && isAbsolute(value.cwd)
  && typeof value.manifestPath === "string"
  && isAbsolute(value.manifestPath)
  && /^[a-f0-9]{64}$/.test(string(value.manifestHash))
  && validScriptName(value.script)
  && /^[a-f0-9]{64}$/.test(string(value.scriptHash))
  && Array.isArray(value.args)
  && value.args.length <= DELEGATED_VERIFICATION_MAX_ARGS
  && value.args.every((argument) => validArgument(argument))
  && validTimeout(value.timeout)
  && validManifestIdentity(value.manifestIdentity);
const scriptValue = (manifest: Record<string, unknown>, config: DelegatedVerification) => {
  const scripts = manifest.scripts;
  if (!object(scripts) || !Object.hasOwn(scripts, config.script)) return null;
  const selected = scripts[config.script];
  if (config.runner === "npm") {
    return typeof selected === "string" && selected.trim() && noControlCharacters(selected)
      ? JSON.stringify(selected)
      : null;
  }
  if (typeof selected === "string" && selected.trim() && noControlCharacters(selected)) return JSON.stringify(selected);
  return Array.isArray(selected)
    && selected.length > 0
    && selected.every((entry) => typeof entry === "string" && entry.trim() && noControlCharacters(entry))
    ? JSON.stringify(selected)
    : null;
};
const fileIdentity = (entry: { dev: number; ino: number; size: number; mtimeMs: number }) => ({
  device: entry.dev,
  inode: entry.ino,
  size: entry.size,
  modifiedAt: entry.mtimeMs,
});
const sameIdentity = (
  left: DelegatedVerificationSnapshot["manifestIdentity"],
  right: DelegatedVerificationSnapshot["manifestIdentity"],
) => left.device === right.device
  && left.inode === right.inode
  && left.size === right.size
  && left.modifiedAt === right.modifiedAt;
const errorCode = (error: unknown) => error instanceof Error ? error.message : "";
const rejected = (code: string): never => { throw new Error(code); };
const safely = (effect: (() => void) | undefined) => {
  try { effect?.(); } catch {}
};

export const canUseDelegatedVerification = (agent: DelegatedVerificationAgent) =>
  verificationAuthorities.has(agent.authority) && agent.tools.includes("test");

export function validateDelegatedVerifications(input: {
  verifications: unknown;
  agent: DelegatedVerificationAgent;
}): { valid: boolean; errors: string[] } {
  if (input.verifications === undefined) return { valid: true, errors: [] };
  const errors: string[] = [];
  if (!verificationAuthorities.has(input.agent.authority)) errors.push("delegated_verification_role_denied");
  if (!input.agent.tools.includes("test")) errors.push("delegated_verification_tool_denied");
  if (!Array.isArray(input.verifications) || input.verifications.length < 1 || input.verifications.length > DELEGATED_VERIFICATION_MAX_ITEMS) {
    errors.push("delegated_verification_list_invalid");
    return { valid: false, errors };
  }
  const ids = new Set<string>();
  for (const entry of input.verifications) {
    if (!object(entry)
      || Object.keys(entry).some((key) => !verificationKeys.has(key))
      || [...verificationKeys].some((key) => !Object.hasOwn(entry, key))) {
      errors.push("delegated_verification_shape_invalid");
      continue;
    }
    const id = string(entry.id);
    if (!validVerificationId(id) || ids.has(id)) errors.push("delegated_verification_id_invalid");
    ids.add(id);
    if (!verificationRunners.has(entry.runner as DelegatedVerificationRunner)) errors.push("delegated_verification_runner_invalid");
    if (!normalizedCwd(entry.cwd)) errors.push("delegated_verification_cwd_invalid");
    if (!validScriptName(entry.script)) errors.push("delegated_verification_script_invalid");
    if (!Array.isArray(entry.args) || entry.args.length > DELEGATED_VERIFICATION_MAX_ARGS || entry.args.some((argument) => !validArgument(argument))) errors.push("delegated_verification_args_invalid");
    if (!validTimeout(entry.timeout)) errors.push("delegated_verification_timeout_invalid");
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

const canonicalVerificationDirectory = async (input: {
  projectRoot: string;
  relativeCwd: string;
  filesystem: DelegatedVerificationFilesystem;
}) => {
  const lexicalRoot = resolve(input.projectRoot);
  const root = await input.filesystem.realpath(lexicalRoot);
  const lexicalCwd = resolve(lexicalRoot, input.relativeCwd);
  if (!within(lexicalRoot, lexicalCwd)) rejected("delegated_verification_cwd_outside_project");
  let cursor = lexicalRoot;
  for (const segment of input.relativeCwd === "." ? [] : input.relativeCwd.split("/")) {
    cursor = resolve(cursor, segment);
    const entry = await input.filesystem.lstat(cursor);
    if (!entry.isDirectory() || entry.isSymbolicLink()) rejected("delegated_verification_cwd_symlink_or_invalid");
  }
  const cwd = await input.filesystem.realpath(lexicalCwd);
  if (!within(root, cwd)) rejected("delegated_verification_cwd_symlink_escape");
  return { root, cwd, lexicalCwd };
};

const snapshotVerification = async (input: {
  projectRoot: string;
  config: DelegatedVerification;
  filesystem: DelegatedVerificationFilesystem;
}): Promise<DelegatedVerificationSnapshot> => {
  const relativeCwd = normalizedCwd(input.config.cwd);
  if (!relativeCwd) rejected("delegated_verification_cwd_invalid");
  const { root, cwd, lexicalCwd } = await canonicalVerificationDirectory({
    projectRoot: input.projectRoot,
    relativeCwd,
    filesystem: input.filesystem,
  });
  const manifestName = manifestNameFor(input.config.runner);
  const lexicalManifest = resolve(lexicalCwd, manifestName);
  const before = await input.filesystem.lstat(lexicalManifest);
  if (!before.isFile() || before.isSymbolicLink() || before.size > DELEGATED_VERIFICATION_MAX_MANIFEST_BYTES) {
    rejected("delegated_verification_manifest_invalid");
  }
  const manifestPath = await input.filesystem.realpath(lexicalManifest);
  if (!within(root, manifestPath) || relative(cwd, manifestPath) !== manifestName) {
    rejected("delegated_verification_manifest_symlink_escape");
  }
  const content = await input.filesystem.readFile(lexicalManifest, "utf8");
  if (Buffer.byteLength(content, "utf8") > DELEGATED_VERIFICATION_MAX_MANIFEST_BYTES) {
    rejected("delegated_verification_manifest_invalid");
  }
  const after = await input.filesystem.lstat(lexicalManifest);
  const afterPath = await input.filesystem.realpath(lexicalManifest);
  if (!after.isFile() || after.isSymbolicLink() || afterPath !== manifestPath || !sameIdentity(fileIdentity(before), fileIdentity(after))) {
    rejected("delegated_verification_manifest_changed");
  }
  let manifest: unknown;
  try { manifest = JSON.parse(content); } catch { rejected("delegated_verification_manifest_invalid"); }
  if (!object(manifest)) rejected("delegated_verification_manifest_invalid");
  const selectedScript = scriptValue(manifest, input.config);
  if (!selectedScript) rejected("delegated_verification_manifest_script_invalid");
  return Object.freeze({
    id: input.config.id,
    runner: input.config.runner,
    relativeCwd,
    cwd,
    manifestPath,
    manifestHash: hash(content),
    script: input.config.script,
    scriptHash: hash(selectedScript),
    args: Object.freeze([...input.config.args]),
    timeout: input.config.timeout,
    manifestIdentity: Object.freeze(fileIdentity(after)),
  });
};

export async function admitDelegatedVerifications(input: {
  projectRoot: string;
  assignmentCount: number;
  verifications: unknown;
  agent: DelegatedVerificationAgent;
  projectTrusted: boolean;
  filesystem?: DelegatedVerificationFilesystem;
}): Promise<DelegatedVerificationAdmission> {
  const validation = validateDelegatedVerifications({
    verifications: input.verifications,
    agent: input.agent,
  });
  if (!validation.valid) return { admitted: false, error: validation.errors[0] ?? "delegated_verification_invalid" };
  if (input.verifications === undefined) return { admitted: true, snapshots: Object.freeze([]) };
  if (input.assignmentCount !== 1) return { admitted: false, error: "delegated_verification_assignment_count_invalid" };
  if (input.projectTrusted !== true) return { admitted: false, error: "delegated_verification_project_untrusted" };
  const filesystem = input.filesystem ?? verificationFilesystem;
  try {
    const snapshots = await Promise.all((input.verifications as DelegatedVerification[]).map((config) => snapshotVerification({
      projectRoot: input.projectRoot,
      config,
      filesystem,
    })));
    return { admitted: true, snapshots: Object.freeze(snapshots) };
  } catch (error) {
    const code = errorCode(error);
    return {
      admitted: false,
      error: /^delegated_verification_[a-z_]+$/.test(code)
        ? code
        : "delegated_verification_admission_unverifiable",
    };
  }
}

export async function revalidateDelegatedVerificationSnapshot(input: {
  projectRoot: string;
  snapshot: DelegatedVerificationSnapshot;
  filesystem?: DelegatedVerificationFilesystem;
}): Promise<{ valid: true } | { valid: false; error: string }> {
  if (!validSnapshot(input.snapshot)) {
    return { valid: false, error: "delegated_verification_manifest_drift" };
  }
  const filesystem = input.filesystem ?? verificationFilesystem;
  try {
    const current = await snapshotVerification({
      projectRoot: input.projectRoot,
      config: {
        id: input.snapshot.id,
        runner: input.snapshot.runner,
        cwd: input.snapshot.relativeCwd,
        script: input.snapshot.script,
        args: [...input.snapshot.args],
        timeout: input.snapshot.timeout,
      },
      filesystem,
    });
    const unchanged = current.cwd === input.snapshot.cwd
      && current.manifestPath === input.snapshot.manifestPath
      && current.manifestHash === input.snapshot.manifestHash
      && current.scriptHash === input.snapshot.scriptHash
      && sameIdentity(current.manifestIdentity, input.snapshot.manifestIdentity);
    return unchanged ? { valid: true } : { valid: false, error: "delegated_verification_manifest_drift" };
  } catch {
    return { valid: false, error: "delegated_verification_manifest_drift" };
  }
}

export const projectDelegatedVerificationArgv = (snapshot: DelegatedVerificationSnapshot) => snapshot.runner === "npm"
  ? { command: "npm", args: ["run", snapshot.script, "--", ...snapshot.args] }
  : { command: "composer", args: ["run-script", snapshot.script, "--", ...snapshot.args] };

const redactVerificationOutput = (value: string) => value
  .replace(/("(?:api[_ -]?key|apikey|token|authorization|password|passwd|secret|credential)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[redacted]"')
  .replace(
    /\b((?:proxy-)?authorization\s*[:=]\s*)((?:basic|bearer|digest|negotiate|oauth|token|apikey)\b)?[^\r\n]*/gi,
    (_match, header: string, scheme: string | undefined) => `${header}${scheme ? `${scheme} ` : ""}[redacted]`,
  )
  .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
  .replace(/\b(api[_ -]?key|apikey|token|password|passwd|secret|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
  .replace(/\b(authorization)\s*[:=]\s*(?!\[(?:redacted)\]|\b(?:basic|bearer|digest|negotiate|oauth|token|apikey)\b)[^\s,;]+/gi, "$1=[redacted]")
  .replace(/([?&](?:api[_-]?key|token|password|passwd|secret|credential)=)[^&\s]+/gi, "$1[redacted]")
  .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]+\b/g, "[redacted]");

export function boundDelegatedVerificationOutput(stdout: unknown, stderr: unknown) {
  const stdoutText = redactVerificationOutput(string(stdout));
  const stderrText = redactVerificationOutput(string(stderr));
  const output = [
    stdoutText ? `stdout:\n${stdoutText}` : "",
    stderrText ? `stderr:\n${stderrText}` : "",
  ].filter(Boolean).join("\n\n") || "(no output)";
  const full = truncateTail(output, {
    maxLines: DELEGATED_VERIFICATION_OUTPUT_MAX_LINES,
    maxBytes: DELEGATED_VERIFICATION_OUTPUT_MAX_BYTES,
  });
  if (!full.truncated) {
    return {
      output: full.content,
      truncated: false,
      outputBytes: full.totalBytes,
      outputLines: full.totalLines,
    };
  }
  const body = truncateTail(output, {
    maxLines: Math.max(1, DELEGATED_VERIFICATION_OUTPUT_MAX_LINES - 1),
    maxBytes: Math.max(1, DELEGATED_VERIFICATION_OUTPUT_MAX_BYTES - outputTruncationNoticeBytes - 1),
  });
  return {
    output: body.content ? `${body.content}\n${outputTruncationNotice}` : outputTruncationNotice,
    truncated: true,
    outputBytes: full.totalBytes,
    outputLines: full.totalLines,
  };
}

const validToolInput = (value: unknown): value is { id: unknown } => object(value)
  && Object.keys(value).length === 1
  && Object.hasOwn(value, "id")
  && validVerificationId(value.id);

const validExecutorResult = (value: unknown): value is Awaited<ReturnType<DelegatedVerificationExecutor>> => object(value)
  && typeof value.stdout === "string"
  && typeof value.stderr === "string"
  && Number.isSafeInteger(value.code)
  && value.code >= 0
  && value.code <= 255
  && typeof value.killed === "boolean";

const unsafeFailure = (code: string, onUnsafe: ((reason: string) => void) | undefined): never => {
  safely(() => onUnsafe?.(code));
  return rejected(code);
};

export async function executeDelegatedVerification(input: {
  id: unknown;
  projectRoot: string;
  snapshots: readonly DelegatedVerificationSnapshot[];
  executor: DelegatedVerificationExecutor;
  signal?: AbortSignal;
  filesystem?: DelegatedVerificationFilesystem;
  timer?: DelegatedVerificationTimer;
  onUnsafe?: (reason: string) => void;
  onExecutionStart?: () => void;
  onExecutionSettled?: () => void;
}): Promise<DelegatedVerificationExecution> {
  const id = string(input.id);
  if (!validVerificationId(id)) rejected("delegated_verification_id_invalid");
  const matching = input.snapshots.filter((snapshot) => snapshot.id === id);
  if (matching.length !== 1) rejected("delegated_verification_id_unavailable");
  const snapshot = matching[0];
  if (!snapshot) rejected("delegated_verification_id_unavailable");
  const revalidated = await revalidateDelegatedVerificationSnapshot({
    projectRoot: input.projectRoot,
    snapshot,
    filesystem: input.filesystem,
  });
  if (!revalidated.valid) rejected(revalidated.error);
  if (input.signal?.aborted) unsafeFailure("delegated_verification_cancelled", input.onUnsafe);

  const timeout = new AbortController();
  const timer = input.timer ?? verificationTimer;
  let unsafeReason: string | null = null;
  let resolveUnsafe: () => void = () => undefined;
  const unsafe = new Promise<void>((resolve) => { resolveUnsafe = () => resolve(); });
  const latchUnsafe = (reason: string) => {
    if (unsafeReason) return;
    unsafeReason = reason;
    safely(() => input.onUnsafe?.(reason));
    resolveUnsafe();
  };
  const onCancellation = () => { latchUnsafe("delegated_verification_cancelled"); };
  input.signal?.addEventListener("abort", onCancellation, { once: true });
  const timeoutId = timer.schedule(() => {
    latchUnsafe("delegated_verification_timeout");
    timeout.abort();
  }, snapshot.timeout);
  const stopWatching = () => {
    safely(() => timer.cancel(timeoutId));
    input.signal?.removeEventListener("abort", onCancellation);
  };
  let executionSettled = false;
  const markExecutionSettled = () => {
    if (executionSettled) return;
    executionSettled = true;
    safely(input.onExecutionSettled);
  };
  const signal = input.signal ? AbortSignal.any([input.signal, timeout.signal]) : timeout.signal;
  const argv = projectDelegatedVerificationArgv(snapshot);
  safely(input.onExecutionStart);
  if (unsafeReason) {
    stopWatching();
    return rejected(unsafeReason);
  }

  type ExecutionSettlement =
    | { state: "fulfilled"; result: Awaited<ReturnType<DelegatedVerificationExecutor>> }
    | { state: "rejected" };
  let observedExecution: Promise<ExecutionSettlement>;
  try {
    observedExecution = Promise.resolve(input.executor(argv.command, [...argv.args], {
      cwd: snapshot.cwd,
      signal,
      timeout: snapshot.timeout,
    })).then(
      (result) => ({ state: "fulfilled" as const, result }),
      () => ({ state: "rejected" as const }),
    );
  } catch {
    observedExecution = Promise.resolve({ state: "rejected" as const });
  }

  const first = await Promise.race([
    observedExecution.then((settlement) => ({ state: "settled" as const, settlement })),
    unsafe.then(() => ({ state: "unsafe" as const })),
  ]);
  if (input.signal?.aborted) latchUnsafe("delegated_verification_cancelled");
  if (timeout.signal.aborted) latchUnsafe("delegated_verification_timeout");
  const reason = unsafeReason;
  if (reason) {
    stopWatching();
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanupDeadline = new Promise<void>((resolve) => {
      cleanupTimer = timer.schedule(resolve, DELEGATED_VERIFICATION_CLEANUP_TIMEOUT_MS);
    });
    const cleanup = await Promise.race([
      observedExecution.then((settlement) => ({ state: "settled" as const, settlement })),
      cleanupDeadline.then(() => ({ state: "deadline" as const })),
    ]);
    if (cleanupTimer !== undefined) safely(() => timer.cancel(cleanupTimer!));
    if (cleanup.state === "settled") {
      markExecutionSettled();
      return rejected(reason);
    }
    safely(() => input.onUnsafe?.("delegated_verification_process_cleanup_unverified"));
    return rejected("delegated_verification_process_cleanup_unverified");
  }

  stopWatching();
  markExecutionSettled();
  if (first.state !== "settled") unsafeFailure("delegated_verification_process_uncertain", input.onUnsafe);
  if (first.settlement.state === "rejected") unsafeFailure("delegated_verification_process_uncertain", input.onUnsafe);
  const result = first.settlement.result;
  if (!validExecutorResult(result)) unsafeFailure("delegated_verification_process_uncertain", input.onUnsafe);
  if (result.killed) unsafeFailure("delegated_verification_process_cleanup_unverified", input.onUnsafe);
  const output = boundDelegatedVerificationOutput(result.stdout, result.stderr);
  return {
    id: snapshot.id,
    status: result.code === 0 ? "passed" : "failed",
    exitCode: result.code,
    output: output.output,
    outputTruncated: output.truncated,
    outputBytes: output.outputBytes,
    outputLines: output.outputLines,
  };
}

export const delegatedVerificationToolParameters = Type.Object({
  id: Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: DELEGATED_VERIFICATION_ID_PATTERN.source,
    description: "Parent-minted verification identifier.",
  }),
}, { additionalProperties: false });

export function createDelegatedVerificationTool(input: {
  projectRoot: string;
  snapshots: readonly DelegatedVerificationSnapshot[];
  executor: DelegatedVerificationExecutor;
  queue: <Value>(effect: () => Promise<Value>) => Promise<Value>;
  filesystem?: DelegatedVerificationFilesystem;
  timer?: DelegatedVerificationTimer;
  onUnsafe?: (reason: string) => void;
  onExecutionStart?: () => void;
  onExecutionSettled?: () => void;
}): ToolDefinition {
  return {
    name: "test",
    label: "Run approved verification",
    description: `Run one parent-approved project verification by its identifier. Available ids: ${input.snapshots.map((snapshot) => snapshot.id).join(", ")}. Input accepts only an approved id.`,
    parameters: delegatedVerificationToolParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, parameters, signal) => input.queue(async () => {
      const toolInput = parameters as unknown;
      if (!validToolInput(toolInput)) rejected("delegated_verification_input_invalid");
      const outcome = await executeDelegatedVerification({
        id: toolInput.id,
        projectRoot: input.projectRoot,
        snapshots: input.snapshots,
        executor: input.executor,
        signal,
        filesystem: input.filesystem,
        timer: input.timer,
        onUnsafe: input.onUnsafe,
        onExecutionStart: input.onExecutionStart,
        onExecutionSettled: input.onExecutionSettled,
      });
      return {
        content: [{
          type: "text" as const,
          text: `Verification ${outcome.id}: ${outcome.status} (exit ${outcome.exitCode})\n${outcome.output}`,
        }],
        details: {
          id: outcome.id,
          status: outcome.status,
          exitCode: outcome.exitCode,
          output: outcome.output,
          outputTruncated: outcome.outputTruncated,
          outputBytes: outcome.outputBytes,
          outputLines: outcome.outputLines,
        },
      };
    }),
  };
}
