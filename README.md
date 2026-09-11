# ima-pi

Pi-native IMA agent harness, packaged through Pi's standard Git/npm package model.

## Features

- **59 packaged skills and 37 `/ima:*` prompt templates** for engineering, web, WordPress, IMA, MCP, research, and operational workflows.
- **Pi-native package resources**—prompts, skills, agents, extensions, policies, and configuration guidance—distributed through Pi's normal Git/npm package model.
- **Memory-aware project work:** Pi's active global `AGENTS.md` carries current user preferences, Serena provides stable project context, Vestige retains only cited legacy evidence and T7 migration sources, and package-native Tier-1 Qdrant/Ollama corpus tools store formal lifecycle artifacts and durable reference knowledge. None are bundled services.
- **A guided development lifecycle with bounded autonomy:** use the manual phases or the explicit, user-gated `/ima:cycle`; autonomous progression requires an approved bounded, conflict-free, low-risk plan and verified evidence, and it stops at `document`.
- **Bounded specialist delegation** keeps work scoped while parent-owned lifecycle gates preserve accountability.

## BookStack migration (SKYNET-149)

`/ima:bookstack-migrate dry-run config/bookstack-migrations/shared-dev-memory.json` prepares a local, immutable itemized report for the approved Qdrant lifecycle and current eligible `ima-rag` Markdown tree. Its `inventory.json` is a deterministic manifest referencing bounded immutable local parts. Record-level source problems are quarantined and reported without aborting the dry-run; filesystem security-boundary failures still fail closed. Run `preflight <report>` before any write: it validates the report, current approved sources, configuration, exact shelves, and the membership data needed to preserve existing Shelf assignments without BookStack writes. New append-only lifecycle records are reported as a deferred delta instead of invalidating the approved snapshot; Markdown drift still fails closed. A separately confirmed `canary <report> confirm` applies at most ten deterministic records and never escalates to full apply. Bulk apply requires its own explicit confirmation, uses one bounded target catalog, and stops further writes after systemic failures. The tool does not alter normal Pi lifecycle persistence, deploy the Worker, delete sources, or perform the separately owned `ima-memory-search` catalog/indexer work.

Configuration: optional `IMA_QDRANT_URL`, primary `BOOKSTACK_BASE_URL`, and backward-compatible `BOOKSTACK_ORIGIN` are **non-secret variables**; unequal BookStack URL values fail closed. `BOOKSTACK_TOKEN_ID` and `BOOKSTACK_TOKEN_SECRET` are **secrets**; `SYNC_COORDINATOR` is a Worker **platform binding**; `IMA_RAG_ROOT`, `.ima/bookstack-migrate/` report paths, inventory manifests/parts, and preflight/canary/delta reports are **local-only values**.

## BookStack shared-memory tools (SKYNET-84)

`/ima:bookstack-search <question>` discovers candidates through the private Cloudflare AI Search index and returns bounded excerpts with BookStack provenance. Use `ima_bookstack_read` for authoritative current content and `ima_bookstack_write` for explicit BookStack authoring with optimistic-concurrency proof. These BookStack-specific tools do not replace Qdrant lifecycle persistence, require no local Qdrant/Ollama, and never enable public Cloudflare endpoints. See [BookStack shared-memory setup](docs/bookstack-knowledge.md).

Configuration: `CLOUDFLARE_ACCOUNT_ID`, `BOOKSTACK_BASE_URL` (or compatible `BOOKSTACK_ORIGIN`), `BOOKSTACK_LIFECYCLE_BOOK_ID`, and `BOOKSTACK_KNOWLEDGE_BOOK_ID` are **non-secret variables**. `CLOUDFLARE_API_MEMORY`, `BOOKSTACK_TOKEN_ID`, and `BOOKSTACK_TOKEN_SECRET` are **secrets**. There is no Pi-tool **platform binding**; `SYNC_COORDINATOR` belongs only to the separate Worker. The invoking shell environment is a **local-only value**.

