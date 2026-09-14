# Changelog

All notable changes to `ima-pi` are documented here. This history is being backfilled: `1.0.0` is the release baseline, and `1.1.0` collects the current feature push. Release dates and tags are added when a release is cut.

## [Unreleased]

### Added

- Added a first-class closed `document` lifecycle phase for manual and soft-cycle documentation, with verified persistence and exact recall/reassembly; closeout remains separate and human-authorized, while explicitly verified historical document evidence retains bounded fail-closed compatibility.
- Added an additive Qdrant lifecycle provider with strict detached projections, immutable persistence verified by direct read-back, exact get/reconcile, and bounded complete recall for schema-v1/v2 evidence; live selection, pinning, routing, fallback, repair, migration, and external-service validation remain out of scope.
- Added an additive Serena lifecycle provider for immutable persistence with direct read-back, exact get/read-only reconcile, and bounded recall in an existing registered project; T9-owned selection, pins, fallback, and routing remain out of scope, and live synthetic Serena acceptance is unperformed.
- Added an additive, unregistered, fail-closed Markdown lifecycle adapter for checkout-local immutable canonical UTF-8 artifacts, with artifact-first exact read-back and receipt-last publication, exact read-only get, and bounded committed-only recall; T9-owned selection, pins, routing, and consumers remain out of scope.
- Added an additive, fail-closed BookStack lifecycle provider that can provision approved placement, persist and read-back verify immutable lifecycle evidence, and exactly recall or reconcile interrupted operations; it does not select providers or enable live lifecycle routing.
- Added BookStack-specific Pi search, authoritative-read, and guarded-write tools with the `/ima:bookstack-search` UX, provenance, fail-closed boundaries, and no local Qdrant/Ollama requirement.
- Added the `ima-pi` BookStack migration producer's verified read-only `dry-run` workflow, with itemized quarantine reporting and bounded immutable inventory manifests and parts.
- Added a read-only BookStack apply preflight and an explicitly confirmed deterministic ten-record canary, with provider-free coverage and no automatic bulk apply.
- Added a sanitized local BookStack v25.12.3 `/api/docs.json` reference to the migration skill for installed-version request and response contracts.

### Fixed

- Hardened Qdrant lifecycle provider boundaries with strict closed request projection before effects and explicit terminal `next_page_offset: null` before detail reads, so incomplete paginated recall cannot be treated as authoritative.
- Hardened BookStack lifecycle placement and persistence: normal persistence globally discovers one visible canonical page slug before POST, stale locator proof is rejected after authoritative reads, and a reused-shelf failure returns no speculative recovery descriptor.
- Persisted follow-up-eligible direct/manual specialist sessions so original reviewers and implementers can resume safely when lifecycle phases run in new Pi sessions; cycle-owned references remain owner-bound.
- Added exclusive native local-only sidecar leases for session registries and focused continuations, returning busy results without stale-lock theft; `session_cleanup_unverified` retains the lease and blocks retry. Ambiguous or unrecognized commands rejected before effects and failed owned edits do not alone imply partial writes; definite out-of-scope intent remains an interception, with native `@` target normalization preserving owned paths.
- Preserved quarantined dry-run outcomes when an apply report is constructed, retaining migration provenance in the final report.
- Reused the established `BOOKSTACK_BASE_URL`, tolerated append-only lifecycle deltas without weakening approved-source checks, replaced repeated catalog scans with one bounded catalog, and stopped further writes on systemic apply failures without assuming ownership of administrator-managed guest/public policy.

### Known limitations

- An operator completed a Qdrant-to-BookStack `apply` and a separate BookStack-to-Cloudflare AI Search ingestion. The canary, report `verify`, cleanup, discovery/cutover, source deletion, and `ima-rag` disposition remain separately operator-gated.

## [1.20.0] - 2026-09-09

Notable upgrade to the `cycle` system. It can now be reliably triggered in three ways:

1. **Natural language:** The system can often select the SDLC workflow for ordinary work and does so reliably when the request is direct or explicit.
2. **`/ima:soft-cycle`:** A prompt-based trigger that uses a long-horizon model to orchestrate the full SDLC through agent delegation, stopping before human-led closeout.
3. **`/ima:cycle`:** An improved, more rigid, and explicit system that takes a task through the full SDLC in guided or autonomous mode.

