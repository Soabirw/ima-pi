---
lifecycle:
  project: "ima-pi"
  lifecycle_key: "ima-pi:lifecycle:memory-two-tier-qdrant-migration-2026-08-25"
  lifecycle_root_memory_id: ""
  taskwarrior_project: ""
  taskwarrior_task: ""
  taskwarrior_uuid: ""
  jira_key: ""
  source_refs:
    - "vestige:5f27af6e-7a24-4f27-91ca-254892765234"
    - "taskwarrior:ima-pi:945d68e1-8a18-41d3-bcbb-14c711de9871"
    - "taskwarrior:ima-pi:876db94e-dc89-4b82-bdd0-9d02728bf27b"
    - "lifecycle:ima-pi:lifecycle:lifecycle-prompts-vestige-recall-2026-08-22"
  phase: "decision"
  prior_artifact_ids:
    - "5f27af6e-7a24-4f27-91ca-254892765234"
persistence_note: >-
  Persisted as a git-tracked markdown decision record instead of via ima_lifecycle/Vestige.
  Rationale: this decision retires Vestige as the store for lifecycle artifacts; writing it
  into Vestige would be self-contradictory and risks the -32000 poison-node failure it fixes.
  The shared Qdrant corpus does not exist yet (it is proposed here). Re-home this record into
  the Qdrant corpus once /ima:vestige-migrate and the shared collection exist, if desired.
status: approved
approved_by: "Eric"
date: "2026-08-25"
---

> **Superseded implementation note — Story A (2026-08-25):** references below to the
> `qdrant-memory` MCP server and its `qdrant_store`/`qdrant_find` tools are historical planning
> evidence. `ima-pi` now owns the institutional Qdrant corpus through native `ima_corpus_*` tools
> and direct Qdrant/Ollama HTTP boundaries. Story B retains ownership of migration work.

# Decision: Two-tier memory (shared Qdrant corpus + Vestige preferences) with a portable `/ima:vestige-migrate` command

## Decision

Adopt a two-tier memory architecture and deliver a portable, idempotent migration command:

- **Tier 1 — Institutional corpus:** a new, dedicated, **shared, cross-project Qdrant collection owned by `ima-pi`**, isolated from any per-machine `ima-rag` setup and integrable with `ima-rag` later if desired. It stores **both** distilled summaries (fast search) and full lifecycle details (drill-down), is permanent and append-only, never decays or auto-merges, uses bounded records, and is retrievable by semantic similarity and by lifecycle key.
- **Tier 2 — Preferences:** **Vestige holds evolving preferences/conventions only** — no lifecycle artifacts, summaries, status, or pointer-index.
- **Task status** remains in **Taskwarrior**.
- **`/ima:vestige-migrate`:** an `ima-pi` package command (+ supporting extension code) that repairs any developer machine reproducibly — export local Vestige (SQLite-level via `export`/`portable`, bypassing poison nodes), classify records, ensure/bootstrap the shared collection, import lifecycle memories with lineage, quarantine poison/oversized records, run idempotently, and print a report. It is non-destructive by default (preferences stay; migrated lifecycle memories are not purged from Vestige without explicit opt-in).

## Problem / Opportunity

IMA develops via the agent lifecycle (brainstorm → plan → implement → test → review → resolution → closeout); memory must act as the institutional "developer's brain," recalling prior implementations, decisions, and bugs for similar work — including cross-site cases (a plugin change for TRN whose bug appears in JIM or ACAD). Vestige's cognitive mechanics (FSRS decay, consolidation/merge, spaced repetition) make durable, high-volume lifecycle artifacts brittle: poison nodes crash MCP with `-32000`, decay erodes records that must not fade, and the review loop is inoperable. Multiple developer machines are already affected, so the fix must be reproducible per machine.

## Evidence & Research

