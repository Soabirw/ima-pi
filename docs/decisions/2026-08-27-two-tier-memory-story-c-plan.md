---
lifecycle:
  project: "ima-pi"
  lifecycle_key: "ima-pi:lifecycle:memory-two-tier-qdrant-migration-2026-08-25"
  lifecycle_root_memory_id: ""
  taskwarrior_project: "ima-pi"
  taskwarrior_task: "39"
  taskwarrior_uuid: "a6264cf5-82a1-49c5-9ea1-8a39b3b1405a"
  jira_key: ""
  source_refs:
    - "taskwarrior:ima-pi:a6264cf5-82a1-49c5-9ea1-8a39b3b1405a"
    - "lifecycle:ima-pi:lifecycle:memory-two-tier-qdrant-migration-2026-08-25"
    - "file:docs/decisions/2026-08-25-two-tier-memory-qdrant-migration.md"
    - "file:docs/decisions/2026-08-25-two-tier-memory-decomposition.md"
    - "file:docs/decisions/2026-08-25-shared-qdrant-institutional-corpus-plan.md"
    - "file:docs/decisions/2026-08-26-shared-qdrant-institutional-corpus-implementation.md"
    - "file:docs/decisions/2026-08-26-shared-qdrant-institutional-corpus-test.md"
  phase: "plan"
  prior_artifact_ids:
    - "docs/decisions/2026-08-25-two-tier-memory-qdrant-migration.md"
    - "docs/decisions/2026-08-25-two-tier-memory-decomposition.md"
    - "docs/decisions/2026-08-25-shared-qdrant-institutional-corpus-plan.md"
    - "docs/decisions/2026-08-26-shared-qdrant-institutional-corpus-implementation.md"
    - "docs/decisions/2026-08-26-shared-qdrant-institutional-corpus-test.md"
persistence_note: >-
  Persisted as a Git-tracked Markdown plan and referenced from the Taskwarrior task.
  The current ima_lifecycle implementation still writes lifecycle artifacts through Vestige,
  which is the path this Story retires. Later phases must use this file and the Taskwarrior
  annotation as the source of truth until Story C routes ima_lifecycle to Qdrant.
status: approved
approved_by: "Eric"
date: "2026-08-27"
record_type: "lifecycle-plan"
---

# Plan: Route lifecycle persistence and recall to Tier-1 Qdrant (Story C)

## Source and Approved Outcome

- **Source:** `taskwarrior:ima-pi:a6264cf5-82a1-49c5-9ea1-8a39b3b1405a`.
- **Lifecycle key:** `ima-pi:lifecycle:memory-two-tier-qdrant-migration-2026-08-25`.
- **Approved outcome:** Lifecycle artifacts persist to and recall from the package-owned Tier-1
  Qdrant collection, `ima-institutional-memory`. Vestige is preferences-only on the lifecycle
  path. A complete brainstorm-to-closeout pass has no Vestige per-node lifecycle reads and cannot
  encounter Vestige `-32000` on its critical path. Large artifacts remain lossless in Qdrant as an
  embedded manifest/summary point plus deterministic ordered vectorless detail chunks.
- **Approved architecture:** Qdrant remains both the institutional vector index and the full-detail
  store. No file server or wiki dependency is introduced. Wider semantic search across full plan
  bodies is deferred to a future larger solution; lifecycle consumers primarily use exact direct
  fetches after summary or lifecycle-key discovery.

Story A (shared corpus foundation) and Story B (`/ima:vestige-migrate`) are complete. This is Story C
from the approved two-tier decomposition.

## Scope and Non-Goals

### In scope

1. Extend the Story A corpus foundation with backward-compatible schema-v2 manifest and vectorless
   detail-chunk storage, deterministic identity, idempotent persistence, and lossless reassembly.
2. Add a required, explicit, agent-authored `summary` field to `ima_lifecycle`, bounded to 2,000
   UTF-8 bytes. The existing `artifact` remains the complete detailed source of truth.
3. Route `ima_lifecycle` persistence and verification from Vestige to Qdrant.
4. Route `ima_context` lifecycle-source hydration and `/ima:cycle` reconciliation from Vestige to
   Qdrant.
