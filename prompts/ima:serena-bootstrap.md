---
description: Load Serena project instructions and standard project memory read-only through direct MCP
argument-hint: "[optional project-memory context]"
---
Use the package MCP adapter, never generated SDK namespaces. Discover Serena through the compact mcp proxy. In exact order, call direct Serena tools to activate the current project, load initial_instructions, list memories, then read each present standard memory: core, conventions, tech_stack, suggested_commands, task_completion, and memory_maintenance when present. Do not pass a Taskwarrior project as Serena identity.

Return discovery, activation, instructions, listing, and every memory as PASS, MISSING, or FAIL. Recommend migration for a missing memory without writing it. On discovery, activation, instruction, or listing failure, report a safe error excerpt and stop. This prompt is read-only. Stop after the bootstrap summary.