### Added

- Added prompt-only `/ima:soft-cycle` SDLC orchestration with bounded guided/autonomous specialist delegation, parent-owned artifact persistence, and a stop before human-led closeout.
- Added isolated, profile-routed native Pi phase hosts for `/ima:cycle`, including `commands.cycle` orchestration routing, literal `/ima:cycle reply`, durable original-reviewer continuation, and local-only cycle-owned session records.
- Added parser-backed Plane work-item description fidelity: HTML-only descriptions now hydrate as bounded readable text with independently bounded description and context payloads.
- Added `plane:create` for explicit approved Plane work-item creation through the direct REST helper, with project resolution, strict fields, escaped descriptions, and no browser-control fallback.
- `/ima:cycle` now automatically adopts the newest exact verified manual plan; marker-free legacy plans require one exact TUI confirmation/reference-only approval receipt.
- Added separately invoked manual `/ima:closeout` after verified documentation, which best-effort normalizes an unambiguous supplied source to the canonical lifecycle form and presents Git, tracker, and lifecycle actions as one itemized final action overview whose single approval confirms every executable action shown; it never invokes `/ima:cycle` or auto-dispatches from document.
- Added `/ima:cycle` observability: immediate start acknowledgement, below-editor phase and configured-route feedback, settled child identity, and deterministic retriable or terminal blocker guidance.

### Changed

- Made `/ima:cycle` a parent orchestrator: phase hosts retain lifecycle context and bounded specialist delegation while human-confirmed tracker close remains coordinator-owned.
- Revalidates the original plan contract and downstream lineage before reuse, failing closed on mismatches.
- Preserves guided and autonomous modes, review-cap behavior, fixed lifecycle ordering, and human-only close.

### Fixed

- Routed pre-review test defects back through plan-bound implementation repair and retesting, with stable `TEST-NNN` evidence, legacy defect-state recovery, and a fresh initial review only after tests pass.
- Allowed multiline `/ima:cycle reply` answers while continuing to reject unsafe control characters and oversized replies.
- Made cycle phase questions persistent and actionable in the parent transcript instead of relying on transient notifications.
- Prevented cancellation, callback-drain, cleanup-ownership, and successor-dispatch races from allowing unsafe cycle phase work or replacement after failed cleanup.
- Prevented unsupported binary/empty Plane descriptions and unrepresentable generated description payloads from being treated as safe blanks or sent to Plane writes.
- Hardened stop, session, recovery, and publication-cancellation safeguards.
- Cleared stale start feedback on pre-persist cancellation while restoring retained post-tracker-close blocker state.

## [1.19.0] - 2026-09-05

### Added

- Added default-on, generic desktop readiness notifications for valid interactive Pi TUI settlement and documented extension-dialog waiting events on Linux and macOS, with one attempt per event and silent native-delivery failures.
- Added validated bundled and user notification configuration, a user opt-out, focused behavior/configuration/discovery/fixture coverage, and operator-facing notification documentation with a manual desktop-acceptance procedure.

### Changed

- Raised the repository development baseline for `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` to 0.84.4 while supporting coding-agent peers `^0.84.4 || ^0.85.0`.

### Fixed

- Made observed broken or unsafe notification configuration entries fail closed and aligned the manual notification fixture with configured native confirm/cancel actions and mounted nested-dialog ordering.

## [1.18.0] - 2026-09-05

### Added

