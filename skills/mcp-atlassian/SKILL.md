---
name: mcp-atlassian
description: Jira and Confluence via a packaged REST helper with narrow approved writes.
---
# Atlassian REST helper
Use the packaged REST helper as the supported route; Rovo MCP is optional and not registered by default. Resolve scripts/atlassian-api.mjs relative to this skill directory. Supported forms include jira:get, jira:search, jira:transitions, jira:transition, confluence:search, and confluence:get.

Read issue metadata, status, comments, and transitions before a write. Look up transition IDs before transitioning. Keep locale English, preserve authentication environment names, and never print tokens or credentials. Comments, transitions, and Confluence writes require narrow explicit approval.
