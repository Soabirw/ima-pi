---
lifecycle:
  project: "ima-pi"
  lifecycle_key: "ima-pi:lifecycle:memory-two-tier-qdrant-migration-2026-08-25"
  lifecycle_root_memory_id: ""
  taskwarrior_project: "ima-pi"
  taskwarrior_task: ""
  taskwarrior_uuid: ""
  jira_key: ""
  source_refs:
    - "lifecycle:ima-pi:lifecycle:memory-two-tier-qdrant-migration-2026-08-25"
    - "file:docs/decisions/2026-08-25-two-tier-memory-qdrant-migration.md"
    - "vestige:5f27af6e-7a24-4f27-91ca-254892765234"
  phase: "decision"
  prior_artifact_ids: []
persistence_note: >-
  Persisted as a git-tracked markdown decomposition record instead of via ima_lifecycle/Vestige,
  per the approved decision (D7/D9) that lifecycle artifacts must leave Vestige and the standing
  operator directive not to store this work in Vestige. Vestige recall is additionally degraded
  (-32000). The authoritative delivery units are the Taskwarrior Stories listed below.
record_type: "pm-decomposition"
destination: "taskwarrior"
status: persisted
date: "2026-08-25"
---

# Decomposition: Two-tier memory (Qdrant corpus + Vestige preferences) + `/ima:vestige-migrate`

Source PRD: `docs/decisions/2026-08-25-two-tier-memory-qdrant-migration.md`
(lifecycle key `ima-pi:lifecycle:memory-two-tier-qdrant-migration-2026-08-25`, approved by Eric).

Destination: **Taskwarrior project `ima-pi`** (single destination; no dual-write). Two managed tiers: Project -> Task -> checklist embedded in each Task's annotations.

## Created lifecycle units

| Story | Taskwarrior ID | UUID | Depends on |
|-------|----------------|------|------------|
| A — Shared Qdrant institutional-memory corpus foundation | 39 | `0f1bd176-962c-4a6c-8ed8-31c87c3868c5` | none |
| B — `/ima:vestige-migrate` command (export→classify→import→quarantine, idempotent & non-destructive) | 40 | `7742b1e1-af39-44d1-9c7e-39c455b15828` | A |
| C — Reorient ima-pi lifecycle persistence & recall to Tier-1 (+ Vestige preferences-only + docs) | 41 | `a6264cf5-82a1-49c5-9ea1-8a39b3b1405a` | A |

Each Story is an independent `plan -> implement -> test -> review -> document` unit and carries Stakeholder, Business outcome, Rationale, Scope, Non-goals, Acceptance criteria, Dependencies, Source traceability, Checklist, and Lifecycle annotations in Taskwarrior.

## Sequencing

1. **Story A** first (foundation). Its `plan` phase resolves the technical Open Questions 1–2 (embedding provider/parity; stable record-ID + idempotency scheme).
2. **Stories B and C** proceed in parallel after A.

## Embedded-vs-promoted note

The PRD's separate "Vestige scope reduction + two-tier documentation" bullet is **embedded as checklist items in Story C** (routing change and scope reduction overlap heavily). It can be promoted to an independent Story D later if an independent lifecycle is preferred.

## Traceability to PRD decisions

- Story A ← D1, D3, D4, D6; Open Questions 1–2.
- Story B ← D5, D8; Open Question 4; business rules 5–8.
- Story C ← D2, D6, D7 (+ embedded D7 scope reduction); business rules 1, 9; acceptance criteria 2–4; Open Question 5.

## Deferred / open

- Open Question 5 (long-term home for governance/decision artifacts) is tracked inside Story C's scope.
- Governance artifacts (this record and the PRD) currently live in `docs/decisions/`; re-home into the Qdrant corpus once Story A + Story B exist, if desired.

## Recommended next phase

Begin Story A:

```text
/ima:plan taskwarrior:ima-pi:0f1bd176-962c-4a6c-8ed8-31c87c3868c5
```
