---
description: Load Serena project instructions and standard project memory read-only
argument-hint: "[optional project-memory context]"
---
Run a terminal, read-only Serena project-memory bootstrap. `$@` is optional natural-language context; it never changes Serena project identity.

Use only the `ima-mcp serena` gateway, never a typed SDK or direct/native wrapper while the gateway is available. In this exact order: verify `ima-mcp` with `command -v ima-mcp`; activate the current project with `ima-mcp serena project activate --json`; load `ima-mcp serena instructions --json`; list `ima-mcp serena memory list --json`; then read every present standard memory: `core`, `conventions`, `tech_stack`, `suggested_commands`, `task_completion`, plus `memory_maintenance` when present. Never pass a Taskwarrior project as Serena activation identity.

Return a compact auditable status report for gateway, activation, instructions, listing, and every standard memory using exactly PASS, MISSING, or FAIL. For a missing standard memory, recommend migration but do not write it. On gateway, activation, instruction, or listing failure, report the command and safe error excerpt and stop. Do not mutate memory, files, trackers, or configuration. Stop after the bootstrap summary.