- First-hand this session: bounded `recall` works; `memory get`/`state` on `a4f27951` fail `-32000` through reconnect + one retry; store otherwise `healthy` (485 memories); due-review resource instructs calling the retired/unexposed `mark_reviewed`.
- Vestige `2.3.0`: `export` (json/jsonl) and richer `portable` archive + `restore`, reading SQLite directly — migration bypasses the poison-node MCP path.
- `qdrant-memory` MCP exposes `qdrant_store`/`qdrant_find`; `~/IMA/dev/ima-rag` is a git-markdown → Qdrant curated KB whose setup varies per machine.
- `ima-pi` is a Pi package (extensions/prompts/skills), a natural vehicle for a namespaced `/ima:vestige-migrate` command.
- Prior lineage: oversized-node remediation story `taskwarrior:ima-pi:876db94e-...` (completed) and lifecycle `ima-pi:lifecycle:lifecycle-prompts-vestige-recall-2026-08-22`.

## Users & Use Cases

- Planning/implementation/review agents semantically retrieve prior comparable lifecycle work (summaries for fast scan, full detail on demand), across sites/repos.
- Every IMA developer runs one command to repair their machine, with a clear report and safe re-runs.
- Maintainer (Eric) gets durable, auditable, non-brittle recall, portable across machines with unknown `ima-rag` setups.

## Scope & Non-Goals

**In scope:** establish the two-tier separation and shared Qdrant collection; migrate lifecycle/planning/implementation/test/review/resolution/closeout memories into Tier 1 (summaries + details); deliver `/ima:vestige-migrate`; reorient `ima-pi` (instructions, prompts, skills, extension routing) so lifecycle persistence/recall targets Tier 1 and preferences target Vestige.

**Non-goals:** no implementation/schema design in this phase; no decomposition or Jira/Taskwarrior hierarchy; not fixing Vestige's upstream `-32000`/review bugs; not retiring Vestige entirely; no Vestige lifecycle/pointer layer; no hard dependency on a specific `ima-rag` install; Serena's role unchanged; the command does not delete migrated lifecycle data from Vestige without explicit opt-in.

## Business Rules

1. Class routing: lifecycle artifacts → Tier 1; preferences/conventions → Vestige; task status → Taskwarrior.
2. Two granularities in one store: each unit contributes a distilled summary and retains linked full detail in Tier 1.
3. Shared, cross-project corpus: one collection across IMA repos/sites, tagged by project/site/repo/lifecycle-key for scoped and cross-site recall.
4. Durability & bounded records: Tier-1 records never decay/auto-merge; retrievable by similarity and by key; size-bounded so none can break transport.
5. Migration safety: verified backup before any source mutation; lineage preserved; idempotent and re-runnable (no duplicate corpus entries on repeat runs).
6. Portability / zero-config: `/ima:vestige-migrate` works on a fresh machine regardless of `ima-rag`; verifies prerequisites (Qdrant + embeddings) and fails closed with actionable guidance if unavailable.
7. Non-destructive by default: preferences remain in Vestige; migrated lifecycle memories are not purged from Vestige unless the operator explicitly confirms.
8. Fail-closed: unreadable/oversized legacy records are quarantined and reported, never silently dropped or substituted.
9. Contract stability: keep `ima_lifecycle`/`ima_context` contracts unless Qdrant forces minimal, documented change.

## Product Acceptance Criteria

- Running `/ima:vestige-migrate` on an affected machine migrates lifecycle memories into the shared Qdrant corpus and reports migrated / retained-in-Vestige / quarantined records; a second run is safe and creates no duplicates.
- A new plan/implement session reliably surfaces relevant prior artifacts by similarity, including a cross-site example; retrieval offers fast summaries with full detail on demand.
- A full brainstorm → closeout pass yields zero `-32000` on the critical path and no dependence on Vestige per-node reads.
- Post-migration, Vestige holds a bounded preferences-only set and preference bootstrap still works.
- The command runs on a fresh machine without a preconfigured `ima-rag`, or fails with clear prerequisite guidance.

## Constraints & Dependencies

