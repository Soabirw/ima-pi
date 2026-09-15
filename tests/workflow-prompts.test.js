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
test("lifecycle prompts delegate optional evidence to matching specialists", async () => {
  const specialists = {
    brainstorm: "brainstormer",
    plan: "planner",
    decompose: "decomposer",
    investigate: "investigator",
  };

  for (const [name, specialist] of Object.entries(specialists)) {
    const text = await prompt(name);
    has(text, specialist);
    has(text, "ima-delegation-contract");
  }
});
test("decompose enforces two tiers, one PM destination, preview, and checklist-only work", async () => { const text = await prompt("decompose"); for (const value of ["Taskwarrior Project -> Task", "Jira Epic -> Story/Task", "checklist", "exactly one destination", "never dual-write", "exact persistence preview", "explicit approval", "lifecycle unit", "as `decision`", "stop"]) has(text, value); has(text, "technical files, functions, control flow"); });
test("plan enforces one-unit Serena-first technical planning without implementation", async () => {
  const text = await prompt("plan");
  for (const value of ["exactly one", "/ima:decompose", "ima_context", "Serena-first", "files, modules, symbols, APIs", "pure/effect boundaries", "verification commands", "rollback", "as `plan`", "stop", "ima-lifecycle-contract", "Pi global `AGENTS.md` preferences", "ima-memory-workflow", "two or three", "I will not make code changes in this planning session.", "Problem, Prior Work", "readable-code", "functional-programmer", "ima-security-guardrails", "Standards Impact", "500-line file-size smell", "responsibility/cohesion", "cohesion-based justification"]) has(text, value);
  assert.match(
    text,
    /^- Standards Impact:[^\n]*500-line file-size smell[^\n]*responsibility\/cohesion[^\n]*cohesion-based justification/mi,
  );
  has(text, "Do not edit code/config/content");
});

test("shared lifecycle skill keeps artifact, identity, source-identifier, and cycle-marker boundaries in one source", async () => {
  const text = await skill("ima-lifecycle-contract");
  for (const value of ["name: ima-lifecycle-contract", "artifact is the detailed source of truth", "ima_lifecycle", "generated SDK namespace", "lifecycle_key", "prior_artifact_ids", "Do not create a disconnected lifecycle thread", "exactly one cycle outcome marker", "taskwarrior:<project>:<uuid>", "lifecycle:<lifecycle-key>", "vestige:<UUID>", "canonical colon identifiers", "Tier-1 Qdrant", "No Vestige lifecycle write, recall, or fallback", "summary"]) has(text, value);
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
  for (const value of [
    "implementation-grade",
    "append",
    "corrective",
    "exact files/symbols",
    "control/data/error behavior",
    "tests and acceptance checks",
    "constraints",
    "rejected alternatives",
    "resolution dependencies",
    "rather than merely restating the failure without corrective instructions",
    "must never suppress",
  ]) has(rereview, value);
  assert.match(
    rereview,
    /Preserve each original `REVIEW-NNN` ID;[^\n]*append an implementation-grade corrective handoff[^\n]*rather than merely restating the failure without corrective instructions[^\n]*exact files\/symbols[^\n]*control\/data\/error behavior[^\n]*tests and acceptance checks[^\n]*constraints[^\n]*rejected alternatives[^\n]*resolution dependencies[^\n]*Assign the next unused ID only to an independently verified regression caused by the resolution[^\n]*same complete corrective handoff[^\n]*Do not edit code, reopen unrelated scope, or redesign;[^\n]*must never suppress[^\n]*Apply the `code-review` request-changes gate/,
  );
  has(rereview, "even when rereview runs in a new Pi session");
  const review = await prompt("review");
  has(review, "including when the next phase runs in a new Pi session");
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
    for (const value of ["pre-review test `DEFECTS`", "TEST-NNN", "disposition", "return completed repair work to `/ima:test`", "Block rather than redesign"]) has(text, value);
    has(text, readableCodeDirectives[name]);
    for (const prohibition of ["Do not invoke `/ima:cycle`", "a workflow DSL", "Goose recipes", "subrecipe mechanics", "does not change the active model"]) has(text, prohibition);
  }
});

