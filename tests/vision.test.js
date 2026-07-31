import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_IMAGE_BYTES, STORY, USAGE, buildVisionBrief,
  childExecutionErrorCode, childIdentityMatches, classifyImage, deliverImageToVerifiedSession,
  deriveVisionProbeResult, extensionMatchesMime, formatSummary, imageSizeError,
  parseModelSelector, parseVisionProbeArgs, parseVisionResponse, sanitizeError,
  supportsImageInput, validateVisionResponse, withDeadline,
} from "../extensions/vision-probe.ts";

const id = "opaque-id";
const label = "evidence.png";
const response = {
  schemaVersion: 1,
  image: { id, sourceLabel: label },
  observations: ["A blue square is visible."],
  extractedText: [],
  limitations: ["Small image."],
  uncertainty: ["Text may be unreadable."],
  scope: { visualEvidenceOnly: true, implementationDecisionMade: false },
};
const image = { id, sourceLabel: label, mimeType: "image/png", byteLength: 8, accessible: true, delivered: true };
const completeProbe = () => ({
  requested: { provider: "p", model: "m" }, actual: { provider: "p", model: "m" },
  sessionId: "session-id", sessionFile: "/tmp/session.jsonl", image, providerCompleted: true, parsed: true,
  validated: validateVisionResponse(response, { id, sourceLabel: label }),
});

test("selector and command grammar preserve nested model ids and require an absolute path", () => {
  assert.deepEqual(parseModelSelector("openrouter/openai/gpt"), { valid: true, provider: "openrouter", model: "openai/gpt" });
  for (const value of [undefined, "", "provider", "/model", "provider/"]) assert.equal(parseModelSelector(value).valid, false, String(value));
  assert.deepEqual(parseVisionProbeArgs("openai/gpt /tmp/image.png"), { provider: "openai", model: "gpt", imagePath: "/tmp/image.png" });
  assert.deepEqual(parseVisionProbeArgs('openai/gpt "/tmp/image with spaces.png"'), { provider: "openai", model: "gpt", imagePath: "/tmp/image with spaces.png" });
  assert.deepEqual(parseVisionProbeArgs("openai/gpt '/tmp/image with spaces.png'"), { provider: "openai", model: "gpt", imagePath: "/tmp/image with spaces.png" });
  for (const value of ["", "openai/gpt relative.png", "openai/gpt /tmp/a extra", 'openai/gpt "/tmp/a" extra', "openai/ /tmp/a"]) assert.equal(parseVisionProbeArgs(value).error, "invalid_arguments", value);
  assert.match(USAGE, /vision-probe/);
});

test("image capability derives solely from metadata", () => {
  assert.equal(supportsImageInput({ input: ["text", "image"] }), true);
  for (const model of [{ input: ["text"] }, { input: "image" }, {}, null]) assert.equal(supportsImageInput(model), false);
});

