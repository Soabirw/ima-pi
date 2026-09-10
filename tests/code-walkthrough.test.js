import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const read = (path) => readFile(join(root, path), "utf8");
const countResources = async (directory, predicate) =>
  (await readdir(join(root, directory), { recursive: true }))
    .filter(predicate)
    .length;
const has = (text, value) => assert.match(
  text,
  new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
);
const localMarkdownTargets = (content) => [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
  .map(([, target]) => target.trim().split("#", 1)[0])
  .filter((target) => target && !target.includes("$") && !/^(?:[a-z]+:|\/)/i.test(target));
const assertLocalMarkdownLinksResolve = async (path, content) => {
  await Promise.all(
    localMarkdownTargets(content).map((target) =>
      access(resolve(root, dirname(path), target))),
  );
};

test("code-walkthrough skill acquires evidence for a new read-only presentation", async () => {
  const content = await read("skills/code-walkthrough/SKILL.md");

  for (const marker of [
    "name: code-walkthrough",
    "as if a teammate were presenting their work",
    "acquires its own\nread-only evidence",
    "understanding-first, not a review",
    "does not emit `REVIEW-NNN` findings",
    "Gitea or GitHub pull request",
    "Normalize `{ host, owner, repo, number }`",
    "tea pr <n>",
    "gh pr diff <pr-url>",
    "-R owner/repo",
    "--repo owner/repo",
    "--login <login>",
    "generic local uncommitted working tree",
    "git status --short",
    "git diff --staged",
    "git ls-files --others --exclude-standard",
    "non-ignored untracked",
    "project root",
    "never execute file content",
    "explicit set of files",
    "ask for one subject and stop",
    "Serena-first",
    "Do not run tests",
    "make any lifecycle mutation",
    "Do not change the active model",
    "one complete, visible Markdown response",
    "repository-relative `file:line`",
    "source-display code fences",
    "pagination",
    "/ima:speak",
    "Do not invoke\n`/ima:speak`, another phase, or `/ima:cycle` automatically",
    "[narrate](../narrate/SKILL.md)",
    "[narrated-review](../narrated-review/SKILL.md)",
    "[code-review](../code-review/SKILL.md)",
    "[tea-gitea](../tea-gitea/SKILL.md)",
    "[gh-cli](../gh-cli/SKILL.md)",
    "[mcp-serena](../mcp-serena/SKILL.md)",
    "[ima-vision-handoff](../ima-vision-handoff/SKILL.md)",
    "[ima-memory-workflow](../ima-memory-workflow/SKILL.md)",
    "[readable-code](../readable-code/SKILL.md)",
  ]) has(content, marker);

  assert.doesNotMatch(content, /request-changes gate applies|emit a graded verdict/i);
  await assertLocalMarkdownLinksResolve("skills/code-walkthrough/SKILL.md", content);
});

test("walkthrough prompt is a read-only single-response teammate presentation", async () => {
  const content = await read("prompts/ima:walkthrough.md");

  for (const marker of [
    "description:",
    'argument-hint: "[walkthrough-subject]"',
    "advisory",
    "read-only",
    "non-mutating",
    "does not change the active model",
    "Unlike `/ima:narrate` and `/ima:narrated-review`",
    "understanding-first, not a review",
    "never emits `REVIEW-NNN`",
    "For a graded verdict use `/ima:review`",
    "exactly one walkthrough subject",
    "ask for one subject and stop",
    "Gitea or GitHub pull request",
    "Normalize `{ host, owner, repo, number }`",
    "host-matched `--login`",
    "git status --short",
    "git diff --staged",
    "git ls-files --others --exclude-standard",
    "non-ignored untracked",
    "project-root-contained",
    "never execute file content",
    "explicit set of files",
    "Serena-first",
    "mcp-serena",
    "vision-handoff",
    "needs no lifecycle\nrecall",
    "run builds or tests",
    "lifecycle mutation",
    "no pagination",
    "Do not invoke `/ima:cycle`",
    "Run /ima:speak to hear this walkthrough.",
    "Do not\nautomatically invoke `/ima:speak`",
  ]) has(content, marker);

  await assertLocalMarkdownLinksResolve("prompts/ima:walkthrough.md", content);
});

test("README documents the walkthrough entry point and current package inventory", async () => {
  const [content, skillCount, promptCount] = await Promise.all([
    read("README.md"),
    countResources("skills", (path) => path.endsWith("SKILL.md")),
    countResources("prompts", (path) => path.endsWith(".md")),
  ]);

  assert.equal(skillCount, 58);
  assert.equal(promptCount, 36);
  has(content, `${skillCount} packaged skills and ${promptCount} \`/ima:*\` prompt templates`);

  for (const marker of [
    "/ima:walkthrough [walkthrough-subject]",
    "read-only developer walkthrough",
    "pull request, local `git diff` changes, or a set of files",
    "as if a teammate were presenting",
    "their work.",
    "understanding-first, never emits `REVIEW-NNN` findings or a verdict",
    "without starting speech automatically",
    "Use `/ima:review` when a graded verdict is required.",
    "/ima:closeout [completed-lifecycle-source]",
    "separately invoked manual terminal lifecycle closeout",
  ]) has(content, marker);
});

test("code-review skill documents an external pull-request peer-review mode without lifecycle artifacts", async () => {
  const content = await read("skills/code-review/SKILL.md");

  for (const marker of [
    "Peer review of an external pull request",
    "authored outside the IMA lifecycle",
    "Do not demand a plan, implementation, or test lifecycle artifact",
    "do not treat their absence as a missing prerequisite",
    "Do not substitute a Tier-1 lifecycle recall",
    "Derive acceptance intent",
    "explicit assumption",
    "Apply the full four-pass methodology",
    "advisory",
    "Do not persist an `ima_lifecycle` artifact",
    "Normalize the supplied PR as `{ host, owner, repo, number }`",
    "gh pr diff <pr-url>",
    "-R owner/repo",
    "--repo owner/repo",
    "--login <login>",
    "missing prerequisite and stop",
    "[tea-gitea](../tea-gitea/SKILL.md)",
    "[gh-cli](../gh-cli/SKILL.md)",
  ]) has(content, marker);

  await assertLocalMarkdownLinksResolve("skills/code-review/SKILL.md", content);
});

test("review prompt isolates external PRs from formal lifecycle effects", async () => {
  const content = await read("prompts/ima:review.md");
  has(content, "Gitea or GitHub PR URL");

  const externalStart = content.indexOf("## External pull-request peer review");
  const formalStart = content.indexOf("## Formal lifecycle review");

  assert.ok(externalStart >= 0);
  assert.ok(formalStart > externalStart);

  const externalBranch = content.slice(externalStart, formalStart);
  const formalBranch = content.slice(formalStart);

  for (const marker of [
    "Peer review of an external pull request",
    "advisory report with report-local `REVIEW-NNN` IDs",
    "Do not call `ima_context`",
    "or call `ima_lifecycle`",
    "Stop after the advisory report",
  ]) has(externalBranch, marker);
  assert.doesNotMatch(externalBranch, /Persist a complete `review` artifact/);
  assert.doesNotMatch(externalBranch, /When dispatched by `\/ima:cycle`/);

  for (const marker of [
    "Call `ima_context`",
    "latest VERIFIED Tier-1 lifecycle artifact",
    "code-review",
    "Integration Contract",
    "request-changes gate",
    "review-verifier",
    "Persist a complete `review` artifact through `ima_lifecycle`",
    "<!-- ima-cycle outcome: phase=review; outcome=APPROVED -->",
  ]) has(formalBranch, marker);
});
