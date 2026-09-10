import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
  DESCRIPTION_INPUT_MAXIMUM_BYTES,
  DESCRIPTION_MAXIMUM_DEPTH,
  DESCRIPTION_MAXIMUM_NODES,
  DESCRIPTION_OUTPUT_MAXIMUM_BYTES,
  DESCRIPTION_SERIALIZED_MAXIMUM_BYTES,
  normalizeWorkItemDescription,
} from "../skills/plane-api/scripts/plane-description.mjs";
import {
  PlaneApiError,
  normalizeWorkItem,
} from "../skills/plane-api/scripts/plane-client.mjs";

const WORK_ITEM_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const STATE_ID = "33333333-3333-4333-8333-333333333333";

const workItem = (overrides = {}) => ({
  id: WORK_ITEM_ID,
  project: PROJECT_ID,
  sequence_id: 1,
  name: "Plane item",
  description_stripped: "Safe description",
  state: STATE_ID,
  priority: "medium",
  assignees: [],
  labels: [],
  ...overrides,
});

const description = (rawWorkItem) => {
  const result = normalizeWorkItemDescription(rawWorkItem);
  assert.equal(result.success, true, result.success ? "" : result.error);
  return result.data;
};

const assertDescriptionFailure = (rawWorkItem) => {
  const result = normalizeWorkItemDescription(rawWorkItem);
  assert.equal(result.success, false);
  assert.equal(typeof result.error, "string");
  return result.error;
};

const htmlOnlyWorkItem = (descriptionHtml) => workItem({
  description_stripped: undefined,
  description: undefined,
  description_html: descriptionHtml,
});

const descriptionWithSerializedByteLength = (target) => {
  const quoteCount = Math.floor((target - 2) / 2);
  const literalByteCount = target - 2 - quoteCount * 2;
  const value = "\"".repeat(quoteCount) + "x".repeat(literalByteCount);
  assert.equal(Buffer.byteLength(JSON.stringify(value), "utf8"), target);
  return value;
};

test("preserves supported Plane description representations with deterministic precedence", () => {
  assert.equal(description({ description_stripped: "Preferred", description: "Legacy" }), "Preferred");
  assert.equal(description({ description_stripped: " \n", description: "Legacy" }), "Legacy");
  assert.equal(
    description({
      description_stripped: "",
      description: " \t",
      description_html: "<p>HTML fallback</p>",
    }),
    "HTML fallback",
  );
  assert.equal(
    description({
      description_stripped: "Preferred",
      description: "Legacy",
      description_html: "<p>Ignored HTML</p>",
      description_binary: { opaque: true },
    }),
    "Preferred",
  );
  for (const descriptionHtml of ["<p> </p>", "<!-- no content -->"]) {
    assert.equal(description({ description_html: descriptionHtml }), "");
    assertDescriptionFailure({ description_html: descriptionHtml, description_binary: "opaque" });
  }
  assert.equal(
    description({ description_html: "<p>Human requirements</p>", description_binary: "opaque" }),
    "Human requirements",
  );

  assertDescriptionFailure({});
  assertDescriptionFailure({ description_stripped: null, description: null, description_html: null });
  assertDescriptionFailure({ description_stripped: "", description_binary: "opaque" });
});

test("converts HTML-only Plane descriptions without retaining URLs or markup", () => {
  const rawWorkItem = htmlOnlyWorkItem(
    "<h2>Plan &amp; Scope</h2><p>Line one<br>Line two</p><ol><li>First</li><li>Second <a href=\"https://example.test/path\">read more</a></li></ol>",
  );

  const normalized = normalizeWorkItem(rawWorkItem);
  assert.equal(
    normalized.description,
    "Plan & Scope\n\nLine one\nLine two\n\n 1. First\n 2. Second read more",
  );
  assert.equal(normalized.description.includes("https://"), false);
  assert.equal(normalized.description.includes("<"), false);

  assert.equal(
    description({ description_html: "<p>Unclosed <strong>text" }),
    "Unclosed text",
  );
});