5. Repoint the lifecycle portion of the gateway probe while retaining Vestige preference coverage.
6. Remove Vestige lifecycle helpers when no callers remain.
7. Update active skills, Serena memories, documentation, changelog, and tests to describe and prove
   the two-tier model.
8. Verify that preference bootstrap continues to use Vestige and that lifecycle paths do not.

### Non-goals

- Reimplementing Story A's corpus foundation or Story B's migration command.
- Fixing Vestige's upstream `-32000`, merge, decay, or review behavior.
- Retiring Vestige; it remains the evolving-preference store.
- Embedding or semantically searching detail chunks in this Story.
- Introducing a file server, wiki, generic vector-database framework, workflow DSL, or model-tier
  change.
- Editing or retiring `ima-goose` or `ima-claude`.

## Phase Result

**APPROVED.** The product, storage, retrieval, size, identity, compatibility, failure, verification,
and rollout decisions below are settled. Implementation must not redesign them.

## Prior Work and Evidence

### Existing corpus contract

Story A implemented one immutable Qdrant point per institutional record:

- only `summary` is embedded;
- semantic find and lifecycle recall return summaries;
- `ima_corpus_get` retrieves full `detail` by deterministic record key;
- normalized payload is limited to 44,000 UTF-8 bytes;
- UUIDv5 point IDs and content hashes make identical stores idempotent and divergent stores fail;
- writes use insert-only behavior and are verified by read-back.

This provides the correct summary-first API but cannot store a large lifecycle artifact in one
point.

### Patristic and ima-rag chunking precedent

`/home/eric/IMA/dev/ima-rag/scripts/qdrant-rag/sync.py` provides a useful retrieval-chunking
precedent: opted-in Markdown is split at `##`, oversized sections with `###` are sub-split, title and
section context are retained, and each chunk is embedded independently. The canonical full article
remains in Git and random point membership is kept in local sync state. The semantic boundary is
useful evidence, but random IDs and an external canonical file cannot satisfy this Story's Qdrant-only,
lossless direct-fetch requirement.

Current Qdrant documentation confirms that documents are commonly represented by multiple points
sharing a document identifier, points may be stored without vectors as payload/document storage,
deterministic point IDs are supported, payload fields may be indexed and filtered, and application
code is responsible for full-document reconstruction. Qdrant multi-point writes do not provide a
general distributed transaction guarantee, so the implementation must detect incomplete chunk sets.

### Vestige artifact-size evidence

A live current-invocation read successfully returned one 124,579-byte Vestige node containing 20
merged lifecycle artifacts. A second selected node failed with `MCP -32000: Connection closed`; the
sole reconnect plus identical retry also failed.

A 2026-08-24 exact Vestige export supplied historical supporting evidence:

| Population | Count | Median | p90 | Maximum | Over 44 KB |
| --- | ---: | ---: | ---: | ---: | ---: |
| Unmerged lifecycle artifacts | 42 | 5.7 KB | 11.5 KB | 18.4 KB | 0 |
| Merged lifecycle nodes | 53 | 53.4 KB | 560 KB | 9.8 MB | 28 |

Existing individual artifacts have usually been modest, while Vestige consolidation produced most
extreme nodes. The product nevertheless requires future large plans without a 40 KB ceiling.

## Decisions

### Logical record and point kinds

One logical lifecycle artifact uses two Qdrant point kinds in the same
`ima-institutional-memory` collection.

#### Manifest point

The manifest is the only embedded/searchable point and the commit marker for a complete artifact.
Its payload includes:

```text
schema_version: 2
record_kind: manifest
record_key
project
site
repo
lifecycle_key
phase
summary
detail_hash
detail_bytes
chunk_count
source_refs
created_at
content_hash
```

The named `nomic-embed-text-0a109f42` vector is derived only from the explicit approved summary.
`ima_corpus_find` and `ima_corpus_recall` return manifest summaries, never detail chunks.

#### Detail-chunk points

Each vectorless point contains one exact ordered segment:

```text
schema_version: 2
record_kind: detail_chunk
parent_record_key
chunk_index
chunk_count
chunk_hash
detail_chunk
```

Chunks omit the named vector. They are invisible to vector search, incur no embedding cost, and are
retrieved directly by deterministic ID. Detail chunks are not semantically searched in this Story.

### Identity and idempotency

