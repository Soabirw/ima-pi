---
description: Explain the deprecated Vestige preference-bootstrap compatibility path without reading memory
argument-hint: "[legacy reference]"
---
Routine user preferences are already present in Pi's active global `AGENTS.md` context when context-file loading is enabled. This retained compatibility command performs no MCP discovery and no Vestige read or write.

Use `/ima:memorize` to propose an approved preference update. After a direct human edit to the global `AGENTS.md`, use `/reload` or restart Pi to load it into the active session.

Vestige remains available only for explicitly cited legacy evidence and the separate T7 migration. A cited `vestige:<UUID>` source belongs to the applicable lifecycle workflow, which retrieves only that cited memory before continuing with Tier-1 Qdrant evidence. Do not use this command as a broad preference fallback.

Do not call Vestige, ingest, suppress, delete, or otherwise mutate memory. Stop after this compatibility guidance.