test("rejects unsupported or malformed descriptions without leaking source content", () => {
  for (const rawWorkItem of [
    { description_stripped: { text: "not a string" } },
    { description_html: ["not a string"] },
    { description_html: "<script>source-secret</script>" },
    { description_html: "<style>.source-secret {}</style>" },
    { description_html: "<img src=\"https://example.test/source-secret\">" },
    { description_html: "<iframe src=\"https://example.test/source-secret\"></iframe>" },
    { description_html: "<object>source-secret</object>" },
    { description_html: "<svg><text>source-secret</text></svg>" },
    { description_html: "<form><input value=\"source-secret\"></form>" },
    { description_html: "<unknown>source-secret</unknown>" },
  ]) {
    const error = assertDescriptionFailure(rawWorkItem);
    assert.equal(error.includes("source-secret"), false);
  }

  assert.throws(
    () => normalizeWorkItem(htmlOnlyWorkItem("<script>source-secret</script>")),
    (error) => error instanceof PlaneApiError && error.code === "DESCRIPTION_ERROR",
  );
});

test("enforces input and output description bounds without truncating", () => {
  for (const size of [DESCRIPTION_OUTPUT_MAXIMUM_BYTES - 1, DESCRIPTION_OUTPUT_MAXIMUM_BYTES]) {
    assert.equal(description({ description_stripped: "x".repeat(size) }).length, size);
  }
  assertDescriptionFailure({ description_stripped: "x".repeat(DESCRIPTION_OUTPUT_MAXIMUM_BYTES + 1) });

  for (const size of [DESCRIPTION_INPUT_MAXIMUM_BYTES - 1, DESCRIPTION_INPUT_MAXIMUM_BYTES]) {
    assert.equal(
      description({ description_stripped: "short", description_html: "x".repeat(size) }),
      "short",
    );
  }
  assertDescriptionFailure({
    description_stripped: "short",
    description_html: "x".repeat(DESCRIPTION_INPUT_MAXIMUM_BYTES + 1),
  });
});

test("enforces serialized description output bounds for every representation", () => {
  for (const target of [
    DESCRIPTION_SERIALIZED_MAXIMUM_BYTES - 1,
    DESCRIPTION_SERIALIZED_MAXIMUM_BYTES,
    DESCRIPTION_SERIALIZED_MAXIMUM_BYTES + 1,
  ]) {
    const expected = target <= DESCRIPTION_SERIALIZED_MAXIMUM_BYTES;
    const value = descriptionWithSerializedByteLength(target);
    const rawWorkItems = [
      { description_stripped: value },
      { description_stripped: "", description: value },
      { description_html: `<p>${value}</p>` },
    ];

    for (const rawWorkItem of rawWorkItems) {
      const result = normalizeWorkItemDescription(rawWorkItem);
      assert.equal(result.success, expected);
      if (result.success) assert.equal(result.data, value);
    }
  }
});

test("measures description limits in UTF-8 bytes", () => {
  const fourByteCharacter = "😀";
  const outputAtLimit = fourByteCharacter.repeat(DESCRIPTION_OUTPUT_MAXIMUM_BYTES / 4);
  const inputAtLimit = fourByteCharacter.repeat(DESCRIPTION_INPUT_MAXIMUM_BYTES / 4);

  assert.equal(description({ description_stripped: outputAtLimit }), outputAtLimit);
  assertDescriptionFailure({ description_stripped: `${outputAtLimit}a` });
  assert.equal(
    description({ description_stripped: "short", description_html: inputAtLimit }),
    "short",
  );
  assertDescriptionFailure({
    description_stripped: "short",
    description_html: `${inputAtLimit}a`,
  });
});

test("enforces bounded HTML structure before conversion", () => {
  const atMaximumDepth = `<span>`.repeat(DESCRIPTION_MAXIMUM_DEPTH) + "text" + "</span>".repeat(DESCRIPTION_MAXIMUM_DEPTH);
  assert.equal(description({ description_html: atMaximumDepth }), "text");
  assertDescriptionFailure({
    description_html: `<span>`.repeat(DESCRIPTION_MAXIMUM_DEPTH + 1) + "text" + "</span>".repeat(DESCRIPTION_MAXIMUM_DEPTH + 1),
  });

  assert.equal(description({ description_html: "<span></span>".repeat(DESCRIPTION_MAXIMUM_NODES) }), "");
  assertDescriptionFailure({ description_html: "<span></span>".repeat(DESCRIPTION_MAXIMUM_NODES + 1) });
});
