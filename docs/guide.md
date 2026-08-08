# ima-pi guide

## What it is—and is not

`ima-pi` is a Pi-native IMA agent harness distributed as a normal Pi package. It supplies packaged prompts, skills, agents, extensions, policies, and configuration guidance while preserving Pi's native resource resolution. It preserves IMA workflow outcomes; it does **not** require Goose ETA/YAML rendering, path rewriting, a separate cycle executable, or a custom package installer.

## Prerequisites

Use Node.js 24+ and an installed Pi version. The normal package path also needs access to the approved private Gitea repository. Optional integrations have their own credentials and executables; they are not installation prerequisites.

## Team/global Git installation

Install with Pi's standard package command:

```bash
pi install ssh://git@gitea.theflccc.org:2222/IMA/ima-pi.git
```

This is the canonical normal-install path. Do not run `scripts/install.ts` as part of Pi installation.

## First-run package verification

Start Pi from the installed environment and confirm an `/ima:*` command and `/skill:*` guidance are discoverable. The clean-install acceptance observed `/ima:probe`, `/ima:plan`, `/skill:ima-pi-guide`, and `/skill:pi-preflight` with package provenance for the prompt. Use `pi --help` and package-specific help from your installed Pi version for current listing, update, and removal syntax.

## Configuration and model roles

Opt-in IMA configuration can live in `~/.pi/agent/ima/config.json` or trusted `.pi/ima/config.json`; project-local configuration takes precedence as documented in [`../config/README.md`](../config/README.md). Profiles express required `HIGH`, `MID`, `LOW`, and `vision` roles plus optional quality roles and distinct configurable `XHIGH`. They may map bare `/ima:*` command names through `commands`, with explicit legacy `phases` as a fallback. A command resolves `commands[X]`, then the matching explicit phase (with only `resolve-review` -> `resolution` and the two implementation aliases), then runs unchanged when neither exists. Unknown extra config entries warn and are dropped without blocking unrelated commands; invalid foundational role mappings remain fatal. In TUI mode, `/ima:new` accepts bare invocation, `low`, `mid`, `high`, `xhigh`, and discovered IMA command names. It creates a fresh replacement session with no explicit route, the selected role route, or the selected command route respectively; an unconfigured command stays on the current model. A verified regular-file parent is linked; an absent, unwritten, inaccessible, or non-file parent is omitted. The replacement applies any resolved route before Serena then Vestige bootstrap bodies and any mapped package skill bodies (currently `plan` seeds `ima-lifecycle-contract` and `implement`-family commands seed `readable-code`); an unavailable, unauthenticated, unsupported, or rolled-back resolved route blocks fail-closed.

## Workflow, commands, agents, and skills

The packaged `/ima:*` prompts provide phase or bounded-operation entry points. Use the manual lifecycle—plan, implement, test, review, resolution/rereview, document, close—or `/ima:cycle` for one explicit, user-gated Story. The cycle coordinator uses Pi custom entries and the existing lifecycle tools; it is not a generic workflow DSL or automatic progression engine. See [`foundation/FNR-3036.md`](foundation/FNR-3036.md) for its exact command syntax, source forms, safety gates, and required human acceptance. Packaged agents provide bounded roles, authority, and result contracts; `ima_delegate` creates bounded child sessions and reports cancellation or partial state explicitly. Pi's native `/skill:*` discovery resolves reusable knowledge with normal package/user/project precedence.

## Memory and integrations

Serena holds stable project context and instructions. Vestige holds preferences, decisions, and reconstructable task lifecycle artifacts. Qdrant is for durable reference knowledge. Jira, Taskwarrior, browser, MCP services, and other integration executables remain external boundaries. See [`foundation/FNR-3032.md`](foundation/FNR-3032.md) for the integration inventory.

## Degradation and troubleshooting

Missing credentials, provider access, IDE support, browser tooling, MCP executables, Jira/Taskwarrior access, or memory backends should affect only the invoked capability. They do not make a successful package installation fail. Use `/ima:preflight` and [`/skill:pi-preflight`](../skills/pi-preflight/SKILL.md) for read-only diagnosis. In the recorded clean-install acceptance, a non-interactive preflight prompt reached an unavailable default provider before diagnostics; treat that as a provider limitation, not an installation failure.

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
