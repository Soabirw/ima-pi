---
name: mcp-vestige
description: Vestige preference retrieval through the Pi MCP adapter.
---
# Vestige MCP

Use Vestige only for bounded user preferences and explicit preference decisions. Serena owns
stable project instructions. Qdrant owns formal lifecycle artifacts and institutional detail.
Do not use Vestige for lifecycle persistence, lifecycle recall, per-node lifecycle reads, or a
fallback when corpus work fails.

## Preference load and recovery

Use the package MCP adapter. Discover direct Vestige tools through mcp. One bounded
`session_start` for broad context or one focused `recall` for a supplied preference topic is the
preference load; do not seek a separate helper.

For a focused topic, pass the exact non-empty topic only as `recall` query data with the bounded
shape:

```js
{
  query,
  mode: "lookup",
  retrieval_mode: "precise",
  detail_level: "brief",
  concrete: true,
  limit: 10,
  token_budget: 1000,
}
```

On a transient read-only transport failure (`-32000`, `Connection closed`, or adapter timeout),
call `mcp({ connect: "vestige" })`. After a successful reconnect, repeat the same read with
identical arguments exactly once. Never retry `smart_ingest` or any mutation.

Accept evidence only when it is an explicit, topic-relevant preference or decision from the live
current invocation. Reject unrelated merged lifecycle or log content and stale cached output.
Retrieve one selected full memory only when the summary is insufficient for preference relevance or summarization; use `vestige_memory` with `{ action: "get", id }`. If that required read
fails, report partial or failed evidence rather than guessing. Stop after an adequate summary of preferences.

## Mutation boundary

Preference writes route through `/ima:memorize`, which owns preview, approval, and verification.
Writes including `smart_ingest` require separate explicit authority and are never part of a
preference bootstrap. Formal lifecycle persistence and verification remain owned by
`ima_lifecycle`, which stores a Qdrant manifest plus verified detail chunks and has no Vestige
fallback.
