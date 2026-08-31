import assert from "node:assert/strict";
import test from "node:test";
import {
  selectCurrentSettledAssistantText,
  selectLatestCompletedAssistantText,
} from "../lib/ima-tts-session.ts";

const assistantEntry = (content, stopReason = "stop") => ({
  type: "message",
  message: {
    role: "assistant",
    stopReason,
    content,
  },
});

const textPart = (text) => ({ type: "text", text });

test("selects the newest completed assistant response without mutating session entries", () => {
  const entries = [
    assistantEntry([textPart("First response")]),
    { type: "message", message: { role: "user", content: "Continue" } },
    assistantEntry([textPart("Newest response")]),
  ];
  const original = structuredClone(entries);

  assert.equal(selectLatestCompletedAssistantText(entries), "Newest response");
  assert.deepEqual(entries, original);
});

test("selects only the current settled assistant response", () => {
  const completed = [
    assistantEntry([textPart("Earlier response")]),
    assistantEntry([textPart("Current response")]),
    { type: "message", message: { role: "user", content: "next prompt" } },
  ];
  const aborted = [
    assistantEntry([textPart("Completed response")]),
    assistantEntry([textPart("Aborted response")], "aborted"),
    { type: "custom", data: { text: "ignored" } },
  ];

  assert.equal(selectCurrentSettledAssistantText(completed), "Current response");
  assert.equal(selectCurrentSettledAssistantText(aborted), null);
});

test("ignores non-completed and non-assistant session entries", () => {
  const entries = [
    assistantEntry([textPart("Completed response")]),
    { type: "custom", data: { text: "ignored" } },
    assistantEntry([textPart("Interrupted response")], "aborted"),
    { type: "message", message: { role: "toolResult", content: [textPart("tool")] } },
    { type: "message", message: { role: "user", content: "user input" } },
    null,
  ];

  assert.equal(selectLatestCompletedAssistantText(entries), "Completed response");
});

test("joins text content and returns null for missing or empty latest completed text", () => {
  const content = [
    textPart(" First line "),
    { type: "thinking", thinking: "ignored" },
    textPart("Second line "),
    { type: "image", data: "ignored" },
  ];

  assert.equal(
    selectLatestCompletedAssistantText([assistantEntry(content)]),
    "First line \nSecond line",
  );
  assert.equal(
    selectLatestCompletedAssistantText([
      assistantEntry([textPart("Older text")]),
      assistantEntry([{ type: "thinking", thinking: "no text" }]),
    ]),
    null,
  );
  assert.equal(selectLatestCompletedAssistantText([]), null);
});
