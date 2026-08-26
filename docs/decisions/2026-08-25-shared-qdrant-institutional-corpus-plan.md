---
lifecycle:
  project: "ima-pi"
  lifecycle_key: "ima-pi:lifecycle:memory-two-tier-qdrant-migration-2026-08-25"
  lifecycle_root_memory_id: ""
  taskwarrior_project: "ima-pi"
  taskwarrior_task: "39"
  taskwarrior_uuid: "0f1bd176-962c-4a6c-8ed8-31c87c3868c5"
  jira_key: ""
  source_refs:
    - "taskwarrior:ima-pi:0f1bd176-962c-4a6c-8ed8-31c87c3868c5"
    - "lifecycle:ima-pi:lifecycle:memory-two-tier-qdrant-migration-2026-08-25"
    - "file:docs/decisions/2026-08-25-two-tier-memory-qdrant-migration.md"
    - "file:docs/decisions/2026-08-25-two-tier-memory-decomposition.md"
    - "vestige:5f27af6e-7a24-4f27-91ca-254892765234"
  phase: "plan"
  prior_artifact_ids:
    - "docs/decisions/2026-08-25-two-tier-memory-qdrant-migration.md"
    - "docs/decisions/2026-08-25-two-tier-memory-decomposition.md"
persistence_note: >-
  Persisted as a git-tracked markdown plan record instead of via ima_lifecycle/Vestige.
  Rationale: Vestige exact per-node reads are broken (-32000) and this two-tier work exists
  precisely to move lifecycle artifacts out of Vestige; the operator directed markdown
  persistence for now. Re-home into the shared Qdrant corpus once Story A + Story B exist.
status: approved
approved_by: "Eric"
date: "2026-08-25"
amended: "2026-08-25"
amendment_reason: "Resolve active preflight and migration contracts for Pi-native Qdrant ownership."
record_type: "lifecycle-plan"
---

# Plan: Shared Qdrant institutional-memory corpus foundation (Story A)

## Source and Approved Outcome

- **Source:** `taskwarrior:ima-pi:0f1bd176-962c-4a6c-8ed8-31c87c3868c5`
- **Lifecycle key:** `ima-pi:lifecycle:memory-two-tier-qdrant-migration-2026-08-25`
- **Outcome:** `ima-pi` directly owns a shared, multi-collection Qdrant integration as native Pi
  extension tools. It stores bounded institutional records, retrieves summaries semantically and
  by lifecycle key, retrieves full detail on demand, and guarantees idempotent immutable storage
  through deterministic IDs.
- **Architecture decision (approved by Eric):** remove `ima-pi`'s `qdrant-mcp` dependency. The
  package communicates directly with Qdrant and Ollama through abort-aware Node 24 `fetch`.
- **Persistence exception:** Vestige exact reads fail with MCP `-32000`; this plan is persisted to
  a git-tracked Markdown artifact instead of `ima_lifecycle`.

This is one cohesive foundation delivery unit. Migration remains Story B; lifecycle
persistence/routing remains Story C.

## Scope

1. Add a package-owned Qdrant/Ollama HTTP boundary.
2. Add the immutable institutional-record contract.
3. Add native Pi tools for status, storage, semantic search, lifecycle recall, and full retrieval.
4. Automatically bootstrap and validate the institutional collection.
5. Preserve `ima_context`'s existing public durable-knowledge contract while replacing its internal
   MCP lookup.
6. Remove `qdrant-memory` from `ima-pi`'s MCP catalog, gateway probe, activity classification,
   skills, tests, and active documentation.
7. Reconcile preflight and configuration-migration contracts so Qdrant diagnostics use the native
   corpus status tool while Serena/Vestige retain package-MCP semantics.
8. Add focused unit/integration coverage and live acceptance instructions.

## Scope and Non-Goals