test("manual lifecycle prompts normalize shared source identifiers before declaring evidence missing", async () => {
  const manualPrompts = ["plan", "implement", "implement-js", "implement-wp", "test", "review", "resolve-review", "rereview", "document"];
  const sourceGrammar = ["taskwarrior:<project>:<uuid>", "taskwarrior <project> <uuid>", "jira:<KEY>", "jira <KEY>", "lifecycle:<lifecycle-key>", "lifecycle <lifecycle-key>", "vestige:<UUID>", "vestige <UUID>", "canonical colon forms", "space-delimited aliases", "reference", "Tier-1 Qdrant"];
  for (const name of manualPrompts) {
    const text = await prompt(name);
    for (const value of sourceGrammar) has(text, value);
  }
  for (const name of ["implement", "implement-js", "implement-wp", "test", "review", "resolve-review", "rereview"]) {
    const text = await prompt(name);
    for (const value of ["ima-memory-workflow", "latest VERIFIED Tier-1 lifecycle artifact", "ima-pi:taskwarrior:<project>:<uuid>", "ima-pi:jira:<KEY>", "unavailable lifecycle corpus evidence"]) has(text, value);
  }
  const rereview = await prompt("rereview");
  has(rereview, "First call `ima_context`");
  assert.ok(rereview.indexOf("First call `ima_context`") < rereview.indexOf("latest VERIFIED Tier-1 lifecycle artifact"));
  const document = await prompt("document");
  assert.ok(document.indexOf("First call `ima_context`") < document.indexOf("recall verified plan"));
  assert.ok(document.indexOf("recall verified plan") < document.indexOf("Fail closed only"));
  const planning = await prompt("plan");
  for (const value of ["ima-memory-workflow", "canonical prefixed source form", "/ima:implement taskwarrior:<project>:<uuid>", "/ima:implement jira:<KEY>", "/ima:implement lifecycle:<lifecycle-key>", "/ima:implement vestige:<UUID>"]) has(planning, value);
  assert.ok(planning.indexOf("ima_context") < planning.indexOf("ima-memory-workflow"));
});

test("documentation prompts reserve canonical document persistence and cycle markers for their respective routes", async () => {
  const document = await prompt("document");
  for (const value of [
    "Persist complete documentation evidence with lifecycle type `document`",
    "distinct from human-authorized `closeout`",
    "manual or `/ima:soft-cycle` document phase",
    "state `READY` or `BLOCKED` explicitly in the summary and detailed phase result",
    "do not add an `ima-cycle` marker",
    "Storage verification confirms persistence and direct read-back, not documentation readiness",
    "Only when the existing `/ima:cycle` coordinator dispatched this phase",
    "exactly one marker",
    "phase=document; outcome=READY",
  ]) has(document, value);

  const softCycle = await prompt("soft-cycle");
  for (const value of [
    "lifecycle type `document`",
    "manual `/ima:soft-cycle` non-plan phases",
    "persistence success alone is not documentation readiness",
  ]) has(softCycle, value);

  const closeout = await prompt("closeout");
  for (const value of [
    "canonical `document` artifacts",
    "A `closeout` artifact is never relabeled as documentation",
    "narrowly verified historical compatibility",
  ]) has(closeout, value);
});

