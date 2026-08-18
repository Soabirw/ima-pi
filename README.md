# ima-pi

Pi-native IMA agent harness, packaged through Pi's standard Git/npm package model.

## Features

- **52 packaged skills and 29 `/ima:*` prompt templates** for engineering, web, WordPress, IMA, MCP, research, and operational workflows.
- **Pi-native package resources**—prompts, skills, agents, extensions, policies, and configuration guidance—distributed through Pi's normal Git/npm package model.
- **Memory-aware project work:** Serena provides stable project context, Vestige preserves task decisions and lifecycle artifacts, and Qdrant stores durable reference knowledge. These are external integrations, not bundled services.
- **A guided development lifecycle with bounded autonomy:** use the manual phases or the explicit, user-gated `/ima:cycle`; autonomous progression requires an approved bounded, conflict-free, low-risk plan and verified evidence, and it stops at `document`.
- **Bounded specialist delegation** keeps work scoped while parent-owned lifecycle gates preserve accountability.

Start with the [package guide](docs/guide.md). For the memory and lifecycle contracts, see [FNR-3016](docs/foundation/FNR-3016.md) and [FNR-3036](docs/foundation/FNR-3036.md).

## Install and get started

Prerequisites: Node.js 24+ and a current Pi installation. Install the complete package through Pi's normal Git-package mechanism:

```bash
pi install ssh://git@gitea.theflccc.org:2222/IMA/ima-pi.git
```

Open Pi after installation and use an `/ima:*` command (for example `/ima:plan`) or inspect packaged guidance through `/skill:*`. The full onboarding path—configuration, model roles, commands, agents, skills, integrations, degradation, troubleshooting, updates/removal, and checkout development—is in [`docs/guide.md`](docs/guide.md).