## Text-to-speech command and engine (S1–S4, S6)

The bundled TTS feature is disabled by default. To opt in, create
`~/.pi/agent/ima/tts.json` with the supported keys: `enable`, `autoSpeak`, `provider`,
`model`, `voice`, and `playerCommand`. The package defaults are `enable: false`,
`autoSpeak: false`, `provider: "openai"`, `model: "gpt-4o-mini-tts"`,
`voice: "alloy"`, and `playerCommand: "ffplay"`. `playerCommand` must be an absolute
executable path or a bare command name resolved through `PATH`; relative paths are rejected.

The reusable engine removes Markdown and code from response text, requests MP3 audio from
OpenAI using explicit credentials, writes a private temporary file, and runs the configured
Linux player with a separate command and file argument. Starting another request cancels the
previous synthesis or playback; contained synthesis, file, and player failures return results
rather than escaping the engine. Long cleaned responses are automatically divided at natural
boundaries into ordered segments of at most 3,000 characters and spoken one after another. No
manual `next` is required; a next prompt or `/ima:speak stop` cancels the remaining segments.

When enabled in an interactive TUI, `/ima:speak` speaks the latest completed assistant
response. Run it again to replay that response, or use `/ima:speak stop` to cancel active
synthesis or playback. Submitting the next real prompt also cancels active speech without
changing the prompt. The command reports non-fatal readiness notices for missing OpenAI
credentials or player support, and reports when there is no completed response to speak.

`/ima:narrate [presentation-instruction]` reforms the last completed assistant response into one
visible, narration-friendly Markdown response. Its optional instruction changes presentation only:
it may shape audience, tone, depth, organization, or emphasis, but cannot request new analysis or
change conclusions. The original response remains visible, and `/ima:narrate` never starts speech
automatically; after a narration, the operator may run `/ima:speak` explicitly. Use
`/ima:narrated-review` instead when the presentation must be grounded in a verified completed
review rather than the last general response.

`/ima:walkthrough [walkthrough-subject]` builds an entirely new, read-only developer walkthrough
of a pull request, local `git diff` changes, or a set of files, as if a teammate were presenting
their work. Unlike `/ima:narrate` and `/ima:narrated-review`, it acquires its own read-only
evidence (via `tea`/`gh`, `git diff`, and Serena) instead of reforming a prior response. It is
understanding-first, never emits `REVIEW-NNN` findings or a verdict, and hands off to `/ima:speak`
without starting speech automatically. Use `/ima:review` when a graded verdict is required.

TTS reuses Pi's existing OpenAI authentication, including `OPENAI_API_KEY`, and never stores
credentials. The default `ffplay` and common VLC/mpv players support MP3. PCM-only
`paplay` and `aplay` are unsupported unless configured around a compatible decoder. TTS checks
only the configured command's `PATH` candidates; it does not auto-detect a different player.

Readiness checks and commands run only in the interactive TUI; print, JSON, and RPC modes
remain silent. When both `enable` and `autoSpeak` are true, automatic TTS speaks the current
settled assistant response once after final settlement, never on intermediate turns. It does not
replay an older response if the current settled response was aborted or incomplete, and remains
silent when automatic setup becomes non-idle or stale. It retains the existing next-prompt and
`/ima:speak stop` cancellation behavior. To opt into live audible acceptance checks, run:

```bash
IMA_TTS_IT=1 OPENAI_API_KEY=<configured-secret> node --test tests/tts-speech-live.test.js
```

The live test uses the configured default player (`ffplay`) or
`IMA_TTS_PLAYER_COMMAND`; it is skipped unless explicitly enabled and never prints the key.

## Desktop notifications (SKYNET-185)

Desktop notifications are enabled by default for valid waiting events in an interactive
TUI: final agent settlement and documented extension dialogs. They use the Pi 0.84.4
development baseline, while the package peer range supports `^0.84.4 || ^0.85.0`.
Print, JSON, and RPC modes remain silent. Opt out with:

