---
description: Preview and save one stable project fact or cross-project preference safely
argument-hint: "[what should be remembered]"
---
Use natural language as the interface: `$@` is an ordinary request, and users do not need parameter grammar, target tokens, or memory names. If it is empty, ask for the note and wait.

Use `ima-memory-workflow` to infer the smallest closed destination by meaning: cross-project user preference or decision -> Pi's supported global lower-case `AGENTS.md` through `ima-preferences`; project purpose, architecture, ownership, or path -> Serena `core`; stable coding/workflow rule -> `conventions`; runtime/toolchain/integration fact -> `tech_stack`; canonical command/prerequisite -> `suggested_commands`; verification/review/docs/closeout rule -> `task_completion`; provenance/refresh policy -> `memory_maintenance`. Ask one focused question only when project-local versus cross-project scope is materially ambiguous. Reject secrets, credentials, raw logs, transcripts, and temporary evidence. Redirect active lifecycle state to `ima_lifecycle` and durable reference knowledge to Qdrant.

For a global preference, load `ima-preferences`. Resolve `PI_CODING_AGENT_DIR/AGENTS.md` only when `PI_CODING_AGENT_DIR` is non-empty; otherwise use `~/.pi/agent/AGENTS.md`. Before any preview or mutation, use Pi's built-in file operations to establish whether regular `AGENTS.override.md`, lower-case `AGENTS.md`, and `AGENTS.MD` exist. A regular `AGENTS.override.md` -> stop with `unsupported-active-layout` and perform no mutation. Absent lower-case `AGENTS.md` plus regular `AGENTS.MD` -> stop with `would-shadow-active-file` and perform no mutation. Do not edit an override, uppercase AGENTS file, or `CLAUDE` variant. Otherwise read the whole supported lower-case destination and preserve unrelated content.

For an absent supported lower-case destination, infer a meaningful heading before approval. If none can be inferred safely, ask and perform no mutation. Otherwise preview one complete document:

```markdown
# User Preferences

## <the meaningful heading shown in the preview>

- <the exact approved preference wording>
```

After explicit approval, create that complete document in one native write, re-read it, and verify the heading and exact preference. Never create a heading-only initialization. Existing unreadable file -> fail without mutation; duplicate -> no-op; unambiguous supersession -> preview an exact replacement; ambiguous conflict -> ask; ambiguous exact-edit target -> fail with no broad-rewrite fallback; near or above 500 lines -> advise consolidation but allow an approved write. Never call Vestige for this path.

Before a preview, bootstrap/read the inferred system and search or read existing content for equivalent, conflicting, or superseded facts. For a Serena preview, read the relevant standard memories: at minimum `conventions`, `suggested_commands`, `task_completion`, and `memory_maintenance`, plus `core` or `tech_stack` when the note may belong there. Preserve existing Serena content. Present one plain-language exact preview: inferred scope, destination, exact proposed wording, duplicate/conflict result, and whether it adds, replaces, merges, or supersedes. Obtain explicit approval immediately before exactly one write; material drift requires a new preview.

For Serena: activate, load instructions, list memories, and read the relevant memory first. For an existing memory, use the package MCP adapter to call `serena_edit_memory` with `{"memory_name":"...","needle":"...","repl":"...","mode":"literal","allow_multiple_occurrences":false}`. Reject zero-match or multiple-match ambiguity. For a missing memory or content-preserving reconstruction, call `serena_write_memory` with `{"memory_name":"...","content":"..."}`, then verify by exact `serena_read_memory`. For an approved global preference, perform one built-in native edit or write only after the exact preview and explicit approval, then re-read and verify it. Report the human-readable destination and verification; do not expose raw payloads. Do not inspect repository files, run Taskwarrior, search Vestige/Qdrant, fetch Jira, or browse the web unless the user explicitly asks after the memory update. Stop after one verified memory update.
