import assert from "node:assert/strict";
import test from "node:test";
import { cleanForSpeech } from "../lib/ima-tts-clean.ts";

test("cleans Markdown into deterministic spoken-friendly prose", () => {
  const source = [
    "# Finding",
    "Keep **useful** [words](https://example.com/docs).",
    "> - `Read this`",
  ].join("\n");

  const cleaned = cleanForSpeech(source);

  assert.equal(cleaned, "Finding\nKeep useful words.\nRead this");
  assert.equal(source, [
    "# Finding",
    "Keep **useful** [words](https://example.com/docs).",
    "> - `Read this`",
  ].join("\n"));
  assert.equal(cleanForSpeech(source), cleaned);
});

test("removes comments, HTML, fenced code, bare URLs, and absolute paths", () => {
  const source = [
    "<!-- ima-cycle outcome: phase=plan; outcome=COMPLETED -->",
    "<p>Before</p>",
    "```ts",
    "const ignored = true;",
    "```",
    "After https://example.com/now /home/eric/IMA/dev/ima-pi/lib/ima-tts.ts",
  ].join("\n");

  assert.equal(cleanForSpeech(source), "Before\nAfter");
});

test("removes short POSIX paths without stripping slash prose", () => {
  const source = "Keep /etc/passwd and (/tmp/audio.mp3) with /profile but preserve and/or";
  const cleaned = cleanForSpeech(source);

  assert.equal(cleaned, "Keep and () with but preserve and/or");
  assert.equal(cleanForSpeech(source), cleaned);
  assert.equal(
    source,
    "Keep /etc/passwd and (/tmp/audio.mp3) with /profile but preserve and/or",
  );
});

test("collapses whitespace while retaining useful prose", () => {
  assert.equal(
    cleanForSpeech("  First   line  \r\n\r\n\r\n  Second line  "),
    "First line\n\nSecond line",
  );
});
