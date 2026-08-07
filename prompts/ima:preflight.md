---
description: Run bounded read-only Pi and IMA diagnostic preflight
argument-hint: "[offline, quick, full, or natural-language diagnostic request]"
---
Run a terminal, diagnostically read-only preflight. Interpret `$@` as natural language; supported scopes are `offline`, `quick`, and `full`, defaulting to `quick`. Load the `pi-preflight` skill and use it as the authoritative checklist and routing guidance. Never install, repair, configure OAuth, mutate project/config/service/memory/tracker state, or migrate anything.

In every scope inspect appropriate direct evidence for current path, `pi`, Node/npm, Git status, `ima-mcp`, Taskwarrior, package resources, and configured skills/agents. In quick/full run read-only `ima-mcp` doctor/status/bootstrap-style checks for Serena, Vestige, Qdrant, and gateway availability. Respect brokered-service semantics: `configured:false` is not degradation where direct gateway evidence is healthy. Full may add configured external/auth/browser checks; unavailable optional capability is WARN unless explicitly required. Probe independent areas after failures. PASS needs direct evidence. Use only PASS, WARN, FAIL, BLOCKED, SKIP, NOT_CONFIGURED.

In every scope invoke `preflight-probe` through `ima_delegate` with one complete fresh read-only assignment, no write scope. Accept child spawning as PASS only if the result contains exact marker `IMA_PI_PREFLIGHT_CHILD_OK` and identifies the package `preflight-probe` agent; error, timeout, missing marker, or wrong identity is FAIL. Never call a Goose subrecipe or technical-spike command as the production canary.

Prevent large-output failure: create a unique mode-0700 directory under `/tmp`; redirect each potentially large command stdout to a distinct restrictive-permission file; record only command category and path while orchestrating; inspect bounded line/byte chunks; summarize incrementally; never load complete Serena/Vestige payloads at once. Redact credentials, environment values, full memory contents, provider payloads, and sensitive paths. Remove raw files/directory on every terminal path; report cleanup warning and remaining path on failure. If requested, retain only a redacted `/tmp/ima-pi-preflight-<timestamp>.md` final report; the retained report is never raw evidence.

Return headings: generated timestamp, scope, overall, summary table, grouped details, prioritized next actions, report path when written, cleanup status. Do not claim unobserved external uptime or provider behavior. Stop after the report.