- Added the packaged `/skill:plane-api` direct REST helper for explicitly configured self-hosted Plane instances, supporting canonical work-item, state, and comment reads plus plain-text comment creation and state-only updates without Plane Cloud or external MCP fallback.
- Added a dedicated Taskwarrior-to-Plane migration runner with a read-only preflight report.
- Added TUI-only `/ima:plane-migrate` preparation with token-scoped destination discovery, exact Taskwarrior identity filtering, deterministic schema-v2 artifacts, and bounded readiness for compatible empty destinations without Plane work-item writes.
- Added guarded interactive `/ima:plane-migrate` status, apply, and reconcile operations with source-reproduced dynamic destination authorization, reviewed hash plus literal confirmation, locked revalidation, checkpoint recovery, and read-only reconciliation before verified completion.
- Added reviewed blank-only Taskwarrior description backfills for already-migrated Plane items: preparation separates prompted inserts from in-place updates, persists a distinct backfill artifact without changing the create-plan hash, and apply uses a live blank re-check before its description-only PATCH.
- Added typed Plane `ima_context` hydration with canonical work-item references and aliases, paired workspace-aware lifecycle identity, deterministic boundary coverage, and manual-phase documentation.
- Added first-class Plane `/ima:cycle` sources with canonical and space-delimited syntax, source-bound Tier-1 lifecycle verification/reconciliation, and a human-confirmed close that requires exactly one completed-group state and an exact provider state receipt.
- Added strict raw HTTPS Plane browse-URL input for `/ima:cycle start`, canonicalizing supported URLs to existing Plane identities without using the pasted origin as an API destination.
- Added focused security references for durable webhook idempotency, constrained Python subprocess execution, and PHPUnit WordPress negative testing.

### Changed

- Hardened development, testing, review, and workflow skills around a shared fail-closed security boundary, source-to-sink review evidence, and marker-based regression coverage.

### Fixed

- Hardened Plane browse-URL parsing against WHATWG-normalized dot paths, backslashes, excess slashes, and empty userinfo before cycle effects.
- Hardened Plane lifecycle markers, lifecycle-key hydration, and state-update receipts to reject malformed or ambiguous identity and unconfirmed provider state before dependent effects.
- Corrected recommended Node API response/error handling, IMA Forms field projection, webhook idempotency, Python subprocess argument boundaries, and Playwright auth-state handling.
- Rejected schema-v2 and schema-v3 interactive prepared runs from legacy direct apply/reconcile paths with `PREPARED_RUN_INTERACTIVE_ONLY` before plan loading, configuration, client construction, or Plane access.
- Bound current schema-v3 backfill artifacts to their authoritative source workspace and fail closed when a required artifact is missing, while retaining exact historical schema-v2 no-backfill compatibility.
- Enriched newly created Taskwarrior-to-Plane descriptions with escaped annotation briefs, approved task metadata, provenance, and both Plane description fields; ordinary reused items remain unchanged outside the reviewed blank-only backfill path.
- Preserved exact historical schema-v2 prepared-plan payloads and hashes while making equal-timestamp annotation ordering independent of the host locale.
- Hardened Plane work-item API pagination termination, rejected authenticated redirects, guarded inherited CLI command names, and documented rollback inventory.
- Narrowed exact two-filter external-identity first-page 404 handling to no-match only after proof from the same-project unfiltered route, and re-ran preflight before Plane writes to block applies with blocked, incomplete, or unpersistable results.
- Preserved dependencies across selected source projects for one Plane destination while failing closed on mixed destinations, rejected absent or invalid archive metadata without offering or querying archived projects, and canonicalized schema-v2 preparation source artifacts before run creation or artifact writes.
- Made interactive Plane migration status, application, and reconciliation visibly announce activity and durable checkpoint progress; unsupported print or JSON invocations now report a concise no-work diagnostic.
- Hardened prepared-run readiness validation with capability-specific status domains so malformed local evidence fails closed while valid schema-1 and schema-2 readiness reports remain compatible.

## [1.17.0] - 2026-09-01

### Added

- Added the `ima-preferences` skill for exact-preview, approval-gated maintenance of Pi's active global `AGENTS.md` without a custom preference store.
- Added the read-only `/ima:walkthrough` command and `code-walkthrough` skill for a fresh teammate-style presentation of one pull request, local change set, or explicit code subject.

### Changed

- Cut routine user preference loading and updates over to Pi-native global `AGENTS.md` context files; `/ima:memorize` now uses built-in file tools, `/ima:vestige-bootstrap` is a non-reading compatibility pointer, and `/ima:new` runs Serena bootstrap only. Vestige data and the separate T7 migration remain untouched.
- Updated `/ima:review` to classify external Gitea/GitHub pull requests before lifecycle work and produce an advisory, approval-gated peer-review report without lifecycle persistence.
- Require review and walkthrough PR acquisition to preserve the supplied host, owner, repository, and number; generic local walkthroughs now include safe non-ignored untracked-file evidence.

