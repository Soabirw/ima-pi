---
description: Load relevant user preferences through direct Vestige MCP without mutation
argument-hint: "[optional preference topic]"
---
Use the package MCP adapter, never generated SDK namespaces. Discover Vestige through the compact mcp proxy. Use one bounded read-only session_start call or focused recall query for preferences and optional context. Retrieve full memory only when a hit is insufficient; direct Vestige may not expose dedicated preference helpers.

Return discovery, preference lookup, focused fallback, and retrieval as PASS, EMPTY, FAIL, or SKIP. Summarize high-confidence preferences and label stale or partial evidence. Never ingest, suppress, delete, or otherwise mutate memory. Stop after the preference summary.