- No Vestige export, classification, migration, quarantine, or cleanup — Story B.
- No change to `ima_lifecycle` persistence or lifecycle prompt routing — Story C.
- No `ima-rag` integration.
- No edits to `ima-claude`, `ima-goose`, `~/.agents/skills`, or `ima-qdrant-mcp-server`.
- No collection deletion command.
- No generic vector-database framework.
- No PHP, WordPress, Bootstrap, SQL, browser, or TUI work.
- No release/version tag in this Story.

## Plan Amendment 1 — Pi-native Qdrant preflight and migration contracts

The implementation-phase contradiction report correctly identified active package contracts omitted
from the original changed-file list. Eric's approved all-in-Pi direction resolves the disposition;
there is no remaining product or architecture fork.

### Preflight semantics

- `prompts/ima:preflight.md` and `skills/pi-preflight/SKILL.md` continue to discover and probe Serena
  and Vestige through the compact `mcp` proxy/package MCP adapter.
- In `quick` and `full`, Qdrant is checked by calling the native read-only `ima_corpus_status` tool
  exactly once; Qdrant is not discovered or invoked through `mcp`.
- `offline` does not call Qdrant or Ollama and reports the live corpus check as `SKIP`.
- Native status `ready` maps to preflight `PASS`. Unavailable/incompatible prerequisites map to
  `WARN` when Qdrant is optional and `FAIL` when the request explicitly requires Qdrant. A missing
  package-native tool/resource is `FAIL`, not `NOT_CONFIGURED`.
- `configured:false` brokered-service semantics remain valid for Serena/Vestige. Absence of a
  Qdrant MCP registration is the expected architecture and must not be reported as degradation.
- `/ima:preflight` remains entirely read-only: `ima_corpus_status` must never bootstrap, create,
  index, store, repair, or migrate.

### Migration semantics

- `prompts/ima:migrate.md` retains `external through the package MCP adapter` for Serena/Vestige and
  other brokered services, but classifies Qdrant corpus support as **Pi-native**.
- Replace the blanket `Never direct-register Serena, Vestige, or Qdrant in Pi` wording with the
  concrete rule: never direct-register Serena or Vestige; never add or copy a user/project
  `qdrant-memory`/`qdrant-mcp` MCP server; use the package-native `ima_corpus_*` tools.
- Legacy Qdrant MCP entries are `unsupported/obsolete` or `manual action required`; `/ima:migrate`
  does not copy them into IMA config and does not mutate MCP settings outside its existing approved
  destinations.
- No Qdrant endpoint, model, collection, or credential is copied from legacy Claude/Goose config.
  Package defaults/operator environment and `ima_corpus_status` remain the supported boundary.

### Contract evidence and tests

- `tests/workflow-prompts.test.js` must assert the split explicitly: Serena/Vestige remain package-MCP
  services; Qdrant is package-native; preflight names `ima_corpus_status`; migration refuses legacy
  Qdrant MCP registration and points to `ima_corpus_*`.
- `docs/foundation/FNR-3025.md` must record the superseding direct-Qdrant preflight/migration
  behavior rather than claiming all three memory services use direct MCP sessions.
- `skills/ima-pi-guide/SKILL.md` must distinguish the native Qdrant corpus boundary from package-MCP
  integrations while preserving `/ima:preflight` as the diagnostic entry point.

## Decisions (approved)

### Collection and embedding contract

| Property | Value |
|---|---|
| Institutional collection | `ima-institutional-memory` |
| Provider | Ollama |
| Model | `nomic-embed-text:latest` |
| Required model digest | `0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f` |
| Vector size | 768 |
| Distance | cosine |
| Named vector | `nomic-embed-text-0a109f42` |
| Minimum Qdrant version | 1.16.0 (required for `insert_only`) |
| Current observed Qdrant | 1.17.1 |
| Default Qdrant URL | `http://127.0.0.1:6333` |
| Default Ollama URL | `http://127.0.0.1:11434` |

The named vector and digest check prevent a same-dimension but semantically incompatible model
from silently writing into the collection. A future embedding-model change requires an explicit
corpus migration or new named-vector decision. `ima_context.durableKnowledge` retains support for
the legacy/default `ima-knowledge` collection through an unnamed 768-dimensional vector; the
institutional collection uses the named vector.

