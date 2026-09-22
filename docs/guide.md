# ima-pi guide

## What it is—and is not

`ima-pi` is a Pi-native IMA agent harness distributed as a normal Pi package. It supplies packaged prompts, skills, agents, extensions, policies, and configuration guidance while preserving Pi's native resource resolution. It preserves IMA workflow outcomes; it does **not** require Goose ETA/YAML rendering, path rewriting, a separate cycle executable, or a custom package installer.

## Prerequisites

Use Node.js 24+ and an installed Pi version. The normal package path also needs access to the approved private Gitea repository. Optional integrations have their own credentials and executables; they are not installation prerequisites.

## New-developer shared-memory readiness

This is a documentation-only readiness path for capability contracts in this reviewed checkout. It is not evidence of a release, shared-service rollout, migration, cutover, live-provider acceptance, or tracker closeout.

**Installation versus checkout.** A released installation makes Pi package resources discoverable. The reviewed checkout describes current capability contracts, but neither installation nor resource discovery grants shared-service access, configures a provider, or proves managed lifecycle persistence.

### Journey and dependency matrix

| Step | Establishes | Owner role | Stop gate |
| --- | --- | --- | --- |
| Install and discover package resources | Node.js, Pi, package-source access, and visible `/ima:*` or `/skill:*` resources | Developer or package operator | Stop at installation/discovery failure; it does not authorize shared-service changes. |
| Discover shared knowledge candidates | The private search capability can return a bounded, derived candidate | Shared-service administrator and developer | Missing configuration, authorization, or index access stops discovery. A snippet is not current authority. |
| Read current shared content | `ima_bookstack_read` authorizes and reads the candidate's current BookStack content | Authorized developer | A denied, missing, malformed, or unverifiable read stops the claim; never elevate its search excerpt to authority. |
| Create a BookStack page | A new page after successful direct verification when `sourceId`, `expectedRevisionCount`, and `expectedUpdatedAt` are all absent; valid approved destination/book context, authorized BookStack access, and validated content are required | Authorized BookStack author | Stop if `sourceId`, `expectedRevisionCount`, or `expectedUpdatedAt` is supplied, or a required destination/book, access, validation, or verification control fails. |
| Update a BookStack page | An updated page after successful direct verification when `sourceId`, `expectedRevisionCount`, and `expectedUpdatedAt` are all supplied and the expected revision fields match the reread page; valid approved destination/book context, authorized BookStack access, and validated content are required | Authorized BookStack author | Stop on missing or mismatched revision proof, or a required destination/book, access, validation, or verification control failure. |
| Persist managed lifecycle evidence | A user-confirmed selected provider or valid pin can perform its provider-native immutable verification | Lifecycle operator and provider owner | An unavailable or unverifiable selected or pinned provider blocks; do not fall back, repin, migrate, or mix providers. |
| Invoke a Qdrant capability | The requested Qdrant/Ollama capability has its own verified service prerequisites | Qdrant service operator and requesting developer | No local installation is required for the earlier steps. If this capability, a valid Qdrant pin, or historical Qdrant authority is required, stop rather than bypass it. |

General BookStack authoring is not managed lifecycle persistence.

The role labels identify ownership boundaries, not assigned people.

### Shared-service configuration classes

These names classify handling only; use no real values in source control, examples, reports, or lifecycle artifacts.