test("manual closeout best-effort matches its source and uses one aggregate approval for an idempotent terminal contract", async () => {
  const text = await prompt("closeout");

  for (const value of [
    "description: Perform manual terminal lifecycle closeout after documented lifecycle evidence",
    'argument-hint: "[completed-lifecycle-source]"',
    "configured `commands.closeout` route",
    "otherwise remain on the current model",
    "Require a non-empty source parameter",
    "make a best effort to resolve it to exactly one supported canonical source",
    "no match, or more than one plausible match",
    "/ima:closeout [completed-lifecycle-source]",
    "First normalize the supplied parameter to one canonical identifier",
    'closed `{ type: "reference", value: "<identifier>" }` source',
    "ima-memory-workflow",
    "ima-lifecycle-contract",
    "ima-git",
    "canonical colon form",
    "Best-effort matching includes trimming surrounding whitespace",
    "extracting one recognizable identifier from a copied command, supported tracker URL, or short prose phrase",
    "using exact read-only lookups to complete a structurally recognizable Plane item, Taskwarrior UUID, lifecycle key, or cited UUID",
    "Do not fuzzy-match titles",
    "exact Tier-1 Qdrant manifest recall",
    "selected direct detail retrieval",
    "approved plan, implementation, test, final review or rereview, and canonical `document` artifacts",
    "Closeout is available only after `/ima:document` has completed",
    "do not invoke `/ima:cycle`, auto-dispatch from document, call a next lifecycle phase, or create a cycle-outcome marker",
    "Read-only source hydration and exact tracker or lifecycle evidence reads are allowed before the final action overview",
    "evidence-backed, itemized final action overview before any state-changing effect",
    "purpose, exact target, evidence, expected effect, reversibility",
    "Approval of that overview is the single confirmation for all presented actions",
    "Approval authorizes every action presented as executable in the approved overview",
    "execute the approved actions without asking for individual confirmations",
    "present a revised complete overview and obtain one new aggregate approval",
    "Git is instruction-driven",
    "never stash, clean, discard, force-push, rewrite history, move or delete tags, or deploy",
    "include `/ima:ship-it` only as a separate recommendation",
    "dry-run never authorizes deployment",
    "Only include tracker closure in the final action overview when the verified canonical source identifies exactly one supported target and the operator asks to close it",
    "Plane:",
    "Jira:",
    "Taskwarrior:",
    "verify identity and receipt by rereading the exact target",
    "Never perform a broad project operation",
    "do not retry the tracker mutation",
    "`commands.closeout` route selection is a **non-secret variable**",
    "self-hosted tracker endpoint, selected workspace/project, and Git remote are **platform bindings**",
    "Tracker authentication material is a **secret**",
    "Taskwarrior context, local repository path, and local configuration are **local-only values**",
    "Never show secret values or credential examples",
    "persist one formal `closeout` artifact through `ima_lifecycle`",
    "Final lifecycle closeout:",
    "## Final Closeout",
    "prior artifact IDs and separate prior artifact record keys",
    "without embedding them",
    "Do not include an `ima-cycle` marker",
    "verifies persistence and direct detail reassembly",
    "distinguish completed actions from recommendations and unperformed human-owned work",
    "then stop",
  ]) has(text, value);

  for (const value of [
    "taskwarrior:<project>:<uuid>",
    "taskwarrior <project> <uuid>",
    "plane:<workspace>:<PROJECT>-<seq>",
    "plane <workspace> <PROJECT>-<seq>",
    "jira:<KEY>",
    "jira <KEY>",
    "lifecycle:<lifecycle-key>",
    "lifecycle <lifecycle-key>",
    "vestige:<UUID>",
    "vestige <UUID>",
  ]) has(text, value);

  assert.ok(text.indexOf("First normalize the supplied parameter") < text.indexOf("exact Tier-1 Qdrant manifest recall"));
  assert.doesNotMatch(text, /<!-- ima-cycle outcome:/i);
  assert.doesNotMatch(text, /individually confirms|Do not batch confirmations|Proposal approval is not authority|requires its own immediate confirmation/i);
});

