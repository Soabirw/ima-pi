import { Buffer } from "node:buffer";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  IMA_PROJECT,
  buildFinalCloseoutArtifact,
  cycleSourceReference,
  parseJiraTracker,
  parsePlaneCurrentWorkItem,
  parsePlaneStateMutation,
  parsePlaneWorkflowStates,
  parseTaskwarriorTracker,
  requiredCloseoutEvidence,
  sanitizeCycleError,
  type CycleSource,
  type CycleState,
} from "./ima-cycle.ts";
import type { LifecycleIdentity } from "./ima-lifecycle.ts";

const JIRA_HELPER = join(homedir(), ".agents", "skills", "mcp-atlassian", "scripts", "atlassian-api.mjs");
const PLANE_HELPER = fileURLToPath(new URL("../skills/plane-api/scripts/plane-api.mjs", import.meta.url));
const MAX_PLANE_HELPER_OUTPUT_BYTES = 128 * 1024;

export type CycleCloseInput = {
  state: CycleState;
  mode: string;
  commitPrep: boolean;
  confirmed?: boolean;
  run: (program: string, args: string[]) => Promise<unknown>;
  lifecycle?: (request: { type: "closeout"; identity: LifecycleIdentity; summary: string; artifact: string }) => Promise<{ status?: string; [key: string]: unknown }>;
  identity?: LifecycleIdentity;
  appendState: (state: CycleState) => void | Promise<void>;
  timestamp?: string;
};

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const copyState = (state: CycleState): CycleState => structuredClone(state);
const nowIso = () => new Date().toISOString();
const safeError = (code: string) => ({ ok: false as const, error: sanitizeCycleError(code) });
const execPayload = (value: unknown): unknown => {
  const result = object(value);
  if (!result) return value;
  if (typeof result.stdout === "string") {
    try {
      return JSON.parse(result.stdout);
    } catch {
      return result.stdout;
    }
  }
  return value;
};
const planePayload = (value: unknown): unknown | null => {
  const result = object(value);
  if (!result || typeof result.stdout !== "string" || Buffer.byteLength(result.stdout, "utf8") > MAX_PLANE_HELPER_OUTPUT_BYTES) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
};
const execSucceeded = (value: unknown) => {
  const result = object(value);
  if (!result) return false;
  if (typeof result.code === "number") return result.code === 0;
  return result.ok === true || result.success === true;
};
const sameLifecycleIdentity = (state: CycleState, identityValue: unknown): boolean => {
  const identity = object(identityValue);
  if (!identity || text(identity.project) !== IMA_PROJECT || text(identity.lifecycleKey) !== state.lifecycleKey) return false;
  if (state.source.type === "jira") return text(identity.jiraKey) === state.source.key;
  if (state.source.type === "taskwarrior") {
    return text(identity.taskwarriorProject) === state.source.project
      && text(identity.taskwarriorUuid) === state.source.uuid;
  }
  return text(identity.jiraKey) === ""
    && text(identity.taskwarriorProject) === ""
    && text(identity.taskwarriorTask) === ""
    && text(identity.taskwarriorUuid) === ""
    && text(identity.planeWorkspace) === state.source.workspace
    && text(identity.planeWorkItem) === `${state.source.project}-${state.source.sequenceId}`;
};

export const identityForCycleSource = (state: CycleState): LifecycleIdentity => {
  const priorArtifactIds = [...new Set(state.evidence.flatMap((item) => [
    ...(item.artifactId ? [item.artifactId] : []),
    ...(item.approvedPlan ? [item.approvedPlan.artifactId] : []),
  ]))];
  if (state.source.type === "jira") {
    return { project: IMA_PROJECT, lifecycleKey: state.lifecycleKey, lifecycleRootMemoryId: "", taskwarriorProject: "", taskwarriorTask: "", taskwarriorUuid: "", jiraKey: state.source.key, sourceRefs: [`Jira:${state.source.key}`], priorArtifactIds };
  }
  if (state.source.type === "taskwarrior") {
    return { project: IMA_PROJECT, lifecycleKey: state.lifecycleKey, lifecycleRootMemoryId: "", taskwarriorProject: state.source.project, taskwarriorTask: state.source.uuid, taskwarriorUuid: state.source.uuid, jiraKey: "", sourceRefs: [`Taskwarrior:${state.source.project}:${state.source.uuid}`], priorArtifactIds };
  }
  const planeWorkItem = `${state.source.project}-${state.source.sequenceId}`;
  return {
    project: IMA_PROJECT,
    lifecycleKey: state.lifecycleKey,
    lifecycleRootMemoryId: "",
    taskwarriorProject: "",
    taskwarriorTask: "",
    taskwarriorUuid: "",
    jiraKey: "",
    planeWorkspace: state.source.workspace,
    planeWorkItem,
    sourceRefs: [cycleSourceReference(state.source)],
    priorArtifactIds,
  };
};

