---
name: mcp-serena
description: Serena project memory and code navigation through the package-owned Serena boundary.
---
# Serena MCP
Use the native `ima_context` tool before broad repository reading. It is the package-owned Serena bootstrap boundary: the package, not the model, opens the configured connection and, when available, performs same-connection capability discovery, private initialization, exact current-checkout activation/receipt verification, and standard-memory loading. The package MCP adapter is internal to that boundary and is never model-directed. Never use a generated SDK namespace or a direct compact `mcp` Serena sequence for bootstrap.

## Package-owned bootstrap
For current project work, give `ima_context` the valid typed source already governing the work. For bootstrap-only work, use one bounded `text` source. Do not tell the model to activate the checkout, invoke `initial_instructions`, list memories, or read memories directly; do not inspect advertised schemas, create session arguments, or relay checkout or private state. Never use a Taskwarrior project as Serena identity.

The package initializes before activation when the advertised protocol requires a session and also activates and verifies the exact checkout on the legacy-compatible path. Private state is bounded, connection-local, and accepted only when all present carriers agree. It is never printed or persisted. SDK-normalized structured-only responses are accepted only after the same strict validation; unsupported schema semantics and malformed or ambiguous responses fail closed before further effects.

Use the sanitized package result to identify the read-only status of `core`, `conventions`, `tech_stack`, `suggested_commands`, `task_completion`, and `memory_maintenance`. Report a missing memory and recommend migration without writing it. Stop on a package failure: no blind retry, reconnect, fallback, provider switch, or model-mediated state propagation.

When a delegated child is explicitly granted `ima_serena_bootstrap`, call that package-owned tool exactly once with an empty object. Do not call Serena MCP directly, and do not put the checkout or private state in child instructions. The parent/package supplies the fixed checkout internally.

Use symbols before bodies and locate references before compatibility-affecting edits. jet_brains tools need the Serena JetBrains plugin and an open IDE. Context files are migration inputs, not runtime truth. The packaged scripts/migrate-context-to-serena.py helper prepares migration material.

## Pin-aware lifecycle provider boundary

Serena is one provider behind the current pin-aware `ima_lifecycle` route. It remains separate from
ordinary bootstrap: the package lifecycle adapter—not the model and never a generated SDK namespace—performs
project-bound immutable `persist`, exact `get`, bounded exact `recall`, and read-only `reconcile`
only when `ima-lifecycle-contract` has selected Serena for an authorized unpinned attempt or
recovered a Serena pin. The provider does not choose a lifecycle provider, change a pin, migrate
evidence, or supply fallback. See the [current
lifecycle routing contract](../ima-lifecycle-contract/SKILL.md) and the [Serena lifecycle provider
contract](../../docs/serena-lifecycle-provider.md).

Fail closed unless the project is already registered and existing, uses the default project-local
`.serena` layout, has visible memories, and returns exact verified provider evidence. Never use a
Taskwarrior project as Serena identity. After an unknown write, retain the local exclusion: do not
retry or fall back, and require operator-authorized recovery; there is no automatic recovery. A
local pin does not claim live acceptance, replication, or cross-device Serena authority.

`SERENA_HOME` is a **non-secret variable** and provider v1 does not use or configure it.
Non-sensitive lifecycle identifiers are **non-secret variables**. Serena checkout paths,
configuration/memories, session state, lease state, and lifecycle pins are **local-only values**.
Serena MCP is a **platform binding**. Serena/MCP/service credentials and tokens are **secrets**.

## Safety
Edits, memory writes, refactors, restart/state operations, and shell execution require explicit workflow authority. Perform authorized operations only through the package-owned Serena boundary; there is no separate CLI allow-flag layer.
