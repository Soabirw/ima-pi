import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SPEECH_INPUT_CHARACTERS,
  segmentSpeechText,
} from "../lib/ima-tts-segment.ts";

test("returns one unchanged frozen chunk when speech text fits the budget", () => {
  const text = "Short speech text.";
  const chunks = segmentSpeechText(text, text.length);

  assert.deepEqual(chunks, [text]);
  assert.ok(Object.isFrozen(chunks));
});

test("prefers paragraph, line, sentence, and word boundaries in that order", () => {
  assert.equal(
    segmentSpeechText(
      "Paragraph one.\n\nLine two\nSentence three. trailing words continue",
      50,
    )[0],
    "Paragraph one.\n\n",
  );
  assert.equal(
    segmentSpeechText("First line\nSecond sentence. trailing words continue", 40)[0],
    "First line\n",
  );
  assert.equal(
    segmentSpeechText("First sentence. trailing words continue", 25)[0],
    "First sentence.",
  );
  assert.equal(
    segmentSpeechText("first second third fourth", 13)[0],
    "first second ",
  );
});

test("hard-splits an over-budget indivisible unit without losing text", () => {
  assert.deepEqual(segmentSpeechText("abcdefgh", 3), ["abc", "def", "gh"]);
});

test("keeps paragraph candidates inside the active boundary window", () => {
  const source = "\n\nx";
  const chunks = segmentSpeechText(source, 1);

  assert.ok(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 1));
  assert.equal(chunks.join(""), source);
});

test("avoids separator-only chunks at paragraph straddles", () => {
  const source = [
    "x".repeat(MAX_SPEECH_INPUT_CHARACTERS - 1),
    "\n\n",
    "y".repeat(MAX_SPEECH_INPUT_CHARACTERS),
  ].join("");
  const chunks = segmentSpeechText(source, MAX_SPEECH_INPUT_CHARACTERS);

  assert.ok(chunks.every((chunk) => (
    chunk.length <= MAX_SPEECH_INPUT_CHARACTERS && chunk.trim()
  )));
  assert.equal(chunks.join(""), source);
});

test("keeps exact-boundary input in one chunk", () => {
  assert.deepEqual(segmentSpeechText("exact", 5), ["exact"]);
});

test("returns no chunks for blank text or invalid budgets", () => {
  assert.deepEqual(segmentSpeechText(" \n\t ", MAX_SPEECH_INPUT_CHARACTERS), []);

  for (const budget of [0, -1, Number.NaN, Infinity, -Infinity, 0.5]) {
    assert.deepEqual(segmentSpeechText("speech", budget), []);
  }
});

test("preserves source content in deterministic, non-empty, budget-safe chunks", () => {
  const source = [
    "First sentence. Second sentence with a paragraph boundary.",
    "A line with an indivisible token: abcdefghijklmnopqrstuvwxyz.",
    "Final sentence.",
  ].join("\n\n");
  const original = source;
  const first = segmentSpeechText(source, 24);
  const second = segmentSpeechText(source, 24);

  assert.equal(first.join(""), source);
  assert.ok(first.every((chunk) => chunk.length > 0 && chunk.length <= 24));
  assert.deepEqual(first, second);
  assert.equal(source, original);
  assert.ok(Object.isFrozen(first));
});
