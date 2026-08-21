---
description: Load relevant user preferences through direct Vestige MCP without mutation
argument-hint: "[optional preference topic]"
---
Use the package MCP adapter, never generated SDK namespaces.
Discover Vestige through the compact `mcp` proxy.
Use `$@` as the optional preference topic. Treat an empty value or an unexpanded literal
placeholder as no topic and select one broad read-only `session_start`. Otherwise select
one focused `recall` and pass the exact non-empty topic only as recall query data. That
native operation is the preference load; do not seek a separate helper.

On a read-only transport failure classified as MCP `-32000`, `Connection closed`, or
an adapter timeout, call `mcp({ connect: "vestige" })`. If reconnect succeeds, repeat
the same read operation with identical arguments exactly once. Allow at most one retry
per invocation. Never retry `smart_ingest` or any other mutation.

Accept preference evidence only when it contains an explicit preference or decision,
is relevant to the supplied topic, and is not merely unrelated merged lifecycle or log
content. Count only live current-invocation MCP responses as retrieved evidence; stale
`/tmp` output or prior-session caches cannot substitute. Retrieve full memory only when
its summary is insufficient.

Return discovery, preference lookup, focused fallback, and retrieval as PASS, EMPTY, FAIL, or SKIP.
Classify the final read or retrieval result before noting recovery. Recovery annotates,
never replaces, that final disposition:
- PASS — usable current-invocation evidence.
- PASS — recovered after one retry — the sole identical retry produced usable current-invocation evidence.
- EMPTY — a successful read found no matching preference.
- EMPTY — recovered after one retry — the sole identical retry succeeded but found no matching preference.
- FAIL — discovery, reconnect, the sole retry, required full retrieval, or evidence validation failed; label any remaining excerpt partial or stale.
- SKIP — the focused fallback or full retrieval was unnecessary.

Never ingest, suppress, delete, or otherwise mutate memory. Stop after the preference summary.
