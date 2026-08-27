---
lifecycle:
  project: "ima-pi"
  lifecycle_key: "ima-pi:lifecycle:vestige-migrate-command-2026-08-26"
  lifecycle_root_memory_id: ""
  taskwarrior_project: "ima-pi"
  taskwarrior_task: "39"
  taskwarrior_uuid: "7742b1e1-af39-44d1-9c7e-39c455b15828"
  jira_key: ""
  source_refs:
    - "taskwarrior:ima-pi:7742b1e1-af39-44d1-9c7e-39c455b15828"
    - "lifecycle:ima-pi:lifecycle:memory-two-tier-qdrant-migration-2026-08-25"
    - "file:docs/decisions/2026-08-25-two-tier-memory-qdrant-migration.md"
    - "file:docs/decisions/2026-08-25-two-tier-memory-decomposition.md"
  phase: "plan"
  prior_artifact_ids:
    - "90ae9ce1-cde5-43d7-9e2f-133d722887be"
    - "adebadb3-7de3-4465-8f21-04e752fcc8b7"
    - "e79a9273-10bb-4ed4-a562-d3becf9bfe2a"
status: "approved"
approved_by: "Eric"
date: "2026-08-26"
persistence_note: >-
  Git-tracked lifecycle fallback during the Vestige-to-Qdrant transition. The rev 1 and
  rev 2 Vestige artifacts returned accepted receipts and matched semantic recall when
  written, but later returned "Memory not found." Rev 3 was immediately readable after
  the same receipt-plus-recall verification. This demonstrates the lifecycle durability
  failure tracked by task 38 and makes this file the durable approved-plan source of truth.
---

# Plan: Safe Vestige-to-Qdrant lifecycle migration

## Source and approved outcome

- **Source:** `taskwarrior:ima-pi:7742b1e1-af39-44d1-9c7e-39c455b15828`
  (Story B, `/ima:vestige-migrate`).
- **Approved outcome:** one package command safely migrates a machine's cross-project
  Vestige lifecycle memories into the shared Tier-1 Qdrant collection
  `ima-institutional-memory`.
- Repeated migrations are idempotent and create no duplicate records.
- Poison, malformed, or oversized records are quarantined and reported rather than
  silently discarded.
- Preferences remain in Vestige.
- Lifecycle memories are deleted from Vestige only after explicit user confirmation and
  renewed verification that each selected record exists in Qdrant.
- Serena remains the per-project memory system and is not part of this migration.

## Problem

Vestige is currently the cross-project source of lifecycle history, but lifecycle records
can poison or destabilize its MCP retrieval path. Multiple developer machines require a
reproducible migration rather than manual database repair. The migration carries material
data-loss risk, so backups, validation, import verification, and a separate confirmation
before source deletion are mandatory.

The plan itself also demonstrates the problem: two Vestige copies disappeared after
successful write receipts and semantic-recall verification. This Markdown artifact is the
durable source of truth until lifecycle persistence moves to Qdrant.

## Scope

1. Fail-closed source and destination prechecks.
2. Vestige SQLite backup and JSON export.
3. Qdrant snapshot when the institutional collection already exists.
4. Bounded validation and classification of every exported record.
5. Creation or compatibility verification of `ima-institutional-memory`.
6. Deterministic secret redaction, transformation, and Qdrant ingestion.
7. Point-level and lifecycle-key verification after ingestion.
8. A migration report and mandatory stop for user testing.
9. A separate, explicit cleanup operation that deletes only verified lifecycle records
   from Vestige.

## Non-goals

- Story A's Qdrant corpus foundation, which is complete.
- Story C's lifecycle persistence and recall routing.
- Fixing Vestige's upstream `-32000` or durability behavior.
- Migrating Serena memories.
- Migrating preferences out of Vestige.
- Integrating with `ima-rag`.
- Forced or unverified Vestige deletion.
- A built-in collection reset, drop, or batch rollback command.
- Changing the shared Qdrant record contract or its content-hash semantics.
- Consolidating all project redaction into a new shared abstraction.

## Existing implementation boundaries

- `lib/qdrant-corpus.ts` owns the bounded institutional record contract, deterministic
  UUIDv5 IDs, content hashing, validation, and insert-only idempotency. It trims and
  validates text but **does not redact secrets**.
- `lib/qdrant-http.ts` owns status, collection creation/indexing, embedding, insert-only
  storage, semantic search, lifecycle recall, and full record retrieval.