test("active documentation assigns lifecycle artifacts to Qdrant, current preferences to Pi global AGENTS, and Vestige to legacy boundaries", async () => {
  const [readme, guide, workflow, lifecycle, vestige, conventions, completion] = await Promise.all([
    readFile(join(root, "README.md"), "utf8"),
    readFile(join(root, "docs", "guide.md"), "utf8"),
    skill("ima-memory-workflow"),
    skill("ima-lifecycle-contract"),
    skill("mcp-vestige"),
    readFile(join(root, ".serena", "memories", "conventions.md"), "utf8"),
    readFile(join(root, ".serena", "memories", "task_completion.md"), "utf8"),
  ]);
  for (const text of [readme, guide, workflow, lifecycle]) {
    has(text, "Tier-1 Qdrant");
  }
  for (const text of [readme, guide, workflow]) has(text, "global `AGENTS.md`");
  for (const text of [workflow, lifecycle, vestige]) {
    has(text, "Vestige");
    assert.doesNotMatch(text, /Vestige MCP `smart_ingest`.*lifecycle/i);
  }
  has(vestige, "explicitly cited legacy evidence");
  has(conventions, "Pi global AGENTS.md");
  has(completion, "ima_lifecycle");
});

test("workflow routing treats arbitrary /ima:* tokens as command-keyed candidates", () => {
  assert.deepEqual(parseWorkflowCommand("/ima:resolve-review source"), { command: "ima:resolve-review", name: "resolve-review", args: "source" });
  assert.deepEqual(parseWorkflowCommand("/ima:future-command source"), { command: "ima:future-command", name: "future-command", args: "source" });
  assert.equal(parseWorkflowCommand("/other:command source"), null);
});

test("soft-cycle is a prompt-only delegating SDLC orchestrator with bounded autonomy", async () => {
  const text = await prompt("soft-cycle");
  for (const value of [
    "description:",
    "argument-hint:",
    "guided|autonomous",
    "implementer:",
    "primary orchestrator",
    "delegates every phase",
    "does not change the active model",
    "instruction-based",
    "Do not invoke `/ima:cycle`",
    "ima_context",
    "/ima:decompose",
    "ima-memory-workflow",
    "ima-lifecycle-contract",
    "ima-delegation-contract",
    "readable-code",
    "functional-programmer",
    "ima-security-guardrails",
    "the orchestrator persists",
    "ima_lifecycle",
    "ima_delegate",
    "planner",
    "tester",
    "reviewer",
    "documenter",
    "review-verifier",
    "second opinion",
    "request-changes gate",
    "resumeReference",
    "ima_agent_follow_up",
    "never create a replacement reviewer",
    "resolve",
    "rereview",
    "until",
    "approval",
    "bounded, conflict-free, low-risk",
    "BLOCKED",
    "final verification",
    "never auto-close",
    "stop",
    "ima-cycle outcome: phase=plan",
    "Pre-review test-defect loop",
    "TEST-NNN",
    "newest test passes",
    "Test defects never enter resolution or rereview",
    "dispatch ceiling",
    "untrusted-soft-cycle-input",
    "first standalone `--`",
    "BARE-INSTRUCTIONS",
    "bare uppercase Jira key",
    "approved configured Jira or Plane browse URL",
    "project-relative file path or `file:` path",
    "65,536 JavaScript string units",
    "65,537-unit or larger invocation",
    "256 KiB",
    "64,000 JavaScript UTF-16 code units",
    "same complete matching content",
    "available implementer-capable agent catalog",
    "<project>:manual:<approved-name>:<YYYY-MM-DD>",
    "human-selected resume path",
    "human-selected new path",
    "naming registry",
    "Guided plan approval is human-owned",
    "orchestrator owns plan approval only after the existing safety gate",
    "programmatic soft-cycle parser or coordinator",
    "raw, unvalidated block",
    "fully validated, normalized source",
    "one required `ima_context` call",
    "whitespace-free, project-relative token",
    "each component must be nonempty",
    "ASCII letters, digits, `.`, `_`, or `-`",
    "percent-encoded",
  ]) has(text, value);
  assert.match(text, /one source followed only by\s+controls/i);
  assert.match(text, /never falls back to\s+prose/i);
  assert.match(text, /must not\s+be `\.` or `\.\.`/i);
  assert.match(
    text,
    /Never create or consult a naming registry,[\s\S]*?auto-suffix, merge, overwrite, or similarity-match a manual identity/i,
  );
  assert.match(
    text,
    /Before parsing, trimming, normalizing, validating, or taking any tool action,[\s\S]*?including all leading, trailing, and\s+inter-token whitespace[\s\S]*?65,536 JavaScript string units/i,
  );
  assert.match(
    text,
    /raw file is at most 256 KiB[\s\S]*?complete normalized-context content is at most 64,000 JavaScript UTF-16 code units[\s\S]*?After\s+that single hydration,[\s\S]*?same complete matching content/i,
  );
  assert.match(
    text,
    /manual identity\/new-versus-resume decision and required first-use BookStack placement consent\s+are human-owned[\s\S]*?Guided plan approval is human-owned[\s\S]*?orchestrator owns plan approval only after the existing safety gate/i,
  );
  assert.ok(
    text.indexOf("### Complete expanded-input gate")
      < text.indexOf("### Hydrate only validated input"),
    "the whole-invocation gate must precede hydration",
  );
  assert.equal((text.match(/ima-cycle outcome:/g) ?? []).length, 1);
  assert.match(
    text,
    /expected-empty recall[\s\S]*new normalized Taskwarrior, Jira, Plane, or[\s\S]*proceed to Plan/i,
  );
  assert.match(
    text,
    /matching verified evidence[\s\S]*retrieve selected detail[\s\S]*reuse its lifecycle identity/i,
  );
  assert.match(
    text,
    /explicit lifecycle or requested resume source[\s\S]*missing required artifact is `BLOCKED`/i,
  );
  assert.match(
    text,
    /mismatched,[\s\S]*incomplete, corrupt, or unverified evidence is also `BLOCKED`; stop/i,
  );
});

