---
name: mcp-vestige
description: Vestige working memory and task lifecycle continuity through the Pi MCP adapter.
---
# Vestige MCP
Use Vestige for preferences, decisions, plans, active task state, findings, and closeout
learning. Use Serena for stable project instructions and Qdrant for durable references.

## Preference load and recovery

Use the package MCP adapter. Discover direct Vestige tools through mcp. Common native
tools include `session_start`, `recall`, `memory`, `intention`, `smart_ingest`, and
`memory_status`. One bounded `session_start` for broad context or focused `recall` for
a topic is the preference LOAD; do not seek a separate helper. Use one lifecycle thread
through plan, implementation, test, review, resolution, rereview, and closeout.

For a transient read-only transport failure (`-32000`, `Connection closed`, or adapter
timeout), call `mcp({ connect: "vestige" })`. After a successful reconnect, repeat the
same read with identical arguments exactly once. Never retry `smart_ingest` or any
mutation. Accept preference evidence only when it is an explicit, topic-relevant
preference or decision from the live current invocation; reject unrelated merged
lifecycle or log content and stale cached output. Stop after an adequate summary.
Retrieve a selected full memory only when its summary cannot support relevance
validation or preference summarization. If that required retrieval fails, report partial
or failed evidence rather than guessing.

## Bounded lifecycle discovery

For focused lifecycle discovery, call `recall` through the package MCP adapter with the
existing bounded shape:

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

Reuse these package-standard limits rather than inventing another set. Validate candidate
IDs and summaries, then use `vestige_memory` with `{ action: "get", id }` only for
selected candidates whose summaries are insufficient. A failed or oversized exact read
is partial or failed evidence; never broaden to unbounded recall or mutate memory.

Persist preferences through `/ima:memorize`, which owns its approval and verification
flow. Writes including `smart_ingest` are explicit mutations requiring authority.
`ima_lifecycle` persists and semantically verifies lifecycle artifacts directly through
Vestige MCP: it calls `smart_ingest`, then requires a successful receipt and `recall`
nonce/identity/outcome match. Callers must continue to use `ima_lifecycle` rather than
bypassing its lifecycle receipt protocol.