- Manifest record key:
  `${lifecycleKey}:${phase}:${sha256(serializedArtifact).slice(0, 12)}`.
- Chunk record key: `${manifestRecordKey}:chunk:${zeroPaddedIndex}`.
- Qdrant point IDs remain UUIDv5 values derived from normalized record keys using Story A's existing
  namespace.
- The manifest and each chunk carry hashes of normalized immutable content.
- An identical repeat is `unchanged`; a different payload at an existing deterministic key is
  `record_conflict` and never overwrites existing content.
- `project` comes from lifecycle identity, `repo` is `ima-pi`, and `site` is empty when not
  applicable.

### Summary contract

`ima_lifecycle` gains a required top-level `summary` sibling to `type`, `identity`, and `artifact`.
It is non-empty, agent-authored, control-character-safe, and at most 2,000 UTF-8 bytes. It states the
phase's approved one-line outcome. Mechanical extraction from the first artifact paragraph is not
used because summary quality controls semantic findability.

### Size and lossless splitting

- Do not lower lifecycle artifacts to 40 KB.
- Preserve the current 128,000-character raw request ceiling.
- Replace the accidental 64,000-byte serialized-artifact restriction with a 160,000 UTF-8-byte
  stored-artifact ceiling, leaving bounded headroom for generated front matter and verification
  marker.
- Detail chunks are at most 32,000 UTF-8 bytes.
- Split near an existing paragraph or newline boundary when possible, otherwise at a valid UTF-8
  code-point boundary. Do not trim, normalize, duplicate headings, or add separators to chunk text.
- Reassembly by `chunk_index` must reproduce the serialized artifact byte-for-byte and match the
  manifest `detail_hash` and `detail_bytes`.

### Persistence and commit ordering

Qdrant does not supply an all-or-nothing transaction for the logical multi-point artifact. Persist
with this fail-closed protocol:

1. Validate the complete request and construct the final serialized lifecycle artifact.
2. Split and hash all chunks without I/O.
3. Insert or verify deterministic detail chunks first.
4. Read back every expected chunk and validate key, index, count, per-chunk hash, and parent key.
5. Insert the manifest last as the commit marker.
6. Read the manifest and every chunk back, reassemble exact detail, and verify the full detail hash.
7. Report completion only after lifecycle nonce, phase, completed outcome, and required source
   identity also match the reassembled artifact.

An interrupted pre-manifest write may leave orphan chunk points, but recall cannot expose them.
Repeating the identical operation reuses/verifies them and completes the manifest. A missing,
duplicate, extra, reordered, conflicting, or corrupt chunk produces `record_incomplete` or
`record_conflict`; no partial detail is returned and no Vestige fallback occurs.

### Retrieval

- `ima_corpus_find`: semantic search over manifest summaries only.
- `ima_corpus_recall`: exact lifecycle-key lookup over manifests only.
- `ima_corpus_get`: read manifest, derive/retrieve all expected chunk IDs without vectors, validate,
  order, concatenate, verify, and expose one logical institutional record.
- `ima_context` lifecycle source: recall the exact lifecycle key, select the verified record, and
  directly fetch its complete detail through the corpus client.
- `/ima:cycle` reconciliation: recall corpus manifests and directly fetch candidate detail needed
  for the cycle outcome marker.
- Existing schema-v1 single-point records remain readable; schema-v2 writes do not rewrite them.

Broader semantic searching inside complete plans is explicitly deferred. If future evidence requires
it, a separate design may embed chunks and use grouping by parent record, or integrate the joint
human/AI wiki initiative. Neither is part of this Story.

## Pure and Effect Boundaries

### Pure core

- Normalize and validate lifecycle request, identity, summary, record metadata, chunks, and Qdrant
  responses.
- Build serialized artifact, manifest/chunk payloads, hashes, record keys, and deterministic IDs.
- Split and reassemble detail without mutation.
- Validate complete index sets and integrity hashes.
- Evaluate lifecycle completion markers.
- Return explicit `{ success, data, error }` results.

### Effect shell

- Embed the manifest summary through Ollama.
- Create/check Qdrant collection and payload indexes.
- Insert vectorless chunks and embedded manifest points.
- Retrieve manifests and chunk points directly.
- Coordinate source hydration and cycle reconciliation.
- Keep Vestige I/O limited to preference operations.