const closePlaneTracker = async (
  source: Extract<CycleSource, { type: "plane" }>,
  run: CycleCloseInput["run"],
): Promise<{ ok: true } | { ok: false; code: string }> => {
  const reference = cycleSourceReference(source);
  let currentResult: unknown;
  try {
    currentResult = await run("node", [PLANE_HELPER, "plane:get", reference]);
  } catch {
    return { ok: false, code: "tracker_read_failed" };
  }
  if (!execSucceeded(currentResult)) return { ok: false, code: "tracker_read_failed" };
  const current = parsePlaneCurrentWorkItem(planePayload(currentResult), source);
  if (!current.valid) return { ok: false, code: current.error.code };

  let statesResult: unknown;
  try {
    statesResult = await run("node", [PLANE_HELPER, "plane:states", reference]);
  } catch {
    return { ok: false, code: "tracker_read_failed" };
  }
  if (!execSucceeded(statesResult)) return { ok: false, code: "tracker_read_failed" };
  const workflow = parsePlaneWorkflowStates(planePayload(statesResult), source, current.workItem);
  if (!workflow.valid) return { ok: false, code: workflow.error.code };

  let mutationResult: unknown;
  try {
    mutationResult = await run("node", [PLANE_HELPER, "plane:set-state", reference, workflow.completedState.id]);
  } catch {
    return { ok: false, code: "tracker_close_failed" };
  }
  if (!execSucceeded(mutationResult)) return { ok: false, code: "tracker_close_failed" };
  const mutation = parsePlaneStateMutation(planePayload(mutationResult), source, current.workItem, workflow.completedState.id);
  return mutation.valid ? { ok: true } : { ok: false, code: mutation.error.code };
};

export async function coordinateCycleClose(input: CycleCloseInput): Promise<{ ok: true; state?: CycleState; commitPrep?: { status: string; diffCheck: string; gitStatus: string }; message: string } | { ok: false; error: ReturnType<typeof sanitizeCycleError>; state?: CycleState }> {
  if (input.commitPrep) {
    let status: unknown;
    let diffCheck: unknown;
    try {
      [status, diffCheck] = await Promise.all([input.run("git", ["status", "--short"]), input.run("git", ["diff", "--check"])]);
    } catch {
      return safeError("commit_prep_failed");
    }
    if (!execSucceeded(status) || !execSucceeded(diffCheck)) return safeError("commit_prep_failed");
    return {
      ok: true,
      commitPrep: {
        status: "read-only",
        gitStatus: text(object(status)?.stdout),
        diffCheck: text(object(diffCheck)?.stdout),
      },
      message: "Read-only commit preparation completed.",
    };
  }
  if (input.mode !== "tui") return { ...safeError("close_requires_tui"), state: input.state };
  if (!requiredCloseoutEvidence(input.state).valid) return { ...safeError("closeout_evidence_missing"), state: input.state };
  if (input.confirmed !== true) return { ...safeError("close_confirmation_required"), state: input.state };
  const state = input.state;
  const identity = input.identity ?? identityForCycleSource(state);
  if (!sameLifecycleIdentity(state, identity)) return { ...safeError("lifecycle_identity_mismatch"), state };
  if (state.source.type === "plane") {
    const closed = await closePlaneTracker(state.source, input.run);
    if (!closed.ok) return { ...safeError(closed.code), state };
  } else {
    let tracker: unknown;
    try {
      const trackerResult = state.source.type === "jira"
        ? await input.run("node", [JIRA_HELPER, "jira:transitions", state.source.key])
        : await input.run("task", ["rc.verbose=nothing", `project:${state.source.project}`, state.source.uuid, "export"]);
      if (object(trackerResult) && !execSucceeded(trackerResult)) return { ...safeError("tracker_read_failed"), state };
      tracker = execPayload(trackerResult);
    } catch {
      return { ...safeError("tracker_read_failed"), state };
    }
    let transitionId = "";
    if (state.source.type === "jira") {
      const parsed = parseJiraTracker(tracker);
      if (!parsed.valid || (parsed.key && parsed.key !== state.source.key) || parsed.doneTransitions.length !== 1) {
        return { ...safeError(parsed.valid ? "jira_done_transition_ambiguous" : parsed.error.code), state };
      }
      transitionId = parsed.doneTransitions[0].id;
    } else {
      const parsed = parseTaskwarriorTracker(tracker, state.source);
      if (!parsed.valid) return { ...safeError(parsed.error.code), state };
    }
    let mutation: unknown;
    try {
      mutation = state.source.type === "jira"
        ? await input.run("node", [JIRA_HELPER, "jira:transition", state.source.key, transitionId])
        : await input.run("task", ["rc.verbose=nothing", `project:${state.source.project}`, state.source.uuid, "done"]);
    } catch {
      return { ...safeError("tracker_close_failed"), state };
    }
    if (!execSucceeded(mutation)) return { ...safeError("tracker_close_failed"), state };
  }
  const artifact = buildFinalCloseoutArtifact(state, { identity });
  let persisted: { status?: string; [key: string]: unknown };
  try {
    persisted = input.lifecycle
      ? await input.lifecycle({ type: "closeout", identity, summary: "Cycle closeout verified after tracker completion.", artifact })
      : { status: "failed" };
  } catch {
    persisted = { status: "failed" };
  }
  const success = persisted.status === "completed";
  const next: CycleState = {
    ...copyState(state),
    status: success ? "closed" : "blocked-after-tracker-close",
    trackerClosed: true,
    blockers: success ? [] : ["lifecycle_closeout_failed"],
    updatedAt: input.timestamp ?? nowIso(),
  };
  await input.appendState(copyState(next));
  return success
    ? { ok: true, state: next, message: "Tracker closed and lifecycle closeout verified." }
    : { ...safeError("lifecycle_closeout_failed"), state: next };
}
