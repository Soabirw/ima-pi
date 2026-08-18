---
name: mcp-vestige
description: Vestige working memory and task lifecycle continuity through the Pi MCP adapter.
---
# Vestige MCP
Use Vestige for preferences, decisions, plans, active task state, findings, and closeout learning. Use Serena for stable project instructions and Qdrant for durable references.

Discover direct Vestige tools through mcp. Common native tools include session_start, recall, memory, intention, smart_ingest, and memory_status. Before task work, use one bounded session_start or focused recall query for task UUID, Jira key, and preferences. Use one lifecycle thread through plan, implementation, test, review, resolution, rereview, and closeout.

Writes including smart_ingest are explicit mutations requiring authority. `ima_lifecycle` persists and semantically verifies lifecycle artifacts directly through Vestige MCP: it calls `smart_ingest`, then requires a successful receipt and `recall` nonce/identity/outcome match. It does not require the `ima-mcp` binary. Callers must continue to use `ima_lifecycle` rather than bypassing its lifecycle receipt protocol.
