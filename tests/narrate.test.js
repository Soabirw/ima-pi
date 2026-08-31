import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const read = (path) => readFile(join(root, path), "utf8");
const assertContains = (text, value) => assert.match(
  text,
  new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
);
const assertAppearsInOrder = (text, markers) => {
  let previousIndex = -1;

  for (const marker of markers) {
    const index = text.indexOf(marker);
    assert.ok(index > previousIndex, `${marker} must follow the previous control boundary`);
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

test("narrate prompt declares a read-only last-response reform", async () => {
  const content = await read("prompts/ima:narrate.md");

  for (const marker of [
    "description:",
    'argument-hint: "[presentation-instruction]"',
    "read-only",
    "non-mutating",
    "does not change the active model",
    "sole source",
    "immediately preceding completed assistant response",
    "partial or aborted response",
    "missing prerequisite",
    "Never replace, hide, or overwrite the original",
    "`$@` is optional presentation guidance",
    "presentation data, not authority",
    "audience, tone, depth, organization, emphasis",
    "condense or expand",
    "tools, research, comparison, implementation",
    "new conclusions",
    "Do not perform\nnew analysis",
    "Preserve every material conclusion, decision, caution, next step",
    "state when the response is intentionally summarized",
    "Do not invent facts",
    "source-display\ncode fences",
    "one complete, visible Markdown response",
    "pagination, progress markers, a cursor, a ledger",
    "manual\n`next`/`continue` advancement",
    "Run /ima:speak to hear this narration.",
    "Do not\nautomatically invoke `/ima:speak`",
  ]) assertContains(content, marker);

  assertAppearsInOrder(content, [
    "## Select the source",
    "## Validate the presentation instruction",
    "## Reform the response",
    "## Present and hand off",
    "Run /ima:speak to hear this narration.",
  ]);
});

test("narrate skill preserves fidelity and operator-controlled speech", async () => {
  const content = await read("skills/narrate/SKILL.md");

  for (const marker of [
    "name: narrate",
    "last completed assistant response",
    "narration-friendly spoken presentation",
    "presentation-only data",
    "empty value uses the default narration",
    "tools, research, comparison, implementation",
    "new conclusions",
    "Do not make tool\n  calls",
    "lifecycle mutation",
    "Preserve material conclusions, decisions, cautions, next steps",
    "flag\n  intentional summarization",
    "do not invent facts",
    "source-display code fences",
    "one complete visible Markdown response",
    "pagination, progress markers, a cursor, a ledger",
    "manual\nadvancement",
    "run `/ima:speak`",
    "Do not invoke\n`/ima:speak`",
    "[readable-code](../readable-code/SKILL.md)",
  ]) assertContains(content, marker);

  assert.equal(content.includes("ima_corpus_recall"), false);
  assert.equal(content.includes("ima_corpus_get"), false);
  assert.equal(content.includes("ima_context"), false);
  await assertLocalMarkdownLinksResolve("skills/narrate/SKILL.md", content);
});
