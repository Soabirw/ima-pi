# IMA configuration

IMA configuration is schema-versioned JSON with exactly `schemaVersion`, optional `profile`, optional `models`, and optional `phases`. Required model roles are `HIGH`, `MID`, `LOW`, and `vision`; optional `reviewVerify`, `adversaryA`, and `adversaryB` remain available for quality routes. Every mapping has non-empty `provider` and `model`, with optional Pi `thinking` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`). Phase mappings are `plan`, `implement`, `test`, `review`, and `document`. Unknown keys, credentials, endpoints, commands, and arbitrary provider settings are rejected. Profile names are lowercase kebab-case.

Profiles resolve by trusted project -> user -> package precedence from `.pi/ima/profiles/*.json`, `~/.pi/agent/ima/profiles/*.json`, and package `config/presets/*.json`. The selected profile is controlled by package `config/defaults.json`, user `~/.pi/agent/ima/config.json`, or trusted project `.pi/ima/config.json`, with project configuration ignored unless the caller supplies project trust. A profile file provides the base role and phase mappings; valid user then trusted-project mappings replace whole mappings. `profile: null` clears an inherited choice.

```json
{
  "schemaVersion": 1,
  "profile": "openai-codex-56-max",
  "phases": {
    "implement": { "provider": "openai-codex", "model": "gpt-5.6-luna", "thinking": "max" }
  }
}
```

Omitted phases inherit configuration only: `plan` and `review` inherit `HIGH`; `implement`, `test`, and `document` inherit `MID`. This is resolved configuration inheritance, not runtime fallback. Once a phase route exists, an unavailable, unauthenticated, unsupported, or clamped route blocks before the workflow prompt runs and never downgrades to another route.

`/ima:profile` lists available profiles and their effective matrix. `/ima:profile <name>` activates a session-only selection; `/ima:profile <name> --save` also atomically updates the user default while preserving valid model and phase overrides. Session selection is stored in the Pi session and restored on reload/resume. Ordinary Pi prompts and manual `/model` selection remain flexible; only the named IMA workflow commands are routed.

The built-in `openai-codex-56-max` experiment uses Terra/max for `plan` and `document`, Luna/max for `implement` and `test`, and Sol/xhigh for `review`. Credentials, provider registration, and model catalogs stay Pi-owned. No dependency or package-manifest change is required to add a valid profile.