The shell calls the pure core; the core never calls the shell.

## API Contracts

### `ima_lifecycle`

Input becomes:

```json
{
  "type": "plan|implementation|test|review|resolution|rereview|decision|closeout",
  "identity": {
    "project": "",
    "lifecycleKey": "",
    "lifecycleRootMemoryId": "",
    "taskwarriorProject": "",
    "taskwarriorTask": "",
    "taskwarriorUuid": "",
    "jiraKey": "",
    "sourceRefs": [],
    "priorArtifactIds": []
  },
  "summary": "Required approved one-line phase outcome.",
  "artifact": "Complete detailed artifact."
}
```

The result retains its current compatibility shape:

```text
schemaVersion
status
phase
lifecycleKey
artifactId
receiptAccepted
semanticRecall
error
```

`artifactId` becomes the deterministic Qdrant manifest point ID. `receiptAccepted` means the
manifest/chunk store receipt and read-back were accepted. `semanticRecall` retains its compatibility
name but represents verified corpus direct retrieval rather than Vestige physical shape.

### Corpus client

Extend the internal `QdrantCorpusClient` with cohesive operations for:

- storing one logical manifest plus chunks;
- retrieving points by deterministic ID list with `with_vector:false`;
- getting and reassembling one logical institutional record;
- filtering lifecycle recall to manifests.

Do not expose Qdrant endpoints, credentials, raw provider responses, or unrestricted payloads.

## Detailed Code Instructions and Files to Update

### Corpus pure core

**`lib/qdrant-corpus.ts`**

- Preserve schema-v1 normalization, storage, find, recall, and get behavior.
- Add record-kind and schema-v2 manifest/chunk types and compatibility normalization.
- Extend stable error codes with `record_incomplete`.
- Delegate chunk cohesion to the new module below rather than exceeding the 500-line smell further.

**Create `lib/qdrant-corpus-chunks.ts`**

- Define named size and record-kind constants.
- Implement immutable, lossless UTF-8-aware split planning.
- Build deterministic chunk keys/IDs and hashes.
- Validate retrieved chunk sets independently of response order.
- Reassemble and verify exact detail bytes/hash.
- Reject missing, duplicate, extra, wrong-parent, wrong-index, wrong-count, malformed, or corrupt
  chunks.

### Qdrant effect boundary

**`lib/qdrant-http.ts` and, only where transport cohesion requires it,
`lib/qdrant-http-boundary.ts`**

- Add bounded multi-ID retrieval with payload included and vectors excluded.
- Add vectorless insert-only point storage with `wait=true` and approved ordering semantics.
- Ensure payload indexes include fields required to distinguish manifests and chunks.
- Preserve abort propagation, endpoint validation, response-size limits, sanitization, and verified
  read-after-write behavior.
- Do not treat Qdrant batch execution as transactional.

### Native corpus tools

**`extensions/institutional-memory.ts`**

- Route `ima_corpus_store` through logical manifest/chunk storage for large detail.
- Keep semantic find and lifecycle recall manifest-only.
- Route `ima_corpus_get` through schema-aware full-detail retrieval and integrity validation.
- Keep strict TypeBox schemas and bounded model-visible output. Never emit an incomplete/truncated
  logical artifact as if complete.

### Lifecycle core

**`lib/ima-lifecycle.ts`**

- Validate required `summary` by UTF-8 bytes and control-character policy.
- Replace Vestige-named save receipt and recall helpers with storage-neutral/corpus helpers while
  retaining the public result shape.
- Build deterministic manifest record keys and corpus input.
- Verify reassembled nonce marker, phase, completed outcome, lifecycle key, and required Jira or
  Taskwarrior source identity.
- Use named bounds rather than repeated numeric literals.

### Lifecycle/context integration shell

**`extensions/integrations.ts`**

- `coordinateLifecycle`: remove `smart_ingest`, Vestige discovery, and Vestige per-node get. Store
  through the injected corpus client, retrieve/reassemble through the corpus, verify, and fail
  closed on any corpus error. Never fall back to Vestige.
- `sourcePayload` lifecycle case: exact corpus lifecycle-key recall followed by direct full-detail
  retrieval. Preserve canonical lifecycle references.