| Scope or setting | Classification |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID`, `BOOKSTACK_BASE_URL`, `BOOKSTACK_ORIGIN`, `BOOKSTACK_LIFECYCLE_BOOK_ID`, and `BOOKSTACK_KNOWLEDGE_BOOK_ID` | **Non-secret variables** for BookStack shared-memory access. |
| `CLOUDFLARE_API_MEMORY`, `BOOKSTACK_TOKEN_ID`, and `BOOKSTACK_TOKEN_SECRET` | **Secrets** for shared-memory operations. |
| `SYNC_COORDINATOR` | **Platform binding** for the separate Worker; Pi BookStack tools do not consume it. |
| Invoking shell environment | **Local-only value** for developer-scoped shared-memory configuration. |
| `IMA_QDRANT_URL` and `IMA_OLLAMA_URL` | **Non-secret variables** only when a Qdrant/Ollama capability is invoked. |
| Qdrant or Ollama credentials | **Secrets**. |
| Local Qdrant data and synthetic fixtures | **Local-only values**. |
| `SERENA_HOME`, when an integrator uses it outside the Serena provider | **Non-secret variable**; the provider itself does not configure it. |
| Serena project paths, `.serena` configuration/memories, and retained sidecars | **Local-only values**. |
| Serena, MCP, service, or platform credentials/tokens | **Secrets**. |
| Markdown checkout paths, artifacts, receipts, references, locks, and fixtures | **Local-only values**; Markdown adds no environment variable or platform binding. |
| Existing provider preferences and non-sensitive identifiers | **Non-secret variables** under the [lifecycle authority contract](#lifecycle-authority-memory-and-integrations). |
| Public lifecycle-read identifiers—`lifecycleKey`, `phase`, `artifactId`, `recordKey`, `contentHash`, and closed descriptor `reference` fields | **Non-secret variables**. A closed reference is verification proof, never bearer authorization. |
| Returned lifecycle-read descriptors and complete artifacts | **Local-only values**. They do not expose or select provider authority. |
| Configured provider service, project, or workspace destinations | **Platform bindings** where applicable; they are internal authority context, never public lifecycle-read inputs. |
| Checkout-local pin registry and retained BookStack writing attempts/checkpoints | **Local-only values**. |

Qdrant, Serena, Markdown, and the lifecycle authority contract add no new platform binding. Configured provider destinations remain separately classified platform bindings where applicable. This guide invents no preference key and enables no automatic preference loading.

### Owner-owned readiness gates

Use the dependency matrix in order. Package/resource discovery is separate from shared-memory access, and both are separate from managed lifecycle persistence. A general BookStack page write never selects or changes a lifecycle provider pin.

A local Qdrant/Ollama installation is not a base onboarding requirement. A capability-specific Qdrant request, a valid Qdrant pin, or verifiable historical Qdrant authority still retains its own requirements and cannot be bypassed. If an operator cannot verify exact historical authority, the operator must stop and preserve the existing authority; do not assume every runtime path uniformly blocks unavailable historical recall.

### Documentation-only, non-destructive rollback

This is documentation-only readiness guidance. If a later, separately approved rollout must be paused, use these preservation steps; they do not perform a rollout, cleanup, or data recovery.

1. Pause prospective rollout activity and new shared-memory or lifecycle writes with the relevant owner. Preserve concurrent work rather than trying to reverse it.
2. Inventory exact provider revisions, lifecycle keys, pins, retained attempts or leases, references, and—if a future cutover exists—all post-cutover writes and references.
3. Preserve provider pins, authoritative history, concurrent work, and every post-cutover write. Do not reset, clean, downgrade, repin, fall back, replay, snapshot-overwrite, delete, or use cleanup as rollback.
4. Reconcile only through the selected provider's exact read-only `get` or `reconcile` contract; do not repair or overwrite evidence.
5. Resume only after the responsible owners verify the exact revisions, keys, pins, attempts, references, and preserved writes. See the historical [BookStack T2 record](bookstack-configuration.md) for why its separately approved cleanup path is not this rollback.

## Desktop notifications

The default-on desktop notification extension uses the repository's Pi 0.84.4
development baseline and supports peer runtimes `^0.84.4 || ^0.85.0`. It runs only in
interactive TUI sessions and can be disabled with `{"enable":false}` in
`~/.pi/agent/ima/notifications.json` (or the equivalent `PI_CODING_AGENT_DIR` path).
See [desktop notifications](notifications.md) for its configuration, fixed platform
commands, limitations, and manual acceptance procedure.

## Team/global Git installation

Install with Pi's standard package command:

```bash
pi install ssh://git@gitea.theflccc.org:2222/IMA/ima-pi.git
```

This is the canonical normal-install path. Do not run `scripts/install.ts` as part of Pi installation.

## First-run package verification

Start Pi from the installed environment and confirm an `/ima:*` command and `/skill:*` guidance are discoverable. The clean-install acceptance observed `/ima:probe`, `/ima:plan`, `/skill:ima-pi-guide`, and `/skill:pi-preflight` with package provenance for the prompt. Use `pi --help` and package-specific help from your installed Pi version for current listing, update, and removal syntax.

## Configuration and model roles

Opt-in IMA configuration can live in `~/.pi/agent/ima/config.json` or trusted `.pi/ima/config.json`; project-local configuration takes precedence as documented in [`../config/README.md`](../config/README.md). Profiles express required `HIGH`, `MID`, `LOW`, and `vision` roles plus optional quality roles and distinct configurable `XHIGH`. They may map bare `/ima:*` command names through `commands`, with explicit legacy `phases` as a fallback, and exact resolved agent names through direct `agents` mappings. A command resolves `commands[X]`, then the matching explicit phase (with only `resolve-review` -> `resolution` and the two implementation aliases), then runs unchanged when neither exists. A delegated child resolves its exact agent mapping, then its phase mapping, then its tier role independently of the parent model; a selected unavailable route fails closed without substitution. Unknown extra command/phase config entries warn and are dropped without blocking unrelated commands; malformed agent entries and invalid foundational role mappings remain fatal. In TUI mode, `/ima:new` accepts bare invocation, `low`, `mid`, `high`, `xhigh`, and discovered IMA command names. It creates a fresh replacement session with no explicit route, the selected role route, or the selected command route respectively; an unconfigured command stays on the current model. A verified regular-file parent is linked; an absent, unwritten, inaccessible, or non-file parent is omitted. The replacement applies any resolved route before Serena bootstrap and any mapped package skill bodies; Pi natively loads the active global `AGENTS.md` context file (currently `plan` seeds `ima-lifecycle-contract`, `readable-code`, `functional-programmer`, and `ima-security-guardrails`; `implement`-family commands seed `readable-code`); an unavailable, unauthenticated, unsupported, or rolled-back resolved route blocks fail-closed.

## Workflow, commands, agents, and skills

The packaged `/ima:*` prompts provide phase or bounded-operation entry points. Use the manual lifecycle—plan, implement, test, review, resolution/rereview, document, then separately invoked `/ima:closeout`—or `/ima:cycle` for one explicit, user-gated Story. `document` is the persisted documentation phase; it never closes a tracker, commits, deploys, or dispatches closeout. Manual and `/ima:soft-cycle` document artifacts explicitly state `READY` or `BLOCKED` in summary and detail without a cycle marker; cycle-dispatched document artifacts retain their exact marker contract. Storage verification is not a `READY` determination. `/ima:closeout` is distinct from `/ima:cycle close`: after verified documentation evidence, it best-effort normalizes an unambiguous source, presents Git, tracker, and lifecycle actions in one final action overview, and treats approval of that overview as confirmation for every executable action shown; it never invokes `/ima:cycle` or auto-dispatches from document. `/ima:soft-cycle` is the prompt-only delegation-based SDLC comparator: it persists parent-owned phase artifacts and stops after documentation for user-led final verification and closeout. The cycle coordinator uses Pi custom entries and the existing lifecycle tools; it is not a generic workflow DSL or automatic progression engine. See [`foundation/FNR-3036.md`](foundation/FNR-3036.md) for its exact command syntax, source forms, safety gates, and required human acceptance. Packaged agents provide bounded roles, authority, result contracts, and `useWhen` applicability cues. When `ima_delegate` is active on an ordinary turn, Pi gives the parent a safe resolved-agent catalog so it can delegate a clear bounded match opportunistically or honor an explicit named-agent request through the same path. No match means no delegation; writers retain exact disjoint ownership, children cannot delegate, and existing activity remains visible without a confirmation loop. Each child uses its own active-profile route rather than inheriting the parent model. Fresh and focused-continuation results share a 400-line/10 KiB summary contract with an inspectable nested session pointer; full child reports remain in Pi JSONL sessions. Pi's native `/skill:*` discovery resolves reusable knowledge with normal package/user/project precedence.

### `/ima:soft-cycle` flexible input

`/ima:soft-cycle` remains a prompt-only orchestrator, not a programmatic parser, coordinator, or general file-import service. It accepts one of these forms:

```text
/ima:soft-cycle SOURCE [guided|autonomous] [implementer:<agent>] [-- INSTRUCTIONS]
/ima:soft-cycle [guided|autonomous] [implementer:<agent>] -- INSTRUCTIONS
/ima:soft-cycle BARE-INSTRUCTIONS
```

`guided` and `autonomous` are case-sensitive standalone header controls; there can be at most one mode and one `implementer:<agent>` override. An override must be a lowercase-hyphenated name of at most 64 characters and resolve to an available implementer-capable agent. A bare instruction is always guided: words such as `autonomous` or `implementer:...` inside prose or source commentary are data, not controls.

Before parsing, trimming, normalization, or any tool action, the complete native Pi-expanded invocation—including leading, trailing, and inter-token whitespace—must be at most 65,536 JavaScript string units (UTF-16 code units reported by `String.length`). At 65,537 units or more, `/ima:soft-cycle` shows usage and stops without a tool call; it never trims, truncates, summarizes, or otherwise transforms input into validity.

The first standalone `--` is the only delimiter. Its nonempty right side is instructions; with a source, that side is source commentary. The primary source is normalized and hydrated once, while commentary is given separately to the planner. Without `--`, a source-shaped first input accepts only a complete source and optional controls; a control-shaped first input blocks; all other input is guided bare instructions. This fail-closed order means malformed, duplicate, unsupported, conflicting, oversized, control-character, or ambiguous input never silently becomes prose.

A source may be a canonical or space-delimited Taskwarrior, Plane, Jira, lifecycle, or Vestige identifier; a bare Jira key; an approved configured Jira or Plane browse URL; or a project-relative path, including `file:`. Browse URLs supply an extracted identity to the configured integration only: they are never arbitrary fetch destinations.

A file source is exactly one whitespace-free, project-relative token of at most 1,024 characters, or `file:` immediately followed by one such token. Split its path on `/`: every component must be nonempty, cannot be `.` or `..`, and may contain only ASCII letters, digits, `.`, `_`, or `-`. A bare `file:` prefix and absolute, home-expanded, backslash, drive, URI, glob, percent-encoded, or whitespace forms block. Before its one hydration, a valid file must still resolve inside the project root even through symlinks, be readable and regular, have a complete non-truncated read, contain neither control/NUL characters nor suspected credentials, and independently fit both 256 KiB (bytes, not characters) and 64,000 JavaScript UTF-16-code-unit normalized-context (`String.length`) limits. After that single hydration, bounded evidence must verify complete matching content. Missing, changed, truncated, partial, mismatched, or otherwise unverifiable content blocks before recall, delegation, or persistence; there is no second hydration, chunking, or text fallback.

File and text instructions have no tracker identity. Before their first lifecycle persistence, both guided and autonomous mode stop for the human-owned manual identity/new-versus-resume gate. The human approves or adjusts `<project>:manual:<approved-name>:<YYYY-MM-DD>` after a bounded preview of the project, proposed name, complete key, validated source/file reference, bounded outcome, and explicit `new` or `resume` choice. Both `project` and `approved-name` must each be 1–80 lowercase ASCII characters matching exactly `[a-z0-9]+(?:-[a-z0-9]+)*`; the verified UTC date freezes with the approved key. An invalid adjustment requires correction, a new complete preview, and renewed approval. The canonical handoff is `lifecycle:<key>`. Exact collision/recall evidence is required: an exact existing key only resumes through the human-selected resume choice, and an expected-empty exact key only proceeds through the human-selected new choice. There is no naming registry, similarity match, auto-suffix, merge, or overwrite. The manual identity/new-versus-resume gate and required first-use BookStack placement consent are human-owned and independent of plan approval. Guided plan approval is human-owned. Only after the existing safety gate can the orchestrator approve an eligible autonomous plan; an unsafe autonomous plan blocks. Integration, file-validation, lifecycle-evidence, or provider failures remain blocked results, not evidence of deterministic model compliance or live-provider acceptance.

## Lifecycle authority, memory, and integrations

BookStack, Qdrant, Serena, and Markdown are the sole lifecycle authorities. Before a checkout-local pin exists, the lifecycle service evaluates a provider preference in this order: explicit session preference, project preference, Serena preference, global lower-case `AGENTS.md` preference, then the default priority: BookStack, Qdrant, Serena, Markdown. It shows the recommendation, its source, and any BookStack sharing implication; **only the user** confirms the provider and, for BookStack, that shared placement is appropriate.

A valid pin skips selection. Before the first write, selection may be reevaluated only after a proven no-write result; an uncertain write blocks. The first approved, verified write creates the checkout-local pin. Later operations, including fresh sessions, use only that pin: a pinned-provider failure blocks without fallback, migration, or mixing. Unpinned historical lifecycle and institutional corpus operations use Tier-1 Qdrant; any historical Qdrant lifecycle phase establishes Qdrant authority. When exact historical authority cannot be verified, operators must stop rather than assume runtime uniformly blocks unavailable historical recall. When no preference orders providers, Markdown selection is exact rather than inferred. The original four-authority contract evidence is `plane:ima:SKYNET-94`, lifecycle key `shared-dev-memory:manual:human-ai-memory-system:2026-08-31`, with approved rereview artifact `556c1dd8-c7f2-54f3-bbf4-30627aeb70e6`.

There is no live-provider or cross-device acceptance. Provider-native verification and the user-owned closeout boundary remain unchanged: verified storage does not determine lifecycle readiness or close a tracker. Provider preferences and identifiers are **non-secret variables**; credentials and tokens are **secrets**. The pin registry, Markdown evidence, local Qdrant state, and machine Serena state are **local-only values**. Configured provider service, project, or workspace destinations are **platform bindings** where applicable. See the provider-native contracts for [BookStack](bookstack-lifecycle-provider.md), [Qdrant](qdrant-lifecycle-provider.md), [Serena](serena-lifecycle-provider.md), and [Markdown](markdown-lifecycle-provider.md).

### P/R/S lineage authority

Lifecycle evidence has three fixed operator-facing roles: **P** is the verified provider-pin anchor, **R** is the original lifecycle-seed root, and **S** is the stable source identity. A rootless `plan` or `decision` is a valid lifecycle seed and establishes R. Later records retain its original R and S; a rooted initial pin also retains R. An approval receipt preserves the original R and S and never becomes or replaces the lifecycle-seed root.

Existing legacy rootless phases other than `plan` or `decision` remain unchanged but block. They have no repair, migration, repinning, or fallback path. A future rootless first write for a phase other than `plan` or `decision` is rejected before any effect. A `decision` never satisfies approved technical-plan selection; cycle adoption and closeout require a distinct approved `plan`. Before tracker effects, closeout revalidates the exact P/R/S lineage and blocks on any missing or mismatched evidence; it never auto-closes a tracker.

This selector form does not change the provider-neutral authority or lineage semantics below. Their approved evidence is baseline canonical source `plane:ima:SKYNET-230`, final approved rereview `d2ffc65d-35ae-57cd-bfc2-ed9f3c65c69c`, and assessment `direct:d7f62171-e139-422b-a05b-7b59b929fef1`; verified decision-seed correction `plane:ima:SKYNET-245`.

### Provider-neutral lifecycle reads

`ima_lifecycle_recall({ lifecycleKey, phase?, limit? })` is the public read-only discovery surface. It returns at most 20 verified descriptors; `limit` defaults to 20 and may be 1–20. A descriptor contains `lifecycleKey`, exact `phase`, `artifactId`, `recordKey`, `contentHash`, a bounded `summary` (at most 2,000 UTF-8 bytes), and a closed `reference` proof—never provider, checkout path, endpoint, credential, or resource authority.

`ima_lifecycle_get({ lifecycleKey, phase, artifactId })` is the recommended model-facing exact read. The package freshly recalls that exact phase, requires one unambiguous non-saturated match, projects the closed descriptor proof internally, and returns one complete verified artifact. The complete descriptor form remains accepted for compatibility and is verified strictly, but models must not reconstruct or resend `recordKey`, `contentHash`, `summary`, or `reference` as get arguments. `document` is an exact public phase and never expands to `closeout`.

Failed reads preserve their existing error code and message and may add an optional, bounded `error.diagnostic`. Provider diagnostics use only the allowlisted codes `provider_access_denied`, `provider_adapter_unavailable`, `provider_operation_failed`, `provider_response_invalid`, `provider_transport_failed`, `provider_unavailable`, or `provider_verification_failed`, with optional safe `phase` and `reason` metadata. Get-side local verification diagnostics use stage `verification` and only `get_reference_projection_failed`, `get_record_verification_failed`, `get_descriptor_projection_failed`, or `get_descriptor_mismatch`; runtime uses only `unexpected_failure`. Diagnostics never include a provider name, endpoint, credential, page or resource ID, artifact content, raw upstream error, or stack trace.

After pinning, the durable pin is the sole authority for both tools. Only while the lifecycle is genuinely unpinned may they use exact all-phase historical Qdrant authority. A pending, unavailable, changed, malformed, mismatched, secret-shaped, or incomplete read fails closed: the tools perform no provider selection, mutation, pinning, fallback, repair, migration, or partial output. Closed references prove a verified binding; they do not grant authorization or let callers select a provider or destination. `ima_corpus_*` remains the separate Qdrant-native institutional corpus API.

This provider-neutral read surface is documented from canonical source `plane:ima:SKYNET-230` and final approved rereview artifact `d2ffc65d-35ae-57cd-bfc2-ed9f3c65c69c`.

A retained BookStack `writing` attempt is not retried through `ima_lifecycle`. BookStack accepts only canonical generated page bytes or those same bytes missing one final LF; the locator hashes actual remote bytes, and every broader difference blocks. After a restart, an operator may use the TUI-only `ima_bookstack_lifecycle_recover` tool with the exact original lifecycle request, exact existing placement, and exact local-only `attemptId`. After one confirmation and two matching stable discoveries, one exact verified existing page pins with zero page POSTs; otherwise a durable one-shot checkpoint permits at most one page POST followed by direct verification and pin confirmation. With a consumed checkpoint, missing, ambiguous, or changed evidence blocks and cannot POST. The tool has no provider selection, fallback, container provisioning, deletion, abandonment, or retry option. Empty-slug unrelated drafts are accepted only as count-preserving page-list discovery entries; authoritative reads and writes remain strict. The complete input contract, configuration classifications, and residual crash/concurrency risk are in the [BookStack provider contract](bookstack-lifecycle-provider.md#operator-owned-same-attempt-page-recovery).

When Pi's precedence permits the supported lower-case layout, global `AGENTS.md` holds current cross-project user preferences and explicit decisions. Serena also holds stable project context and instructions; Vestige retains only explicitly cited legacy evidence and the separate T7 migration source. Jira, Taskwarrior, browser, brokered MCP services, and other integration executables remain external boundaries. See [`foundation/FNR-3032.md`](foundation/FNR-3032.md) for the integration inventory.

For private BookStack discovery and authoring, use `/ima:bookstack-search` and the [`ima-bookstack` tool contract](../skills/ima-bookstack/SKILL.md); see the [developer setup runbook](bookstack-knowledge.md).

## User preference management

Pi resolves global context files at startup and after `/reload`. `/ima:memorize` supports the
lower-case `AGENTS.md` destination only when `PI_CODING_AGENT_DIR` is non-empty (otherwise
`~/.pi/agent`) and Pi's precedence does not select an `AGENTS.override.md` or an uppercase-only
`AGENTS.MD` layout. Those unsupported active layouts stop without mutation; `/ima:memorize` never
edits an override, uppercase AGENTS file, or `CLAUDE` variant. For a supported absent destination,
`ima-preferences` previews one complete document containing `# User Preferences`, a meaningful
heading, and the exact preference before one approved native write and read-back verification. It
rejects secrets, credentials, transient context, and ambiguous conflicts; 500 lines is advisory
only. After a direct human edit, use `/reload` or restart Pi.

