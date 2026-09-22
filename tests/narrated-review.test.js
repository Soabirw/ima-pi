  import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const read = (path) => readFile(join(root, path), "utf8");
const has = (text, value) => assert.match(
  text,
  new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
);
const assertAppearsInOrder = (text, markers) => {
  let previousIndex = -1;

  for (const marker of markers) {
    const index = text.indexOf(marker);
    assert.ok(index > previousIndex, `${marker} must follow the previous selection step`);
    previousIndex = index;
  }
};
const localMarkdownTargets = (content) => [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
  .map(([, target]) => target.trim().split("#", 1)[0])
  .filter((target) => target && !target.includes("$") && !/^(?:[a-z]+:|\/)/i.test(target));

const assertLocalMarkdownLinksResolve = async (path, content) => {
  await Promise.all(
    localMarkdownTargets(content).map((target) =>
      access(resolve(root, dirname(path), target))),
  );
};

test("narrated-review prompt declares a read-only single-response walkthrough", async () => {
  const content = await read("prompts/ima:narrated-review.md");

  for (const marker of [
    "description:",
    'argument-hint: "[completed-review-source]"',
    "advisory",
    "read-only",
    "non-mutating",
    "does not change the active model",
    "exactly one source",
    "ima_context",
    "Serena-first",
    "ima-memory-workflow",
    "completed review",
    "Tier-1 Qdrant",
    "ima_corpus_recall",
    "Do not use `ima_corpus_recall` at `limit: 20`",
    "`ima_lifecycle_recall` and `limit: 50`",
    "potentially saturated",
    "`review` or `rereview`",
    "Directly retrieve every candidate",
    "Validate every candidate",
    "unique candidate with the greatest valid `createdAt`",
    "missing,\ninvalid, or tied",
    "taskwarrior:<project>:<uuid>",
    "jira:<KEY>",
    "lifecycle:<lifecycle-key>",
    "vestige:<UUID>",
    "one complete walkthrough",
    "/ima:speak",
    "no pagination",
    "no `next`/`continue`",
    "Do not invoke `/ima:cycle`",
    "Do not automatically invoke `/ima:speak`",
  ]) has(content, marker);

  assertAppearsInOrder(content, [
    "ima_corpus_recall",
    "`ima_lifecycle_recall` and `limit: 50`",
    "potentially saturated",
    "`review` or `rereview`",
    "Directly retrieve every candidate",
    "Validate every candidate",
    "unique candidate with the greatest valid `createdAt`",
  ]);
  assert.ok(content.indexOf("ima_context") < content.indexOf("discovery"));
  await assertLocalMarkdownLinksResolve("prompts/ima:narrated-review.md", content);
});

test("narrated-review skill preserves evidence fidelity and presentation boundaries", async () => {
  const content = await read("skills/narrated-review/SKILL.md");

  for (const marker of [
    "name: narrated-review",
    "post-`/ima:review`",
    "verified review verdict",
    "ima_corpus_recall",
    "Do not use `ima_corpus_recall` at `limit: 20`",
    "`limit: 50`",
    "potentially saturated",
    "`review` or `rereview`",
    "Directly retrieve every candidate",
    "Validate every candidate",
    "unique candidate with the greatest valid `createdAt`",
    "missing,\n  invalid, or tied",
    "retained verified findings",
    "developer presentation",
    "repository-relative `file:line`",
    "Do not recite substantial source code or raw diffs",
    "single response",
    "/ima:speak",
    "automatic segmentation",
    "sequential playback",
    "pagination",
    "cursor",
    "ledger",
    "manual advancement",
    "tool-driven TTS invocation",
    "lifecycle mutation",
    "[code-review](../code-review/SKILL.md)",
    "[ima-memory-workflow](../ima-memory-workflow/SKILL.md)",
    "[readable-code](../readable-code/SKILL.md)",
  ]) has(content, marker);

  assertAppearsInOrder(content, [
    "ima_corpus_recall",
    "`limit: 50`",
    "potentially saturated",
    "`review` or `rereview`",
    "Directly retrieve every candidate",
    "Validate every candidate",
    "unique candidate with the greatest valid `createdAt`",
  ]);
  await assertLocalMarkdownLinksResolve("skills/narrated-review/SKILL.md", content);
});