- Keep Vestige dependencies only where preferences still require them.
- Add `summary` to the registered `ima_lifecycle` TypeBox parameters and description.
- Keep the extension as a thin composition shell; move logic into pure modules rather than growing
  this already-large file.

### Cycle integration

**`extensions/cycle.ts`**

- Replace `recallVestige` in the production dependency with corpus lifecycle recall.
- Adapt manifest summaries and direct detail retrieval to the payload accepted by existing cycle
  parsing/reconciliation.
- Preserve lifecycle-key/phase/outcome/source matching and receipt-gated state progression.

### Probe and dead compatibility helpers

**`extensions/gateway-probe.ts`**

- Replace lifecycle `smart_ingest`/Vestige recall verification with corpus logical store/direct get.
- Retain an explicit Vestige read path only for preference behavior.
- Preserve read/write classification and sanitized diagnostics.

**`lib/vestige-lifecycle.ts`**

- Delete only if repository-wide reference search confirms no remaining lifecycle caller.
- Do not remove Vestige preference support.

### Tests

Update or create the smallest cohesive test targets:

- `tests/qdrant-corpus.test.js`
- create `tests/qdrant-corpus-chunks.test.js`
- `tests/institutional-memory.test.js`
- `tests/lifecycle.test.js`
- `tests/integrations.test.js`, or a focused lifecycle-integration file if adding to the existing
  large suite would worsen cohesion
- `tests/context.test.js`
- `tests/cycle.test.js`
- `tests/gateway.test.js`
- prompt/skill/documentation contract tests already used by the repository

### Skills, project memory, and documentation

Update active wording in:

- `skills/ima-memory-workflow/SKILL.md`
- `skills/ima-lifecycle-contract/SKILL.md`
- `.serena/memories/conventions.md`
- `.serena/memories/tech_stack.md`
- `.serena/memories/suggested_commands.md` where it still prescribes Vestige lifecycle recall
- `.serena/memories/task_completion.md` where it still prescribes Vestige lifecycle closeout
- `docs/guide.md`
- `README.md` where lifecycle memory ownership is described
- `CHANGELOG.md`
- prior decision records only where a superseding implementation note is necessary; do not erase
  historical evidence

Document that governance records currently remain Git-tracked under `docs/decisions/`. Re-homing or
indexing them later is optional and outside this Story.

## Error Paths

Preserve Story A errors and add/use stable lifecycle/corpus errors for:

- invalid or oversized summary;
- invalid or oversized serialized lifecycle artifact;
- unavailable/incompatible Qdrant or Ollama;
- embedding failure or incompatible vector;
- chunk store failure;
- missing, duplicate, malformed, reordered, conflicting, or corrupt chunks;
- incomplete manifest/chunk set;
- manifest store or verification failure;
- lifecycle key, nonce, phase, outcome, or source-identity mismatch;
- abort.

Errors must be actionable but sanitized: no raw endpoint responses, credentials, complete private
artifacts, stack traces, or unrestricted payload excerpts. Every failure is terminal for that
persistence attempt; no Vestige fallback and no false completion receipt.

## Security Checklist

- **JavaScript/TypeScript boundary validation — applicable.** Validate lifecycle request fields,
  explicit summary, artifact bounds, record metadata, Qdrant/Ollama responses, point IDs, indices,
  counts, hashes, vectors, and reassembled content. Propagate aborts and fail closed.
- **SQL — inapplicable.** No SQL is introduced.
- **WordPress PHP — inapplicable.** No PHP files are changed.
- **Bootstrap styling — inapplicable.** No UI or styling is changed.
- **Functional boundaries — applicable.** Keep business rules pure; isolate Qdrant, Ollama, Serena,
  Vestige-preference, filesystem, and task effects at explicit boundaries. Do not create custom
  `pipe`, `compose`, `curry`, or monad utilities.

## Standards Impact

- `lib/qdrant-corpus.ts` is already 499 lines. Do not add chunk responsibility directly. Create
  `lib/qdrant-corpus-chunks.ts` and keep each module cohesive.
- `extensions/integrations.ts` already exceeds 500 lines. It remains a composition root; the
  Vestige lifecycle block should shrink while pure corpus orchestration moves to `lib/`.