- `lib/qdrant-http-boundary.ts` owns validated endpoints and bounded JSON HTTP requests.
- `lib/mcp-client.ts` owns direct package MCP sessions.
- `config/mcp.json` declares `vestige-mcp` as the Vestige server.
- `lib/ima-lifecycle.ts` provides evidence of the legacy lifecycle front matter and
  verification marker formats. Its local `clean()` redactor is precedent only and is not
  exported for migration use.

## Files and responsibilities

### Create `lib/vestige-migrate.ts`

Pure migration core, kept below the 500-line smell where cohesion permits:

- validate exported envelopes and records;
- classify lifecycle records, preferences, and quarantine candidates;
- parse lifecycle front matter and verification markers;
- deterministically redact secret-bearing free text;
- derive stable Qdrant record keys and Vestige lineage references;
- derive bounded summaries and details;
- build report counts and cleanup eligibility;
- perform no MCP, HTTP, filesystem, logging, or user interaction.

### Create `extensions/vestige-migrate.ts`

Impure Pi extension shell:

- register `ima_vestige_migrate` and `ima_vestige_cleanup`;
- call Vestige through direct package MCP sessions;
- run destination prechecks and Qdrant collection bootstrap;
- create Qdrant snapshots through the bounded HTTP boundary;
- write bounded local migration artifacts;
- import records through the existing corpus operations;
- re-read imported records before reporting success;
- require explicit cleanup confirmation and renewed point verification before each
  Vestige deletion.

### Modify `lib/qdrant-http-boundary.ts`

Add only the narrow Qdrant snapshot operation needed by migration. Do not place migration
or destructive collection-management behavior in `lib/qdrant-http.ts` or
`lib/qdrant-corpus.ts`, which are already near the 500-line file-size smell.

### Create `prompts/ima:vestige-migrate.md`

Provide the user-facing operator flow:

- run the non-destructive migration;
- present backup locations and the complete report;
- stop for external testing and user verification;
- invoke cleanup only from a later explicit confirmation;
- document one-off clean-slate recovery for a bad migration: drop only
  `ima-institutional-memory`, never `ima-knowledge`, `patristic`, or another collection,
  then rerun migration.

The prompt does not implement a generic reset command.

### Create `tests/vestige-migrate.test.js`

Use the built-in Node test runner and injected fake boundaries. Cover the pure core and
shell orchestration without depending on live Vestige, Qdrant, or Ollama services.

### Modify `CHANGELOG.md`

Document the new migration and cleanup capability under Unreleased.

No `package.json` change is required because Pi loads the `extensions/` and `prompts/`
directories declared by the package manifest.

## Data and control flow

### 1. Precheck and fail closed

Before a migration write:

- confirm Vestige is reachable;
- obtain a bounded export and confirm it contains at least one valid lifecycle candidate;
- confirm Qdrant version compatibility;
- confirm Ollama and the approved embedding model digest;
- if the institutional collection exists, confirm schema and vector compatibility.

Any failure returns actionable guidance and performs no Qdrant collection mutation or
Vestige deletion.

### 2. Back up source and destination

- Run Vestige's SQLite backup operation.
- Produce a JSON export suitable for bounded validation.
- If `ima-institutional-memory` exists, create a Qdrant snapshot before ingest.
- Record backup and snapshot receipts in
  `.ima/vestige-migrate/<timestamp>/` (the `.ima/` directory is gitignored).
- If a required backup cannot be confirmed, stop before ingestion.

### 3. Export and validate

Treat the complete Vestige export as untrusted input:

- validate envelope and per-record shape;
- enforce input and output size bounds;
- never interpolate exported data into SQL;
- send malformed, unreadable, or oversized candidates to quarantine with a reason;
- do not silently omit records.

### 4. Ensure the destination collection

Use the existing idempotent `ensureCollection()` behavior:

- create `ima-institutional-memory` and required indexes on the first migration for a
  machine;
- reuse a compatible existing collection on later runs;
- fail closed on an incompatible collection rather than repairing or replacing it.

### 5. Classify and transform

Classify a record as lifecycle only when it carries the expected lifecycle metadata and
verification evidence. Retain everything else in Vestige as a preference or unknown
non-lifecycle record.

For each lifecycle record:

- parse `project`, `lifecycle_key`, phase, source references, and verification nonce;
- derive `recordKey = "<lifecycle_key>:<phase>:<nonce>"`;
- append `vestige:<nodeId>` to `sourceRefs` for lineage;
- derive a deterministic summary from the first heading and lead paragraph, bounded to
  2,000 UTF-8 bytes;
- retain the full bounded artifact as `detail`;
- quarantine details that exceed the 44,000-byte corpus limit after redaction.

### 6. Redact free text before store

