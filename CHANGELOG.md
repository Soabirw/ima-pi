# Changelog

All notable changes to `ima-pi` are documented here. This history is being backfilled: `1.0.0` is the release baseline, and `1.1.0` collects the current feature push. Release dates and tags are added when a release is cut.

## [Unreleased]

### Added

- Added package-native Qdrant/Ollama institutional corpus tools for bounded immutable storage, semantic search, lifecycle-key recall, full retrieval, and read-only prerequisite status.
- Added `/ima:vestige-migrate` with bounded Vestige export, migration-local secret redaction, idempotent Tier-1 import, quarantine reporting, a non-destructive default, and later explicit Tier-1-verified cleanup that counts a purge only after a positive deletion acknowledgment.

### Changed

- Replaced the `qdrant-memory` MCP dependency with direct abort-aware Node fetch boundaries while preserving `ima_context.durableKnowledge`.
- Restricted optional durable-knowledge lookups to the known legacy `ima-knowledge` collection so unknown embedding compatibility fails closed.
- Updated Qdrant skills, preflight, migration, gateway, activity, and documentation contracts for the native corpus boundary.

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
