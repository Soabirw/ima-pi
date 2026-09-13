---
name: mcp-serena
description: Serena project memory and code navigation through the Pi MCP adapter.
---
# Serena MCP
Use the package MCP adapter for Serena before broad repository reading. Use the compact mcp proxy to search Serena, describe the advertised runtime tool, then call it with exact arguments.

## Bootstrap
For project work: activate the current project, load initial_instructions, list memories, then read present core, conventions, tech_stack, suggested_commands, and task_completion memories. Never use a Taskwarrior project as Serena identity. Report missing memories and recommend migration.

Use symbols before bodies and locate references before compatibility-affecting edits. jet_brains tools need the Serena JetBrains plugin and an open IDE. Context files are migration inputs, not runtime truth. The packaged scripts/migrate-context-to-serena.py helper prepares migration material.

## Additive lifecycle provider
This internal provider is additive: it is separate from ordinary bootstrap and is not live lifecycle selection or routing. A caller that has already selected Serena may use the package's compact MCP adapter—never generated SDK namespaces—for project-bound immutable `persist`, exact `get`, bounded exact `recall`, and read-only `reconcile`. T9 alone owns confirmation, provider selection, fallback, durable pins, live routing, and dedicated sessions; this provider does not complete T9, add lifecycle pinning, or claim live acceptance.

Fail closed unless the project is already registered and existing, uses the default project-local `.serena` layout, has visible memories, and returns exact verified provider evidence. Never use a Taskwarrior project as Serena identity. After an unknown write, retain the local exclusion: do not retry or fall back, and require operator-authorized recovery; there is no automatic recovery. Live synthetic Serena acceptance remains unperformed. See the [Serena lifecycle provider contract](../../docs/serena-lifecycle-provider.md).

`SERENA_HOME` is a **non-secret variable** and provider v1 does not use or configure it. Serena project paths, configuration/memories, and lease state are **local-only values**; Serena/MCP/service credentials are **secrets**. This provider introduces no **platform binding**.

## Safety
Edits, memory writes, refactors, restart/state operations, and shell execution require explicit workflow authority. Perform these only through the package MCP adapter with explicit workflow authority; there is no separate CLI allow-flag layer.
