# Configurable command model profiles

## Outcome

IMA Pi profiles bind a configured `/ima:*` command or model role to an exact provider, model, and optional thinking level without reinstalling package resources. Required roles remain `HIGH`, `MID`, `LOW`, and `vision`; optional `XHIGH` is distinct from a thinking override. `/ima:profile` selects a named configuration for its current session (including reload/resume) and atomically updates the user default. Workflow input is considered before Pi expands the prompt template.

## Resolution

Profile files are discovered in this order:

1. trusted project `.pi/ima/profiles/*.json`;
2. user `~/.pi/agent/ima/profiles/*.json`;
3. package `config/presets/*.json`.

A project profile is ignored when the project is not trusted. Schema-v1 profile JSON accepts `schemaVersion`, `profile`, `models`, legacy `phases`, `agents`, and `commands`, including `commands.cycle`. `commands.cycle` uses the ordinary command-mapping form; it is the only cycle-specific mapping, not a phase-host schema or workflow DSL. Direct command/phase mappings contain a provider, model, and optional thinking level; command/phase values may instead use `low`, `mid`, `high`, or `xhigh` to resolve a configured role. Each `agents` entry is an exact lowercase kebab-case agent name with a complete direct mapping; it cannot use a role shorthand.

User and trusted-project configuration replace complete role, phase, agent, or command entries from the selected profile. A route for command `X` resolves in this order:

1. explicit `commands[X]`;
2. explicit legacy `phases[COMMAND_PHASE_FALLBACK[X] ?? X]`;
3. no route, so the prompt proceeds on the current model.

The only fallback aliases are `resolve-review` -> `resolution`, `implement-js` -> `implement`, and `implement-wp` -> `implement`. Phase inheritance is intentionally removed for direct commands: omitted command phase mappings are not synthesized from `HIGH` or `MID`.

A delegated agent resolves in this order: exact `agents[agent.name]`, its explicit phase mapping when present, then its tier role. This is absolute and independent of the parent session model. `review-verifier` resolves its exact agent route, then `reviewVerify`, then the visible `HIGH` fallback. A selected agent route that is unavailable, unauthenticated, unsupported, or identity-mismatched fails closed without trying a lower-precedence route. Vision overrides must support image input; exact adversary overrides participate before tier routes and must remain available and distinct.

Invalid JSON, unsupported schema versions, invalid profiles, unknown presets, profile filesystem safety diagnostics, and malformed agent mappings block configuration. Unknown keys, unknown phases, malformed command/phase mappings, and unknown command names are warnings; invalid entries are dropped while valid siblings remain usable. A soft prompt-directory check warns for a command key that does not match a packaged `ima:<name>.md` prompt or role selector. Model-role mapping failures remain fatal because delegation depends on them.

## Cycle orchestration

`/ima:cycle` is a parent orchestrator. On `start` and `resume`, it selects `commands.cycle` when configured, otherwise the configured `HIGH` role, otherwise the current parent route. An explicit configured route that is unavailable or unauthenticated blocks rather than falling through.

Each phase runs in an isolated native Pi host session with lifecycle tools and context; a host may delegate bounded specialist leaves. The only package extension excluded from phase hosts is the cycle coordinator itself, so safety and user extensions remain loaded. A phase first resolves its direct dispatched command, then its legacy phase mapping. If still unmapped, `resolution` (`resolve-review`) falls back to `implement`, `rereview` falls back to `review`, and every remaining unmapped phase inherits the coordinator route. A configured phase route that is unavailable or unauthenticated blocks; only absent mappings use those fallbacks.

`/ima:cycle reply <answer>` passes the literal answer only to the current waiting phase host. It does not itself append lifecycle evidence or advance a phase. `stop` persists cycle state before aborting its host. On restart, recovery validates the retained host session, project, and lifecycle context, reconciles evidence, and waits for explicit `resume`; it never auto-progresses. Manual confirmed `close` remains required.

Successful cycle-owned specialist session records are written only to ignored local `.ima-cycle/agent-sessions.json`. Rereview uses `ima_agent_follow_up` to continue an eligible original reviewer and never creates a new reviewer. `commands.cycle` and other profile mappings are non-secret configuration; provider credentials are secrets and are not stored in profile or local cycle records.

## Runtime behavior

The extension observes any `/ima:<name>` input. It loads configuration, reports non-fatal diagnostics as warnings, and resolves the bare name. No resolved route means `continue`: the prompt is not blocked and the session model is unchanged. A resolved route verifies model availability and configured authentication, refuses a busy session, snapshots current model/thinking state, applies Pi's native setters, and rejects a clamped thinking level. A failed or partial switch restores the previous model and thinking level; failed restoration blocks that command and requires manual model selection. Route evidence records the profile, command, provider, model, and thinking level.

`/ima:new` accepts bare invocation, role selectors, and discovered IMA command names. A command selector uses the same lookup and may start unchanged when it has no route; an explicitly resolved route remains fail-closed for busy, unavailable, unauthenticated, unsupported, or rollback-failed switching. It preserves the existing parent-link and Serena -> Vestige -> mapped-skill bootstrap ordering.

Unrelated prompts and manual model selection are not forced to a profile. `reviewVerify`, vision, adversarial, exploration, and preflight routes retain their specialized behavior. For delegated agents, exact agent configuration takes precedence over phase metadata and tier capability; phase metadata remains the middle fallback and tier still expresses capability and authority.

## Built-in experiment

`openai-codex-56-max` retains its explicit legacy mappings:

| Legacy phase fallback | Route |
|---|---|
| plan | `openai-codex/gpt-5.6-terra`, `max` |
| implement | `openai-codex/gpt-5.6-luna`, `max` |
| test | `openai-codex/gpt-5.6-luna`, `max` |
| review | `openai-codex/gpt-5.6-sol`, `xhigh` |
| document | `openai-codex/gpt-5.6-terra`, `max` |

For direct invocations and cycle hosts, an absent `resolve-review` mapping may use the configured `implement` mapping and an absent `rereview` mapping may use the configured `review` mapping. If no fallback mapping exists, a direct invocation passes through on its current model while a cycle host inherits the coordinator route. Provider availability, authentication, thinking-level support, and human TUI acceptance remain environmental. Provider-free tests cover parsing, validation, precedence, passthrough, persistence, transaction rollback, and cycle/new-session lookup consistency; live model switching is a separate acceptance path.
