# Configurable command model profiles

## Outcome

IMA Pi profiles bind a configured `/ima:*` command or model role to an exact provider, model, and optional thinking level without reinstalling package resources. Required roles remain `HIGH`, `MID`, `LOW`, and `vision`; optional `XHIGH` is distinct from a thinking override. `/ima:profile` selects a named configuration for its current session (including reload/resume) and atomically updates the user default. Workflow input is considered before Pi expands the prompt template.

## Resolution

Profile files are discovered in this order:

1. trusted project `.pi/ima/profiles/*.json`;
2. user `~/.pi/agent/ima/profiles/*.json`;
3. package `config/presets/*.json`.

A project profile is ignored when the project is not trusted. Schema-v1 profile JSON accepts `schemaVersion`, `profile`, `models`, legacy `phases`, and `commands`. Direct command/phase mappings contain a provider, model, and optional thinking level; command/phase values may instead use `low`, `mid`, `high`, or `xhigh` to resolve a configured role.

User and trusted-project configuration replace complete role, phase, or command entries from the selected profile. A route for command `X` resolves in this order:

1. explicit `commands[X]`;
2. explicit legacy `phases[COMMAND_PHASE_FALLBACK[X] ?? X]`;
3. no route, so the prompt proceeds on the current model.

The only fallback aliases are `resolve-review` -> `resolution`, `implement-js` -> `implement`, and `implement-wp` -> `implement`. Phase inheritance is intentionally removed: omitted phase mappings are not synthesized from `HIGH` or `MID`.

Invalid JSON, unsupported schema versions, invalid profiles, unknown presets, and profile filesystem safety diagnostics block configuration. Unknown keys, unknown phases, malformed command/phase mappings, and unknown command names are warnings; invalid entries are dropped while valid siblings remain usable. A soft prompt-directory check warns for a command key that does not match a packaged `ima:<name>.md` prompt or role selector. Model-role mapping failures remain fatal because delegation depends on them.

## Runtime behavior

The extension observes any `/ima:<name>` input. It loads configuration, reports non-fatal diagnostics as warnings, and resolves the bare name. No resolved route means `continue`: the prompt is not blocked and the session model is unchanged. A resolved route verifies model availability and configured authentication, refuses a busy session, snapshots current model/thinking state, applies Pi's native setters, and rejects a clamped thinking level. A failed or partial switch restores the previous model and thinking level; failed restoration blocks that command and requires manual model selection. Route evidence records the profile, command, provider, model, and thinking level.

`/ima:cycle` maps each lifecycle phase to its dispatched command name before using the same resolver. In particular, the resolution phase uses `resolve-review`; when no route is configured, the cycle step runs on the current model rather than blocking. `/ima:new` accepts bare invocation, role selectors, and discovered IMA command names. A command selector uses the same lookup and may start unchanged when it has no route; an explicitly resolved route remains fail-closed for busy, unavailable, unauthenticated, unsupported, or rollback-failed switching. It preserves the existing parent-link and Serena -> Vestige -> mapped-skill bootstrap ordering.

Unrelated prompts and manual model selection are not forced to a profile. `reviewVerify`, vision, adversarial, exploration, and preflight routes retain their existing specialized behavior; explicit agent phase metadata continues to govern matching lifecycle agents while tier expresses capability and authority.

## Built-in experiment

`openai-codex-56-max` retains its explicit legacy mappings:

| Legacy phase fallback | Route |
|---|---|
| plan | `openai-codex/gpt-5.6-terra`, `max` |
| implement | `openai-codex/gpt-5.6-luna`, `max` |
| test | `openai-codex/gpt-5.6-luna`, `max` |
| review | `openai-codex/gpt-5.6-sol`, `xhigh` |
| document | `openai-codex/gpt-5.6-terra`, `max` |

Resolution and rereview intentionally pass through unless a profile adds explicit phase or command mappings. Provider availability, authentication, thinking-level support, and human TUI acceptance remain environmental. Provider-free tests cover parsing, validation, precedence, passthrough, persistence, transaction rollback, and cycle/new-session lookup consistency; live model switching is a separate acceptance path.
