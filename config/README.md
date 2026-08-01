# IMA configuration

IMA configuration is schema-versioned JSON with exactly `schemaVersion`, optional `profile`, and optional `models`. Required model roles are `HIGH`, `MID`, `LOW`, and `vision`; optional `reviewVerify` selects a dedicated fresh second-opinion route when configured; every mapping has non-empty `provider` and `model`, with optional Pi `thinking` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`). Unknown keys, credentials, endpoints, and arbitrary provider settings are rejected.

Paths are package `config/defaults.json` and `config/presets/<name>.json`, user `~/.pi/agent/ima/config.json`, and trusted project `.pi/ima/config.json`. The loader never reads project configuration unless its caller explicitly supplies `projectTrusted: true`. Package defaults select nothing. Profile choice resolves package → user → trusted project; models resolve selected preset → user → trusted project. A higher-precedence role replaces the whole role mapping, and `profile: null` clears an inherited choice.

```json
{"schemaVersion":1,"profile":"openai-codex-56"}
```

A complete configuration has independent mappings for all four required roles. `reviewVerify` is optional: when omitted, fresh review verification visibly uses `HIGH`; when explicitly configured but unavailable, verification fails closed. `vision` never inherits another role and catalog validation requires its exact provider/model entry to advertise image input; no model falls back automatically. Presets are opt-in data, while credentials, provider registration, and model catalogs stay Pi-owned. To add an ordinary preset, add a schema-valid JSON file under `presets/`; no resolution-code change is required.
