---
description: Load relevant user preferences through Vestige without mutation
argument-hint: "[optional preference topic]"
---
Run a terminal, read-only Vestige preference bootstrap. `$@` is an optional natural-language topic.

Verify `ima-mcp` with `command -v ima-mcp`, call `ima-mcp vestige status --json`, then prefer `ima-mcp vestige preferences list --json` (or focused `ima-mcp vestige preferences search "$@" --json`). Use high-level `ima-mcp vestige search` only if the preference helper is unavailable. If a healthy backend search times out, retry once with `--timeout-ms 300000`. Retrieve a full hit only when its list/search content is insufficient using `ima-mcp vestige get <id> --json`.

Return gateway, status, preference search, focused fallback, and retrieval as PASS, EMPTY, FAIL, or SKIP; summarize relevant high-confidence preferences with IDs and label stale or partial uncertainty. Never save, suppress, delete, or otherwise mutate memory. Stop after the preference summary.