## Degradation and troubleshooting

Missing credentials, provider access, IDE support, browser tooling, MCP executables, Jira/Taskwarrior access, or memory backends should affect only the invoked capability. They do not make a successful package installation fail. For lifecycle work, a pinned-provider failure is a blocked result, not permission to substitute another provider. Each provider verifies evidence under its own contract; unavailable cited-Vestige legacy evidence or T7 migration affects only that invoked capability. Current preferences use native global `AGENTS.md` context files. Use `/ima:preflight` and [`/skill:pi-preflight`](../skills/pi-preflight/SKILL.md) for read-only diagnosis. In the recorded clean-install acceptance, a non-interactive preflight prompt reached an unavailable default provider before diagnostics; treat that as a provider limitation, not an installation failure.

## Updates, removal, rollback, and local development

Consult your installed Pi version's help/documentation before updating or removing a package; do not copy unverified syntax from this guide. For checkout development, install the local checkout through Pi's supported local-package path, then run the repository checks:

```bash
pi install /path/to/ima-pi
npm test
git diff --check
```

Rollback for documentation-only changes is a normal Git revert and does not alter provider pins, authoritative history, or remote state. For shared-memory and lifecycle readiness, follow the [non-destructive rollback procedure](#documentation-only-non-destructive-rollback); package removal uses the installed Pi version's documented command.

## Optional cross-harness skill synchronization

`npm run install:skills -- --validate` and `npm run install:skills` copy package skills for other harnesses. This is optional compatibility synchronization, not a Pi installer, and it does not edit Pi settings, credentials, or integration configuration.

## Evidence and further reading

- [`foundation/FNR-3034.md`](foundation/FNR-3034.md) — clean-install evidence, coverage, limitations, and rollback
- [`foundation/FNR-3032.md`](foundation/FNR-3032.md) — integration boundaries
- [`foundation/FNR-3033.md`](foundation/FNR-3033.md) — operational guidance
- [Lesson 13: Claude Code, Goose, and Pi Workflows](https://flccc.atlassian.net/wiki/spaces/FNR/pages/845611010/Lesson+13+Claude+Code+Goose+and+Pi+Workflows) — cross-harness comparison