- `extensions/gateway-probe.ts` and `tests/integrations.test.js` already exceed the file-size smell.
  Do not broaden or fragment them mechanically. Use focused new test files when that improves
  responsibility cohesion.
- Apply the roughly-50-line function-size heuristic as a soft signal. Split by responsibility and
  control-flow clarity, not arbitrary line count.
- Use intent-based names, guard clauses, immutable transformations, named constants, explicit
  dependency objects, and comments only for non-obvious constraints such as chunks-first/manifest-last
  ordering.

## Implementation Order

1. Add pure schema-v2 manifest/chunk contracts, splitting, hashes, deterministic identity,
   validation, and reassembly with focused tests.
2. Add Qdrant vectorless insert-only and multi-ID direct retrieval operations with mocked boundary
   tests.
3. Extend logical corpus store/get, manifest-only find/recall, v1 compatibility, and native tool
   tests.
4. Add and test required `ima_lifecycle.summary`, record-key construction, corpus result mapping,
   and direct-retrieval completion verification.
5. Route `coordinateLifecycle` persistence/verification to Qdrant and assert no lifecycle Vestige
   call.
6. Route `ima_context` lifecycle hydration to corpus direct retrieval.
7. Route `/ima:cycle` reconciliation and gateway lifecycle probe to corpus.
8. Remove dead Vestige lifecycle helpers after repository-wide caller verification.
9. Update skills, Serena memories, active docs, historical superseding notes, changelog, and their
   contract tests.
10. Run focused tests, full tests, package acceptance, whitespace validation, and live corpus
    acceptance.

## Test Strategy

### Pure corpus tests

- Empty, single, exact-boundary, multi-chunk, and large detail.
- ASCII and multibyte Unicode boundaries; no split UTF-8 code points.
- Paragraph/newline preference without trimming or delimiter loss.
- Concatenation is byte-identical and full hash/byte count match.
- Retrieved response order does not matter; chunk index order does.
- Missing, duplicate, extra, wrong-parent, wrong-count, bad-index, and bad-hash chunks fail.
- Deterministic manifest/chunk IDs and idempotent identical writes.
- Divergent deterministic writes conflict without overwrite.
- Existing schema-v1 records remain readable.

### Boundary/integration tests

- Chunks are vectorless; manifest summary alone is embedded.
- Chunks store and verify before manifest; manifest failure cannot expose an incomplete artifact.
- Partial first attempt followed by identical retry completes safely.
- Corpus failure never invokes Vestige fallback.
- Find/recall omit detail chunks and full detail.
- Direct get retrieves all expected chunks and returns only verified detail.
- Abort propagates through embedding, chunk writes, manifest write, and retrieval.
- `ima_context` lifecycle source and `/ima:cycle` reconciliation use corpus data.
- Vestige preference bootstrap remains unchanged.

### Verification commands and expected signals

```bash
node --test tests/qdrant-corpus.test.js tests/qdrant-corpus-chunks.test.js
node --test tests/institutional-memory.test.js tests/lifecycle.test.js
node --test tests/context.test.js tests/cycle.test.js tests/gateway.test.js
npm test
git diff --check
```

Expected: all focused and full Node tests pass; `git diff --check` prints nothing and exits 0.

Package acceptance:

```bash
pi --no-session -e . -p "/ima:probe package"
```

Expected: local package loads and package/user/project `sourceInfo` provenance remains correct.

Live acceptance must use a dedicated non-production acceptance record key and report any cleanup
limitation:

1. `ima_corpus_status` reports ready.
2. Persist a lifecycle artifact larger than 44 KB, including multibyte text.
3. Verify multiple vectorless detail chunks and one embedded manifest exist.
4. Repeat identical persistence and receive `unchanged`/completed semantics without duplicates.
5. Directly retrieve and reassemble detail; compare exact UTF-8 bytes/hash to source.
6. Find and lifecycle recall return the manifest summary but not detail chunks.
7. Exercise a manual phase handoff and cycle reconciliation without any Vestige lifecycle call or
   `-32000`.
8. Run Vestige preference bootstrap and confirm preference recall still works.

## Observable Acceptance Criteria

1. Every formal lifecycle phase stores its artifact in Tier-1 Qdrant and verifies it through direct
   reassembled read-back.