- Qdrant reachable (`:6333`) + embedding provider (Ollama `nomic-embed-text` / fastembed); embedding-model parity with legacy Vestige (`nomic-embed-text-v1.5`) considered for recall quality.
- Vestige export must handle oversized/poison records (segregate, don't block).
- `/ima:vestige-migrate` distributed via the `ima-pi` package (prompt/command + extension), following Pi resolution precedence; broad `ima-pi` edits across instructions/prompts/skills/extensions.
- Per-machine variability in `ima-rag`, embedding providers, and Vestige data volume.

## Risks

- Per-machine environment drift (missing Qdrant/Ollama) — must degrade gracefully with guidance.
- Idempotency bugs — re-runs could duplicate corpus entries without stable IDs/dedup keys.
- Retrieval parity — embedding/chunking differences vs. Vestige could change recall quality.
- Migration fidelity — poison/oversized nodes and lifecycle-vs-preference misclassification.
- Scope sprawl — command + routing changes are a large surface to keep consistent during rollout.

## Open Questions

1. Embedding/provider choice for Tier 1 and whether to match Vestige's model for parity.
2. Collection bootstrap/ownership + stable per-record IDs enabling idempotent re-runs.
3. Distillation authorship — who/what produces summaries per phase (for the plan phase).
4. Whether `/ima:vestige-migrate` offers an optional, opt-in post-migration Vestige cleanup once corpus integrity is verified.
5. Where governance/decision artifacts like this one live long-term (git `docs/` only, or also indexed into the Qdrant corpus once it exists).

## Decisions

- **D1:** Two-tier memory (institutional corpus vs. cognitive preferences).
- **D2:** Migrate lifecycle/planning/implementation/test/review/resolution/closeout memories to Tier 1; preferences and others stay in Vestige.
- **D3:** Tier 1 = new, dedicated, shared, cross-project Qdrant collection owned by `ima-pi`, isolated from per-machine `ima-rag`, integrable later.
- **D4:** Store both distilled summaries and full details in Tier 1.
- **D5:** Migrate via Vestige `export`/`portable` (SQLite-level), preserving lineage, quarantining oversized/poison records.
- **D6:** Keep `ima_lifecycle`/`ima_context` contracts stable unless Qdrant forces minimal, documented change.
- **D7:** Vestige = preferences/conventions only; no lifecycle summaries/status/pointer-index in Vestige; task status stays in Taskwarrior; Qdrant is the single source of truth for institutional memory.
- **D8:** Deliver the migration as a portable, idempotent, non-destructive `/ima:vestige-migrate` command in the `ima-pi` package.
- **D9:** Persist this decision as a git-tracked markdown record in `docs/decisions/` rather than in Vestige; re-home into the Qdrant corpus later if desired.

## Source References

- This conversation (Q1–Q6 answers; cross-site TRN/JIM/ACAD rationale; `/ima:vestige-migrate` request; do-not-store-in-Vestige constraint).
- `vestige:5f27af6e-7a24-4f27-91ca-254892765234` (prior requirements/migration decision).
- `taskwarrior:ima-pi:945d68e1-8a18-41d3-bcbb-14c711de9871` (closed); `taskwarrior:ima-pi:876db94e-dc89-4b82-bdd0-9d02728bf27b` (oversized-node remediation); `ima-pi:lifecycle:lifecycle-prompts-vestige-recall-2026-08-22`.
- `vestige-mcp 2.3.0` (`maintain export`, `portable`, `restore`); `qdrant-memory` (`qdrant_store`/`qdrant_find`); `~/IMA/dev/ima-rag` (optional future integration).

## Recommended Next Phase

`/ima:decompose` — spans a retrieval-quality + collection-bootstrap/idempotency spike (Open Questions 1–2), the `/ima:vestige-migrate` command + extension, migration/export-import with quarantine, `ima-pi` routing changes across instructions/prompts/skills/extensions, and Vestige scope reduction. Sequence the spike first to de-risk embedding parity, zero-config bootstrap, and idempotent re-runs before broad edits.
