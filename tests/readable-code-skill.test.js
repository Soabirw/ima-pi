import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const read = (path) => readFile(join(root, path), "utf8");
const localMarkdownTargets = (content) => [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
  .map(([, target]) => target.trim().split("#", 1)[0])
  .filter((target) => target && !target.includes("$") && !/^(?:[a-z]+:|\/)/i.test(target));

const mustContain = (content, markers, label) => markers.forEach((marker) => assert.match(content, marker, `${label} must retain ${marker}`));

test("readable-code skill defines the approved universal readability contract", async () => {
  const content = await read("skills/readable-code/SKILL.md");

  assert.match(content, /^---\nname: ?["']?readable-code["']?/);
  assert.match(content, /^description:/m);
  assert.doesNotMatch(content, /sub_recipes|\.eta/i);
  mustContain(content, [
    /Name by intent/i,
    /Keep functions focused/i,
    /guard clauses? or early returns?/i,
    /Named constants/i,
    /parameter lists comprehensible/i,
    /pure transformations/i,
    /Avoid abstraction for its own sake/i,
  ], "readable-code");
  assert.match(content, /functional-programmer/i);
  assert.match(content, /ima-security-guardrails/i);
  assert.match(content, /FP-Redundancy Review Outcome/i);
  assert.match(content, /nesting as a principle/i);
  assert.match(content, /justified exception/i);
  assert.match(content, /Do not mandate an indentation width/i);
});

test("readable-code delegates function size and security without duplicating their ownership", async () => {
  const [readableCode, functionalProgrammer] = await Promise.all([
    read("skills/readable-code/SKILL.md"),
    read("skills/functional-programmer/SKILL.md"),
  ]);

  assert.match(readableCode, /does not repeat or enforce a numeric function-size rule/i);
  assert.match(readableCode, /\[functional-programmer\]\([^)]*\) owns the universal numeric function-size heuristic and general FP principles/i);
  assert.match(readableCode, /matching language FP skill owns language-specific functional patterns, constraints, exceptions, and applicable language-specific FP depth/i);
  assert.doesNotMatch(readableCode, /functional-programmer.*matching language FP skill.*own numeric size guidance/i);
  assert.match(functionalProgrammer, /roughly 50 lines or fewer per function as a soft heuristic/i);
  assert.match(functionalProgrammer, /not an automatic failure/i);
  assert.match(functionalProgrammer, /readable-code/i);
});

test("readable-code local Markdown links resolve", async () => {
  const file = "skills/readable-code/SKILL.md";
  const content = await read(file);

  await Promise.all(localMarkdownTargets(content).map((target) => access(resolve(root, dirname(file), target))));
});
