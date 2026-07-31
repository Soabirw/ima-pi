import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSession, ModelRuntime, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const STORY = "FNR-3012";
export const SCHEMA_VERSION = 1;
export const RESULT_ENV_VAR = "IMA_PI_VISION_RESULT";
export const CHILD_TIMEOUT_MS = 60_000;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const CHILD_EXECUTION_TIMEOUT = Symbol("child_execution_timeout");
export const USAGE = "usage: /ima:vision-probe <provider>/<model> <absolute-image-path>";
const MAX_RESPONSE_BYTES = 32_000;
const MAX_ITEMS = 20;
const MAX_TEXT_LENGTH = 1_000;

export type ModelIdentity = { provider: string; model: string };
export type ProbeError = { code: string; message: string };
type VisionResponse = { schemaVersion: number; image: { id: string; sourceLabel: string }; observations: string[]; extractedText: string[]; limitations: string[]; uncertainty: string[]; scope: { visualEvidenceOnly: boolean; implementationDecisionMade: boolean } };
export type ImageInfo = { id: string; sourceLabel: string; mimeType: string; byteLength: number; accessible: boolean; delivered: boolean };
type DeliverySession = { model?: { provider: string; id: string } | null; prompt: (brief: string, options: { images: { type: "image"; data: string; mimeType: string }[]; expandPromptTemplates: boolean }) => Promise<unknown>; waitForIdle: () => Promise<unknown> };

export function parseModelSelector(value: unknown) {
  const input = typeof value === "string" ? value.trim() : "";
  const slash = input.indexOf("/");
  const provider = slash > 0 ? input.slice(0, slash).trim() : "";
  const model = slash > 0 ? input.slice(slash + 1).trim() : "";
  return provider && model ? { valid: true as const, provider, model } : { valid: false as const };
}

export function parseVisionProbeArgs(value: unknown) {
  const match = typeof value === "string" ? value.match(/^\s*(\S+)\s+(?:"([^"\n]+)"|'([^'\n]+)'|(\S+))\s*$/) : null;
  const selectorToken = match?.[1];
  const imagePath = match?.[2] ?? match?.[3] ?? match?.[4];
  if (!selectorToken || !imagePath || !isAbsolute(imagePath)) return { error: "invalid_arguments", message: USAGE };
  const selector = parseModelSelector(selectorToken);
  return selector.valid ? { provider: selector.provider, model: selector.model, imagePath } : { error: "invalid_arguments", message: USAGE };
}

export function supportsImageInput(model: unknown): boolean {
  return !!model && typeof model === "object" && Array.isArray((model as { input?: unknown }).input) && (model as { input: unknown[] }).input.includes("image");
}

export function classifyImage(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 6 && (String.fromCharCode(...bytes.slice(0, 6)) === "GIF87a" || String.fromCharCode(...bytes.slice(0, 6)) === "GIF89a")) return "image/gif";
  return null;
}

export function imageSizeError(size: number): "image_empty" | "image_too_large" | null {
  return size === 0 ? "image_empty" : size > MAX_IMAGE_BYTES ? "image_too_large" : null;
}

export function extensionMatchesMime(path: string, mimeType: string): boolean {
  const extension = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const expected: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
  return !extension || !expected[extension] || expected[extension] === mimeType;
}

export function buildVisionBrief(input: { imageId: string; sourceLabel: string }): string {
  return [
    "Analyze only the attached image. You have no tools; do not claim tool use.",
    "Report concrete visible facts and exact visible copy only. Distinguish uncertainty and do not infer hidden details.",
    "Make no implementation, testing, review, or lifecycle decision.",
    `Echo image.id exactly as ${input.imageId} and image.sourceLabel exactly as ${input.sourceLabel}.`,
    "Return exactly one JSON object, no markdown or prose, with schemaVersion 1, image, observations, extractedText, limitations, uncertainty, and scope.",
    "scope.visualEvidenceOnly must be true and scope.implementationDecisionMade must be false. Do not include paths, bytes, secrets, or unrelated analysis.",
  ].join("\n");
}

function boundedStrings(value: unknown, required = false): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null;
  if (required && value.length === 0) return null;
  return value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= MAX_TEXT_LENGTH) ? value : null;
}

export function parseVisionResponse(value: unknown): { value?: unknown; error?: string } {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_RESPONSE_BYTES) return { error: "response_invalid_json" };
  const direct = value.trim();
  const match = direct.match(/^```json\s*([\s\S]*?)\s*```$/i);
  const candidate = match ? match[1] : direct;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { value: parsed } : { error: "response_invalid_json" };
  } catch { return { error: "response_invalid_json" }; }
}