### Record contract

One Qdrant point represents one immutable institutional record. Public tool input uses camelCase;
Qdrant payload fields are stable snake_case:

```
schema_version
record_key
project
site
repo
lifecycle_key
phase
summary
detail
source_refs
content_hash
created_at
```

Rules:

- `recordKey` is required, stable, trimmed, control-character-free, and at most 512 characters.
- `project` and `lifecycleKey` are required.
- `site` and `repo` are present but may be empty when not applicable.
- `phase` is required and bounded but not hard-coded to lifecycle-only values.
- `sourceRefs` are trimmed, deduplicated, sorted, and bounded.
- The summary is embedded; full detail is never included in semantic result payloads.
- Summary: at most 2,000 UTF-8 bytes.
- Entire normalized payload: at most 44,000 UTF-8 bytes (headroom below Pi's 50 KB tool-output limit).
- Deterministic point ID: UUIDv5 using namespace `0476e0b1-db93-536a-a78e-959ea945997f` and
  normalized `recordKey`.
- `content_hash`: SHA-256 of the normalized immutable content, excluding `created_at`.
- UUID generation uses the established `uuid` package rather than a custom protocol implementation.

### Idempotency and concurrency

Store flow:

1. Validate and normalize without I/O.
2. Derive deterministic UUID and content hash.
3. Retrieve that point ID.
4. If existing hash matches, return `unchanged` without embedding or writing.
5. If existing hash differs, fail with `record_conflict`.
6. If absent, embed the summary and validate exactly 768 finite numbers.
7. Insert using Qdrant `update_mode: "insert_only"` and `wait=true`.
8. Re-read the point and verify its key/hash.
9. Return `stored` only after verification.
10. Concurrent insert winner: matching hash -> `unchanged`; different hash -> `record_conflict`;
    existing data is never overwritten.

## API Contracts — native Pi tools

Registered by `extensions/institutional-memory.ts`:

- **`ima_corpus_status`** — read-only. Checks Qdrant reachability/version, Ollama reachability,
  approved model name + digest, collection existence, vector size/distance/named-vector
  compatibility, and payload-index compatibility. Does not create or modify the collection.
- **`ima_corpus_store`** — mutation with explicit authority. Accepts one bounded record; ensures
  the collection and keyword indexes before first insert. Returns only
  `{ status: "stored"|"unchanged", id, recordKey }`.
- **`ima_corpus_find`** — semantic lookup with bounded query/limit and optional project/site/repo
  filters. Returns summary metadata and scores only; the Qdrant request uses a payload
  include-selector that excludes `detail`.
- **`ima_corpus_recall`** — exact keyword-filtered lookup by `lifecycleKey`. Returns bounded record
  summaries and deterministic IDs, not full details.
- **`ima_corpus_get`** — derives the deterministic ID from `recordKey` and returns one full bounded
  record. Fails rather than emitting a partial/truncated record if an invariant would exceed Pi's
  tool-output ceiling.

## Boundaries — pure/effect

### Pure core — `lib/qdrant-corpus.ts`

Validation and normalization; byte-size calculation; stable payload construction; UUIDv5
derivation; SHA-256 content hashing; response validation; immutable result construction;
store/retrieve control flow using injected operations; structured `{ success, data, error }`
results. No network, environment access, logging, or global mutable state.

### Effect shell — `lib/qdrant-http.ts`

Trusted environment/default endpoint resolution; Qdrant and Ollama HTTP calls; deadlines and caller
abort propagation; JSON parsing and response-size bounds; collection creation/config validation;
keyword-index creation; embedding requests; point insert/retrieve/query/scroll operations.

### Pi boundary — `extensions/institutional-memory.ts`

Strict TypeBox schemas; tool registration; dependency construction; sanitized error conversion;
bounded model-visible output.

## Detailed Code Instructions — error paths

Stable error codes:

`qdrant_unavailable`, `qdrant_version_unsupported`, `ollama_unavailable`,
`embedding_model_missing`, `embedding_model_mismatch`, `collection_incompatible`,
`collection_bootstrap_failed`, `record_invalid`, `record_too_large`, `record_conflict`,
`embedding_failed`, `embedding_dimension_mismatch`, `store_failed`, `store_unverified`,
`query_failed`, `record_not_found`, `response_invalid`, `aborted`.

Model-visible errors contain a stable code and actionable local guidance but no raw endpoint
responses, credentials, stack traces, or unrestricted payloads.

## Changed Files

### Create

- `lib/qdrant-corpus.ts`
- `lib/qdrant-http.ts`
- `extensions/institutional-memory.ts`
- `tests/qdrant-corpus.test.js`
- `tests/institutional-memory.test.js`
- `skills/ima-qdrant/SKILL.md`
- `docs/decisions/2026-08-25-shared-qdrant-institutional-corpus-plan.md` (this artifact)

### Modify

- `package.json` — add `uuid`
- `package-lock.json`
- `config/mcp.json` — remove `qdrant-memory`
- `extensions/integrations.ts` — replace `qdrant_find` MCP call with injected direct semantic
  lookup while preserving `ima_context`
- `extensions/gateway-probe.ts` — remove Qdrant from the MCP-only gateway protocol
- `lib/ima-activity.ts` — remove obsolete `qdrant-memory` gateway category
- `skills/ima-memory-workflow/SKILL.md` — route durable Qdrant operations to native corpus tools
- `prompts/ima:preflight.md` — use native read-only `ima_corpus_status` for Qdrant while retaining
  compact-MCP discovery for Serena/Vestige
- `prompts/ima:migrate.md` — classify Qdrant as Pi-native and refuse legacy Qdrant MCP registration
- `skills/pi-preflight/SKILL.md` — document the native Qdrant status boundary and status mapping
- `skills/ima-pi-guide/SKILL.md` — distinguish native Qdrant from package-MCP integrations
- `tests/integrations.test.js`
- `tests/gateway.test.js`
- `tests/agent-activity.test.js`
- `tests/mcp-package.test.js`
- `tests/integration-skills.test.js`
- `tests/discovery.test.js`
- `tests/workflow-prompts.test.js`
- `README.md`
- `CHANGELOG.md`
- `docs/guide.md`
- `docs/foundation/FNR-3016.md`
- `docs/foundation/FNR-3025.md`
- `docs/foundation/FNR-3032.md`
- `docs/decisions/2026-08-25-two-tier-memory-qdrant-migration.md` (mark MCP-adapter references superseded)

### Remove

- `skills/mcp-qdrant/SKILL.md`

Historical decision evidence is marked superseded rather than silently rewritten.

## Standards Impact

### Files over the 500-line smell

- `extensions/integrations.ts` — currently 673 lines. Story A removes its Qdrant MCP logic and adds
  no corpus implementation there. Retaining the file is justified: splitting the unaffected
  `ima_context`/`ima_lifecycle` composition root would broaden into Story C and risk contract
  stability.
- `extensions/gateway-probe.ts` — currently 695 lines; shrinks by removing one gateway operation.
  It remains one ordered probe protocol; splitting its state/result machinery would obscure ordering.
- `tests/integrations.test.js` — currently 1,372 lines. Direct-Qdrant cases move into focused new
  test files where practical; no new corpus suite is added to this file. Broader historical test-file
  decomposition is out of scope.

All new production files should remain below 500 lines and be split by cohesion if implementation
evidence threatens that boundary.

### Readability and FP

Intent-based names and shallow guard clauses; no classes unless an external API forces one; no
custom `pipe`/`compose`/`curry`/monad or generic storage framework; immutable normalized records;
explicit dependencies and abort signals; pure contract/core with network effects at the boundary;
named constants for limits, collection, model, digest, vector name, and timeouts.

## Security Checklist

- **JavaScript/TypeScript:** applicable. Validate all environment configuration, tool input, Ollama
  responses, Qdrant responses, vectors, payloads, URLs, collection names, limits, and errors.
- **Functional boundaries:** applicable as defined above.
- **SQL:** inapplicable; no SQL introduced.
- **WordPress PHP:** inapplicable; no PHP files.
- **Bootstrap:** inapplicable; no UI styling.
- Endpoints are package defaults/operator environment, never user-supplied tool arguments.
- URL path segments are encoded and collection names validated.
- Store operations never interpolate data into executable code or shell commands.
- No credentials, raw traces, or private responses enter tool output.

## Implementation Order

1. Pure record validation, normalization, hashing, deterministic identity, and tests.
2. Abort-aware Qdrant/Ollama HTTP shell and mocked boundary tests.
3. Bootstrap/configuration validation and `insert_only` storage verification.
4. Semantic, lifecycle-key, and full-record retrieval.
5. Register native Pi corpus tools and test schemas/results/errors.
6. Replace `ima_context`'s Qdrant MCP lookup while preserving its public contract.
7. Reconcile `/ima:preflight`, `/ima:migrate`, `pi-preflight`, `ima-pi-guide`, FNR-3025, and their
   prompt-contract tests with the approved Pi-native Qdrant/package-MCP split.
8. Remove the Qdrant MCP catalog/probe/activity paths and update affected tests.
9. Replace the `mcp-qdrant` skill with `ima-qdrant`.
10. Update remaining user-facing and historical documentation.
11. Run focused, full, package-loading, and live-service acceptance.

## Test Strategy

### Pure tests
- normalization does not mutate input;
- source-ref normalization is deterministic;
- UUID is stable for a known record key;
- content hash ignores `created_at` but changes with immutable content;
- UTF-8 byte bounds reject multibyte oversize values;
- malformed fields and vectors fail before writes.

### Mocked boundary tests
- Qdrant/Ollama unavailable;
- unsupported Qdrant version;
- missing/wrong model digest;
- absent collection creation;
- compatible existing collection;
- dimension/distance/vector-name mismatch;
- payload-index creation;
- existing exact record returns `unchanged` without embedding;
- existing divergent record returns `record_conflict`;
- `insert_only` concurrent winner handling;
- post-insert verification;
- semantic payload selector excludes detail;
- lifecycle-key scroll uses exact keyword match;
- cancellation and timeout propagation;
- malformed/oversized external responses;
- secret and raw-response redaction.

### Pi integration tests
- all five tools are registered from package provenance;
- schemas are strict and bounded;
- tool failures throw sanitized errors;
- `ima_context.durableKnowledge` output is unchanged;
- MCP catalog no longer includes `qdrant-memory`;
- gateway probe no longer expects Qdrant MCP;
- quick/full preflight calls native read-only `ima_corpus_status` and never discovers Qdrant through
  the compact MCP proxy;
- migration guidance treats Qdrant as Pi-native, refuses legacy Qdrant MCP registration, and retains
  package-MCP semantics for Serena/Vestige;
- renamed skill is discovered.

## Acceptance Criteria (observable)

1. A fresh compatible machine needs only running Qdrant >=1.16, Ollama, and the approved model.
2. First store creates `ima-institutional-memory` and required indexes automatically.
3. First store returns `stored`.
4. Repeating identical input returns `unchanged` and creates no second point.
5. Same `recordKey` with changed content returns `record_conflict` without overwriting.
6. Semantic search finds the record and omits full detail.
7. Lifecycle-key recall returns its summary and deterministic ID.
8. Full retrieval by `recordKey` returns the exact bounded detail.
9. Missing/incompatible prerequisites fail closed with actionable guidance.
10. `ima_context` retains its documented input/result shape.
11. `ima-pi` starts without `qdrant-mcp` installed.
12. No active package configuration or runtime code invokes `qdrant-memory`.
13. Quick/full preflight verifies Qdrant only through read-only `ima_corpus_status`; offline skips it;
    absence of Qdrant MCP registration is not degradation.
14. Migration guidance refuses legacy Qdrant MCP registration, identifies the corpus as Pi-native,
    and preserves brokered package-MCP treatment for Serena/Vestige.

## Verification Commands and Results

Results are expected signals; this is a planning artifact and no commands were run against
production code in the plan phase.

```bash
node --test \
  tests/qdrant-corpus.test.js \
  tests/institutional-memory.test.js \
  tests/integrations.test.js \
  tests/gateway.test.js \
  tests/mcp-package.test.js \
  tests/integration-skills.test.js \
  tests/discovery.test.js \
  tests/agent-activity.test.js \
  tests/workflow-prompts.test.js
# Expected: all focused tests pass.

npm test
# Expected: all Node tests pass.

git diff --check
# Expected: no output, exit 0.

rg -n 'qdrant-memory|qdrant-mcp|qdrant_find|qdrant_store' \
  config extensions lib skills tests README.md
# Expected: no active runtime/configuration references; retained historical docs marked superseded.

pi --no-session -e . -p "Call ima_corpus_status and report only its structured result."
# Expected: prerequisites ready and configuration compatible, or an actionable fail-closed result.
```

Live tool acceptance with one stable acceptance `recordKey`:
first `ima_corpus_store` -> `stored`; identical second store -> `unchanged`; divergent same-key
store -> `record_conflict`; `ima_corpus_find` -> summary hit; `ima_corpus_recall` -> lifecycle-key
hit; `ima_corpus_get` -> exact full detail.

## Rollout and Rollback

### Rollout
- Additive collection bootstrap.
- No lifecycle producer switches during Story A.
- Existing `ima-knowledge` remains readable through direct integration.
- Story B may consume the store API after acceptance.
- Story C may switch lifecycle persistence/recall after Story A review.

### Rollback
- Revert the `ima-pi` implementation/configuration commit.
- Do not delete `ima-institutional-memory`; leaving an unused collection is safer than destroying
  accepted records.
- No source-of-truth cutover occurs in Story A, so rollback needs no data restoration.
- The external Python MCP server remains untouched but is no longer an `ima-pi` dependency.

## Blockers

None. The implementation-phase contradiction involving `ima:preflight`, `ima:migrate`,
`pi-preflight`, and `tests/workflow-prompts.test.js` is resolved by Plan Amendment 1; implementation
must use that explicit disposition rather than retaining a Qdrant MCP exception.

## Residual Risk

- Model digest changes require an explicit upgrade/migration decision.
- Machines with Qdrant older than 1.16 fail closed.
- Historical arbitrary collections passed to `ima_context` may be incompatible with the fixed
  embedding model; those reads fail explicitly rather than returning misleading results.
- Full records larger than the 44 KB payload bound must be split or quarantined by Story B.
- Prior Vestige node `a4f27951-efa9-465c-a69f-790f9181e99b` remains unavailable: exact retrieval
  failed with `-32000` initially and after the permitted reconnect/retry. Git-tracked decision
  records remain authoritative.

## Prior Artifacts

- `docs/decisions/2026-08-25-two-tier-memory-qdrant-migration.md`
- `docs/decisions/2026-08-25-two-tier-memory-decomposition.md`
- `vestige:5f27af6e-7a24-4f27-91ca-254892765234`
- Partial/unreadable Vestige candidate: `a4f27951-efa9-465c-a69f-790f9181e99b`

## Memory & Docs Hits

- Current Qdrant MCP schema and installed `qdrant-mcp` 0.2.0 source
  (`/home/eric/IMA/dev/ima-qdrant-mcp-server`)
- Pi `extensions.md` and `packages.md`
- Official Qdrant and Ollama documentation via Context7
- Live read-only Qdrant (1.17.1) / Ollama (0.21.0, `nomic-embed-text:latest`) prerequisite inspection

## Recommended Next Phase

```text
/ima:implement taskwarrior:ima-pi:0f1bd176-962c-4a6c-8ed8-31c87c3868c5
```

One-line outcome: implement the approved Pi-native, multi-collection Qdrant corpus foundation and
retire `ima-pi`'s Qdrant MCP dependency.
