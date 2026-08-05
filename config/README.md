# IMA configuration

IMA configuration is schema-versioned JSON with exactly `schemaVersion`, optional `profile`, optional `models`, and optional `phases`. Required model roles are `HIGH`, `MID`, `LOW`, and `vision`; optional `reviewVerify`, `adversaryA`, and `adversaryB` remain available for quality routes. Every mapping has non-empty `provider` and `model`, with optional Pi `thinking` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`). Phase mappings are `plan`, `implement`, `test`, `review`, `resolution`, `rereview`, and `document`. Unknown keys, credentials, endpoints, commands, and arbitrary provider settings are rejected. Profile names are lowercase kebab-case.

Profiles resolve by trusted project -> user -> package precedence from `.pi/ima/profiles/*.json`, `~/.pi/agent/ima/profiles/*.json`, and package `config/presets/*.json`. When no live `/ima:profile` selection exists, the selected profile resolves by trusted project -> user -> package precedence from trusted project `.pi/ima/config.json`, user `~/.pi/agent/ima/config.json`, and package `config/defaults.json`, with project configuration ignored unless the caller supplies project trust. A profile file provides the base role and phase mappings; valid user then trusted-project mappings replace whole mappings. `profile: null` clears an inherited choice.

```json
{
  "schemaVersion": 1,
  "profile": "openai-codex-56-max",
  "phases": {
    "implement": { "provider": "openai-codex", "model": "gpt-5.6-luna", "thinking": "max" }
  }
}
```

Omitted phases inherit configuration only: `plan`, `review`, and `rereview` inherit `HIGH`; `implement`, `test`, `resolution`, and `document` inherit `MID`. Explicit phase overrides remain the active resolved route. This is resolved configuration inheritance, not runtime fallback. Once a phase route exists, an unavailable, unauthenticated, unsupported, or clamped route blocks before the workflow prompt runs and never downgrades to another route. Existing presets inherit the new `resolution` and `rereview` routes without redundant preset entries.

`/ima:profile` lists available profiles and their effective matrix. `/ima:profile <name>` controls the current session (including reload/resume) and atomically updates the user default while preserving valid model and phase overrides. A new session uses that default unless a trusted project configuration selects a profile. `--save` remains accepted as a compatibility alias. Ordinary Pi prompts and manual `/model` selection remain flexible; only the named IMA workflow commands are routed.

`/ima:new` is TUI-only, requires a persisted parent session, and accepts exactly no selector, `high`, or `plan`. It creates a parent-linked replacement session without copying arbitrary old-session state: `high` applies the effective `models.HIGH` role, `plan` applies the effective `phases.plan` route, and no selector applies neither. Under `--no-session`, it fails closed and requires restarting Pi without `--no-session`. A successful replacement injects Serena before Vestige and leaves an unsubmitted planning hint; route or bootstrap failure does not auto-plan or downgrade.

The built-in `openai-codex-56-max` experiment uses Terra/max for `plan` and `document`, Luna/max for `implement` and `test`, and Sol/xhigh for `review`. Credentials, provider registration, and model catalogs stay Pi-owned. No dependency or package-manifest change is required to add a valid profile.
