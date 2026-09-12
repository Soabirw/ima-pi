---
name: ima-qdrant
description: Use the Pi-native IMA Qdrant institutional corpus tools for bounded durable records, search, lifecycle recall, and full retrieval.
---

# IMA Qdrant corpus

Qdrant is a package-native institutional-memory boundary, not a package MCP server.
Use `ima_corpus_*` tools; never add, copy, discover, or invoke `qdrant-memory` or
`qdrant-mcp` through `mcp`.

## Read operations

1. Use `ima_corpus_status` for read-only prerequisite and compatibility evidence. It never
   bootstraps, creates, indexes, stores, repairs, or migrates data.
2. Use `ima_corpus_find` for bounded semantic summary search. It excludes full `detail`.
3. Use `ima_corpus_recall` for exact lifecycle-key summary lookup.
4. Use `ima_corpus_get` only for a selected logical record key or a known manifest point-ID UUID
   when full bounded detail is necessary. The public argument remains `recordKey`: logical keys
   are canonical retrieval references, while `artifactId` values identify Qdrant manifest points.

Treat unavailable, incompatible, missing-model, and model-digest failures as fail-closed
local prerequisite evidence. Do not substitute unrelated MCP output, stale caches, or
unbounded retrieval.

## Store operations

Use `ima_corpus_store` only with explicit lifecycle or user authority. Supply one bounded,
immutable record with a stable `recordKey`, project, lifecycle key, phase, summary, detail,
and source references. Small schema-v1 records remain compatible; large detail is stored as a
schema-v2 embedded manifest plus deterministic vectorless detail chunks. Semantic find and
lifecycle recall return manifest summaries only; direct get validates and reassembles full detail.
Lifecycle persistence exposes both the manifest point `artifactId` and the logical `recordKey` so
handoffs can preserve storage and retrieval references without a schema migration. Identical content
returns `unchanged`; a changed record for the same key is `record_conflict` and must not be
overwritten.

Do not store credentials, endpoint values, raw provider responses, stack traces, transient
logs, or unreviewed personal data. The package owns endpoint defaults and operator environment
configuration; tool arguments never select endpoints, models, or collections.

## Reviewed internal lifecycle provider (T14)

The reviewed Qdrant lifecycle provider is an internal additive capability, not an agent-facing
tool or alternate workflow. `ima_corpus_*` remains the public corpus boundary, and
`ima_lifecycle` remains the authoritative lifecycle workflow.

For internal lifecycle-provider routing only, it can:

- `persist` a validated detached lifecycle request and direct-read-back verify it;
- `get` a validated reference;
- `recall` complete records for an exact, bounded lifecycle selection; and
- `reconcile` through the same read-only exact-reference verification as `get`.

Requests, selections, and references are strictly detached and validated. Results are either
verified or blocked; verification checks exact identity across schema-v1 and schema-v2 records.
Invalid, unavailable, incomplete, corrupt, or mismatched data fails closed. It never falls back,
repairs, or migrates records.

T14 adds no provider selection, preferences, initial fallback, durable pins, or live
provider-aware routing; T9 owns all of those decisions.

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
- Story B owns Vestige export and migration. Formal lifecycle persistence/routing uses
  `ima_lifecycle` and the Tier-1 corpus; Vestige remains preferences-only.
- Qdrant collection deletion, generic vector-database abstractions, and `ima-rag` integration
  are outside this capability.
