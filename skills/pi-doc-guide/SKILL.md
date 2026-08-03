---
name: pi-doc-guide
description: Use authoritative Pi documentation for packages, settings, extensions, prompts, skills, models, providers, sessions, commands, and configuration syntax.
---

# Pi Documentation Guidance

Require evidence before asserting Pi field names, commands, paths, precedence, APIs, or value formats. Verify schema and command behavior before presenting configuration or usage instructions.

## Evidence ladder

1. Use current local state for an active-machine question.
2. Prefer installed version-matched documentation in the active `@earendil-works/pi-coding-agent` package: `packages.md`, `skills.md`, `extensions.md`, `prompt-templates.md`, `settings.md`, `models.md`, `providers.md`, and `security.md`.
3. Use this repository's `README.md` and `docs/foundation/` for `ima-pi` package behavior.
4. Consult current authoritative upstream Pi documentation only for explicitly latest/newer behavior or a documented local gap.
5. Report the exact missing evidence rather than guessing.

Distinguish upstream Pi semantics, `ima-pi` package behavior, and observed local state. Cite each consulted source as its exact local path or authoritative upstream URL. Never present newer upstream behavior as installed behavior without checking the installed version.

Goose documentation sites, recipes, provider/configuration schemas, and documentation maps are not active sources.
