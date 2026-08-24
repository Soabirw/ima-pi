export const LIFECYCLE_PHASES = ["plan", "implementation", "test", "review", "resolution", "rereview", "decision", "closeout"] as const;
export type LifecyclePhase = typeof LIFECYCLE_PHASES[number];
export type LifecycleIdentity = { project: string; lifecycleKey: string; lifecycleRootMemoryId: string; taskwarriorProject: string; taskwarriorTask: string; taskwarriorUuid: string; jiraKey: string; sourceRefs: string[]; priorArtifactIds: string[] };
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const REDACTED = "[redacted]";
const clean = (value: unknown) => typeof value === "string" ? value.replace(/(?:authorization|token|secret|password)\s*[:=]\s*\S+/gi, (match) => match.length < REDACTED.length ? "*".repeat(match.length) : REDACTED) : "";
const HTML_COMMENT_START = "<!--";
const HTML_COMMENT_END = "-->";
const LIFECYCLE_VERIFICATION_COMMENT = /^\s*ima-lifecycle verification:/;
const LIFECYCLE_MARKER_NONCE = /nonce=[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
const LIFECYCLE_MARKER_OUTCOME = /outcome=completed/;
const EMBEDDED_LIFECYCLE_FRONT_MATTER =
  /(?:^|\r?\n)---\r?\nlifecycle:\r?\n  project: '[^\r\n]*'\r?\n  lifecycle_key: '[^\r\n]*'/;
const LIFECYCLE_ERROR_MESSAGES: Record<string, string> = {
  lifecycle_artifact_embeds_prior_artifact: "Lifecycle artifact embeds a prior artifact. Reference prior IDs in prior_artifact_ids or source_refs instead of pasting content.",
};
const hasPersistedLifecycleMarker = (artifact: string) => {
  let commentStart = artifact.indexOf(HTML_COMMENT_START);
  while (commentStart >= 0) {
    const contentStart = commentStart + HTML_COMMENT_START.length;
    const commentEnd = artifact.indexOf(HTML_COMMENT_END, contentStart);
    if (commentEnd < 0) return false;

    const comment = artifact.slice(contentStart, commentEnd);
    if (
      LIFECYCLE_VERIFICATION_COMMENT.test(comment)
      && LIFECYCLE_MARKER_NONCE.test(comment)
      && LIFECYCLE_MARKER_OUTCOME.test(comment)
    ) return true;

    commentStart = artifact.indexOf(HTML_COMMENT_START, commentEnd + HTML_COMMENT_END.length);
  }
  return false;
};
const embedsPriorLifecycleArtifact = (artifact: string) =>
  hasPersistedLifecycleMarker(artifact) || EMBEDDED_LIFECYCLE_FRONT_MATTER.test(artifact);
export function sanitizeLifecycleError(code: string, _value: unknown) {
  const message = Object.hasOwn(LIFECYCLE_ERROR_MESSAGES, code)
    ? LIFECYCLE_ERROR_MESSAGES[code]
    : `Lifecycle integration failed: ${code}.`;
  return { code, message };
}
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const validIdentity = (value: unknown): value is LifecycleIdentity => {
  const identity = object(value);
  return Boolean(
    identity
    && ["project", "lifecycleKey"].every((key) => text(identity[key]).length > 0)
    && ["lifecycleRootMemoryId", "taskwarriorProject", "taskwarriorTask", "taskwarriorUuid", "jiraKey"]
      .every((key) => typeof identity[key] === "string")
    && isStringArray(identity.sourceRefs)
    && isStringArray(identity.priorArtifactIds),
  );
};
export function validateLifecycleRequest(value: unknown): { valid: true; type: LifecyclePhase; identity: LifecycleIdentity; artifact: string } | { valid: false; error: ReturnType<typeof sanitizeLifecycleError> } {
 const input = object(value); const type = text(input?.type); const rawArtifact = typeof input?.artifact === "string" ? input.artifact : "";
 if (!input || !LIFECYCLE_PHASES.includes(type as LifecyclePhase) || !validIdentity(input.identity) || rawArtifact.length > 128_000) return { valid: false, error: sanitizeLifecycleError("invalid_lifecycle_request", value) };
 if (embedsPriorLifecycleArtifact(rawArtifact)) return { valid: false, error: sanitizeLifecycleError("lifecycle_artifact_embeds_prior_artifact", value) };
 const artifact = clean(rawArtifact);
 if (artifact.length > 128_000 || !text(artifact)) return { valid: false, error: sanitizeLifecycleError("invalid_lifecycle_request", value) };
 return { valid: true, type: type as LifecyclePhase, identity: input.identity as LifecycleIdentity, artifact };
}
export function buildLifecycleNonceMarker(input: { lifecycleKey: string; nonce: string; type: LifecyclePhase; jiraKey: string; taskwarriorUuid: string }) { return `<!-- ima-lifecycle verification: lifecycle_key=${input.lifecycleKey}; nonce=${input.nonce}; phase=${input.type}; jira_key=${input.jiraKey}; taskwarrior_uuid=${input.taskwarriorUuid}; outcome=completed -->`; }
const quoted = (value: string) => `'${value.replace(/'/g, "''")}'`;
export function buildLifecycleArtifact(input: { type: LifecyclePhase; identity: LifecycleIdentity; artifact: string; nonce: string }) {
 const i = input.identity;
 const refs = (key: string, values: string[]) => values.length ? `${key}:\n${values.map((value) => `    - ${quoted(value)}`).join("\n")}` : `${key}: []`;
 return `---\nlifecycle:\n  project: ${quoted(i.project)}\n  lifecycle_key: ${quoted(i.lifecycleKey)}\n  lifecycle_root_memory_id: ${quoted(i.lifecycleRootMemoryId)}\n  taskwarrior_project: ${quoted(i.taskwarriorProject)}\n  taskwarrior_task: ${quoted(i.taskwarriorTask)}\n  taskwarrior_uuid: ${quoted(i.taskwarriorUuid)}\n  jira_key: ${quoted(i.jiraKey)}\n  ${refs("source_refs", i.sourceRefs)}\n  phase: ${quoted(input.type)}\n  ${refs("prior_artifact_ids", i.priorArtifactIds)}\n---\n\n${input.artifact.trim()}\n\n${buildLifecycleNonceMarker({ lifecycleKey: i.lifecycleKey, nonce: input.nonce, type: input.type, jiraKey: i.jiraKey, taskwarriorUuid: i.taskwarriorUuid })}\n`;
}
const FAILURE_STATUSES = new Set(["failed", "failure", "error"]);

const mcpResultText = (value: unknown) =>
  Array.isArray(value)
    ? value
      .map(object)
      .map((item) => item?.type === "text" ? text(item.text) : "")
      .filter(Boolean)
      .join("\n")
    : "";

const mcpResultData = (result: unknown): Record<string, unknown> | null => {
  const value = object(result);
  const structuredContent = object(value?.structuredContent);
  if (structuredContent) return structuredContent;

  const content = mcpResultText(value?.content);
  if (!content) return null;

  try {
    return object(JSON.parse(content));
  } catch {
    return null;
  }
};

const explicitFalse = (value: unknown) =>
  value === false || text(value).toLowerCase() === "false";

const hasErrorPayload = (value: unknown) =>
  value !== undefined && value !== null && value !== false && value !== "";

const receiptHasFailure = (data: Record<string, unknown> | null) =>
  [data?.stored, data?.success, data?.created].some(explicitFalse)
  || FAILURE_STATUSES.has(text(data?.status).toLowerCase())
  || hasErrorPayload(data?.error);

export function validateVestigeSaveReceipt(result: unknown, _expectedType: LifecyclePhase) {
  const callResult = object(result);
  const data = mcpResultData(result);
  const artifactId = text(data?.id) || text(data?.memoryId) || null;
  const positiveData = data?.stored === true
    || data?.success === true
    || data?.created === true;
  const accepted = callResult?.isError !== true
    && data !== null
    && !receiptHasFailure(data)
    && (positiveData || Boolean(artifactId));

  return { accepted, artifactId: accepted ? artifactId : null };
}

const strings = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];