2. No active lifecycle persistence, lifecycle-source hydration, or cycle-reconciliation path calls
   Vestige `smart_ingest`, lifecycle recall, or per-node get.
3. Vestige remains used for bounded preference bootstrap and no lifecycle fallback.
4. An artifact larger than 44 KB and within the approved lifecycle maximum persists as one manifest
   plus multiple deterministic vectorless chunks and reassembles byte-for-byte.
5. Partial/corrupt chunk sets fail closed and are never returned as complete.
6. Manifest semantic find and lifecycle recall remain bounded summary-only operations.
7. Schema-v1 institutional records remain retrievable.
8. `ima_lifecycle` requires an explicit approved summary and retains compatible result fields.
9. Full focused/package tests and whitespace checks pass.
10. Active skills, memories, and user documentation consistently describe Qdrant lifecycle storage,
    direct full-detail fetch, vectorless chunks, and Vestige preferences-only ownership.

## Rollout and Rollback

### Rollout

- Implement schema-v2 as backward-compatible; do not rewrite schema-v1 records.
- Route all new lifecycle writes to schema-v2 only after corpus unit/integration tests pass.
- Run a dedicated live acceptance record before a normal lifecycle phase.
- Do not purge migrated Vestige lifecycle data in this Story.

### Rollback

- Revert the repository diff to restore the prior implementation.
- Do not delete schema-v2 points: they are inert institutional data under deterministic keys and
  older code ignores unrecognized chunk records.
- Do not re-enable a silent Vestige fallback. If rollback restores Vestige lifecycle behavior, report
  the known `-32000` risk explicitly and block dependent lifecycle use until corrected.

## Blockers

No unresolved product, architecture, security, rollout, or verification question remains. Corpus
availability is an implementation/test prerequisite, not a planning blocker; production behavior
must fail closed with actionable guidance when it is unavailable.

## Residual Risk

- Multi-point writes are not transactional. Chunks-first/manifest-last ordering, deterministic IDs,
  read-back, and integrity validation prevent incomplete artifacts from being reported complete.
  Aborted writes can leave harmless orphan chunks until an identical retry reuses them.
- Summary quality controls semantic findability because detail chunks are intentionally vectorless.
  This is accepted; explicit agent-authored summaries mitigate it, and full-body semantic search is
  deferred.
- Cycle reconciliation adds bounded direct detail fetches after summary recall.
- Very large model-visible direct retrieval remains bounded by the approved artifact ceiling and Pi
  transport behavior; implementation tests must fail rather than silently truncate a complete
  artifact.

## Changed Files

This planning phase creates only:

- `docs/decisions/2026-08-27-two-tier-memory-story-c-plan.md`

No production, test, configuration, package, migration, or external memory file was changed during
planning. The Taskwarrior source receives a compact annotation pointing to this artifact.

## Verification Commands and Results

Planning used read-only repository, Qdrant documentation, local Qdrant status, Taskwarrior, and
bounded Vestige evidence. No tests, builds, formatters, package installs, servers, migrations, or
production writes were run. The approved Markdown artifact should be checked with:

```bash
git diff --check -- docs/decisions/2026-08-27-two-tier-memory-story-c-plan.md
```

Expected: no output and exit 0.

## Memory and Documentation Evidence

- Serena standard project memories: `core`, `conventions`, `tech_stack`, `suggested_commands`,
  `task_completion`, `memory_maintenance`.
- Approved two-tier PRD and decomposition under `docs/decisions/`.
- Story A plan, implementation, and test records under `docs/decisions/`.
- `lib/qdrant-corpus.ts`, `lib/qdrant-http.ts`, `extensions/institutional-memory.ts`,
  `extensions/integrations.ts`, `extensions/cycle.ts`, and existing tests.
- `ima-rag/scripts/qdrant-rag/sync.py` as a read-only chunking precedent.
- Current Qdrant documentation retrieved through Context7.
- Live Vestige recall/read evidence plus aggregate historical export measurements; the export was
  supporting evidence only, not a substitute for the live read result.

## Recommended Next Phase

```text
/ima:implement taskwarrior:ima-pi:a6264cf5-82a1-49c5-9ea1-8a39b3b1405a
```

The implementation phase must use this file as its detailed source of truth and must not redesign
settled architecture.
