---
name: mcp-serena
description: Serena project memory and code navigation through the Pi MCP adapter.
---
# Serena MCP
Use the package MCP adapter for Serena before broad repository reading. Use the compact mcp proxy to search Serena, describe the advertised runtime tool, then call it with exact arguments.

## Bootstrap
For project work: activate the current project, load initial_instructions, list memories, then read present core, conventions, tech_stack, suggested_commands, and task_completion memories. Never use a Taskwarrior project as Serena identity. Report missing memories and recommend migration.

Use symbols before bodies and locate references before compatibility-affecting edits. jet_brains tools need the Serena JetBrains plugin and an open IDE. Context files are migration inputs, not runtime truth. The packaged scripts/migrate-context-to-serena.py helper prepares migration material.

## Pin-aware lifecycle provider boundary

Serena is one provider behind the current pin-aware `ima_lifecycle` route. It remains separate from
ordinary bootstrap: the compact package MCP adapter—never a generated SDK namespace—performs
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
Non-sensitive lifecycle identifiers are **non-secret variables**. Serena project paths,
configuration/memories, lease state, and lifecycle pins are **local-only values**; Serena/MCP/service
credentials and tokens are **secrets**. This provider introduces no **platform binding**.

## Safety
Edits, memory writes, refactors, restart/state operations, and shell execution require explicit workflow authority. Perform these only through the package MCP adapter with explicit workflow authority; there is no separate CLI allow-flag layer.