### Fixed

- Hardened `/ima:memorize` to stop without mutation when Pi context precedence selects `AGENTS.override.md` or an uppercase-only `AGENTS.MD`, and to persist a complete previewed document for a safe absent lower-case target.
- Synchronized the README package inventory with focused resource enumeration coverage.

## [1.16.0] - 2026-08-31

### Added

- Added the bundled TTS S1 foundation: disabled by default, with validated local configuration and TUI-only non-fatal credential/player readiness notices; synthesis and playback remain deferred.
- Added the reusable TTS S2 engine with deterministic spoken-text cleanup, OpenAI MP3 synthesis, private temporary audio, Linux player execution, single-active cancellation, non-fatal results, and an opt-in audible acceptance test.
- Added TTS S3 interactive `/ima:speak` replay, `/ima:speak stop`, and next-prompt cancellation with non-blocking, contained speech results; no bare `/speak` alias is registered.
- Added TTS S4 opt-in automatic speech once per final `agent_settled` response in the interactive TUI; it requires both `enable` and `autoSpeak`, speaks only the current normally completed response, remains silent for aborted, stale, non-idle, and noninteractive contexts, and reuses existing cancellation.
- Added TTS S5 read-only `/ima:narrated-review` prompt and `narrated-review` skill for one visible walkthrough grounded in a verified completed review; operators explicitly invoke `/ima:speak` for its existing automatic segmented sequential playback.
- Added TTS S6 automatic long-response segmentation into ordered, provider-safe 3,000-character speech requests with sequential playback, cancellation, and bounded first-failure behavior.
- Added TTS S8 read-only `/ima:narrate` and `narrate` skill to reform the last completed response with an optional presentation-only instruction into one visible Markdown narration ending in an explicit `/ima:speak` handoff, without auto-speech or new analysis.

### Changed

- Lifecycle persistence, corpus retrieval, and cycle handoffs now preserve both Qdrant manifest `artifactId` and logical `recordKey` references; `ima_corpus_get` accepts either identifier while legacy artifact-ID-only state remains supported.
- Updated `/ima:speak` with Starting, multi-segment progress, and Complete notices while preserving explicit-stop notices and silent input/session-shutdown cancellation.

### Fixed

- Hardened TTS S3 cancellation handling so intentional cancellations stay silent and stale pending requests are invalidated on input or session shutdown.
- Corrected TTS S2 cleanup to remove short POSIX absolute paths before OpenAI synthesis while preserving delimiters and ordinary slash prose.
- Hardened lifecycle record-key validation to reject raw C0, DEL, and C1 controls before trimming at persistence, context, recall, and cycle boundaries.
- Restricted direct Qdrant point-ID lookup to exact UUIDs so logical record keys continue through deterministic resolution.

## [1.15.0] - 2026-08-28

### Added