test("classifies only approved signatures and rejects extension mismatches", () => {
  const cases = [
    [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"],
    [Uint8Array.from([0xff, 0xd8, 0xff]), "image/jpeg"],
    [Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")]), "image/webp"],
    [Uint8Array.from(Buffer.from("GIF89a")), "image/gif"],
  ];
  for (const [bytes, mimeType] of cases) assert.equal(classifyImage(bytes), mimeType);
  assert.equal(classifyImage(Uint8Array.from([1, 2, 3])), null);
  assert.equal(extensionMatchesMime("/tmp/evidence.jpeg", "image/jpeg"), true);
  assert.equal(extensionMatchesMime("/tmp/evidence.jpg", "image/png"), false);
  assert.equal(extensionMatchesMime("/tmp/evidence.unknown", "image/png"), true);
});

test("image size guard bounds allocation before local reads", () => {
  assert.equal(imageSizeError(0), "image_empty");
  assert.equal(imageSizeError(1), null);
  assert.equal(imageSizeError(MAX_IMAGE_BYTES), null);
  assert.equal(imageSizeError(MAX_IMAGE_BYTES + 1), "image_too_large");
  assert.deepEqual(sanitizeError("image_too_large"), { code: "image_too_large", message: "image exceeds the 20 MiB limit" });
});

test("fixed brief carries identity and evidence-only boundaries", () => {
  const brief = buildVisionBrief({ imageId: id, sourceLabel: label });
  for (const text of [id, label, "exact visible copy", "no tools", "implementation, testing, review, or lifecycle decision", "exactly one JSON"]) assert.ok(brief.includes(text));
});

test("response parsing accepts direct JSON or one JSON fence and fails closed otherwise", () => {
  assert.deepEqual(parseVisionResponse(JSON.stringify(response)).value, response);
  assert.deepEqual(parseVisionResponse("```json\n" + JSON.stringify(response) + "\n```").value, response);
  for (const value of ["prose " + JSON.stringify(response), "[]", "null", "{} {}", "```\n" + JSON.stringify(response) + "\n```", "```json\n{}\n```\n```json\n{}\n```", "x".repeat(32_001)]) assert.equal(parseVisionResponse(value).error, "response_invalid_json");
});

test("schema requires exact identity, bounded arrays, observations, and evidence-only scope", () => {
  assert.equal(validateVisionResponse(response, { id, sourceLabel: label }).valid, true);
  const invalid = [
    { ...response, schemaVersion: 2 }, { ...response, image: { id: "other", sourceLabel: label } }, { ...response, observations: [] },
    { ...response, extractedText: ["x".repeat(1001)] }, { ...response, limitations: undefined }, { ...response, uncertainty: [""] },
    { ...response, scope: { visualEvidenceOnly: false, implementationDecisionMade: false } }, { ...response, scope: { visualEvidenceOnly: true, implementationDecisionMade: true } },
  ];
  for (const value of invalid) assert.equal(validateVisionResponse(value, { id, sourceLabel: label }).valid, false);
});

test("exact child identity is required before delivery", async () => {
  const requested = { provider: "p", model: "m" };
  assert.equal(childIdentityMatches(requested, requested), true);
  for (const actual of [null, { provider: "other", model: "m" }, { provider: "p", model: "other" }]) assert.equal(childIdentityMatches(requested, actual), false);
  let promptCalls = 0;
  const source = { ...image, delivered: false };
  const delivery = await deliverImageToVerifiedSession({
    requested,
    session: { model: { provider: "other", id: "m" }, prompt: async () => { promptCalls += 1; }, waitForIdle: async () => {} },
    source,
    bytes: Buffer.from("private image bytes"),
  });
  assert.equal(promptCalls, 0);
  assert.deepEqual(delivery.actual, { provider: "other", model: "m" });
  assert.equal(delivery.source.delivered, false);
  assert.equal(delivery.error?.code, "child_identity_mismatch");
});

test("deadline clears on completion and classifies only its private sentinel as timeout", async () => {
  assert.equal(await withDeadline(Promise.resolve("done"), 10), "done");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const expired = await withDeadline(new Promise(() => {}), 1).then(
    () => assert.fail("deadline should reject"),
    (error) => error,
  );
  assert.equal(childExecutionErrorCode(expired), "child_execution_timeout");
  assert.equal(childExecutionErrorCode(new Error("timeout")), "child_execution_failed");
});

test("result passes only with every required acceptance signal and has a safe projection", () => {
  const result = deriveVisionProbeResult(completeProbe());
  assert.equal(result.status, "passed"); assert.equal(result.story, STORY);
  assert.deepEqual(result.session, { id: "session-id", file: "/tmp/session.jsonl" });
  assert.doesNotMatch(JSON.stringify(result), /base64|raw response|transcript|\/private\/image/i);
  for (const key of ["providerCompleted", "parsed"]) assert.equal(deriveVisionProbeResult({ ...completeProbe(), [key]: false }).status, "failed", key);
  for (const imageUpdate of [{ accessible: false }, { delivered: false }]) assert.equal(deriveVisionProbeResult({ ...completeProbe(), image: { ...image, ...imageUpdate } }).status, "failed");
  assert.equal(deriveVisionProbeResult({ ...completeProbe(), sessionId: "", sessionFile: "" }).status, "failed");
});

test("result rejects an actual child identity different from the explicit request", () => {
  const result = deriveVisionProbeResult({ ...completeProbe(), actual: { provider: "p", model: "other" } });
  assert.equal(result.status, "failed"); assert.equal(result.error?.code, "child_identity_mismatch");
});

test("sanitization and concise summary do not expose error detail", () => {
  const error = sanitizeError("image_not_found", "path=/private/image.png token=secret");
  assert.deepEqual(error, { code: "image_not_found", message: "image was not found" });
  assert.equal(sanitizeError("unknown", "secret").message, "vision probe failed");
  assert.equal(formatSummary({ status: "failed", image, actualChild: { provider: "p", model: "m" }, error }), "failed: evidence.png · p/m · image_not_found");
});