export function validateVisionResponse(value: unknown, identity: { id: string; sourceLabel: string }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false as const, error: "response_schema_invalid" };
  const body = value as Partial<VisionResponse>;
  if (body.schemaVersion !== SCHEMA_VERSION || !body.image || body.image.id !== identity.id || body.image.sourceLabel !== identity.sourceLabel) return { valid: false as const, error: "image_identity_mismatch" };
  const observations = boundedStrings(body.observations, true);
  const extractedText = boundedStrings(body.extractedText);
  const limitations = boundedStrings(body.limitations);
  const uncertainty = boundedStrings(body.uncertainty);
  if (!observations || !extractedText || !limitations || !uncertainty || body.scope?.visualEvidenceOnly !== true || body.scope?.implementationDecisionMade !== false) return { valid: false as const, error: "response_schema_invalid" };
  return { valid: true as const, response: body as VisionResponse };
}

export function sanitizeError(code: string, _detail?: unknown): ProbeError {
  const messages: Record<string, string> = {
    invalid_arguments: USAGE, image_not_found: "image was not found", image_not_regular_file: "image is not a regular file", image_empty: "image is empty", image_too_large: "image exceeds the 20 MiB limit", image_unsupported: "image format is unsupported", image_read_failed: "image could not be read", image_processing_failed: "image could not be prepared", child_model_not_found: "requested child model was not found", child_model_unauthenticated: "requested child model is not authenticated", child_model_not_vision_capable: "requested child model does not advertise image input", child_creation_failed: "child session could not be created", child_execution_timeout: "child session timed out", child_execution_failed: "child session failed", child_identity_mismatch: "child identity did not match request", response_missing: "child returned no response", response_invalid_json: "child response was not valid JSON", response_schema_invalid: "child response did not match schema", image_identity_mismatch: "child image identity did not match", visual_evidence_incomplete: "child visual evidence was incomplete", result_write_failed: "sanitized result could not be written",
  };
  return { code, message: messages[code] ?? "vision probe failed" };
}

export function childIdentityMatches(requested: ModelIdentity, actual: ModelIdentity | null): boolean {
  return actual?.provider === requested.provider && actual.model === requested.model;
}

export function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(CHILD_EXECUTION_TIMEOUT), timeoutMs); });
  return Promise.race([promise, deadline]).finally(() => { if (timer) clearTimeout(timer); });
}

export function childExecutionErrorCode(error: unknown): "child_execution_timeout" | "child_execution_failed" {
  return error === CHILD_EXECUTION_TIMEOUT ? "child_execution_timeout" : "child_execution_failed";
}

export async function deliverImageToVerifiedSession(input: { requested: ModelIdentity; session: DeliverySession; source: ImageInfo; bytes: Buffer }) {
  const actual = input.session.model ? { provider: input.session.model.provider, model: input.session.model.id } : null;
  if (!childIdentityMatches(input.requested, actual)) return { actual, source: input.source, error: sanitizeError("child_identity_mismatch") };
  const attachment = { type: "image" as const, data: input.bytes.toString("base64"), mimeType: input.source.mimeType };
  const source = { ...input.source, delivered: true };
  await withDeadline(input.session.prompt(buildVisionBrief(source), { images: [attachment], expandPromptTemplates: false }).then(() => input.session.waitForIdle()), CHILD_TIMEOUT_MS);
  return { actual, source, error: null };
}

export function deriveVisionProbeResult(input: { requested: ModelIdentity; actual: ModelIdentity | null; sessionId: string; sessionFile: string; image: ImageInfo; providerCompleted: boolean; parsed: boolean; validated: ReturnType<typeof validateVisionResponse>; error?: ProbeError | null }) {
  const response = input.validated.valid ? input.validated.response : null;
  const exactModel = childIdentityMatches(input.requested, input.actual);
  const checks = { responseParsed: input.parsed, schema: input.validated.valid, imageIdentity: input.validated.valid, observations: !!response?.observations.length, limitationsField: !!response, evidenceOnlyScope: response?.scope.visualEvidenceOnly === true, noImplementationDecision: response?.scope.implementationDecisionMade === false, exactModel, session: Boolean(input.sessionId && isAbsolute(input.sessionFile)) };
  const passed = !input.error && input.image.accessible && input.image.delivered && input.providerCompleted && Object.values(checks).every(Boolean);
  return { schemaVersion: SCHEMA_VERSION, story: STORY, status: passed ? "passed" : "failed", requestedChild: input.requested, actualChild: input.actual, session: input.sessionId && isAbsolute(input.sessionFile) ? { id: input.sessionId, file: input.sessionFile } : null, image: input.image, evidence: checks, observations: response?.observations ?? [], extractedText: response?.extractedText ?? [], limitations: response?.limitations ?? [], uncertainty: response?.uncertainty ?? [], error: passed ? null : input.error ?? sanitizeError(!exactModel ? "child_identity_mismatch" : input.validated.valid ? "visual_evidence_incomplete" : input.validated.error) };
}

