import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { parseWorkflowCommand } from "../extensions/workflow-routing.ts";
const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const prompt = (name) => readFile(join(root, "prompts", `ima:${name}.md`), "utf8");
const skill = (name) => readFile(join(root, "skills", name, "SKILL.md"), "utf8");
const has = (text, value) => assert.match(text, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
const localMarkdownTargets = (content) => [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
  .map(([, target]) => target.trim().split("#", 1)[0])
  .filter((target) => target && !target.includes("$") && !/^(?:[a-z]+:|\/)/i.test(target));
test("production planning prompts have distinct Pi frontmatter and HIGH-tier authority", async () => { for (const name of ["brainstorm", "decompose"]) { const text = await prompt(name); has(text, "description:"); has(text, "argument-hint:"); has(text, "HIGH-tier"); has(text, "explicit approval"); assert.doesNotMatch(text, /\/ima:cycle|workflow DSL/i); } const planText = await prompt("plan"); for (const value of ["description:", "argument-hint:", "HIGH-tier", "explicit approval", "ima-cycle outcome: phase=plan"]) has(planText, value); assert.doesNotMatch(planText, /workflow DSL/i); });
test("plan prompt makes autonomous self-approval fail safe", async () => {
  const text = await prompt("plan");
  for (const value of ["autonomousPlan", "Self-approve", "BLOCKED", "/ima:decompose", "unresolved questions", "explicit approval", "exact standalone", "Cycle dispatch contract", "source, lifecycle, or evidence field values"]) has(text, value);
});

test("brainstorm owns approved product requirements and stops before decomposition or design", async () => { const text = await prompt("brainstorm"); for (const value of ["problem or opportunity", "users and use cases", "business rules", "product acceptance criteria", "vision-handoff", "lifecycle type `decision`", "/ima:decompose", "stop"]) has(text, value); has(text, "Do **not** decompose PM work"); });
test("decompose enforces two tiers, one PM destination, preview, and checklist-only work", async () => { const text = await prompt("decompose"); for (const value of ["Taskwarrior Project -> Task", "Jira Epic -> Story/Task", "checklist", "exactly one destination", "never dual-write", "exact persistence preview", "explicit approval", "lifecycle unit", "as `decision`", "stop"]) has(text, value); has(text, "technical files, functions, control flow"); });
test("plan enforces one-unit Serena-first technical planning without implementation", async () => {
  const text = await prompt("plan");
  for (const value of ["exactly one", "/ima:decompose", "ima_context", "Serena-first", "files, modules, symbols, APIs", "pure/effect boundaries", "verification commands", "rollback", "as `plan`", "stop", "ima-lifecycle-contract", "Vestige preferences", "two or three", "I will not make code changes in this planning session.", "Problem, Prior Work"]) has(text, value);
  has(text, "Do not edit code/config/content");
});

test("shared lifecycle skill keeps artifact, identity, and cycle-marker boundaries in one source", async () => {
  const text = await skill("ima-lifecycle-contract");
  for (const value of ["name: ima-lifecycle-contract", "artifact is the detailed source of truth", "ima_lifecycle", "generated SDK namespace", "lifecycle_key", "prior_artifact_ids", "Do not create a disconnected lifecycle thread", "exactly one cycle outcome marker"]) has(text, value);
});

const implementationPrompts = ["implement", "implement-js", "implement-wp"];

test("cycle resolution prompts expose exact phase markers and bounded handoffs", async () => {
  const resolution = await prompt("resolve-review");
  const rereview = await prompt("rereview");
  for (const [text, marker, phase] of [[resolution, "phase=resolution", "RESOLVED"], [rereview, "phase=rereview", "APPROVED"]]) {
    has(text, marker);
    has(text, `outcome=${phase}`);
    has(text, "ima_lifecycle");
    has(text, "/ima:cycle");
  }
  for (const value of ["code-review", "ima-security-guardrails", "functional-programmer", "ima-delegation-contract", "REVIEW-NNN", "retained and not withdrawn", "precise evidence", "required observable outcome", "decided files/symbols", "control/data/error behavior", "tests and acceptance checks", "constraints/non-goals", "CONFIRMED", "resolution ordering/dependencies", "resolved", "blocked", "not attempted", "Mechanical line-number adjustment"]) has(resolution, value);
  assert.doesNotMatch(resolution, /remediation brief is `SUFFICIENT`/i);
});
test("implementation prompts expose a MID current-session, plan-bound terminal contract", async () => {
  const readableCodeDirectives = {
    implement: "Always load `readable-code` for universal readability standards before editing, regardless of stack.",
    "implement-js": "Before editing, load `ima-security-guardrails` for applicable security constraints, `readable-code` for universal readability standards, and `functional-programmer` with `js-fp`;",
    "implement-wp": "Before editing, load `ima-security-guardrails` for applicable security constraints, `readable-code` for universal readability standards, and `functional-programmer` with `php-fp` or `php-fp-wordpress`;"
  };
  for (const name of implementationPrompts) {
    const text = await prompt(name);
    for (const value of ["description:", "argument-hint: \"[approved-plan-source]\"", "MID-tier", "current session", "approved", "scope", "non-goals", "ima_context", "Serena-first", "ima_delegate", "ima_lifecycle", "implementation", "contradiction", "verification", "/ima:plan", "/ima:test", "formal test or review"]) has(text, value);
    for (const sharedSkill of ["ima-security-guardrails", "readable-code", "functional-programmer", "ima-delegation-contract"]) has(text, sharedSkill);
    has(text, readableCodeDirectives[name]);
    for (const prohibition of ["Do not invoke `/ima:cycle`", "a workflow DSL", "Goose recipes", "subrecipe mechanics", "does not change the active model"]) has(text, prohibition);
  }
});

test("lifecycle prompts recall verified plans by canonical source lifecycle key", async () => {
  for (const name of ["implement", "implement-js", "implement-wp", "test", "review", "resolve-review", "rereview"]) {
    const text = await prompt(name);
    for (const value of ["ima-memory-workflow", "latest VERIFIED lifecycle artifact", "ima-pi:taskwarrior:<project>:<uuid>", "ima-pi:jira:<KEY>"]) has(text, value);
  }
  const rereview = await prompt("rereview");
  has(rereview, "First call `ima_context`");
  assert.ok(rereview.indexOf("First call `ima_context`") < rereview.indexOf("latest VERIFIED lifecycle artifact"));
  const planning = await prompt("plan");
  for (const value of ["canonical hydratable source form", "/ima:implement taskwarrior <project> <uuid>", "/ima:implement <JIRA-KEY>", "never a raw colon lifecycle key"]) has(planning, value);
});

test("workflow routing treats arbitrary /ima:* tokens as command-keyed candidates", () => {
  assert.deepEqual(parseWorkflowCommand("/ima:resolve-review source"), { command: "ima:resolve-review", name: "resolve-review", args: "source" });
  assert.deepEqual(parseWorkflowCommand("/ima:future-command source"), { command: "ima:future-command", name: "future-command", args: "source" });
  assert.equal(parseWorkflowCommand("/other:command source"), null);
});

test("README distinguishes direct implementation commands from cycle dispatch", async () => {
  const readme = await readFile(join(root, "README.md"), "utf8");
  for (const value of ["direct command `X` resolves `commands[X]`", "`implement-js` and `implement-wp` both use `phases.implement`", "The `/ima:cycle` implementation phase dispatches `implement`", "`commands.implement` then `phases.implement`"]) has(readme, value);
  assert.doesNotMatch(readme, /command routing resolves `commands\.implement`, then explicit legacy `phases\.implement`/);
});

test("workflow prompts declare their phase route without changing authority", async () => {
  const expected = { plan: "`plan` phase", implement: "`implement` phase", test: "`test` route", review: "`review` route", document: "`document` route" };
  for (const [name, phrase] of Object.entries(expected)) has(await prompt(name), phrase);
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
  for (const value of ["primary production", "nonce", "capability", "Sanitize", "escape output", "$wpdb->prepare()", "declare(strict_types=1)", "do_action()", "apply_filters()", "function_exists()", "WordPress APIs", "hooks", "actions/filters", "vision-handoff"]) has(text, value);
  for (const value of ["For AJAX handlers, verify a nonce with `wp_verify_nonce()` or `check_ajax_referer()` before processing", "privileged operations additionally authorize the caller with `current_user_can()`", "intentional public handlers do not require an authenticated capability check"]) has(text, value);
  assert.doesNotMatch(text, /For every state-changing or privileged action, verify a nonce and separately enforce capability\/authorization checks/i);
});


test("quality and learning prompts retain distinct bounded terminal contracts", async () => {
  for (const name of ["test", "review", "review-verify", "document"]) { const text = await prompt(name); has(text, "description:"); has(text, "argument-hint:"); has(text, "stop"); has(text, "/ima:cycle"); }
  const testing = await prompt("test"); for (const value of ["Do not redesign or edit production behavior", "ima_lifecycle", "unit-testing", "evidence", "smallest project-supported", "ima-security-guardrails", "detected testing contract", "tests or test support added or repaired", "changed files", "commands and results", "behaviors covered", "defects or blockers", "evidence gaps and residual risk", "phase outcome", "recommended next phase", "implementation details", "deep mock chains", "real timers, network, or filesystem", "weaken assertions", "skip markers"]) has(testing, value);
  const review = await prompt("review"); for (const value of ["fresh", "product-read-only", "Critical or Warning", "review-verifier", "REVIEW-NNN", "ima_lifecycle", "code-review", "Integration Contract", "request-changes gate"]) has(review, value);
  const rereview = await prompt("rereview"); for (const value of ["code-review", "regression", "next unused ID"]) has(rereview, value);
  const verify = await prompt("review-verify"); for (const value of ["CONFIRMED|WITHDRAWN|PARTIAL", "Do not edit", "one dependency hop", "only that evidence range", "code-review", "malformed brief"]) has(verify, value); assert.doesNotMatch(verify, /range, named remediation surface/i);
  const document = await prompt("document"); for (const value of ["exact approved", "external-update manifest", "Serena", "Vestige", "Qdrant", "ima_lifecycle"]) has(document, value);
  for (const value of ["ima-memory-workflow", "ima-vision-handoff", "ima-delegation-contract", "active docs", "archive docs", "transient notes", "high-signal", "document-assessor", "documenter", "writeScope"]) has(document, value);
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
  for (const value of ["what to do", "why it matters", "read-only", "low-risk", "state-changing", "destructive", "explore", "vision-handoff", "ima-memory-workflow", "ima-pi-guide", "before making domain-specific claims", "never performs the work", "Stop after the teaching response"]) has(text, value);
});

test("prompt-start builds one inline ready-to-paste prompt without executing it", async () => {
  const text = await prompt("prompt-start");
  for (const value of ["prompt-building", "not execution", "inline in the current Pi conversation", "pre-approved", "/ima:plan", "ask one focused clarification", "standalone, ready-to-paste prompt", "GUI editor", "write files", "invoke the generated workflow", "Stop after presenting the refined prompt"]) has(text, value);
});

test("visual workflows preserve external-browser evidence and terminal planning boundaries", async () => {
  const ui = await prompt("ui-ux-review");
  for (const value of ["HIGH-tier", "non-mutating", "mcp-chrome-devtools", "vision-handoff", "DOM/accessibility", "keyboard/focus", "console", "network", "Critical", "Do not edit"]) has(ui, value);
  const design = await prompt("design-to-code");
  for (const value of ["HIGH-tier", "WordPress/Bootstrap", "ima_context", "Serena-first", "vision-handoff", "ima_lifecycle", "as `plan`", "/ima:implement-wp", "Do not edit"]) has(design, value);
  for (const name of ["plan", "test", "review", "implement-wp"]) has(await prompt(name), name === "test" ? "visual-diff" : "vision-handoff");
});

test("visual prompt restorations name skills and guardrails", async () => {
  const design = await prompt("design-to-code");
  assert.match(design, /^Load installed skills only where evidence requires them\.[^\n]*`ima-vision-handoff`[^\n]*`ima-memory-workflow`[^\n]*`ima-brand`[^\n]*`ima-bootstrap`[^\n]*`livecanvas`[^\n]*`php-fp-wordpress`[^\n]*`mcp-atlassian`[^\n]*`mcp-context7`[^\n]*`playwright`[^\n]*`ima-delegation-contract`[^\n]*$/mi);
  assert.match(design, /^Separate visual facts,[^\n]*Bootstrap utilities before custom CSS[^\n]*IMA SCSS variables and mixins before hard-coded values[^\n]*reusable components before new abstractions[^\n]*$/mi);
  for (const value of ["Never hard-code IMA colors when brand variables exist.", "Never paraphrase design copy unless copywriting is requested.", "Verify asset paths before specifying implementation work.", "Do not duplicate site header, footer, or global components.", "Do not broaden the work into an unrelated redesign or refactor."]) assert.match(design, new RegExp(`^- ${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "mi"));
  for (const value of ["1. Goal", "2. Source Material", "3. Visual Requirements", "4. WordPress/Bootstrap Mapping", "5. Implementation Scope + non-goals", "6. Responsive & Accessibility Requirements", "7. Security & Data Boundaries", "8. Verification", "9. Open Questions"]) assert.match(design, new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "mi"));
  assert.doesNotMatch(design, /\b(?:ETA|sub_recipes)\b/i);

  const ui = await prompt("ui-ux-review");
  assert.match(ui, /^For a live target,[^\n]*`mcp-chrome-devtools`[^\n]*$/mi);
  assert.match(ui, /^Load only skills supported by the review evidence:[^\n]*`ima-vision-handoff`[^\n]*`ima-memory-workflow`[^\n]*`ima-bootstrap`[^\n]*`ima-brand`[^\n]*`mcp-context7`[^\n]*`playwright`[^\n]*(?:`mcp-serena`(?: or `rg`)?|`rg`)[^\n]*`ima-delegation-contract`[^\n]*$/mi);
  assert.match(ui, /^Review accessibility for [^\n]*semantic landmarks[^\n]*keyboard reachability[^\n]*focus visibility[^\n]*control labels[^\n]*heading order[^\n]*target size[^\n]*contrast risk[^\n]*alt text[^\n]*reduced-motion risk[^\n]*screen-reader name\/role\/value\. Review responsive behavior for [^\n]*wrapping[^\n]*overflow[^\n]*stacking order[^\n]*sticky\/fixed elements[^\n]*tables[^\n]*forms[^\n]*media crops[^\n]*touch targets[^\n]*text fit\. Check interaction states: hover[^\n]*focus[^\n]*active[^\n]*disabled[^\n]*empty[^\n]*loading[^\n]*validation errors[^\n]*modal\/drawer[^\n]*navigation[^\n]*long content\.$/mi);
  assert.match(ui, /^For CSS and Bootstrap guidance,[^\n]*utilities first[^\n]*IMA SCSS variables and mixins[^\n]*\.container\/\.row\/\.col-\{bp\}-\{n\}[^\n]*\.ima-row\/\.ima-col-\{bp\}-\{n\}[^\n]*Avoid hard-coded IMA colors[^\n]*one-off media queries[^\n]*nested or decorative card shells[^\n]*Apply a concise UX lens:[^\n]*primary user job[^\n]*next action obvious[^\n]*controls are discoverable[^\n]*labels are concrete[^\n]*long, missing, loading, or error content[^\n]*small widths with touch and keyboard input\.$/mi);
  assert.doesNotMatch(ui, /\b(?:ETA|sub_recipes)\b|review-and-patch/i);
});

test("code-review skill restores the Pi-native verified-review contract", async () => {
  const text = await skill("code-review");
  for (const value of [
    "name: code-review",
    "Four passes",
    "Integration Contract",
    "VERDICT: CONFIRMED|WITHDRAWN|PARTIAL",
    "REVIEW-NNN",
    "Request-changes gate",
    "refactor as needed",
    "readable-code",
    "Readability:",
    "rule-anchored",
    "blocking under the closeout rule",
  ]) has(text, value);
  assert.match(
    text,
    /^- Readability:[^\n]*rule-anchored[^\n]*as a Warning \(blocking under the closeout rule\)/mi,
  );
  assert.doesNotMatch(text, /sub_recipes|\.eta/i);
  await Promise.all(localMarkdownTargets(text).map((target) => access(resolve(root, "skills", "code-review", target))));
});

test("scorecard and adversarial-review retain bounded quality contracts", async () => {
  const scorecard = await prompt("scorecard");
  for (const value of ["Serena-first", "non-mutating validators", "Code Standards", "Security", "Test Coverage", "Documentation", "Maintainability", "A/B/C/D/F", "cap Code Standards at C", "Scorecard", "later explicit request", "stop read-only"]) has(scorecard, value);
  for (const value of ["code-review", "php-fp", "js-fp", "mcp-serena", "composer.json", "package.json", "Top Improvements"]) has(scorecard, value);
  assert.doesNotMatch(scorecard, /\brails\b/i);
  assert.doesNotMatch(scorecard, /ima-editorial-scorecard/i);
  const adversarial = await prompt("adversarial-review");
  for (const value of ["one complete packet", "adversary-a", "adversary-b", "parallel", "distinct", "provider, model", "one-sided", "Dropped Adversarial Claims", "REVIEW-NNN", "advisory", "/ima:review", "code-review", "ima-delegation-contract"]) has(adversarial, value);
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


test("FNR-3025 support prompts encode gateway, safety, and terminal contracts", async () => {
  const serena = await prompt("serena-bootstrap");
  for (const value of ["description:", "argument-hint:", "direct Serena tools to activate", "instructions", "list memories", "core", "conventions", "tech_stack", "suggested_commands", "task_completion", "PASS, MISSING, or FAIL", "Do not pass a Taskwarrior project", "Stop after"]) has(serena, value);
  has(serena, "package MCP adapter");
  const vestige = await prompt("vestige-bootstrap");
  for (const value of ["session_start", "recall", "Discover Vestige", "PASS, EMPTY, FAIL, or SKIP", "Never ingest", "Stop after"]) has(vestige, value);
  const memorize = await prompt("memorize");
  for (const value of ["natural language", "parameter grammar", "Vestige preference", "Serena `core`", "`conventions`", "`tech_stack`", "`suggested_commands`", "`task_completion`", "`memory_maintenance`", "ima_lifecycle", "Qdrant", "secrets", "exact preview", "explicit approval", "vestige_smart_ingest", "serena_edit_memory", "mode\":\"literal", "allow_multiple_occurrences\":false", "serena_write_memory", "verify", "Stop after one"]) has(memorize, value);
  assert.match(
    memorize,
    /serena_edit_memory[\s\S]{0,500}"mode":"literal"[\s\S]{0,250}"allow_multiple_occurrences":false[\s\S]{0,200}Reject zero-match or multiple-match ambiguity/i,
  );
  assert.match(
    memorize,
    /serena_write_memory[\s\S]{0,300}verify by exact `serena_read_memory`/i,
  );
  assert.match(
    memorize,
    /vestige_smart_ingest[\s\S]{0,500}single mode[\s\S]{0,250}smart merge\/supersession[\s\S]{0,250}`forceCreate:true` only with explicit user approval[\s\S]{0,250}verify with focused `recall` or `session_start`/i,
  );
  for (const value of ["ima-memory-workflow", "relevant standard memories", "Do not inspect repository files", "unless the user explicitly asks"]) has(memorize, value);
  const preflight = await prompt("preflight");
  for (const value of ["offline", "quick", "full", "compact `mcp` proxy", "advertised by discovery", "PASS, WARN, FAIL, BLOCKED, SKIP, NOT_CONFIGURED", "0700", "bounded line/byte chunks", "redact", "cleanup", "retained", "ima_delegate", "IMA_PI_PREFLIGHT_CHILD_OK", "preflight-probe", "pi-preflight", "Goose subrecipe", "Stop after"]) has(preflight, value);
  assert.doesNotMatch(preflight, /\bdoctor\b/i);
  const migrate = await prompt("migrate");
  for (const value of ["Pi-native", "external through the package MCP adapter", "Serena, Vestige, or Qdrant", "~/.pi/agent/ima/config.json", "trusted `.pi/ima/config.json`", "exact redacted preview", "explicit approval", "atomically", "secret", "Validate JSON", "Stop after"]) has(migrate, value);
});

test("Unit D scoped guidance uses direct package MCP instructions", async () => {
  const guidance = await Promise.all([
    [skill("mcp-serena"), "package MCP adapter"],
    [skill("mcp-vestige"), "direct Vestige tools through mcp"],
    [skill("pi-preflight"), "Package MCP adapter"],
    [skill("ima-pi-guide"), "package MCP adapters"],
    [prompt("preflight"), "package MCP adapter"],
    [prompt("migrate"), "package MCP adapter"],
    [prompt("memorize"), "package MCP adapter"],
    [prompt("vestige-bootstrap"), "package MCP adapter"],
  ].map(async ([content, directEvidence]) => [await content, directEvidence]));

  for (const [text, directEvidence] of guidance) {
    has(text, directEvidence);
  }
});

test("FNR-3026 ship-it prompt and Git skill preserve release safety without deployment authority", async () => {
  const shipIt = await prompt("ship-it");
  const git = await skill("ima-git");
  for (const value of ["description: Prepare and validate staging release branches", "argument-hint: \"stg|prod [project-path] [release details]\"", "natural-language", "$@", "current working directory", "stg", "prod", "main", "release/*", "v*", "fast-forward", "clean worktree", "git fetch origin --tags --prune", "ship-it script", ".ima-ship-it.json", "npm run ship-it -- stg --dry-run", "npm run ship-it -- prod --dry-run", "npm run ship-it -- stg", "npm run ship-it -- prod", "not executed", "immutable tag", "force", "history rewrite", "latest project ship-it/deploy log", "git rev-parse HEAD", "git cat-file -t <tag>", "refs/tags/<tag>^{}", "captured release commit SHA", "direct tag object", "absent or mismatched", "exit evidence", "Do **not** execute", "stop"]) has(shipIt, value);
  has(shipIt, "do not invoke `/ima:cycle`, persist a lifecycle artifact, or enter a workflow DSL");
  for (const value of ["name: \"ima-git\"", "main", "release/*", "v*", "hotfix", "fast-forward", "Never force-push", "dry-run", "actual deployment authority", "Exit code", "preflight failure", "remote push failure", "direct remote tag-object ref to exist", "peeled remote `^{}` target to equal the expected release commit"]) has(git, value);
  assert.doesNotMatch(git, /direct remote tag object and its peeled remote `\^\{\}` target equal to the expected release commit/);
});


test("FNR-3033 Pi operational guidance skills retain approved contracts", async () => {
  const preflight = await skill("pi-preflight");
  for (const value of ["name: pi-preflight", "/ima:preflight", "offline", "quick", "full", "PASS", "WARN", "FAIL", "BLOCKED", "SKIP", "NOT_CONFIGURED", "package", "agent", "skill", "gateway", "model", "integration", "ima_delegate", "preflight-probe", "configured:false", "READ-ONLY", "FNR-3025"]) has(preflight, value);
  const docs = await skill("pi-doc-guide");
  for (const value of ["name: pi-doc-guide", "installed version-matched", "packages.md", "skills.md", "extensions.md", "prompt-templates.md", "settings.md", "models.md", "providers.md", "security.md", "upstream Pi semantics", "ima-pi", "observed local state", "Cite", "rather than guessing"]) has(docs, value);
  const guide = await skill("ima-pi-guide");
  for (const value of ["name: ima-pi-guide", "installation", "configuration", "operation", "diagnosis", "architecture", "README.md", "docs/foundation", "package resource", "prompts", "/skill:*", "agents", "model-role", "package MCP adapter", "/ima:preflight", "READ-ONLY", "LOCAL WRITE", "EXTERNAL WRITE", "DESTRUCTIVE/RISKY", "pasted secrets"]) has(guide, value);
  for (const text of [preflight, docs, guide]) {
    assert.doesNotMatch(text, /goose-docs\.ai|~\/\.config\/goose|\.goose-aliases|run `goose-cycle`/i);
  }
});
