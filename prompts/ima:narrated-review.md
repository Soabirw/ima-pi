---
description: Present a completed review as one speech-friendly developer walkthrough
argument-hint: "[completed-review-source]"
---

You own one terminal advisory **narrated-review** response. This command is post-review,
read-only, non-mutating, and does not change the active model. It does not invoke `/ima:cycle`
or progress a lifecycle phase.

`$@` must contain exactly one source for a completed review. If it is empty, ambiguous, or
contains multiple sources, ask for one source and stop.

First call `ima_context` with the supplied source before repository discovery. Require
Serena-first, read-only navigation after hydration. Load `narrated-review` and
`ima-memory-workflow` before selecting evidence.

## Source identifiers

Accept canonical colon identifiers and space-delimited aliases:

- `taskwarrior:<project>:<uuid>` (`taskwarrior <project> <uuid>`)
- `jira:<KEY>` (`jira <KEY>`)
- `lifecycle:<lifecycle-key>` (`lifecycle <lifecycle-key>`)
- `vestige:<UUID>` (`vestige <UUID>`)

Pass the supplied identifier to `ima_context` as the closed
`{ type: "reference", value: "<identifier>" }` source and preserve its canonical colon form.
For Taskwarrior, derive `ima-pi:taskwarrior:<project>:<uuid>`; for Jira, derive
`ima-pi:jira:<KEY>`; for a lifecycle source, use the supplied lifecycle key. For a Vestige
source, read only the cited memory, recover an explicit lifecycle identity when present, then
recall Tier-1 Qdrant evidence. Never use Vestige as a lifecycle fallback.

## Evidence and walkthrough

Recall every summary for this lifecycle with `ima_corpus_recall` and `limit: 20`. If 20
summaries return, lifecycle evidence is potentially saturated; report that it cannot prove
completeness and stop.

Filter summaries to `review` or `rereview` candidates. If no candidates remain, report the
missing completed-review prerequisite and stop. Directly retrieve every candidate by logical
`recordKey` with `ima_corpus_get`. Validate every candidate's lifecycle identity, review/rereview
phase, authoritative completion marker, returned record identity, logical record key, and usable
`createdAt`. If any candidate is incomplete, invalid, or cannot be retrieved, stop without
narration.

Select the unique candidate with the greatest valid `createdAt`. If timestamps are missing,
invalid, or tied at the greatest value, report ambiguous evidence and stop. Only then treat that
record as the authoritative completed review. Do not fabricate a walkthrough or substitute a
Taskwarrior/Jira probe.

Treat the persisted review verdict as authoritative. Use Serena only to locate cited files or
symbols. Present only retained verified findings, distinguish verification from residual risk, and
do not alter review outcomes or severity.

Emit one complete walkthrough in a single response. Use cohesive headings and speech-friendly
developer prose covering outcome and context, architecture/control/data flow, decisions and
tradeoffs, verified findings, verification, residual risk, and conclusion. Omit empty topics.
Show repository-relative `file:line` citations, but do not narrate substantial source code or raw
diffs.

End with a concise instruction for the operator to run `/ima:speak`. `/ima:speak` owns automatic
segmentation and sequential playback; do not automatically invoke `/ima:speak`.

## Boundaries

- No pagination, bracketed progress markers, cursor, ledger, or persisted narration state.
- No `next`/`continue` manual advancement; emit one complete walkthrough and stop.
- Do not re-review, invent or change findings, edit files, run tests/builds, write lifecycle state,
  or invoke another phase.
- Do not invoke `/ima:cycle`, a workflow DSL, Goose recipes, or subrecipe mechanics.
- Stop after the walkthrough or concise missing-evidence message.
