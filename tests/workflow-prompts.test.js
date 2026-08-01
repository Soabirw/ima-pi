import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const prompt = (name) => readFile(join(root, "prompts", `ima:${name}.md`), "utf8");
const skill = (name) => readFile(join(root, "skills", name, "SKILL.md"), "utf8");
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


test("quality and learning prompts retain distinct bounded terminal contracts", async () => {
  for (const name of ["test", "review", "review-verify", "document"]) { const text = await prompt(name); has(text, "description:"); has(text, "argument-hint:"); has(text, "stop"); has(text, "/ima:cycle"); }
  const testing = await prompt("test"); has(testing, "Do not redesign or edit production behavior"); has(testing, "ima_lifecycle");
  const review = await prompt("review"); for (const value of ["fresh", "product-read-only", "Critical or Warning", "review-verifier", "REVIEW-NNN", "ima_lifecycle"]) has(review, value);
  const verify = await prompt("review-verify"); for (const value of ["CONFIRMED|WITHDRAWN|PARTIAL", "Do not edit", "one dependency hop"]) has(verify, value);
  const document = await prompt("document"); for (const value of ["exact approved", "external-update manifest", "Serena", "Vestige", "Qdrant", "ima_lifecycle"]) has(document, value);
});


const advisoryPrompts = ["architect", "investigate", "instruct", "prompt-start"];

test("advisory prompts are discoverable, non-mutating terminal contracts distinct from the prompt probe", async () => {
  for (const name of advisoryPrompts) {
    const text = await prompt(name);
    for (const value of ["description:", "argument-hint:", "non-mutating", "does not change the active model", "Stop"]) has(text, value);
    assert.doesNotMatch(text, /\/ima:cycle/i);
  }
  const starter = await prompt("prompt-start");
  for (const value of ["Unlike `/ima:prompt`", "resource-discovery probe", "production inline prompt builder"]) has(starter, value);
});

test("architect favors evidence, simple design, explicit boundaries, and bounded assessment", async () => {
  const text = await prompt("architect");
  for (const value of ["evidence over assumptions", "simple over complex", "simpler viable path", "pure/effect boundaries", "trade-offs", "risks", "do not implement", "Serena-first"]) has(text, value);
});

test("investigate traces evidence and hypotheses without applying fixes", async () => {
  const text = await prompt("investigate");
  for (const value of ["root cause when proven", "ranked hypotheses", "read-only diagnostics", "explore", "vision-handoff", "confidence and disconfirming evidence", "Stop without applying a fix"]) has(text, value);
});

test("instruct teaches safe action without performing it", async () => {
  const text = await prompt("instruct");
  for (const value of ["what to do", "why it matters", "read-only", "low-risk", "state-changing", "destructive", "explore", "vision-handoff", "never performs the work", "Stop after the teaching response"]) has(text, value);
});

test("prompt-start builds one inline ready-to-paste prompt without executing it", async () => {
  const text = await prompt("prompt-start");
  for (const value of ["prompt-building", "not execution", "inline in the current Pi conversation", "ask one focused clarification", "standalone, ready-to-paste prompt", "GUI editor", "write files", "invoke the generated workflow", "Stop after presenting the refined prompt"]) has(text, value);
});

test("visual workflows preserve external-browser evidence and terminal planning boundaries", async () => {
  const ui = await prompt("ui-ux-review");
  for (const value of ["HIGH-tier", "non-mutating", "mcp-chrome-devtools", "vision-handoff", "DOM/accessibility", "keyboard/focus", "console", "network", "Critical", "Do not edit"]) has(ui, value);
  const design = await prompt("design-to-code");
  for (const value of ["HIGH-tier", "WordPress/Bootstrap", "ima_context", "Serena-first", "vision-handoff", "ima_lifecycle", "as `plan`", "/ima:implement-wp", "Do not edit"]) has(design, value);
  for (const name of ["plan", "test", "review", "implement-wp"]) has(await prompt(name), name === "test" ? "visual-diff" : "vision-handoff");
});

test("scorecard and adversarial-review retain bounded quality contracts", async () => {
  const scorecard = await prompt("scorecard");
  for (const value of ["Serena-first", "non-mutating validators", "Code Standards", "Security", "Test Coverage", "Documentation", "Maintainability", "A/B/C/D/F", "cap Code Standards at C", "Scorecard", "later explicit request", "stop read-only"]) has(scorecard, value);
  const adversarial = await prompt("adversarial-review");
  for (const value of ["one complete packet", "adversary-a", "adversary-b", "parallel", "distinct", "provider, model", "one-sided", "Dropped Adversarial Claims", "REVIEW-NNN", "advisory", "/ima:review"]) has(adversarial, value);
  assert.doesNotMatch(adversarial, /ima_lifecycle/);
});

test("specialist research prompts preserve natural-language, terminal, and domain contracts", async () => {
  const medical = await prompt("medical-research");
  for (const value of ["description:", "argument-hint: \"[question]\"", "natural-language", "$@", "empty", "wait", "two or three", "parameter grammar", "emergency", "911", "PICO", "ima-research", "ima-knowledge", "current primary", "funding", "conflicts", "endpoints", "limitations", "Do not diagnose", "prescribe", "educational purposes", "What Is Unsettled", "does not change the active model", "Stop after"]) has(medical, value);
  has(medical, "Do not invoke `/ima:cycle`");

  const patristic = await prompt("patristic-research");
  for (const value of ["description:", "argument-hint: \"[question]\"", "natural-language", "$@", "empty", "wait", "two or three", "parameter grammar", "AD 30–430", "Augustine", "references/Patristic-Quick-Reference.md", "theology", "metadata.collection: fathers", "metadata.era: patristic", "discovery evidence", "verified quotations", "New Advent", "chronologically", "Apostolic Tradition", "pseudepigrapha", "anachronism", "Sources Checked", "does not change the active model", "Stop after"]) has(patristic, value);
  has(patristic, "Do not invoke `/ima:cycle`");
});

test("specialist research skills and packaged patristic references retain their source boundaries", async () => {
  const medical = await skill("ima-medical-research");
  for (const value of ["name: ima-medical-research", "Honest Medicine", "Do not diagnose", "emergency", "ima-research", "Never silently use `ima-knowledge`", "current primary literature", "funding", "conflicts", "PICO", "What Is Unsettled"]) has(medical, value);

  const patristic = await skill("patristic-researcher");
  for (const value of ["name: patristic-researcher", "AD 30–430", "Augustine", "Patristic-Quick-Reference.md", "theology", "metadata.collection: fathers", "metadata.era: patristic", "never as verified quotations", "New Advent", "Apostolic Tradition", "pseudepigrapha", "anachronism", "Sources Checked"]) has(patristic, value);

  for (const name of ["Patristic-Quick-Reference.md", "Index-NT-Epistles.md", "Index-Apostolic-Fathers.md", "Index-Ante-Nicene.md", "Index-Nicene-Post-Nicene.md"]) {
    const content = await readFile(join(root, "skills", "patristic-researcher", "references", name), "utf8");
    assert.ok(content.trim().length > 0, `${name} must be packaged and non-empty`);
  }
});
