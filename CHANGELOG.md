# Changelog

All notable changes to `ima-pi` are documented here. This history is being backfilled: `1.0.0` is the release baseline, and `1.1.0` collects the current feature push. Release dates and tags are added when a release is cut.

## [Unreleased]

### Added

- A read-only `document-assessor` agent for manifest-only documentation assessment without local write authority.
- Four Pi-native shared-instruction skills for memory workflow, security guardrails, visual-evidence handoff, and bounded delegation.
- A prompt-restoration foundation document that defines the reference-by-name wiring pattern and the persona/MOIM and FP-principles fold-ins.
- A Pi-native `code-review` skill with integration-contract discovery, independent verifier protocol, implementation-grade finding handoffs, and adversarial reconciliation.

### Changed

- `/ima:medical-research`, `/ima:patristic-research`, and `/ima:investigate` now restore their owning research and cross-cutting workflow-skill wiring, including memory, bounded delegation, and visual-evidence handoff where applicable.
- `/ima:document`, `/ima:memorize`, and `/ima:scorecard` now restore their Pi-native documentation, memory-routing, and technical-scorecard contracts through packaged skills.
- `/ima:document` now routes manifest-only assessment with `writeScope: []`, while `documenter` remains limited to exact approved documentation targets.
- The `vision-handoff` agent now declares `ima-vision-handoff`, and package discovery verifies all four shared skills.
- `/ima:review`, `/ima:rereview`, `/ima:review-verify`, `/ima:adversarial-review`, and `/ima:test` now restore their bounded review/test methodology through named Pi skills.
- `/ima:review-verify` now limits inspection to the evidence range plus one named dependency hop, and `/ima:test` now requires terminal report fields and anti-pattern guards covered by focused assertions.

### Fixed

- `/ima:new` no longer overwrites the editor with a hardcoded `/ima:plan` hint after bootstrap, preserving text typed while bootstrap runs.
- `/ima:scorecard` no longer names the unbundled `rails` skill; its contract test prevents reintroduction.
- Lifecycle persistence and delegated completion no longer reject otherwise valid human-authored reports solely for missing or reordered headings or an exact verifier format.
- Failed delegation and focused continuations now derive terminal state and text from the same latest assistant message, preventing stale prior text from appearing as current unverified output.
- Secret redaction no longer expands an accepted 128,000-character lifecycle artifact past its persisted bound.

### Safety

- Strict terminal, identity, receipt/recall, write-ownership, cycle-marker, non-empty, and artifact-boundary validation remains fail-closed.

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