- Completed the package-native Vestige-to-Tier-1 migration workflow, including bounded export, migration-local secret redaction, institutional-by-default classification, idempotent import, and direct destination verification. See the [Vestige migration quick guide](README.md#vestige-migration-quick-guide).
- Added schema-v2 Tier-1 lifecycle manifests with deterministic vectorless detail chunks, UTF-8-aware lossless splitting/reassembly, chunks-first/manifest-last persistence, and fail-closed integrity validation.
- Added an explicit required `ima_lifecycle.summary` contract for manifest-only semantic lifecycle recall.
- Added package-native Qdrant/Ollama institutional corpus tools for bounded immutable storage, semantic search, lifecycle-key recall, full retrieval, and read-only prerequisite status.
- Added logical-record migration for 44–160 KB records, Unicode-safe source bundles for larger records, index-last storage, and source-level all-or-nothing cleanup verification.
- Added itemized `/ima:vestige-migrate dry-run` diagnostics with sanitized prerequisite context, restricted local backup/export/report artifacts, explicit `READY`/`NOT_READY` readiness, and no Qdrant or Vestige record mutation.

### Changed

- Reoriented `ima_lifecycle`, lifecycle-source hydration, `/ima:cycle` reconciliation, and the gateway lifecycle probe to Tier-1 Qdrant manifest/direct-detail retrieval. Vestige is now preferences-only on active lifecycle paths, with no lifecycle write, recall, per-node read, or fallback.
- Replaced the `qdrant-memory` MCP dependency with direct abort-aware Node fetch boundaries while preserving `ima_context.durableKnowledge`.
- Restricted optional durable-knowledge lookups to the known legacy `ima-knowledge` collection so unknown embedding compatibility fails closed.
- Updated Qdrant skills, preflight, migration, gateway, activity, and documentation contracts for the native corpus boundary.

### Fixed

- Corrected `/ima:vestige-migrate` to classify legacy and unknown non-preference records as institutional by default while retaining only explicit standalone preferences.
- Rejected legacy schema-v2 migration reports without the required `source-bundles` layout; operators must run a new non-destructive migration before cleanup.
- Corrected cleanup to send Vestige's canonical `purge` action and count a source as purged only after an identity-bound receipt; verified `migrated` and idempotently `unchanged` sources are cleanup-eligible after re-verification.

## [1.14.0] - 2026-08-27

### Fixed

- Hardened the shared review/rereview `REQUEST_CHANGES` gate: retained or sharpened rereview findings now require complete implementation-grade corrective instructions and failure/root-cause context, without the no-redesign boundary suppressing either.

## [1.13.1] - 2026-08-25

### Fixed

- Lifecycle persistence now rejects embedded prior lifecycle artifacts before Vestige I/O while preserving identifier-only references.
- Added local containment for oversized Vestige lifecycle records: brief, small-budget candidate discovery and isolated 64 KB-bounded exact reads skip failed or oversized candidates while preserving fail-closed verification; lifecycle persistence uses one-item batch force-create with exact `saved`/`create` receipt-node verification.
- Propagated the bounded Vestige lifecycle-discovery contract to the cycle callback, planning prompt, shared guidance, and command guidance.

### Known limitations

- This package-local containment does not change existing Vestige records; direct consumers outside `ima-pi` can still encounter oversized records.

## [1.13.0] - 2026-08-21

### Added

- Added read-only lifecycle-specialist agents: `brainstormer`, `planner`, `decomposer`, and `investigator`.

### Changed

- Recovery from `critical-decision` and `plan-contradiction` now routes plan-level analysis and decision evidence to `planner`; the parent or a human retains decision ownership, with no automatic retry.
- Lifecycle prompts now delegate optional bounded read-only evidence to their matching specialists (`brainstormer`, `planner`, `decomposer`, and `investigator`) while preserving parent judgment, approval, persistence, and authority.

## [1.12.0] - 2026-08-21

### Added

- Added shared canonical source identifiers for all nine manual lifecycle phases: Taskwarrior, Jira, lifecycle, and Vestige forms now accept canonical colon syntax with space-delimited aliases.

### Changed

- `ima_context` now normalizes manual source identifiers and hydrates lifecycle keys through a bounded direct Vestige recall while preserving canonical handoffs.

### Fixed

- Manual lifecycle phases now retrieve lifecycle or Vestige evidence before declaring prerequisites missing, reject non-authoritative lifecycle artifacts, and never substitute Taskwarrior or Jira probes for those sources.
- Hardened Vestige preference bootstrap instructions with native `session_start`/focused `recall`, one classified read-only reconnect/retry, current-evidence safeguards, and no mutation retries.

## [1.11.0] - 2026-08-20

### Added

- Added bounded terminal delegation results: fresh and focused-continuation children return a 400-semantic-line/10 KiB summary plus an inspectable session pointer, while complete child-authored reports remain in Pi JSONL sessions.
- Added bounded `useWhen` applicability metadata to all packaged agents and a safe resolved-agent catalog for ordinary turns with active `ima_delegate`. The parent can opportunistically delegate a clear match or honor an explicit named-agent request through the existing visible, confirmation-free path; invalid catalogs fail closed without exposing prompts or paths.
- Added optional complete per-agent `agents` profile mappings for an exact provider, model, and optional thinking level, enabling parent-independent delegated-agent promotion and demotion.

### Changed

- Delegated-agent routing now resolves exact agent mapping before phase and tier routes; `/ima:profile` displays and preserves agent mappings.

### Fixed

- Enforced adversarial delegation as one matching `adversary-a`/`adversary-b` evidence-packet pair before route resolution or child-session creation.
- Reject logical-line control characters in explicit `useWhen` cues and normalize them from legacy definition fallbacks.
- Clarified catalog and delegation guidance so rereview or verified-finding follow-up uses an eligible existing reviewer continuation rather than a fresh reviewer delegation.
- Reject digit-prefixed agent mapping keys while preserving numeric profile names and agent numeric suffixes.
- Keep `review-verifier` on exact agent mapping, then `reviewVerify`, then `HIGH`; unavailable selected routes fail closed without phase or lower-tier fallback.

## [1.10.0] - 2026-08-20

### Changed

- Restored planning and review standards enforcement: `/ima:plan` and `/ima:new plan` load or seed `readable-code`, `functional-programmer`, and `ima-security-guardrails` alongside the lifecycle contract; plans record Standards Impact, and review treats an unjustified changed file over the >500-line file-size smell as a blocking Warning while preserving cohesion-based exceptions.
- Renamed the package-internal MCP client to `lib/mcp-client.ts` and replaced active retired-CLI references in its imports, tests, README, and Serena memories; direct MCP behavior is unchanged.
- `ima_lifecycle` now persists formal lifecycle artifacts through package-owned direct Vestige MCP `smart_ingest`, validates the receipt, and requires a matching nonce, identity, phase, and completed-outcome `recall`; this path no longer requires the `ima-mcp` binary. `/ima:cycle` reconciliation uses configured direct Vestige `recall`.
- `ima_context` now opens package-owned direct MCP sessions for Serena bootstrap, Vestige source retrieval, and Qdrant durable-knowledge lookup; its context path no longer requires the `ima-mcp` binary.
- Updated the README and foundation integration documentation to distinguish direct-MCP `ima_context` and configured direct Vestige `recall` for cycle reconciliation from unchanged unrelated `ima-mcp` compatibility paths.
- Updated four MCP/operational skills and four support prompts to use the package MCP adapter and direct Serena/Vestige tools rather than legacy `ima-mcp` CLI guidance; added contract tests for the direct-MCP and mutation-safety sequences.

### Fixed

- Lifecycle request validation now rejects non-string `sourceRefs` and `priorArtifactIds` members before nonce generation or Vestige I/O.

## [1.9.0] - 2026-08-07

### Added

- Command-keyed profile routes through `commands`, including configured role shorthands for individual `/ima:*` commands.

### Changed

- Direct `/ima:*` commands, `/ima:cycle`, and `/ima:new` now share command-first routing with explicit legacy phase fallback and unchanged-model passthrough when no route exists.
- Active configuration and workflow documentation now distinguishes direct command routes, legacy phase fallbacks, and cycle dispatch behavior.

### Fixed

- Unknown or malformed command/phase configuration warns and drops only the offending entry, while malformed known model-role mappings remain fail-closed.
- Prototype-collision command names and inherited fallback aliases now preserve passthrough behavior in direct and fresh-session routing.

## [1.8.1] - 2026-08-08

### Fixed

- Corrected the `1.8.0` changelog release heading.

## [1.8.0] - 2026-08-08

### Added

- Universal `readable-code` skill for language-agnostic implementation and review guidance, including FP and security deference.

### Changed

- `/ima:implement`, `/ima:implement-js`, and `/ima:implement-wp` now explicitly load `readable-code`; `/ima:new implement` seeds it after Serena and Vestige bootstrap with prompt and bootstrap-content coverage.
- `functional-programmer` now owns the soft, non-automatic roughly-50-line function-size heuristic and links to `readable-code`.

## [1.7.0] - 2026-08-07

### Added

- `/ima:cycle` supports persisted `guided` and `autonomous` cycle modes, including `start --mode autonomous` and `resume --autonomous|--guided`.
- Verified autonomous progression chains implementation through document without auto-closing the tracker.
- `start --mode autonomous` lets the plan phase self-approve one bounded, conflict-free, low-risk delivery unit or persist `plan BLOCKED`; guided starts remain human-gated.

### Changed

- The default cycle review cap is now five; explicit existing caps remain unchanged.
- Cycle status reports the persisted cycle mode alongside phase and review state.

### Safety

- Autonomous progression stops on unverified, blocked, defect, review-cap, ceiling, and interrupt paths; autonomous stop preserves `stopped` state without requiring `--ack`.
- A generation guard prevents a late first autonomous-resume dispatch from overwriting the authoritative `stopped` state or restarting autonomous progression.
- Close remains human-gated in every cycle mode.
- Autonomous plan self-approval is authorized only by the exact standalone `autonomousPlan: true` directive in the cycle dispatch contract; matching lifecycle metadata is non-authoritative.

## [1.6.0] - 2026-08-07

### Changed

- `/ima:cycle` now persists project-local `.ima-cycle/active.json` before phase prompt injection, treats dispatch handshake failures as advisory, restores/reconciles active state across sessions, and recalls lifecycle plans from manual phase prompts.

## [1.5.0] - 2026-08-07

### Added

- A read-only `document-assessor` agent for manifest-only documentation assessment without local write authority.
- Four Pi-native shared-instruction skills for memory workflow, security guardrails, visual-evidence handoff, and bounded delegation.
- A prompt-restoration foundation document that defines the reference-by-name wiring pattern and the persona/MOIM and FP-principles fold-ins.
- A Pi-native `code-review` skill with integration-contract discovery, independent verifier protocol, implementation-grade finding handoffs, and adversarial reconciliation.

### Changed

- `/ima:instruct`, `/ima:preflight`, and `/ima:prompt-start` now restore their evidence-gated Pi skill and workflow-template references, with focused static workflow-prompt assertions.
- `/ima:medical-research`, `/ima:patristic-research`, and `/ima:investigate` now restore their owning research and cross-cutting workflow-skill wiring, including memory, bounded delegation, and visual-evidence handoff where applicable.
- `/ima:document`, `/ima:memorize`, and `/ima:scorecard` now restore their Pi-native documentation, memory-routing, and technical-scorecard contracts through packaged skills.
- `/ima:document` now routes manifest-only assessment with `writeScope: []`, while `documenter` remains limited to exact approved documentation targets.
- The `vision-handoff` agent now declares `ima-vision-handoff`, and package discovery verifies all four shared skills.
- `/ima:review`, `/ima:rereview`, `/ima:review-verify`, `/ima:adversarial-review`, and `/ima:test` now restore their bounded review/test methodology through named Pi skills.
- `/ima:review-verify` now limits inspection to the evidence range plus one named dependency hop, and `/ima:test` now requires terminal report fields and anti-pattern guards covered by focused assertions.
- `/ima:implement`, `/ima:implement-js`, `/ima:implement-wp`, and `/ima:resolve-review` now restore Pi-native security, functional-programming, bounded-delegation, and review-handoff contracts, with focused workflow-prompt assertions protecting the critical boundaries.
- `/ima:design-to-code` and `/ima:ui-ux-review` now restore Pi-native visual/design-to-code prompt contracts through named skills, guardrails, and focused static workflow-prompt coverage.
- `/ima:architect`, `/ima:brainstorm`, and `/ima:decompose` now restore evidence-led architecture, ideation, and decomposition guidance through packaged skill and agent references.

### Fixed

- `/ima:cycle status` and `/ima:cycle resume` now reconcile verified persisted lifecycle evidence, treat matching outcome markers as advisory, and surface unresolved verified artifacts instead of silently stalling.
- `/ima:new` no longer overwrites the editor with a hardcoded `/ima:plan` hint after bootstrap, preserving text typed while bootstrap runs.
- `/ima:scorecard` no longer names the unbundled `rails` skill; its contract test prevents reintroduction.
- Lifecycle persistence and delegated completion no longer reject otherwise valid human-authored reports solely for missing or reordered headings or an exact verifier format.
- Failed delegation and focused continuations now derive terminal state and text from the same latest assistant message, preventing stale prior text from appearing as current unverified output.
- Secret redaction no longer expands an accepted 128,000-character lifecycle artifact past its persisted bound.

### Safety

- Strict terminal, identity, receipt/recall, write-ownership, cycle-marker, non-empty, and artifact-boundary validation remains fail-closed.
- `/ima:decompose` now capability-gates Jira hierarchy persistence before approval and blocks unsupported issue create/update without substitute writes.

## [1.4.0] - 2026-08-05

### Added

- Packaged `ima-lifecycle-contract` as the single reusable lifecycle handoff and persistence contract.
- `/ima:new plan` now resolves and seeds the mapped lifecycle-contract skill after Serena and Vestige bootstrap.

### Changed

- `/ima:plan` restores its Pi-native planning methodology and idempotent shared-instruction bootstrap guidance.

### Safety

- Missing, invalid, or unsuccessful mapped skill bootstrap fails closed without leaving a plan hint; non-plan selectors retain their existing bootstrap sequence.

### Known limitations

- Human TUI confirmation of `/ima:new plan` skill seeding and direct `/ima:plan` / `/ima:cycle` prompt compliance remain manual acceptance paths.

## [1.3.1] - 2026-08-05

### Fixed

- `/ima:new` now accepts every canonical role and phase selector, dispatches the exact configured route before bootstrap, and creates an unlinked replacement when no verified regular-file parent exists.

## [1.3.0] - 2026-08-05

### Added

- Optional `XHIGH` model role with source-backed mappings in every bundled preset; it remains distinct from `HIGH` thinking overrides.
- TUI-only `/ima:new xhigh` for a native parent-linked fresh session; it applies only the configured `XHIGH` route.
- Selector-to-route validation that rejects persisted XHIGH mismatches before bootstrap.

### Safety

- Missing, unavailable, unauthenticated, unsupported, clamped, cancelled, or mismatched XHIGH routes fail closed without fallback or bootstrap.

### Known limitations

- Live XHIGH provider availability, authentication, thinking support, TUI timing, native replacement, and external bootstrap acceptance remain human verification paths.

## [1.2.0] - 2026-08-05

### Added

- TUI-only `/ima:new [high|plan]` for a native parent-linked fresh session: bare invocation applies no explicit route, while `high` and `plan` apply the configured `HIGH` and `plan` routes.
- Ordered Serena then Vestige bootstrap bodies and an unsubmitted `/ima:plan <story-or-task-source>` hint after a successful replacement.

### Safety

- `/ima:new` requires an existing regular-file parent session and fails closed before resource lookup or replacement for `--no-session`, allocated-but-unwritten, inaccessible, or non-file paths.
- Route, cancellation, and bootstrap failures do not fall back or submit a planning prompt.

### Known limitations

- Live TUI timing, native replacement, provider/model availability, and external bootstrap acceptance remain human verification paths.

## [1.1.0] - 2026-08-04

### Added

- `/ima:cycle`, an explicit, user-gated coordinator for one Story from a Jira key/browse URL or exact Taskwarrior project/UUID.
- The fixed `plan -> implement -> test -> review -> resolution/rereview -> document -> close` lifecycle, with explicit `status`, `stop`, `resume`, and `close` commands rather than automatic progression.
- Persisted `generic`, `js`, and `wp` implementation modes, selecting the matching implementation prompt through the configured route.
- Provider-free coverage of production cycle registration, lifecycle-evidence buffering, terminal settlement, and failed-dispatch cleanup.

### Changed

- Phase routing selects the configured route before prompt expansion, including the document phase.
- README and operational guidance now describe cycle commands, safety gates, verification coverage, and required human acceptance.

### Safety

- Normal close requires TUI confirmation and mutates only the selected tracker; `close --commit-prep` performs read-only Git checks.
- Lifecycle evidence is buffered until safe terminal settlement. Tracker mutation and lifecycle persistence remain intentionally non-atomic and are never automatically retried after a partial close.

### Known limitations

- Live provider/TUI acceptance, provider retries/compaction/queued follow-ups, and external Jira/Taskwarrior behavior remain to be exercised by a human before tracker closeout.

## [1.0.0] - Baseline

### Added

- Pi-native package discovery for namespaced prompts, extensions, skills, agents, policies, and opt-in configuration.
- Bounded planning, implementation, testing, review, documentation, advisory, research, visual, release-preparation, and operational workflows.
- First-class delegation, model-role configuration, Serena/Vestige lifecycle integration, and provider-free package verification.
- Packaged engineering, JavaScript, WordPress/PHP, IMA content, research, MCP, Git, and testing skills.