export function formatSummary(result: { status: string; image: ImageInfo; actualChild: ModelIdentity | null; error: ProbeError | null }) { return `${result.status}: ${result.image.sourceLabel} · ${result.actualChild ? `${result.actualChild.provider}/${result.actualChild.model}` : "no child model"}${result.error ? ` · ${result.error.code}` : ""}`; }

async function runProbe(input: { provider: string; model: string; imagePath: string }) {
  const requested = { provider: input.provider, model: input.model };
  let bytes: Buffer; let source: ImageInfo;
  try {
    const info = await stat(input.imagePath);
    if (!info.isFile()) return failure(requested, "image_not_regular_file");
    const sizeError = imageSizeError(info.size);
    if (sizeError) return failure(requested, sizeError);
    bytes = await readFile(input.imagePath);
    const mimeType = classifyImage(bytes);
    if (!mimeType || !extensionMatchesMime(input.imagePath, mimeType)) return failure(requested, "image_unsupported");
    source = { id: randomUUID(), sourceLabel: basename(input.imagePath), mimeType, byteLength: bytes.length, accessible: true, delivered: false };
  } catch (error) { return failure(requested, (error as { code?: string }).code === "ENOENT" ? "image_not_found" : "image_read_failed"); }
  const runtime = await ModelRuntime.create(); const model = runtime.getModel(input.provider, input.model);
  if (!model) return failure(requested, "child_model_not_found", source);
  if (!runtime.hasConfiguredAuth(input.provider)) return failure(requested, "child_model_unauthenticated", source);
  if (!supportsImageInput(model)) return failure(requested, "child_model_not_vision_capable", source);
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const workspace = await mkdtemp(join(tmpdir(), "ima-pi-vision-")); const sessionDir = join(workspace, "sessions"); await mkdir(sessionDir, { recursive: true });
    ({ session } = await createAgentSession({ cwd: workspace, model, modelRuntime: runtime, noTools: "all", tools: [], sessionManager: SessionManager.create(workspace, sessionDir) }));
    const delivery = await deliverImageToVerifiedSession({ requested, session, source, bytes });
    source = delivery.source;
    if (delivery.error) return deriveVisionProbeResult({ requested, actual: delivery.actual, sessionId: session.sessionId, sessionFile: session.sessionFile ?? "", image: source, providerCompleted: false, parsed: false, validated: { valid: false, error: delivery.error.code }, error: delivery.error });
    const text = session.getLastAssistantText(); const parsed = parseVisionResponse(text); const validated = parsed.value === undefined ? { valid: false as const, error: parsed.error ?? "response_missing" } : validateVisionResponse(parsed.value, source);
    const providerCompleted = !session.messages.some((message: any) => message?.role === "assistant" && message?.stopReason === "error");
    return deriveVisionProbeResult({ requested, actual: delivery.actual, sessionId: session.sessionId, sessionFile: session.sessionFile ?? "", image: source, providerCompleted, parsed: !parsed.error, validated, error: !text ? sanitizeError("response_missing") : null });
  } catch (error) { return failure(requested, childExecutionErrorCode(error), source); } finally { session?.dispose(); }
}

function failure(requested: ModelIdentity, code: string, image: ImageInfo = { id: "", sourceLabel: "", mimeType: "", byteLength: 0, accessible: false, delivered: false }) { return deriveVisionProbeResult({ requested, actual: null, sessionId: "", sessionFile: "", image, providerCompleted: false, parsed: false, validated: { valid: false as const, error: code }, error: sanitizeError(code) }); }

export default function visionProbe(pi: ExtensionAPI) {
  pi.registerCommand("ima:vision-probe", { description: "Prove dedicated vision-model image routing and evidence handoff (FNR-3012)", handler: async (args, ctx) => {
    const parsed = parseVisionProbeArgs(args); const result = "error" in parsed ? failure({ provider: "", model: "" }, parsed.error) : await runProbe(parsed);
    let finalResult = result; const sink = process.env[RESULT_ENV_VAR];
    if (sink) { if (!isAbsolute(sink)) finalResult = { ...result, status: "failed", error: sanitizeError("result_write_failed") }; else try { await mkdir(dirname(sink), { recursive: true }); await writeFile(sink, `${JSON.stringify(result, null, 2)}\n`, "utf8"); } catch { finalResult = { ...result, status: "failed", error: sanitizeError("result_write_failed") }; } }
    ctx.ui.notify(formatSummary(finalResult), finalResult.status === "passed" ? "info" : "error");
  }});
}