const unmatchedSemanticRecall = () => ({
  matched: false,
  lifecycleKeyMatched: false,
  nonceMatched: false,
  phaseMatched: false,
  sourceIdentityMatched: false,
  outcomeMatched: false,
  physicalShapeIgnored: true as const,
});

export function evaluateLifecycleRecall(input: {
  envelope: unknown;
  lifecycleKey: string;
  nonce: string;
  type: LifecyclePhase;
  jiraKey: string;
  taskwarriorUuid: string;
}) {
  if (object(input.envelope)?.isError === true) return unmatchedSemanticRecall();

  const data = mcpResultData(input.envelope);
  const results = Array.isArray(data?.results) ? data.results : [];
  const requiredSources = [input.jiraKey, input.taskwarriorUuid]
    .filter((value) => text(value));
  const hasCompletedOutcome = (value: string) => /\boutcome\s*=\s*completed\b/i.test(value);
  const hasExpectedPhaseMarker = (value: string) =>
    value.includes(`phase=${input.type};`);
  const matches = (value: string) =>
    value.includes(input.lifecycleKey)
    && value.includes(input.nonce)
    && hasExpectedPhaseMarker(value)
    && requiredSources.every((source) => value.includes(source))
    && hasCompletedOutcome(value);
  const matchedValue = results
    .map((result) => strings(result).join("\n"))
    .find(matches);

  if (!matchedValue) return unmatchedSemanticRecall();

  return {
    matched: true,
    lifecycleKeyMatched: true,
    nonceMatched: true,
    phaseMatched: true,
    sourceIdentityMatched: true,
    outcomeMatched: true,
    physicalShapeIgnored: true as const,
  };
}
export function deriveLifecycleResult(input: { type: LifecyclePhase; lifecycleKey: string; receipt: ReturnType<typeof validateVestigeSaveReceipt>; recall: ReturnType<typeof evaluateLifecycleRecall>; error?: string }) { const completed = input.receipt.accepted && input.recall.matched && !input.error; return { schemaVersion: 1, status: completed ? "completed" as const : "failed" as const, phase: input.type, lifecycleKey: input.lifecycleKey, artifactId: input.receipt.artifactId, receiptAccepted: input.receipt.accepted, semanticRecall: input.recall, error: completed ? null : sanitizeLifecycleError(input.error ?? (!input.receipt.accepted ? "vestige_receipt_invalid" : "vestige_semantic_completion_unverified"), "") }; }
