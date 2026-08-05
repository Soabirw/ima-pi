# Configurable phase model profiles

## Outcome

IMA Pi phase profiles bind each manual workflow to an exact provider, model, and optional thinking level without reinstalling package resources. `/ima:profile` selects a named matrix for its current session (including reload/resume) and atomically updates the user default; a new session uses that default unless its trusted project configuration selects a profile. `--save` remains a compatibility alias. Workflow input is routed before Pi expands the prompt template, and delegated agents with phase metadata load the same session profile.

## Resolution

Profile files are discovered in this order:

1. trusted project `.pi/ima/profiles/*.json`;
2. user `~/.pi/agent/ima/profiles/*.json`;
3. package `config/presets/*.json`.

A project profile is ignored when the project is not trusted. Profile names and filenames are lowercase kebab-case. Profile JSON accepts only schema-v1 `schemaVersion`, `profile`, `models`, and `phases` fields; credentials, endpoints, shell commands, and arbitrary provider settings remain outside IMA configuration.

A selected profile supplies base mappings. User and trusted-project `config.json` mappings then replace complete role or phase entries. Resolved configuration reports explicit phase overrides as active routes. Omitted phase entries inherit `HIGH` for `brainstorm`/`plan`/`review`/`rereview` and `MID` for `implement`/`test`/`resolution`/`document`. Inheritance happens while loading configuration and is never a runtime downgrade.

## Runtime behavior

The extension registers `/ima:profile` and observes raw input for the exact workflow commands:

- `/ima:brainstorm` -> `brainstorm`;
- `/ima:plan` -> `plan`;
- `/ima:implement`, `/ima:implement-js`, `/ima:implement-wp` -> `implement`;
- `/ima:test` -> `test`;
- `/ima:review` -> `review`;
- `/ima:resolve-review` -> `resolution`;
- `/ima:rereview` -> `rereview`;
- `/ima:document` -> `document`.

For a routed command, the extension resolves the phase mapping, verifies the exact model and configured authentication, refuses a busy session, snapshots the current model/thinking state, and applies the route with Pi's native setters. It verifies that the requested thinking level was not clamped. A failed or partial switch restores the previous model and thinking level; failed restoration blocks the workflow and requires manual model selection. Successful route evidence stores only profile, phase, provider, model, and thinking in the session. `/ima:cycle` calls the same reusable route adapter before injecting each explicitly resumed phase, including resolution and rereview.

No runtime fallback or downgrade occurs. Unrelated prompts and manual model selection are not intercepted. `reviewVerify`, vision, adversarial, exploration, and preflight routes retain their existing special/tier behavior; explicit agent `phase` metadata controls only the matching lifecycle agents while `tier` continues to express capability and authority.

## Built-in experiment

`openai-codex-56-max` is intentionally explicit:

| Phase | Route |
|---|---|
| plan | `openai-codex/gpt-5.6-terra`, `max` |
| implement | `openai-codex/gpt-5.6-luna`, `max` |
| test | `openai-codex/gpt-5.6-luna`, `max` |
| review | `openai-codex/gpt-5.6-sol`, `xhigh` |
| resolution | inherited from `MID` (`openai-codex/gpt-5.6-terra`, `high`) |
| rereview | inherited from `HIGH` (`openai-codex/gpt-5.6-sol`, `high`) |
| document | `openai-codex/gpt-5.6-terra`, `max` |

Provider availability, authentication, thinking-level support, and human TUI acceptance remain environmental. Provider-free tests cover parsing, validation, precedence, persistence, transaction rollback, agent consistency, and prompt/discovery contracts; live model switching is a separate acceptance path.