`npm run install:skills` is **optional** cross-harness synchronization for `~/.agents/skills`; Pi installation, package discovery, and normal operation do not require it. Use installed-version Pi help for update/removal syntax. The team comparison is [Lesson 13: Claude Code, Goose, and Pi Workflows](https://flccc.atlassian.net/wiki/spaces/FNR/pages/845611010/Lesson+13+Claude+Code+Goose+and+Pi+Workflows).

## Core engineering skills

Pi discovers these package skills directly:

```text
/skill:architect
/skill:functional-programmer
/skill:readable-code
/skill:js-fp
/skill:php-fp
/skill:py-fp
/skill:ruby-fp
/skill:rg
/skill:ima-git
/skill:gh-cli
/skill:tea-gitea
```

See [`docs/foundation/FNR-3027.md`](docs/foundation/FNR-3027.md) for source coverage, Ruby reference repairs, verification, limitations, and rollback.

## JavaScript, browser, API, and testing skills

Pi also discovers native guidance for JavaScript API/framework work, WordPress/browser behavior, and pragmatic testing:

```text
/skill:js-fp-api
/skill:js-fp-react
/skill:js-fp-vue
/skill:js-fp-wordpress
/skill:jquery
/skill:playwright
/skill:unit-testing
```

See [`docs/foundation/FNR-3028.md`](docs/foundation/FNR-3028.md) for source coverage, Pi-native skill semantics, verification, limitations, and rollback.

## WordPress, PHP, and IMA site-building skills

Pi also discovers native guidance for production WordPress/PHP and IMA site-building work:

```text
/skill:php-fp-wordpress
/skill:phpunit-wp
/skill:wp-ddev
/skill:ima-bootstrap
/skill:livecanvas
/skill:ima-forms-expert
/skill:php-authnet
```

DDEV is the supported local WordPress environment. LocalWP support is deprecated and not packaged. Standalone `ima-brand` remains assigned to FNR-3031; `ima-bootstrap` includes implementation-level brand guidance only.

See [`docs/foundation/FNR-3029.md`](docs/foundation/FNR-3029.md) for source coverage, security boundaries, verification, limitations, and rollback.

## IMA brand, editorial, email, and research skills

Pi discovers IMA content and domain guidance directly:

```text
/skill:ima-brand
/skill:ima-copywriting
/skill:ima-editorial-scorecard
/skill:ima-editorial-workflow
/skill:ima-email-creator
/skill:ima-medical-research
/ima:medical-research
/skill:patristic-researcher
/ima:patristic-research
```

The editorial scorecard is distinct from engineering `/ima:scorecard`; the editorial workflow is skill-only. Email helpers have optional Python dependencies and are never installed automatically. See [`docs/foundation/FNR-3031.md`](docs/foundation/FNR-3031.md) for source coverage, safety boundaries, verification, limitations, and rollback.

## MCP, browser, research, and work-management skills

Pi discovers these package skills directly:

/skill:mcp-serena
/skill:mcp-vestige
/skill:mcp-qdrant
/skill:mcp-atlassian
/skill:mcp-taskwarrior
/skill:mcp-context7
/skill:mcp-tavily
/skill:mcp-fetch
/skill:mcp-sequential-thinking
/skill:mcp-chrome-devtools

Eight direct MCP servers use the package adapter. Atlassian uses its packaged REST helper and Taskwarrior uses the native CLI. For team or global installation, run `pi install ssh://git@gitea.theflccc.org:2222/IMA/ima-pi.git`; this unpinned private-Gitea source was verified in an isolated Pi home on 2026-08-03. For local development only, run `pi install /home/eric/IMA/dev/ima-pi`. Updates are explicit with `pi update --extensions` or `pi update --all`. Synchronize shared Agent Skills with `npm run install:skills`. See [`docs/foundation/FNR-3032.md`](docs/foundation/FNR-3032.md) for prerequisites, source coverage, manual acceptance, limitations, and rollback.

## Try the package

```bash
pi -e .
```

Then try:

```text
/ima:probe package
/ima:prompt hello
/ima:delegate-probe start <provider>/<model>
/ima:control-probe start <provider>/<model> <provider>/<model>
/ima:gateway-probe <provider>/<model>
/ima:vision-probe <provider>/<model> <absolute-image-path>
```

`/ima:delegate-probe`, `/ima:control-probe`, `/ima:gateway-probe`, and `/ima:vision-probe` are bounded technical-spike entry points, not production orchestration interfaces. The gateway probe performs one intentional semantic Vestige ingestion while Serena and Qdrant remain read-only. The control probe accepts `/ima:control-probe cancel <run-id> <a|b>` after startup; see its spike document for live acceptance steps and limitations.

## Production support workflows

- `/ima:serena-bootstrap [context]` loads Serena instructions and standard project memories through direct MCP, read-only.
- `/ima:vestige-bootstrap [topic]` reads relevant user preferences through direct MCP without mutation.
- `/ima:memorize [what should be remembered]` lets users say what should be remembered; it infers project memory versus cross-project preference, asks only when scope is ambiguous, previews exact wording, and requires approval before one verified write.
- `/ima:preflight [offline|quick|full or request]` reports bounded read-only Pi/IMA diagnostics. It can spool large raw gateway evidence into restrictive temporary files and optionally retain only a redacted final report.
- `/ima:migrate [request]` classifies legacy configuration and, after an exact preview and approval, writes only supported Pi/IMA configuration atomically.

See [`docs/foundation/FNR-3025.md`](docs/foundation/FNR-3025.md) for source coverage, authority boundaries, verification, limitations, and rollback.

## Pi operational guidance

- `/skill:pi-preflight` explains evidence-led, read-only Pi and IMA diagnostic scopes and routes executable checks to `/ima:preflight`.
- `/skill:pi-doc-guide` requires version-matched Pi documentation before Pi-specific guidance.
- `/skill:ima-pi-guide` routes installation, configuration, operation, diagnosis, architecture, and integration questions to the smallest supported evidence source.

See [`docs/foundation/FNR-3033.md`](docs/foundation/FNR-3033.md) for source disposition and verification.

## Release preparation

- `/ima:ship-it stg [project-path]` prepares/pushes a fast-forward `release/*` branch and runs its staging dry-run.
- `/ima:ship-it prod [project-path]` prepares/pushes a new immutable annotated `v*` tag from a pushed release branch and runs its production dry-run.

Both recommend, but never execute, the real deployment command after successful validation. See [`docs/foundation/FNR-3026.md`](docs/foundation/FNR-3026.md) for source coverage, authority boundaries, verification, limitations, and rollback.

## Production advisory workflows

- `/ima:architect [source]` produces a bounded, evidence-oriented architecture assessment and favors the simplest viable design.
- `/ima:investigate [source]` traces symptoms and reports a proven root cause or ranked hypotheses without applying a fix.
- `/ima:instruct [source]` researches enough to teach what to do and why, labels command risk, and never performs the work.
- `/ima:prompt-start [rough-context]` produces one standalone, ready-to-paste prompt inline without executing or persisting it.
- `explore` remains the fast read-only repository specialist and is invoked through `ima_delegate` with a complete bounded assignment; inspect it with `/ima:agents`.

All five are advisory and non-mutating, and they stop without implementing. They are optional bounded operations rather than stages in the formal delivery sequence. `/ima:prompt` remains the resource-discovery probe, while `/ima:prompt-start` is the production prompt builder. See [`docs/foundation/FNR-3020.md`](docs/foundation/FNR-3020.md) for source disposition, authority boundaries, integration, verification, and limitations.

## Production workflow prompts

### Lifecycle at a glance

Use the manual phases when you want to control each handoff, or use `/ima:cycle` to coordinate one explicit Story.

```text
main:    plan -> implement -> test -> review -- APPROVED --> document -- READY --> close (human-confirmed)
changes: review -- REQUEST_CHANGES --> resolution -> rereview
         rereview -- APPROVED --> document
         rereview -- REQUEST_CHANGES --> resolution
```

Guided mode waits for an explicit human `resume` after each phase. Autonomous mode begins only when the strict plan gate accepts one bounded, conflict-free, low-risk unit; verified progression ends at `document`, and blockers stop it. `close` is always a separate, human-confirmed action. See [FNR-3036](docs/foundation/FNR-3036.md) for commands, safety gates, and lifecycle evidence.

- `/ima:brainstorm [source]` turns an idea or evidence into approved product requirements; it does not decompose or technically design.
- `/ima:decompose [requirements-source]` creates exactly a Taskwarrior Project → Task or Jira Epic → Story/Task hierarchy, with lower-level work kept as checklists. It previews one PM destination and requires approval before persistence.
- `/ima:plan [story-or-task-source]` creates an approved technical implementation contract for one bounded delivery unit; it does not implement or execute work.
- `/ima:cycle start [--review-cap 0-10] [--implementation generic|js|wp] [--mode guided|autonomous] <source>` starts one explicit, branch-aware lifecycle (default review cap: five). A source is one Jira key/supported browse URL or `taskwarrior <project> <uuid>`; a Story is the lifecycle unit, not each checklist. Generic is the new-cycle implementation default, the selected implementation mode persists, and all modes use the configured `implement` route. Cycle mode defaults to `guided`. A guided `start` holds the plan for explicit human approval. `start --mode autonomous` lets the plan agent self-approve only one bounded, conflict-free, low-risk delivery unit with no unresolved product, architecture, security, rollout, or verification questions; otherwise it persists `plan BLOCKED` and stops, recommending `/ima:decompose` for multiple delivery units. `resume --autonomous` persists autonomous progression after a guided plan, while `resume --guided` returns the cycle to guided mode. Cycle intent/configuration and the last-known phase persist in project-local `.ima-cycle/active.json`; `.ima-cycle/.gitignore` self-ignores that local cache without changing the repository root `.gitignore`. State writes before prompt injection, while handshake failure is advisory. `status`, `stop`, and `close` remain user-gated. Guided `resume` dispatches only one phase; after an approved autonomous plan, autonomous mode advances only with verified lifecycle evidence through `document`, then stops at human-gated close. Autonomous stop needs no `--ack`; guided stops retain the write-phase acknowledgement. On session start, before reporting, or before dispatching, active state reconciles matching verified persisted lifecycle evidence; recovery may append evidence but never auto-progresses a phase. A verified artifact without a deterministic valid outcome preserves state and names the artifact for inspection. `resume` may retry a phase blocked by its explicit `BLOCKED` outcome after the external blocker is corrected; review-cap, defect, invalid-transition, and post-tracker-close blocks remain terminal. Normal close requires TUI confirmation, while `close --commit-prep` is read-only.

Each selected Story follows `plan -> implement -> test -> review -> resolution/rereview -> document -> close`. `/ima:cycle` coordinates that fixed lifecycle without becoming a workflow DSL or mutating unrelated trackers. It never auto-closes a tracker; after the bounded plan gate, autonomous mode is limited to the verified implementation-to-document tail. See [`docs/foundation/FNR-3017.md`](docs/foundation/FNR-3017.md) and [`docs/foundation/FNR-3036.md`](docs/foundation/FNR-3036.md) for authority, integration, safeguards, limitations, and human acceptance.

- `/ima:implement [approved-plan-source]` executes a plan for mixed, ambiguous, or non-JavaScript/non-WordPress stacks.
- `/ima:implement-js [approved-plan-source]` executes a plan for known JavaScript/TypeScript work.
- `/ima:implement-wp [approved-plan-source]` executes a plan for production WordPress/PHP work with nonce, authorization, sanitization, contextual escaping, and prepared-query requirements.

All implementation prompts require an approved implementation-grade plan, work in the current session with configured MID intent, may delegate bounded work, stop with evidence on material contradictions, and persist verified implementation lifecycle evidence. They run only immediate plan-authorized verification and never automatically enter formal testing or review. Before expansion, direct command `X` resolves `commands[X]`, then its explicit legacy phase fallback; `implement-js` and `implement-wp` both use `phases.implement` as that fallback, otherwise the session model remains unchanged. The `/ima:cycle` implementation phase dispatches `implement`, so it resolves `commands.implement` then `phases.implement`. See [`docs/foundation/FNR-3018.md`](docs/foundation/FNR-3018.md) for source disposition, routing, safeguards, and live acceptance limitations.

- `/ima:test [implementation-source]` performs bounded test work without silently changing production behavior.
- `/ima:review [implementation-and-test-source]` runs a fresh product-read-only review and fresh second opinions for Critical/Warning candidates.
- `/ima:resolve-review [review-and-implementation-source]` resolves only confirmed review findings within the fixed review-loop cap.
- `/ima:rereview [resolution-and-review-source]` independently verifies the resolution without editing.
- `/ima:review-verify [finding-brief]` returns exactly one narrow finding verdict.
- `/ima:document [completed-lifecycle-source]` updates only exact local documentation targets and prepares parent-owned external update manifests.
- `/ima:profile [name]` lists or activates configured command routes and model roles, then persists an explicit selection to the user default without changing ordinary prompt/model flexibility.
- `/ima:new [low|mid|high|xhigh|<discovered-ima-command>]` creates a TUI-only fresh session. Bare `/ima:new` applies no explicit route; role selectors apply the effective configured `LOW`, `MID`, `HIGH`, or `XHIGH` role; command selectors use the same command lookup as direct prompts. An unconfigured command starts on the current model. A verified regular-file parent is linked; missing, unwritten, inaccessible, or non-file parents are omitted so native persisted/ephemeral session semantics are preserved. A successful replacement runs Serena then Vestige bootstrap bodies and any mapped package skill bodies (currently `plan` seeds `ima-lifecycle-contract` and `implement`-family commands seed `readable-code`).

See [`docs/foundation/FNR-3019.md`](docs/foundation/FNR-3019.md) for authority, review verification fallback, knowledge routing, and limitations. See [`docs/foundation/phase-model-profiles.md`](docs/foundation/phase-model-profiles.md) for command routing and fail-closed behavior.

## Quality advisory workflows

- `/ima:scorecard [target]` produces a read-only, evidence-backed A/B/C/D/F assessment for Code Standards, Security, Test Coverage, Documentation, and Maintainability using only existing configured non-mutating validators. It displays paste-ready Markdown; a later explicit request may update only that exact scorecard section in one unambiguous README.
- `/ima:adversarial-review [target]` gives one evidence packet to two fresh, read-only adversaries in parallel. It requires configured, catalog-available `adversaryA` and `adversaryB` routes with distinct `(provider, model)` identities and blocks rather than falling back or accepting one-sided results.

Adversarial reports are advisory only: they do not create formal review state or `REVIEW-NNN` findings. Use `/ima:review` for formal review. See [`docs/foundation/FNR-3022.md`](docs/foundation/FNR-3022.md) for source-to-target coverage, authority, tests, manual acceptance, limitations, and rollback.

## Visual workflows

- `/ima:ui-ux-review [target-and-review-request]` performs a read-only evidence-led UI/UX review. Live inspection requires a configured external Chrome DevTools MCP capability; supplied or captured local images go through the configured `vision-handoff` agent.
- `/ima:design-to-code [design-source]` produces an approved WordPress/Bootstrap implementation plan, persists it as `plan`, and stops at `/ima:implement-wp`.

Vision delegation accepts one to four accessible absolute local PNG, JPEG, WebP, or GIF paths and blocks on any invalid source. Image bytes and full paths are not projected into results. See [`docs/foundation/FNR-3021.md`](docs/foundation/FNR-3021.md) for privacy, limitations, source disposition, and manual acceptance.

## Specialist research workflows

- `/ima:medical-research [question]` provides evidence-driven medical research using current primary-source verification and `ima-research` when available. It never silently substitutes `ima-knowledge`, discloses corpus limitations, audits methods/funding/conflicts, escalates emergency symptoms, and provides education rather than individualized medical advice.
- `/ima:patristic-research [question]` researches early Christianity through Augustine with packaged indexes, the `theology` corpus, primary-source quotation verification, precise citations, historical context, authority distinctions, and anti-anachronism safeguards.

Both accept natural-language questions rather than depth/audience parameters. They infer safe context, ask focused clarification only when needed, and stop after the research response rather than entering a delivery lifecycle. See [`docs/foundation/FNR-3023.md`](docs/foundation/FNR-3023.md) for source coverage, safety boundaries, manual acceptance, limitations, and rollback.

## Production agents

`ima_delegate` is the model-callable production delegation tool. It accepts one to four complete, agent-defined assignments and fails closed for invalid authority, overlapping writer ownership, unavailable minimum capability, or unsafe reuse. During a run it projects at most five concise activity lines through Pi tool updates and one replaceable TUI widget/status, including phase, child agent, exact model, declared skills, sanitized tool/gateway category, state, elapsed time, retry, and escalation. Terminal results preserve child reports and add structured cancellation, possible-partial-state, blocker, resume-reference, and safe-next-action facts. Safety interception remains the narrow FNR-3014 mechanical ownership boundary; no confirmation loop or permission matrix was added.

Inspect resolved definitions with `/ima:agents`, session metadata with `/ima:agent-sessions`, and request a focused reusable continuation with `/ima:agent-follow-up <session-reference> <brief>`. Phase-tagged implementation, tester, reviewer, and documenter agents inherit the parent session profile while retaining their tier authority. See [`agents/README.md`](agents/README.md), [`policies/README.md`](policies/README.md), [`docs/foundation/FNR-3014.md`](docs/foundation/FNR-3014.md), and [`docs/foundation/FNR-3015.md`](docs/foundation/FNR-3015.md).

## Production integrations

`ima_context` is a model-callable tool that activates Serena, loads its instructions and standard project memories, then normalizes exactly one Jira, Taskwarrior, project-file, Vestige-memory, or free-text source into a versioned phase context. An optional Qdrant lookup is read-only. `ima_lifecycle` validates a complete lifecycle artifact, persists it through direct Vestige MCP `smart_ingest`, and reports completion only after receipt acceptance plus one `recall` result that matches its nonce, identity, phase, and completed outcome. Formal lifecycle persistence does not require the `ima-mcp` binary.

`ima_context` still uses `ima-mcp` for its Serena, Vestige-source, and optional Qdrant boundaries, and `/ima:cycle` reconciliation retains a separate `ima-mcp` path. Direct lifecycle persistence uses the package-owned MCP stdio client; callers must continue to use `ima_lifecycle` rather than bypassing its receipt protocol. Neither integration exposes a service SDK, mutates Jira or Taskwarrior, or indexes Qdrant. `/ima:cycle` reuses these boundaries and independently verifies lifecycle evidence before its explicitly confirmed single-tracker close. See [`docs/foundation/FNR-3016.md`](docs/foundation/FNR-3016.md) and [`docs/foundation/FNR-3036.md`](docs/foundation/FNR-3036.md) for contracts, ordering, security boundaries, limitations, and live acceptance.

## Configure model roles

Create `~/.pi/agent/ima/config.json` (or trusted `.pi/ima/config.json`) to opt into a preset:

```json
{
  "schemaVersion": 1,
  "profile": "openai-codex-56"
}
```

See [`config/README.md`](config/README.md) for schema, command routes, legacy phase fallbacks, profile paths, trust, and precedence, [`docs/foundation/phase-model-profiles.md`](docs/foundation/phase-model-profiles.md) for runtime routing, and [`docs/foundation/FNR-3013.md`](docs/foundation/FNR-3013.md) for the original role configuration foundation.

## Test

```bash
npm test
```

The default suite is provider-free and makes no paid model requests.

## Spike evidence

- [`docs/spikes/FNR-3008.md`](docs/spikes/FNR-3008.md) — package discovery and precedence
- [`docs/spikes/FNR-3009.md`](docs/spikes/FNR-3009.md) — child routing, authority, and persisted-session reuse
- [`docs/spikes/FNR-3010.md`](docs/spikes/FNR-3010.md) — parallel control, cancellation, narrow safety hooks, and skill observability
- [`docs/spikes/FNR-3011.md`](docs/spikes/FNR-3011.md) — external gateway access and semantic lifecycle verification
- [`docs/spikes/FNR-3012.md`](docs/spikes/FNR-3012.md) — dedicated vision-model routing and evidence handoff
