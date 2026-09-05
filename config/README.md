# IMA configuration

IMA configuration is schema-versioned JSON with `schemaVersion`, optional `profile`, optional `models`, optional legacy `phases`, optional `agents`, and optional `commands`. Required model roles are `HIGH`, `MID`, `LOW`, and `vision`; optional `reviewVerify`, `adversaryA`, `adversaryB`, and distinct `XHIGH` remain available. A direct mapping has non-empty `provider` and `model`, with optional Pi `thinking` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`). Command and phase values may also be the role shorthands `low`, `mid`, `high`, or `xhigh`; `agents` values must be complete direct mappings.

`commands` uses bare `/ima:*` names, such as `resolve-review` or `implement-js`. Its keys are structurally any non-empty string, but package prompt discovery warns and drops a key that does not match a `prompts/ima:<name>.md` resource or role selector. Unknown top-level keys, unknown phases, malformed command/phase entries, and unknown command names warn and drop only the offending entry; they do not block other commands.

`agents` maps an exact lowercase kebab-case resolved agent name, such as `js-developer`, to a direct route. Agent keys must begin with a lowercase letter and may contain digits thereafter, including numeric suffixes such as `reviewer-2`; profile names may begin with a digit. A malformed `agents` container, name, or mapping is fatal rather than silently falling through. Credentials, endpoints, shell commands, and arbitrary provider settings are never used.

Profiles resolve by trusted project -> user -> package precedence from `.pi/ima/profiles/*.json`, `~/.pi/agent/ima/profiles/*.json`, and package `config/presets/*.json`. When no live `/ima:profile` selection exists, the selected profile resolves by the same precedence from trusted `.pi/ima/config.json`, user `~/.pi/agent/ima/config.json`, and package `config/defaults.json`. A profile supplies base mappings; valid user then trusted-project mappings replace whole role, phase, agent, or command entries. `profile: null` clears an inherited profile choice.

```json
{
  "schemaVersion": 1,
  "profile": "openai-codex-56-max",
  "agents": {
    "js-developer": { "provider": "openai-codex", "model": "gpt-5.6-sol", "thinking": "xhigh" }
  },
  "commands": {
    "implement-js": { "provider": "openai-codex", "model": "gpt-5.6-luna", "thinking": "max" },
    "resolve-review": "high"
  }
}
```

For a command `X`, routing resolves `commands[X]`, then an explicit legacy `phases` fallback, then passthrough. The only fallback aliases are `resolve-review` -> `resolution`, `implement-js` -> `implement`, and `implement-wp` -> `implement`; other names try the matching phase name. Omitted phase entries do **not** inherit a role. Existing presets may stay on explicit `phases` mappings, and unconfigured commands run with the current session model unchanged.

A delegated agent resolves `agents[agent.name]`, then its explicit phase route, then its tier role. `review-verifier` uses its exact agent route, then `reviewVerify`, then the visible `HIGH` fallback. A selected agent route that is unavailable, unauthenticated, unsupported, or identity-mismatched fails closed with a visible reason; it never substitutes a phase or tier route. Vision overrides still require image-capable models, and adversary overrides must remain distinct and available.

`/ima:profile` lists configured command, agent, phase, and model routes. `/ima:profile <name>` controls the current session (including reload/resume) and atomically updates the user default while preserving valid model, phase, agent, and command overrides. Ordinary Pi prompts and manual `/model` selection remain flexible; any `/ima:*` prompt is only switched when it resolves to a configured route.

`/ima:new` is TUI-only and accepts no selector, role selectors `low`, `mid`, `high`, and `xhigh`, or a discovered bare IMA command name. Role selectors apply the configured role; command selectors use the same command resolver; a command without a route starts unchanged. A verified regular-file parent is linked; missing, unwritten, inaccessible, or non-file parents are omitted. A successful replacement injects Serena before Vestige and any phase-mapped package skill; an explicitly selected configured route that is unavailable, unauthenticated, unsupported, or rolled back fails closed.

The built-in `openai-codex-56-max` experiment keeps its explicit legacy phase mappings. Credentials, provider registration, and model catalogs stay Pi-owned. No dependency or package-manifest change is required to add a valid profile.

## Desktop notifications

`notifications.json` is separate from IMA model configuration. The bundled package
configuration enables notifications by default. To opt out, create
`~/.pi/agent/ima/notifications.json` (or the matching `PI_CODING_AGENT_DIR` path):

```json
{"enable": false}
```

Only the boolean `enable` key is accepted. An empty user object inherits the bundled
default; malformed, unknown, oversized, nonregular, or unsafe files disable
notifications until `/reload` or restart. See [`../docs/notifications.md`](../docs/notifications.md)
for behavior, platform prerequisites, and manual acceptance.