`lib/qdrant-corpus.ts` does not redact. The migration therefore owns a deterministic pure
`redactSecrets(text)` operation and applies it to `summary` and `detail` before hashing or
storage.

Case-insensitive patterns cover:

- `(authorization|token|secret|password)\s*[:=]\s*\S+`;
- `bearer\s+\S+`;
- `(api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*\S+`.

Use the established mask convention: values shorter than `[redacted]` become the same
number of `*` characters; longer values become `[redacted]`. Do not redact structural
metadata (`project`, `lifecycle_key`, phase, or `recordKey`) because doing so would break
lookup and idempotency.

The redactor is deterministic, so the existing corpus hash covers already-redacted
content and repeated migrations remain `unchanged`. Reports include a count of records
whose free text was changed without exposing matched values.

### 7. Ingest idempotently

Store through the existing insert-only corpus path:

- a new stable record key produces `stored`;
- identical content for the same key produces `unchanged`;
- different content for the same immutable key produces `record_conflict` and is reported;
- no conflict is overwritten automatically.

### 8. Verify and report, then stop

For every stored or unchanged record:

- re-fetch by deterministic record key or ID;
- validate the returned record and content hash;
- verify expected lifecycle-key recall;
- count only current-invocation verified results as successful.

Write and display a bounded report including:

- migrated;
- unchanged;
- retained preferences/non-lifecycle records;
- quarantined records and reasons;
- conflicts;
- redacted records;
- failed or unverified records;
- backup/snapshot receipts.

The migration stops here. It does not delete from Vestige.

### 9. Explicit, verified cleanup

`ima_vestige_cleanup` is a separate invocation and requires explicit confirmation. Before
each deletion:

- reconstruct the expected deterministic Qdrant identity from the saved migration report;
- re-fetch and validate the Qdrant record in the current invocation;
- confirm the Vestige node was classified as lifecycle;
- call Vestige delete/purge with `confirm:true` only after both checks pass.

Never delete preferences, quarantined records, conflicts, failed imports, or records that
cannot be re-verified. Report purged and retained IDs without printing record content.

## Approved decisions

- **D-B1 — Identity and lineage:** stable record key is
  `<lifecycle_key>:<phase>:<nonce>`; `vestige:<nodeId>` is retained in source references.
- **D-B2 — Distillation and bounds:** summary is first heading plus lead paragraph,
  bounded to 2,000 bytes; detail retains the full artifact; artifacts above 44,000 bytes
  after redaction are quarantined.
- **D-B3 — Redo safety:** ordinary reruns are the supported recovery and create no
  duplicates. No reset or rollback tool is built. A clean-slate recovery is a documented
  one-off that may drop only `ima-institutional-memory`, then rerun.
- **D-B4 — Deletion staging:** migration is non-destructive and stops for user testing;
  cleanup is a later explicit invocation with `confirm:true` and renewed Tier-1
  verification.
- **D-B5 — Secret handling:** Story B owns migration-local deterministic redaction of free
  text before store. Story A's shared corpus contract and hash behavior remain unchanged.

## Error paths

- Vestige unavailable, export unavailable, malformed envelope, missing lifecycle records,
  Qdrant unavailable, unsupported version, Ollama unavailable, embedding model absent or
  mismatched, incompatible collection, or failed backup: fail before ingestion.
- One malformed or oversized record: quarantine it; continue only when the complete export
  itself remains trustworthy.
- Store conflict or failed post-store verification: report and retain the source record.
- Snapshot failure for an existing collection: fail before new inserts.
- Cleanup verification failure: retain that Vestige node and report why.
- Cancellation: stop issuing new operations; never infer success from partial responses.

## Pure and effect boundaries

- Pure: validation, classification, parsing, redaction, record-key derivation,
  transformation, bounds, reports, and cleanup eligibility.
- Effects: MCP calls, Qdrant/Ollama HTTP, filesystem artifact writes, user confirmation,
  and Vestige deletion.
- The shell calls the pure core; the pure core never calls the shell.
- Do not add custom `pipe`, `compose`, `curry`, monad, or generic migration-framework
  utilities.

## Standards impact

- Keep each new file below roughly 500 lines where cohesion permits; split by
  responsibility rather than extracting artificial abstractions.
- Keep functions focused, use intent-revealing names, guard clauses, named constants, and
  shallow control flow.
- Treat Vestige exports and service responses as untrusted boundary data.
- Never construct SQL with interpolated values.
- Do not expose credentials, matched secret values, raw provider responses, or stack
  traces in reports.
- WordPress PHP guardrails: **not applicable**; no PHP files are in scope.
- Bootstrap styling guardrails: **not applicable**; no web UI is in scope.

