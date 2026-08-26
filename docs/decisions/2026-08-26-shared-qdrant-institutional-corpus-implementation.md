---
lifecycle:
  project: "ima-pi"
  lifecycle_key: "ima-pi:lifecycle:memory-two-tier-qdrant-migration-2026-08-25"
  taskwarrior_project: "ima-pi"
  taskwarrior_task: "39"
  taskwarrior_uuid: "0f1bd176-962c-4a6c-8ed8-31c87c3868c5"
  source_refs:
    - "taskwarrior:ima-pi:0f1bd176-962c-4a6c-8ed8-31c87c3868c5"
    - "file:docs/decisions/2026-08-25-shared-qdrant-institutional-corpus-plan.md"
    - "file:docs/decisions/2026-08-25-two-tier-memory-qdrant-migration.md"
    - "file:docs/decisions/2026-08-25-two-tier-memory-decomposition.md"
phase: "implementation"
status: "completed"
record_type: "lifecycle-implementation"
date: "2026-08-26"
persistence_note: >-
  Markdown fallback while Vestige lifecycle retrieval is unreliable. This file is the
  reviewable implementation record; historical Vestige artifact 65611aee-ae45-4951-bad5-9fc113bab5fb
  is correlation evidence only.
---

# Implementation: Pi-native Qdrant institutional-memory corpus (Story A)

## Approved outcome

`ima-pi` now owns a package-native shared Qdrant corpus: bounded immutable institutional
records can be stored idempotently, found semantically, recalled by lifecycle key, and read
fully by deterministic record key. Qdrant and Ollama are reached through abort-aware Node 24
HTTP boundaries; `qdrant-memory` is no longer an active package MCP dependency.

## Delivered scope

- Added immutable record normalization, UTF-8 bounds, sorted/deduplicated source references,
  UUIDv5 IDs, SHA-256 immutable content hashes, and exact 768-finite-number vector validation.
- Added trusted Qdrant/Ollama transport with endpoint validation, abort/timeout propagation,
  bounded JSON responses, model-digest and Qdrant-version checks, collection/index bootstrap,
  named-vector search, lifecycle recall, deterministic full retrieval, and stable sanitized errors.
- Registered native `ima_corpus_status`, `ima_corpus_store`, `ima_corpus_find`,
  `ima_corpus_recall`, and `ima_corpus_get` Pi tools.
- Replaced `ima_context.durableKnowledge` Qdrant MCP use with injected direct corpus lookup while
  preserving its request/result contract, allowing the legacy `ima-knowledge` collection, and
  rejecting unverified collection names before embedding or search.
- Removed Qdrant from the package MCP catalog, child gateway protocol, and activity classification;
  replaced the obsolete Qdrant MCP skill with `skills/ima-qdrant/SKILL.md`.
- Applied the approved preflight/migration contract split: Serena and Vestige stay package-MCP;
  Qdrant is package-native.

## Non-goals retained

No Vestige export/migration/routing change, `ima_lifecycle` routing change, collection deletion,
`ima-rag` integration, UI/PHP/SQL/WordPress/release work, or edits outside `ima-pi`.

## Changed files

### Production and configuration

- `package.json`, `package-lock.json`, `config/mcp.json`
- `lib/qdrant-corpus.ts`, `lib/qdrant-http-boundary.ts`, `lib/qdrant-http.ts`
- `extensions/institutional-memory.ts`, `extensions/integrations.ts`,
  `extensions/gateway-probe.ts`, `lib/ima-activity.ts`

### Documentation, prompts, and skills

- `skills/ima-qdrant/SKILL.md`; removed `skills/mcp-qdrant/SKILL.md`
- `skills/ima-memory-workflow/SKILL.md`, `skills/pi-preflight/SKILL.md`,
  `skills/ima-pi-guide/SKILL.md`
- `prompts/ima:preflight.md`, `prompts/ima:migrate.md`
- `README.md`, `CHANGELOG.md`, `docs/guide.md`, `docs/foundation/FNR-3016.md`,
  `docs/foundation/FNR-3025.md`, `docs/foundation/FNR-3032.md`, and the historical migration
  decision supersession note.

### Tests

- `tests/qdrant-corpus.test.js`, `tests/institutional-memory.test.js`,
  `tests/integrations.test.js`, `tests/gateway.test.js`, `tests/agent-activity.test.js`,
  `tests/mcp-package.test.js`, `tests/integration-skills.test.js`,
  `tests/discovery.test.js`, and `tests/workflow-prompts.test.js`.

## Implementation verification

- Focused corpus/integration/package tests passed before test-phase additions.
- `npm test` passed during the following test phase.
- `git diff --check` passed during implementation and test verification.

## Risks for review

- Live Qdrant/Ollama acceptance was not established by implementation alone; review should use the
  test record and an isolated package-loading environment before treating live service behavior as
  verified.
- `npm install` reported five dependency audit findings (three moderate, two high); no unrelated
  dependency upgrade was made.
- A model-digest or vector-contract change requires an explicit corpus migration decision.

## Review inputs

Read this record with the approved plan, the test record, the two decision records, and
`skills/ima-qdrant/SKILL.md`. Treat these Markdown files and the Taskwarrior artifact index as the
current handoff source, not a required Vestige lookup.
