---
name: mcp-vestige
description: Vestige working memory and task lifecycle continuity through the Pi MCP adapter.
---
# Vestige MCP
Use Vestige for preferences, decisions, plans, active task state, findings, and closeout learning. Use Serena for stable project instructions and Qdrant for durable references.

Discover direct Vestige tools through mcp. Common native tools include session_start, recall, memory, intention, smart_ingest, and memory_status. Before task work, use one bounded session_start or focused recall query for task UUID, Jira key, and preferences. Use one lifecycle thread through plan, implementation, test, review, resolution, rereview, and closeout.

Writes including smart_ingest are explicit mutations requiring authority. Direct Vestige may not provide ima-mcp preference helpers, typed save categories, receipts, or nonce correlation. Do not claim direct ingestion satisfies the existing ima_lifecycle receipt protocol; that compatibility boundary remains unchanged until separately migrated.