test("soft-cycle user documentation explains flexible input and manual identity gates", async () => {
  const [readme, guide] = await Promise.all([
    readFile(join(root, "README.md"), "utf8"),
    readFile(join(root, "docs", "guide.md"), "utf8"),
  ]);

  for (const text of [readme, guide]) {
    for (const value of [
      "/ima:soft-cycle SOURCE",
      "[-- INSTRUCTIONS]",
      "first standalone `--`",
      "65,536 JavaScript string units",
      "64,000 JavaScript UTF-16",
      "file:",
      "manual identity",
      "BookStack placement consent",
      "Guided plan approval is human-owned",
      "orchestrator",
      "auto-suffix",
      "whitespace-free",
      "1,024",
    ]) has(text, value);
  }

  assert.match(
    readme,
    /65,537 or more it shows usage and stops without trimming or truncating[\s\S]*?single hydration[\s\S]*?incomplete, changed, truncated, mismatched, or unverifiable content blocks/i,
  );
  assert.match(
    guide,
    /Before parsing,[\s\S]*?complete native Pi-expanded invocation[\s\S]*?leading, trailing, and inter-token whitespace[\s\S]*?65,537 units or more[\s\S]*?without a tool call/i,
  );
  assert.match(
    guide,
    /Before its one hydration,[\s\S]*?256 KiB \(bytes, not characters\)[\s\S]*?64,000 JavaScript UTF-16-code-unit normalized-context[\s\S]*?After that single hydration,[\s\S]*?complete matching content[\s\S]*?no second hydration, chunking, or text fallback/i,
  );

  for (const value of [
    "BARE-INSTRUCTIONS",
    "available implementer-capable agent",
    "256 KiB",
    "String.length",
    "<project>:manual:<approved-name>:<YYYY-MM-DD>",
    "project, proposed name, complete key, validated source/file reference, bounded outcome",
    "[a-z0-9]+(?:-[a-z0-9]+)*",
    "verified UTC date freezes with the approved key",
    "new complete preview, and renewed approval",
    "naming registry, similarity match, auto-suffix, merge, or overwrite",
    "canonical handoff is `lifecycle:<key>`",
    "never arbitrary fetch destinations",
    "not a programmatic parser, coordinator, or general file-import service",
    "every component must be nonempty",
    "ASCII letters, digits, `.`, `_`, or `-`",
    "percent-encoded",
  ]) has(guide, value);

  assert.match(
    guide,
    /human-owned manual identity\/new-versus-resume gate[\s\S]*?explicit `new` or `resume` choice[\s\S]*?exact existing key only resumes[\s\S]*?expected-empty exact key only proceeds/i,
  );
  assert.match(
    guide,
    /manual identity\/new-versus-resume gate and required first-use BookStack placement consent are human-owned[\s\S]*?Guided plan approval is human-owned[\s\S]*?Only after the existing safety gate can the orchestrator approve an eligible autonomous plan; an unsafe autonomous plan blocks/i,
  );
});

