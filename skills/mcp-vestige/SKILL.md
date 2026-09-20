---
name: mcp-vestige
description: Retrieve explicitly cited Vestige legacy evidence through the Pi MCP adapter without mutation.
---

# Vestige MCP

Pi's active global `AGENTS.md` owns current user preferences and decisions. Serena owns stable
project instructions. Formal lifecycle persistence uses `ima_lifecycle`; formal lifecycle reads use
`ima_lifecycle_recall` followed by selected exact `ima_lifecycle_get` under the durable provider pin
across BookStack, Qdrant, Serena, or Markdown. Only while genuinely unpinned does the public
lifecycle read pair internally use exact all-phase historical Qdrant authority. Tier-1 Qdrant,
through `ima_corpus_*`, owns institutional detail. Vestige is retained only for explicitly cited
legacy evidence and the separate T7 migration source.

Do not use Vestige for routine preference bootstrap, preference writes, lifecycle persistence,
lifecycle recall, per-node lifecycle reads, or a fallback when corpus work fails.

## Cited-memory and migration retrieval

Use the package MCP adapter, never generated SDK namespaces. Discover direct Vestige tools through
`mcp` only when an explicitly cited `vestige:<UUID>` source or approved T7 migration work requires
it. Retrieve only the cited memory with `vestige_memory` and `{ action: "get", id }`; do not use
`session_start` or broad `recall` to load routine preferences.

On a transient read-only transport failure (`-32000`, `Connection closed`, or adapter timeout),
call `mcp({ connect: "vestige" })`. After a successful reconnect, repeat the same read with
identical arguments exactly once. Never retry `smart_ingest` or any mutation.

Accept evidence only when it is explicit, relevant to the cited source or approved migration, and
from the live current invocation. Reject unrelated merged lifecycle or log content and stale cached
output. When the cited memory lacks an explicit lifecycle identity, retrieve nothing else. Report
partial or failed evidence rather than guessing; never use Qdrant or Vestige as a lifecycle fallback.

## Mutation boundary

This skill is read-only. Never ingest, suppress, delete, or otherwise mutate Vestige memory.
`/ima:memorize` owns current preference updates through the global `AGENTS.md` and requires exact
preview, explicit approval, one native file update, and read-back verification. T7 separately owns
any approved migration; this skill does not authorize it. Formal lifecycle persistence uses
`ima_lifecycle`; formal reads use `ima_lifecycle_recall` followed by selected exact
`ima_lifecycle_get` under the durable provider pin across BookStack, Qdrant, Serena, or Markdown.
When Qdrant is pinned, `ima_lifecycle` stores a Qdrant manifest plus verified detail chunks. These
routes have no Vestige fallback and never select a provider.