```json
{"enable": false}
```

in `~/.pi/agent/ima/notifications.json` (or its `PI_CODING_AGENT_DIR` equivalent).
Malformed or unsafe notification configuration fails closed for that extension instance.
See [desktop notification behavior and manual acceptance](docs/notifications.md).

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
/skill:ima-preferences
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
/skill:ima-qdrant
/skill:mcp-atlassian
/skill:plane-api
/skill:mcp-taskwarrior
/skill:mcp-context7
/skill:mcp-tavily
/skill:mcp-fetch
/skill:mcp-sequential-thinking
/skill:mcp-chrome-devtools

Seven direct MCP servers use the package adapter. Qdrant is package-native through `/skill:ima-qdrant` and `ima_corpus_*` tools; Atlassian and Plane use packaged REST helpers, and Taskwarrior uses the native CLI. `/skill:plane-api` requires an explicit self-hosted non-secret `PLANE_BASE_URL` variable and secret `PLANE_API_KEY`, supports approved work-item/state/comment reads plus explicit work-item creation, comment, and state-only writes, has no Plane Cloud fallback, and does not need an external MCP server. Lifecycle reads first return bounded Qdrant manifest summaries, then directly retrieve only selected full records. Schema-v2 lifecycle detail is losslessly reassembled from deterministic vectorless chunks; missing, duplicate, corrupt, or incomplete chunks fail closed. Lifecycle persistence stores chunks before the manifest commit marker and verifies direct reassembly without a Vestige fallback. Vestige remains a read-only cited-legacy-evidence and T7-migration boundary; routine preferences use Pi's global `AGENTS.md`. For team or global installation, run `pi install ssh://git@gitea.theflccc.org:2222/IMA/ima-pi.git`; this unpinned private-Gitea source was verified in an isolated Pi home on 2026-08-03. For local development only, run `pi install /home/eric/IMA/dev/ima-pi`. Updates are explicit with `pi update --extensions` or `pi update --all`. Synchronize shared Agent Skills with `npm run install:skills`. See [`docs/foundation/FNR-3032.md`](docs/foundation/FNR-3032.md) for prerequisites, source coverage, manual acceptance, limitations, and rollback.

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

`/ima:delegate-probe`, `/ima:control-probe`, `/ima:gateway-probe`, and `/ima:vision-probe` are bounded technical-spike entry points, not production orchestration interfaces. The gateway probe keeps Serena bootstrap and retained Vestige evidence checks read-only, then verifies one dedicated non-production Qdrant lifecycle record by logical store and direct get; it does not clean up that inert deterministic corpus record. Qdrant/Ollama status is separate package-native evidence through read-only `ima_corpus_status`. The control probe accepts `/ima:control-probe cancel <run-id> <a|b>` after startup; see its spike document for live acceptance steps and limitations.

## Production support workflows