test("README distinguishes direct implementation commands, cycle dispatch, and manual source identifiers", async () => {
  const readme = await readFile(join(root, "README.md"), "utf8");
  for (const value of ["direct command `X` resolves `commands[X]`", "`implement-js` and `implement-wp` both use `phases.implement`", "The `/ima:cycle` implementation phase dispatches `implement`", "`commands.implement` then `phases.implement`", "Manual phase source identifiers", "taskwarrior:<project>:<uuid>", "jira:<KEY>", "lifecycle:<lifecycle-key>", "vestige:<UUID>", "space-delimited alias", "plane:<workspace>:<PROJECT>-<seq>", "/ima:cycle start` accepts Jira, Taskwarrior, and Plane sources"]) has(readme, value);
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
  const testing = await prompt("test"); for (const value of ["Do not redesign or edit production behavior", "ima_lifecycle", "unit-testing", "evidence", "smallest project-supported", "ima-security-guardrails", "detected testing contract", "tests or test support added or repaired", "changed files", "commands and results", "behaviors covered", "defects or blockers", "evidence gaps and residual risk", "phase outcome", "recommended next phase", "implementation details", "deep mock chains", "real timers, network, or filesystem", "weaken assertions", "skip markers", "TEST-NNN", "affected acceptance criterion", "On `DEFECTS`", "/ima:implement <canonical-source>", "retest every preserved"] ) has(testing, value);
  const testCycleInstructions = testing.slice(testing.indexOf("When dispatched by `/ima:cycle`"));
  for (const value of ["recommend `/ima:implement <canonical-source>` for `DEFECTS`", "`/ima:review` for `PASSED`", "no advancement for `BLOCKED`"]) has(testCycleInstructions, value);
  assert.doesNotMatch(testCycleInstructions, /stop; recommend `\/ima:review`/i);
  const review = await prompt("review"); for (const value of ["fresh", "product-read-only", "Critical or Warning", "review-verifier", "REVIEW-NNN", "ima_lifecycle", "code-review", "Integration Contract", "request-changes gate", "latest ordered lifecycle evidence", "implementation COMPLETED -> test PASSED", "fresh initial review", "existing formal review"]) has(review, value);
  const rereview = await prompt("rereview"); for (const value of ["code-review", "regression", "next unused ID", "implementation-grade", "append", "corrective", "resolution dependencies", "must never suppress", "Test-origin repairs without an original formal review", "fresh initial review"]) has(rereview, value);
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
    "500-line file-size smell",
    "cohesion-based justification",
    "responsibility/cohesion",
    "rereview",
    "corrective",
    "must never suppress",
    "regression",
    "applies identically to review and rereview",
    "same six-part corrective handoff",
    "preserved `REVIEW-NNN`",
    "independently verified regression caused by the resolution",
    "next unused ID",
    "same complete handoff",
    "failing behavior",
    "root cause",
  ]) has(text, value);
  assert.match(
    text,
    /^- Readability:[^\n]*rule-anchored[^\n]*as a Warning \(blocking under the closeout rule\)/mi,
  );
  assert.match(
    text,
    /^- Readability:[^\n]*500-line file-size smell[^\n]*cohesion-based justification[^\n]*Warning \(blocking under the closeout rule\)[^\n]*responsibility\/cohesion/mi,
  );
  assert.match(
    text,
    /^Apply this requirement equally during rereview:[^\n]*same six-part corrective handoff[^\n]*preserved `REVIEW-NNN`[^\n]*independently verified regression caused by the resolution[^\n]*next unused ID[^\n]*same complete handoff[^\n]*must never suppress[^\n]*$/m,
  );
  assert.match(
    text,
    /^This gate applies identically to review and rereview `REQUEST_CHANGES` verdicts\.$/m,
  );
  assert.match(
    text,
    /^1\. location, failing behavior, root cause, and affected contract or callers;$/m,
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
  for (const value of [
    "deprecated Vestige preference-bootstrap compatibility path",
    "global `AGENTS.md`",
    "no MCP discovery and no Vestige read or write",
    "/ima:memorize",
    "/reload",
    "explicitly cited legacy evidence",
    "separate T7 migration",
    "Do not call Vestige",
    "Stop after",
  ]) has(vestige, value);
  assert.doesNotMatch(vestige, /session_start|smart_ingest|mcp\(\{ connect: "vestige" \}\)/i);
  const memorize = await prompt("memorize");
  for (const value of ["natural language", "parameter grammar", "PI_CODING_AGENT_DIR", "non-empty", "AGENTS.override.md", "AGENTS.MD", "unsupported-active-layout", "would-shadow-active-file", "one complete document", "Never create a heading-only initialization", "ima-preferences", "Serena `core`", "`conventions`", "`tech_stack`", "`suggested_commands`", "`task_completion`", "`memory_maintenance`", "ima_lifecycle", "Qdrant", "secrets", "exact preview", "explicit approval", "built-in native edit or write", "re-read and verify", "duplicate", "ambiguous conflict", "serena_edit_memory", "mode\":\"literal", "allow_multiple_occurrences\":false", "serena_write_memory", "verify", "Stop after one"]) has(memorize, value);
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
    /AGENTS\.override\.md[\s\S]{0,180}unsupported-active-layout[\s\S]{0,100}no mutation/i,
  );
  assert.match(
    memorize,
    /Absent lower-case `AGENTS\.md` plus regular `AGENTS\.MD`[\s\S]{0,180}would-shadow-active-file[\s\S]{0,100}no mutation/i,
  );
  assert.match(
    memorize,
    /For an absent supported lower-case destination[\s\S]{0,300}# User Preferences[\s\S]{0,200}## <the meaningful heading shown in the preview>[\s\S]{0,200}- <the exact approved preference wording>[\s\S]{0,300}one native write[\s\S]{0,180}heading and exact preference/i,
  );
  assert.match(memorize, /Do not edit an override, uppercase AGENTS file, or `CLAUDE` variant/i);
  assert.doesNotMatch(memorize, /preview creation of only `# User Preferences`/i);
  assert.doesNotMatch(memorize, /vestige_smart_ingest/i);
  for (const value of ["ima-memory-workflow", "relevant standard memories", "Do not inspect repository files", "unless the user explicitly asks"]) has(memorize, value);
  const preflight = await prompt("preflight");
  for (const value of ["offline", "quick", "full", "compact `mcp` proxy", "advertised by discovery", "ima_corpus_status", "never discover or invoke Qdrant through `mcp`", "Offline skips live Qdrant/Ollama", "missing package-native corpus tool is FAIL", "PASS, WARN, FAIL, BLOCKED, SKIP, NOT_CONFIGURED", "0700", "bounded line/byte chunks", "redact", "cleanup", "retained", "ima_delegate", "IMA_PI_PREFLIGHT_CHILD_OK", "preflight-probe", "pi-preflight", "Goose subrecipe", "Stop after"]) has(preflight, value);
  assert.doesNotMatch(preflight, /\bdoctor\b/i);
  const migrate = await prompt("migrate");
  for (const value of ["Pi-native", "external through the package MCP adapter", "Serena and Vestige remain external", "Qdrant corpus support is Pi-native", "qdrant-memory", "ima_corpus_*", "~/.pi/agent/ima/config.json", "trusted `.pi/ima/config.json`", "exact redacted preview", "explicit approval", "atomically", "secret", "Validate JSON", "Stop after"]) has(migrate, value);
});

