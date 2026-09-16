---
name: ima-qdrant
description: Use the Pi-native IMA Qdrant institutional corpus tools for bounded durable records, search, and full institutional retrieval; formal lifecycle reads use the lifecycle read pair.
---

# IMA Qdrant corpus

Qdrant is a package-native institutional-memory boundary, not a package MCP server.
Use `ima_corpus_*` tools; never add, copy, discover, or invoke `qdrant-memory` or
`qdrant-mcp` through `mcp`.

## Read operations

1. Use `ima_corpus_status` for read-only prerequisite and compatibility evidence. It never
   bootstraps, creates, indexes, stores, repairs, or migrates data.
2. Use `ima_corpus_find` for bounded semantic summary search. It excludes full `detail`.
3. Use `ima_corpus_recall` only for a bounded Qdrant institutional-corpus summary lookup. It is not
   formal lifecycle phase evidence, including while the lifecycle is unpinned or Qdrant-pinned.
4. Use `ima_corpus_get` only for selected institutional Qdrant detail. The public argument remains
   `recordKey`: logical keys are canonical retrieval references, while `artifactId` values identify
   Qdrant manifest points. Formal lifecycle detail instead requires a selected
   `ima_lifecycle_get` descriptor.

Treat unavailable, incompatible, missing-model, and model-digest failures as fail-closed
local prerequisite evidence. Do not substitute unrelated MCP output, stale caches, or
unbounded retrieval.

## Store operations

Use `ima_corpus_store` only for an explicitly authorized **non-lifecycle** institutional record.
Supply one bounded, immutable record with a stable `recordKey`, project, lifecycle key, phase,
summary, detail, and source references. Small schema-v1 records remain compatible; large detail is
stored as a schema-v2 embedded manifest plus deterministic vectorless detail chunks. Semantic find
and corpus recall return manifest summaries only; direct get validates and reassembles full detail.
Identical content returns `unchanged`; a changed record for the same key is `record_conflict` and
must not be overwritten.

Formal lifecycle persistence goes through `ima_lifecycle`, and formal lifecycle retrieval goes
through `ima_lifecycle_recall` followed by selected `ima_lifecycle_get`, never a direct corpus call.
The pin-aware route retains both the Qdrant manifest `artifactId` and logical `recordKey` when
Qdrant is the historical or selected authority; do not use them to cross a provider boundary.

Do not store credentials, endpoint values, raw provider responses, stack traces, transient
logs, or unreviewed personal data. The package owns endpoint defaults and operator environment
configuration; tool arguments never select endpoints, models, or collections.

## Qdrant lifecycle-provider boundary

The reviewed Qdrant lifecycle provider is an internal capability behind the pin-aware
`ima_lifecycle` route and the public `ima_lifecycle_recall`/`ima_lifecycle_get` read pair, not an
agent-facing alternate workflow. `ima_corpus_*` remains the institutional corpus boundary. Follow
[the lifecycle routing contract](../ima-lifecycle-contract/SKILL.md): before a pin, the public read
pair may establish exact verified Tier-1 Qdrant history from any phase; after a non-Qdrant pin,
Qdrant is never fallback or mixed evidence.

For provider routing only, it can:

- `persist` a validated detached lifecycle request and direct-read-back verify it;
- `get` a validated reference;
- `recall` complete records for an exact, bounded lifecycle selection; and
- `reconcile` through the same read-only exact-reference verification as `get`.

Requests, selections, and references are strictly detached and validated. Results are either
verified or blocked; verification checks exact identity across schema-v1 and schema-v2 records.
Invalid, unavailable, incomplete, corrupt, or mismatched data fails closed. The provider does not
select a provider, change a pin, fall back, repair, or migrate records. A local pin makes no live,
replicated, or cross-device authority claim.

## Configuration classification

- `IMA_QDRANT_URL` and `IMA_OLLAMA_URL` are **non-secret variables**.
- Qdrant and Ollama credentials are **secrets**; never place them in tool arguments or
  source-controlled configuration.
- Local Qdrant data is a **local-only value**.
- This capability adds no **platform binding**.

## Boundaries

- `ima_context.durableKnowledge` keeps its documented public contract while using the direct
  package corpus boundary internally for the legacy `ima-knowledge` collection only. Other
  collection names fail closed before embedding or search.
- Formal lifecycle persistence uses `ima_lifecycle`; formal lifecycle reads use
  `ima_lifecycle_recall` followed by selected `ima_lifecycle_get` and their durable-pin authority.
  Tier-1 Qdrant is authoritative only through that pair for unpinned historical lifecycle evidence
  or a Qdrant pin; Vestige remains cited-legacy-only.
- Qdrant collection deletion, generic vector-database abstractions, and `ima-rag` integration
  are outside this capability.