- `/ima:serena-bootstrap [context]` loads Serena instructions and standard project memories through direct MCP, read-only.
- `/ima:vestige-bootstrap [legacy reference]` is a deprecated compatibility pointer: routine preferences already come from Pi's global `AGENTS.md`, and the command makes no Vestige call.
- `/ima:vestige-migrate [dry-run|cleanup <report-path> confirm]` supports a non-destructive
  readiness check, a separate migration, and later explicit, re-verified cleanup. Do not run these
  shared-artifact operations concurrently; see the [Vestige migration quick guide](#vestige-migration-quick-guide).
- `/ima:memorize [what should be remembered]` lets users say what should be remembered; it routes current cross-project preferences to Pi's global `AGENTS.md`, preserves Serena project-memory routing, previews exact wording, and requires approval before one verified native write.
- `/ima:preflight [offline|quick|full or request]` reports bounded read-only Pi/IMA diagnostics. It can spool large raw gateway evidence into restrictive temporary files and optionally retain only a redacted final report.
- `/ima:migrate [request]` classifies legacy configuration and, after an exact preview and approval, writes only supported Pi/IMA configuration atomically.

See [`docs/foundation/FNR-3025.md`](docs/foundation/FNR-3025.md) for source coverage, authority boundaries, verification, limitations, and rollback.

## Vestige migration quick guide

1. Run `/ima:vestige-migrate dry-run` first to create an itemized `READY`/`NOT_READY` checklist and restricted local backup, export, and report artifacts. It does not mutate Vestige or Qdrant records.
2. When the operator approves the actual migration, run `/ima:vestige-migrate`. It migrates institutional records to Tier-1 Qdrant while retaining only explicit standalone preferences in Vestige.
3. Review the returned report before any cleanup. A normal rerun is the supported idempotent recovery path.
4. Only then run `/ima:vestige-migrate cleanup <report-path> confirm`, using the exact relative report path and literal `confirm`. Cleanup re-verifies every destination and applies only to verified `migrated` or idempotently `unchanged` sources; it never deletes standalone preferences.

Unavailable, negative, malformed, or incomplete cleanup evidence retains the source in Vestige. There is no reset or collection-drop command.

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
main:    plan -> implement -> test -- PASSED --> review -- APPROVED --> document -- READY --> close (human-confirmed)
test fix: test -- DEFECTS --> implement repair -> test (repeat before the first review)
changes: review -- REQUEST_CHANGES --> resolution -> rereview
         rereview -- APPROVED --> document
         rereview -- REQUEST_CHANGES --> resolution
```

Guided mode waits for an explicit human `resume` after each phase. Test `DEFECTS` return to plan-bound implementation repair and retest, without consuming review attempts or entering resolution/rereview; a passing retest still receives a fresh initial review. Autonomous mode begins only when the strict plan gate accepts one bounded, conflict-free, low-risk unit; verified progression ends at `document`, and blockers stop it. `close` is always a separate, human-confirmed action. `/ima:cycle` is a parent orchestrator: each phase runs in an isolated native Pi host with lifecycle tools and context. A host may delegate bounded specialist leaves; only the package cycle coordinator is excluded, while safety and user extensions remain loaded. See [FNR-3036](docs/foundation/FNR-3036.md) for commands, safety gates, and lifecycle evidence.

`/ima:cycle start` acknowledges acceptance before route and context hydration. Active and blocked cycles request a below-editor widget showing source, phase and next phase, review count, mode, configured non-secret route identity, activity, and blocker guidance. A settled child's actual provider, model, and thinking are reported only after accepted completion. Guided and autonomous blockers distinguish retriable from terminal states without adding a bypass path.

### Manual phase source identifiers

The ten manual lifecycle phases (`plan`, `implement`, `implement-js`, `implement-wp`, `test`, `review`, `resolve-review`, `rereview`, `document`, and `closeout`) accept one canonical colon identifier, with a space-delimited alias at input: `taskwarrior:<project>:<uuid>` (`taskwarrior <project> <uuid>`), `plane:<workspace>:<PROJECT>-<seq>` (`plane <workspace> <PROJECT>-<seq>`), `jira:<KEY>` (`jira <KEY>`), `lifecycle:<lifecycle-key>` (`lifecycle <lifecycle-key>`), or `vestige:<UUID>` (`vestige <UUID>`). `ima_context` normalizes that identifier before external access, and handoffs retain the canonical colon form. Lifecycle sources use exact Tier-1 Qdrant manifest recall plus selected direct detail retrieval. For a Plane source, reuse an existing lifecycle key when verified evidence supplies one; otherwise use the documented `ima-pi:plane:<workspace>:<PROJECT>-<seq>` convention rather than treating it as automatic derivation. A cited Vestige source retrieves only that cited memory, then any explicit lifecycle identity resolves through Qdrant. Neither path falls back to a Taskwarrior or Jira probe. `/ima:cycle start` accepts Jira, Taskwarrior, and Plane sources.

- `/ima:brainstorm [source]` turns an idea or evidence into approved product requirements; it does not decompose or technically design.
- `/ima:decompose [requirements-source]` creates exactly a Taskwarrior Project → Task or Jira Epic → Story/Task hierarchy, with lower-level work kept as checklists. It previews one PM destination and requires approval before persistence.
- `/ima:plan [story-or-task-source]` creates an approved technical implementation contract for one bounded delivery unit; it does not implement or execute work.
- `/ima:cycle start [--review-cap 0-10] [--implementation generic|js|wp] [--mode guided|autonomous] <source>` starts one explicit, branch-aware lifecycle (default review cap: five). A source is one Jira key/supported browse URL, `taskwarrior <project> <uuid>`, `plane:<workspace>:<PROJECT>-<seq>`, `plane <workspace> <PROJECT>-<seq>`, or `https://<plane-host>/<workspace>/browse/<PROJECT>-<seq>`; a Story is the lifecycle unit, not each checklist. A Plane browse URL normalizes to the canonical Plane source, while configured `PLANE_BASE_URL` remains the API destination. Generic is the new-cycle implementation default, the selected implementation mode persists, and all modes use the configured `implement` route. Cycle mode defaults to `guided`. A guided `start` holds the plan for explicit human approval. `start --mode autonomous` lets the plan agent self-approve only one bounded, conflict-free, low-risk delivery unit with no unresolved product, architecture, security, rollout, or verification questions; otherwise it persists `plan BLOCKED` and stops, recommending `/ima:decompose` for multiple delivery units. `resume --autonomous` persists autonomous progression after a guided plan, while `resume --guided` returns the cycle to guided mode. Cycle intent/configuration and the last-known phase persist in project-local `.ima-cycle/active.json`; successful cycle-owned specialist session records persist in local-only `.ima-cycle/agent-sessions.json`. `.ima-cycle/.gitignore` self-ignores both records without changing the repository root `.gitignore`. State writes a unique phase-dispatch record before host prompt injection; host startup or terminal failure preserves that state for reconciliation or explicit recovery. `stop` persists state before it aborts the active phase host. `status`, `stop`, and `close` remain user-gated. Guided `resume` dispatches only one phase; after an approved autonomous plan, autonomous mode advances only with verified lifecycle evidence through `document`, then stops at human-gated close. Autonomous stop needs no `--ack`; guided stops retain the write-phase acknowledgement. On session start and before reporting, active state reconciles matching verified persisted lifecycle evidence. Before an explicit `resume` reopens a retained phase host, it validates the host session, project, and lifecycle context. Restart recovery may append evidence but requires explicit `resume` and never auto-progresses a phase. A verified artifact without a deterministic valid outcome preserves state and names the artifact for inspection. `resume` may retry a phase blocked by its explicit `BLOCKED` outcome after the external blocker is corrected. Test defects route to implementation repair and retest; legacy exact `test:DEFECTS` blocks recover to implementation. Review-cap, invalid-transition, and post-tracker-close blocks remain terminal. Normal close requires TUI confirmation, while `close --commit-prep` is read-only. For Plane, close rereads the exact work item and workflow states, accepts only a current `backlog`, `unstarted`, or `started` state, requires exactly one `completed`-group state, and verifies the exact state-mutation receipt before lifecycle closeout.

- When a phase host needs operator input, `/ima:cycle` posts its questions as a persistent cycle message with the exact reply command. `/ima:cycle reply <answer>` sends the literal answer, including line breaks, only to that waiting phase host; it does not itself append or advance lifecycle evidence.
- `/ima:soft-cycle [source] [guided|autonomous] [implementer:<agent>]` is a prompt-only SDLC orchestrator that delegates each phase and persists parent-owned lifecycle artifacts; it stops after document for human final verification and closeout.

For `start` and `resume`, the parent coordinator selects `commands.cycle` when configured, otherwise the configured `HIGH` role, otherwise the current parent route. Each phase host first uses its direct command/legacy phase mapping; an unmapped `resolution` (`resolve-review`) host falls back to `implement`, an unmapped `rereview` host to `review`, and any still-unmapped host inherits the coordinator route. A configured route that is unavailable or unauthenticated blocks instead of falling back. `commands.cycle` is the only cycle-specific profile mapping; profile mappings are non-secret configuration, provider credentials are secrets, and `.ima-cycle` records are local-only.

An approved manual `plan` artifact is reusable by `/ima:cycle start`: cycle verifies the newest exact lifecycle/source-bound plan and begins at `implement` instead of redispatching planning. A newer `plan BLOCKED`, ambiguous, malformed, unavailable, or saturated plan history fails closed. Older verified plans without a canonical plan outcome marker require one explicit TUI review and confirmation of the exact immutable plan; cycle persists a reference-only approval receipt, rechecks it, and then may continue. Adoption does not change guided/autonomous mode, bypass review caps or blockers, or auto-close a tracker. Imported approval pointers are revalidated before implementation/recovery, and later lifecycle evidence must carry the selected approval lineage.

Each selected Story follows `plan -> implement -> test`, repeating `test DEFECTS -> implement repair -> test` before a fresh initial `review`, then `resolution/rereview -> document -> close` only for formal review findings. `/ima:cycle` coordinates that fixed lifecycle without becoming a workflow DSL or mutating unrelated trackers. It never auto-closes a tracker; after the bounded plan gate, autonomous mode is limited to the verified implementation-to-document tail. See [`docs/foundation/FNR-3017.md`](docs/foundation/FNR-3017.md) and [`docs/foundation/FNR-3036.md`](docs/foundation/FNR-3036.md) for authority, integration, safeguards, limitations, and human acceptance.

- `/ima:implement [approved-plan-source]` executes a plan for mixed, ambiguous, or non-JavaScript/non-WordPress stacks.
- `/ima:implement-js [approved-plan-source]` executes a plan for known JavaScript/TypeScript work.
- `/ima:implement-wp [approved-plan-source]` executes a plan for production WordPress/PHP work with nonce, authorization, sanitization, contextual escaping, and prepared-query requirements.

All implementation prompts require an approved implementation-grade plan, work in the current session with configured MID intent, may delegate bounded work, stop with evidence on material contradictions, and persist verified implementation lifecycle evidence. They run only immediate plan-authorized verification and never automatically enter formal testing or review. Before expansion, direct command `X` resolves `commands[X]`, then its explicit legacy phase fallback; `implement-js` and `implement-wp` both use `phases.implement` as that fallback, otherwise the session model remains unchanged. The `/ima:cycle` implementation phase dispatches `implement`, so it resolves `commands.implement` then `phases.implement`. See [`docs/foundation/FNR-3018.md`](docs/foundation/FNR-3018.md) for source disposition, routing, safeguards, and live acceptance limitations.

- `/ima:test [implementation-source]` performs bounded test work without silently changing production behavior.
- `/ima:review [implementation-and-test-source]` runs a fresh product-read-only review and fresh second opinions for Critical/Warning candidates. When the source is a Gitea or GitHub pull request authored outside the IMA lifecycle, it runs an advisory peer review that derives acceptance intent from the PR and repository conventions instead of demanding plan/implementation/test lifecycle artifacts, and does not persist a lifecycle artifact.
- `/ima:resolve-review [review-and-implementation-source]` resolves only confirmed review findings within the fixed review-loop cap.
- `/ima:rereview [resolution-and-review-source]` uses `ima_agent_follow_up` to continue an eligible original reviewer for read-only resolution verification; it never starts a new reviewer.
- `/ima:review-verify [finding-brief]` returns exactly one narrow finding verdict.
- `/ima:document [completed-lifecycle-source]` updates only exact local documentation targets and prepares parent-owned external update manifests.
- `/ima:closeout [completed-lifecycle-source]` is a separately invoked manual terminal lifecycle closeout after verified documentation evidence. It best-effort normalizes an unambiguous supplied source to the canonical lifecycle form, presents Git, optional project release preparation, tracker closure, and lifecycle persistence as one itemized final action overview, and treats approval of that overview as confirmation for every executable action shown; it never invokes `/ima:cycle` or auto-dispatches from document.
- `/ima:profile [name]` lists or activates configured command, agent, phase, and model routes, then persists an explicit selection to the user default without changing ordinary prompt/model flexibility.
- `/ima:new [low|mid|high|xhigh|<discovered-ima-command>]` creates a TUI-only fresh session. Bare `/ima:new` applies no explicit route; role selectors apply the effective configured `LOW`, `MID`, `HIGH`, or `XHIGH` role; command selectors use the same command lookup as direct prompts. An unconfigured command starts on the current model. A verified regular-file parent is linked; missing, unwritten, inaccessible, or non-file parents are omitted so native persisted/ephemeral session semantics are preserved. A successful replacement runs Serena bootstrap only; Pi natively loads the active global `AGENTS.md` context file. It then runs any mapped package skill bodies (currently `plan` seeds `ima-lifecycle-contract`, `readable-code`, `functional-programmer`, and `ima-security-guardrails`; `implement`-family commands seed `readable-code`).

See [`docs/foundation/FNR-3019.md`](docs/foundation/FNR-3019.md) for authority, review verification fallback, knowledge routing, and limitations. See [`docs/foundation/phase-model-profiles.md`](docs/foundation/phase-model-profiles.md) for command routing and fail-closed behavior.

## Quality advisory workflows

- `/ima:scorecard [target]` produces a read-only, evidence-backed A/B/C/D/F assessment for Code Standards, Security, Test Coverage, Documentation, and Maintainability using only existing configured non-mutating validators. It displays paste-ready Markdown; a later explicit request may update only that exact scorecard section in one unambiguous README.
- `/ima:adversarial-review [target]` gives one evidence packet to two fresh, read-only adversaries in parallel. It requires configured, catalog-available exact-agent or `adversaryA`/`adversaryB` routes with distinct `(provider, model)` identities and blocks rather than falling back or accepting one-sided results.

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

`ima_delegate` is the model-callable production delegation tool. It accepts one to four complete, agent-defined assignments and fails closed for invalid authority, overlapping writer ownership, unavailable minimum capability, or unsafe reuse. During a run it projects at most five concise activity lines through Pi tool updates and one replaceable TUI widget/status, including phase, child agent, exact model, declared skills, sanitized tool/gateway category, state, elapsed time, retry, and escalation. Terminal results return a 400-line/10 KiB bounded child summary with an inspectable nested session pointer; complete child-authored reports remain in Pi JSONL sessions. The complete tool payload remains valid JSON within Pi’s 2,000-line/50 KiB ceiling and retains structured cancellation, possible-partial-state, blocker, resume-reference, and safe-next-action facts. Safety interception remains the narrow FNR-3014 mechanical ownership boundary; no confirmation loop or permission matrix was added.

When `ima_delegate` is active on an ordinary turn, the parent receives a bounded resolved-agent catalog with applicability cues. It can delegate a clear bounded match opportunistically or honor an explicit “use `<name>` agent” request through the same path; no fit means no delegation. The catalog never exposes agent prompts or paths, writes still require exact disjoint ownership, and children cannot delegate.

Inspect resolved definitions with `/ima:agents`, session metadata with `/ima:agent-sessions`, and request a focused reusable continuation with `/ima:agent-follow-up <session-reference> <brief>`. Each delegated agent resolves from the active profile as exact agent override, then phase route, then tier role, independently of the parent model. A selected unavailable route blocks visibly rather than falling back. See [`agents/README.md`](agents/README.md), [`policies/README.md`](policies/README.md), [`docs/foundation/FNR-3014.md`](docs/foundation/FNR-3014.md), and [`docs/foundation/FNR-3015.md`](docs/foundation/FNR-3015.md).

## Production integrations

`ima_context` is a model-callable tool that activates Serena, loads its instructions and standard project memories, then normalizes exactly one Jira, Taskwarrior, typed Plane work-item, project-file, Vestige-memory, lifecycle-key, raw manual-phase reference, or free-text source into a versioned phase context. A raw reference accepts canonical `taskwarrior:<project>:<uuid>`, `plane:<workspace>:<PROJECT>-<seq>`, `jira:<KEY>`, `lifecycle:<lifecycle-key>`, and `vestige:<UUID>` forms plus their space-delimited aliases. Lifecycle-key hydration uses exact Tier-1 Qdrant manifest recall and selected direct full-detail retrieval, accepting only verified completed artifacts for the exact key. A typed Plane source uses `{ type: "plane", workspace, project, sequenceId }`, hydrates through the packaged `plane:get` helper, and retains `Plane:<workspace>:<PROJECT>-<seq>` traceability. `ima_lifecycle` accepts `planeWorkspace` and `planeWorkItem` only as a complete pair, emitting `plane_workspace` and `plane_work_item` only for that pair. An optional durable-Qdrant lookup is read-only. `ima_lifecycle` requires an explicit summary, stores one schema-v2 Qdrant manifest plus deterministic vectorless detail chunks, and reports completion only after direct lossless reassembly matches its nonce, identity, phase, and completed outcome.

`ima_context` uses package-owned direct MCP sessions for Serena and cited Vestige preference-source boundaries, plus the package-native Qdrant/Ollama corpus boundary for lifecycle and durable knowledge; `/ima:cycle` reconciliation uses the same corpus manifest/direct-get path. Native `ima_corpus_*` tools own bounded institutional Qdrant records without a `qdrant-memory` MCP dependency. Callers must continue to use `ima_lifecycle` rather than bypassing its corpus receipt protocol. Neither integration exposes a service SDK, mutates Jira, Taskwarrior, or Plane, or indexes Qdrant without explicit corpus-store authority. Vestige has no lifecycle write, recall, per-node read, or fallback role. Governance records currently remain Git-tracked under `docs/decisions/`; later indexing is optional. `/ima:cycle` reuses these boundaries and independently verifies lifecycle evidence before its explicitly confirmed single-tracker close. See [`docs/foundation/FNR-3016.md`](docs/foundation/FNR-3016.md) and [`docs/foundation/FNR-3036.md`](docs/foundation/FNR-3036.md) for historical contracts, ordering, security boundaries, limitations, and live acceptance.

> **Target architecture, not current runtime behavior:** [SKYNET-12 shared development memory architecture](docs/decisions/SKYNET-12-shared-development-memory-architecture.md) records the future BookStack authority and Cloudflare discovery model. Current package-native Qdrant lifecycle routing remains in effect until separately verified migration and cutover.

> **BookStack configuration record:** [SKYNET-98 configuration evidence](docs/bookstack-configuration.md) records the non-public shared-memory setup and operator-managed acceptance boundaries. It does not change the current Qdrant runtime.

## Configure model roles

Create `~/.pi/agent/ima/config.json` (or trusted `.pi/ima/config.json`) to opt into a preset:

```json
{
  "schemaVersion": 1,
  "profile": "openai-codex-56"
}
```

See [`config/README.md`](config/README.md) for schema, command and agent routes, legacy phase fallbacks, profile paths, trust, and precedence, [`docs/foundation/phase-model-profiles.md`](docs/foundation/phase-model-profiles.md) for runtime routing, and [`docs/foundation/FNR-3013.md`](docs/foundation/FNR-3013.md) for the original role configuration foundation.

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