test("BookStack migration prompt retains its exact untrusted invocation arguments", async () => {
  const migrate = await prompt("bookstack-migrate");
  for (const value of [
    "$@",
    "<invocation-arguments>",
    "dry-run <spec-path>",
    "preflight <report-path>",
    "canary <report-path> confirm",
    "apply <report-path> confirm",
    "verify <report-path>",
    "cleanup <report-path> confirm",
    "Usage: /ima:bookstack-migrate",
  ]) has(migrate, value);
});

test("Vestige migration prompt separates dry-run readiness from actual migration", async () => {
  const migrate = await prompt("vestige-migrate");
  for (const value of [
    "$ARGUMENTS",
    "Invocation arguments",
    "untrusted command data",
    "Empty arguments: live migration.",
    "Exactly `dry-run`: dry run.",
    "Exactly `cleanup <report-path> confirm`: cleanup.",
    "unsupported or incomplete arguments",
    "call no tool",
    "Usage: /ima:vestige-migrate [dry-run|cleanup <report-path> confirm]",
    "{ dryRun: true }",
    "{ confirm: true }",
    "literal `confirm` token",
    "exactly once",
    "READY",
    "NOT_READY",
    "never means migrated",
    "Qdrant snapshot",
    "Vestige MCP",
    "does not create",
    "Do not paraphrase",
    "separate migration",
    "idempotent rerun",
    "cleanup",
    "restore",
  ]) has(migrate, value);
});

