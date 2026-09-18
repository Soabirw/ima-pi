---
description: Load Serena project instructions and standard project memory through package-owned read-only bootstrap
argument-hint: "[optional project-memory context]"
---
Use the native `ima_context` tool for this read-only Serena bootstrap. Provide the current work's typed source; when there is no work source, use one bounded `text` source solely for project context. The package—not the model—owns the configured connection and, when available, same-connection capability discovery, private initialization, exact current-checkout activation and receipt verification, and standard-memory loading. The package MCP adapter is internal to that boundary and is never model-directed.

Do not use direct Serena tools to activate the checkout, load `initial_instructions`, list memories, or read memories. Do not inspect capabilities, construct or relay session state, or supply a checkout identity. Do not pass a Taskwarrior project as Serena identity. In a session-required protocol, package initialization completes before activation; the package also activates and verifies the exact checkout on the legacy-compatible path.

Private state is bounded, stays connection-local, and is accepted only when every present carrier agrees. Never print, persist, or propagate private values, raw initialization responses, credentials, fragments, or hashes. SDK-normalized structured-only responses remain acceptable only under the same validation. Unsupported schema semantics and malformed or ambiguous responses fail closed before further effects.

From the sanitized package result, return bootstrap, instructions, listing, and each present standard memory—`core`, `conventions`, `tech_stack`, `suggested_commands`, `task_completion`, and `memory_maintenance`—as PASS, MISSING, or FAIL. Recommend migration for a missing memory without writing it. On failure, report only the bounded package stage and stop: no blind retry, reconnect, fallback, provider switch, or model-mediated state propagation. Stop after the bootstrap summary.
