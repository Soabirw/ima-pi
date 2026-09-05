# ima-pi guide

## What it is—and is not

`ima-pi` is a Pi-native IMA agent harness distributed as a normal Pi package. It supplies packaged prompts, skills, agents, extensions, policies, and configuration guidance while preserving Pi's native resource resolution. It preserves IMA workflow outcomes; it does **not** require Goose ETA/YAML rendering, path rewriting, a separate cycle executable, or a custom package installer.

## Prerequisites

Use Node.js 24+ and an installed Pi version. The normal package path also needs access to the approved private Gitea repository. Optional integrations have their own credentials and executables; they are not installation prerequisites.

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

The packaged `/ima:*` prompts provide phase or bounded-operation entry points. Use the manual lifecycle—plan, implement, test, review, resolution/rereview, document, close—or `/ima:cycle` for one explicit, user-gated Story. The cycle coordinator uses Pi custom entries and the existing lifecycle tools; it is not a generic workflow DSL or automatic progression engine. See [`foundation/FNR-3036.md`](foundation/FNR-3036.md) for its exact command syntax, source forms, safety gates, and required human acceptance. Packaged agents provide bounded roles, authority, result contracts, and `useWhen` applicability cues. When `ima_delegate` is active on an ordinary turn, Pi gives the parent a safe resolved-agent catalog so it can delegate a clear bounded match opportunistically or honor an explicit named-agent request through the same path. No match means no delegation; writers retain exact disjoint ownership, children cannot delegate, and existing activity remains visible without a confirmation loop. Each child uses its own active-profile route rather than inheriting the parent model. Fresh and focused-continuation results share a 400-line/10 KiB summary contract with an inspectable nested session pointer; full child reports remain in Pi JSONL sessions. Pi's native `/skill:*` discovery resolves reusable knowledge with normal package/user/project precedence.

## Memory and integrations

When Pi's precedence permits the supported lower-case layout, global `AGENTS.md` holds current cross-project user preferences and explicit decisions. Serena holds stable project context and instructions. Vestige retains only explicitly cited legacy evidence and the separate T7 migration source. Tier-1 Qdrant is the package-native institutional corpus for formal lifecycle artifacts and durable reference knowledge: use read-only `ima_corpus_status`, bounded manifest-summary `ima_corpus_find`/`ima_corpus_recall`, selected verified `ima_corpus_get`, and explicitly authorized `ima_corpus_store`. `ima_lifecycle` stores formal artifacts as an embedded manifest plus deterministic vectorless detail chunks and completes only after direct lossless reassembly. Lifecycle results expose both the manifest point `artifactId` and logical `recordKey`; pass either value to `ima_corpus_get` through its compatible `recordKey` argument. Qdrant is not a package MCP server. Governance records currently remain Git-tracked under `docs/decisions/`; later indexing is optional. Jira, Taskwarrior, browser, brokered MCP services, and other integration executables remain external boundaries. See [`foundation/FNR-3032.md`](foundation/FNR-3032.md) for the integration inventory.

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

Missing credentials, provider access, IDE support, browser tooling, MCP executables, Jira/Taskwarrior access, or memory backends should affect only the invoked capability. They do not make a successful package installation fail. Lifecycle hydration and reconciliation first use exact Tier-1 manifest recall, then fetch only selected full detail; a missing, duplicate, corrupt, reordered, or incomplete chunk set fails closed and is never returned as complete. `ima_lifecycle` writes chunks before the manifest commit marker and verifies direct byte-for-byte reassembly, nonce, phase, source identity, and completed outcome with no Vestige fallback. Current preferences use native global `AGENTS.md` context files; unavailable cited-Vestige legacy evidence or T7 migration affects only that invoked capability. Use `/ima:preflight` and [`/skill:pi-preflight`](../skills/pi-preflight/SKILL.md) for read-only diagnosis. In the recorded clean-install acceptance, a non-interactive preflight prompt reached an unavailable default provider before diagnostics; treat that as a provider limitation, not an installation failure.

## Updates, removal, rollback, and local development

Consult your installed Pi version's help/documentation before updating or removing a package; do not copy unverified syntax from this guide. For checkout development, install the local checkout through Pi's supported local-package path, then run the repository checks:

```bash
pi install /path/to/ima-pi
npm test
git diff --check
```

Rollback for documentation-only changes is a normal Git revert; package removal uses the installed Pi version's documented command.

## Optional cross-harness skill synchronization

`npm run install:skills -- --validate` and `npm run install:skills` copy package skills for other harnesses. This is optional compatibility synchronization, not a Pi installer, and it does not edit Pi settings, credentials, or integration configuration.

## Evidence and further reading

- [`foundation/FNR-3034.md`](foundation/FNR-3034.md) — clean-install evidence, coverage, limitations, and rollback
- [`foundation/FNR-3032.md`](foundation/FNR-3032.md) — integration boundaries
- [`foundation/FNR-3033.md`](foundation/FNR-3033.md) — operational guidance
- [Lesson 13: Claude Code, Goose, and Pi Workflows](https://flccc.atlassian.net/wiki/spaces/FNR/pages/845611010/Lesson+13+Claude+Code+Goose+and+Pi+Workflows) — cross-harness comparison