test("Unit D scoped guidance uses direct package MCP instructions", async () => {
  const guidance = await Promise.all([
    [skill("mcp-serena"), "package MCP adapter"],
    [skill("mcp-vestige"), "explicitly cited `vestige:<UUID>`"],
    [skill("pi-preflight"), "Package MCP adapter"],
    [skill("ima-pi-guide"), "package MCP adapters"],
    [prompt("preflight"), "package MCP adapter"],
    [prompt("migrate"), "package MCP adapter"],
    [prompt("memorize"), "package MCP adapter"],
    [prompt("vestige-bootstrap"), "global `AGENTS.md`"],
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
  for (const value of ["name: pi-preflight", "/ima:preflight", "offline", "quick", "full", "ima_corpus_status", "Qdrant MCP registration is expected", "PASS", "WARN", "FAIL", "BLOCKED", "SKIP", "NOT_CONFIGURED", "package", "agent", "skill", "gateway", "model", "integration", "ima_delegate", "preflight-probe", "configured:false", "READ-ONLY", "FNR-3025"]) has(preflight, value);
  const docs = await skill("pi-doc-guide");
  for (const value of ["name: pi-doc-guide", "installed version-matched", "packages.md", "skills.md", "extensions.md", "prompt-templates.md", "settings.md", "models.md", "providers.md", "security.md", "upstream Pi semantics", "ima-pi", "observed local state", "Cite", "rather than guessing"]) has(docs, value);
  const guide = await skill("ima-pi-guide");
  for (const value of ["name: ima-pi-guide", "installation", "configuration", "operation", "diagnosis", "architecture", "README.md", "docs/foundation", "package resource", "prompts", "/skill:*", "agents", "model-role", "package MCP adapter", "/ima:preflight", "READ-ONLY", "LOCAL WRITE", "EXTERNAL WRITE", "DESTRUCTIVE/RISKY", "pasted secrets"]) has(guide, value);
  for (const text of [preflight, docs, guide]) {
    assert.doesNotMatch(text, /goose-docs\.ai|~\/\.config\/goose|\.goose-aliases|run `goose-cycle`/i);
  }
});