## Test strategy

Unit and orchestration tests must prove:

- lifecycle, preference, unknown, malformed, and oversized classification;
- front-matter and marker parsing;
- stable record-key derivation and Vestige lineage;
- every approved secret pattern is masked;
- non-secret text is unchanged;
- redaction is deterministic and idempotent;
- structural metadata is not redacted;
- redaction counts are correct;
- summary/detail byte bounds and quarantine behavior;
- first migration stores, identical rerun is unchanged, and content conflict fails closed;
- backup and snapshot occur before collection or point mutation;
- missing prerequisites cause no partial write;
- post-store reads gate success;
- cleanup never deletes preferences, quarantine items, conflicts, failed imports, or
  unverified points;
- cleanup requires explicit confirmation;
- reports are bounded and contain no matched secret value.

Live Qdrant/Ollama/Vestige behavior remains a manual environment-dependent acceptance step
and must be reported as unverified if not exercised.

## Acceptance criteria

- A valid affected machine migrates all valid lifecycle memories and reports migrated,
  unchanged, retained, quarantined, conflicted, redacted, and failed counts.
- A second migration creates no duplicates.
- First migration creates the absent institutional collection; later migrations reuse it.
- Preferences and Serena project memories are untouched.
- Missing prerequisites or backups fail closed with actionable guidance.
- Poison, malformed, and oversized records are quarantined and reported.
- Secret-bearing free text is masked before Qdrant storage.
- Every reported success is verified by current-invocation Qdrant reads.
- Migration never deletes Vestige data.
- Cleanup deletes only explicitly confirmed, re-verified lifecycle nodes.

## Verification commands

```bash
node --test tests/vestige-migrate.test.js
npm test
git diff --check
```

Expected signals:

- focused migration tests pass;
- the full Node test suite passes;
- `git diff --check` prints no output and exits zero.

Manual acceptance when suitable services and backups are available:

```text
pi -e .
/ima:vestige-migrate
```

Inspect the backup receipts, report, Qdrant fetches/searches, and retained Vestige data.
Rerun migration and require all prior successful records to report `unchanged`. Invoke
cleanup only in a later explicit session after user verification.

## Rollback

Before Vestige cleanup, rollback is source-preserving: retain Vestige as the authoritative
copy, inspect the Qdrant snapshot/report, and use the documented one-off reset of
`ima-institutional-memory` only when an operator explicitly decides that a bad first
migration requires a clean slate. Never drop another Qdrant collection.

After explicit cleanup, Vestige's SQLite backup and JSON export are the recovery sources;
therefore cleanup must not begin without verified, readable backup receipts.

Repository rollback removes the Story B extension, pure migration core, command prompt,
tests, changelog entry, and the narrow snapshot-boundary addition. It does not modify
Story A's corpus contract.

## Blockers and residual risks

- Vestige export payload size may exceed MCP transport limits; implementation must confirm
  the actual export/backup delivery shape early and use bounded file parsing when the tool
  returns a path.
- Pattern-based secret redaction is defense in depth, not proof that every possible secret
  form is detected.
- Embedding parity differs from legacy Vestige but the approved Story A model digest is
  fixed.
- Live Qdrant/Ollama/Vestige acceptance depends on local services and backups.
- Vestige lifecycle persistence is observably non-durable: successful receipt and semantic
  recall did not keep rev 1 or rev 2 retrievable. This file is therefore the durable plan
  source during the transition.

## Prior artifacts and evidence

- Vestige rev 1 plan `90ae9ce1-cde5-43d7-9e2f-133d722887be`: accepted and semantically
  verified when written; later returned `Memory not found`.
- Vestige rev 2 plan `adebadb3-7de3-4465-8f21-04e752fcc8b7`: accepted and semantically
  verified when written; later returned `Memory not found`.
- Vestige rev 3 durability probe `e79a9273-10bb-4ed4-a562-d3becf9bfe2a`: accepted,
  semantically verified, and immediately readable.
- `docs/decisions/2026-08-25-two-tier-memory-qdrant-migration.md`.
- `docs/decisions/2026-08-25-two-tier-memory-decomposition.md`.
- Story A Qdrant corpus artifacts and `skills/ima-qdrant/SKILL.md`.
- Task 38: Vestige lifecycle recall/transport instability.

## Phase result

**APPROVED.** This Markdown file is the durable implementation contract while Vestige
lifecycle storage is being retired.

## Recommended next phase

`/ima:implement taskwarrior:ima-pi:7742b1e1-af39-44d1-9c7e-39c455b15828`
