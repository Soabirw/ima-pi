import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const prompt = (name) => readFile(join(root, "prompts", `ima:${name}.md`), "utf8");
const has = (text, value) => assert.match(text, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
test("production workflow prompts have distinct Pi frontmatter and HIGH-tier authority", async () => { for (const name of ["brainstorm", "decompose", "plan"]) { const text = await prompt(name); has(text, "description:"); has(text, "argument-hint:"); has(text, "HIGH-tier"); has(text, "explicit approval"); assert.doesNotMatch(text, /\/ima:cycle|workflow DSL/i); } });
test("brainstorm owns approved product requirements and stops before decomposition or design", async () => { const text = await prompt("brainstorm"); for (const value of ["problem or opportunity", "users and use cases", "business rules", "product acceptance criteria", "vision-handoff", "lifecycle type `decision`", "/ima:decompose", "stop"]) has(text, value); has(text, "Do **not** decompose PM work"); });
test("decompose enforces two tiers, one PM destination, preview, and checklist-only work", async () => { const text = await prompt("decompose"); for (const value of ["Taskwarrior Project -> Task", "Jira Epic -> Story/Task", "checklist", "exactly one destination", "never dual-write", "exact persistence preview", "explicit approval", "lifecycle unit", "as `decision`", "stop"]) has(text, value); has(text, "technical files, functions, control flow"); });
test("plan enforces one-unit Serena-first technical planning without implementation", async () => { const text = await prompt("plan"); for (const value of ["exactly one", "/ima:decompose", "ima_context", "Serena-first", "files, modules, symbols, APIs", "pure/effect boundaries", "verification commands", "rollback", "as `plan`", "stop"]) has(text, value); has(text, "Do not edit code/config/content"); });

const implementationPrompts = ["implement", "implement-js", "implement-wp"];
test("implementation prompts expose a MID current-session, plan-bound terminal contract", async () => {
  for (const name of implementationPrompts) {
    const text = await prompt(name);
    for (const value of ["description:", "argument-hint: \"[approved-plan-source]\"", "MID-tier", "current session", "approved", "scope", "non-goals", "ima_context", "Serena-first", "ima_delegate", "ima_lifecycle", "implementation", "contradiction", "verification", "/ima:plan", "/ima:test", "formal test or review"]) has(text, value);
    for (const prohibition of ["Do not invoke `/ima:cycle`", "a workflow DSL", "Goose recipes", "subrecipe mechanics", "does not change the active model"]) has(text, prohibition);
  }
});

test("generic implementation prompt selects evidence-based skills without a stack classifier", async () => {
  const text = await prompt("implement");
  for (const value of ["mixed", "ambiguous", "other-stack", "relevant project/code skills", "stack classifier", "pure transformations", "effects at explicit boundaries"]) has(text, value);
});

test("JavaScript implementation prompt preserves Node, FP, security, and visual boundaries", async () => {
  const text = await prompt("implement-js");
  for (const value of ["Node", "APIs", "CLIs", "TUIs", "frontend", "Node 24+", "pure", "I/O at boundaries", "validate external input", "parameterized SQL", "vision-handoff"]) has(text, value);
});

test("WordPress implementation prompt treats security as a primary production contract", async () => {
  const text = await prompt("implement-wp");
  for (const value of ["primary production", "nonce", "capability", "Sanitize", "escape output", "$wpdb->prepare()", "WordPress APIs", "hooks", "actions/filters", "vision-handoff"]) has(text, value);
});
