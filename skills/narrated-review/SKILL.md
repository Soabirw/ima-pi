---
name: narrated-review
description: Present a completed review as a speech-friendly developer walkthrough for operator-triggered /ima:speak narration. Use for narrated review, spoken walkthrough, review presentation, or post-review explanation.
---

# Narrated Review

Use this skill for a post-`/ima:review` spoken walkthrough of a completed, verified review.
It turns authoritative review evidence into one readable developer presentation; it does not
perform, repeat, or alter the review.

## Read-only boundary

- Treat the persisted verified review verdict as authoritative.
- Do not use `ima_corpus_recall` at `limit: 20` or `ima_corpus_get` for lifecycle evidence; both
  remain institutional Qdrant-only.
- In every fresh narration session, call `ima_lifecycle_recall` for the exact lifecycle key at
  `limit: 20`. It derives the checkout pin or, only while genuinely unpinned, exact historical
  Qdrant authority.
- Its results are descriptors only. If 20 descriptors return, treat lifecycle evidence as potentially saturated
  and stop; the bounded response cannot prove completeness.
- Filter descriptors to `review` or `rereview` candidates. If none remain, report the missing
  completed-review prerequisite and stop.
- Directly retrieve every candidate by calling `ima_lifecycle_get` with only its selected exact
  `lifecycleKey`, `phase`, and `artifactId`; never reconstruct or send descriptor proof fields, and
  never accept a descriptor as evidence. The package freshly resolves the exact phase and proof.
- Validate every candidate's complete result for lifecycle identity, review/rereview phase,
  authoritative completion marker, returned `artifactId`, logical `recordKey`, content hash, read reference, and
  authoritative usable `createdAt` before narration; never infer a missing timestamp.
- Select the unique candidate with the greatest valid `createdAt`. If timestamps are missing,
  invalid, or tied at the greatest value, report ambiguous evidence and stop.
- Fail closed when a candidate cannot be retrieved or validated, or when evidence cannot identify
  the reviewed context. Pending, inaccessible, unavailable, corrupt, mismatched, overflowed, or
  cancelled reads block; do not infer findings or substitute a Taskwarrior/Jira lookup.
- Use [ima-memory-workflow](../ima-memory-workflow/SKILL.md) for Serena, Vestige, and Tier-1
  Qdrant boundaries. `ima_corpus_*` remains institutional Qdrant-only; Vestige is not a lifecycle
  fallback.
- Do not re-review, change a verdict or severity, resolve a finding, run tests or builds, edit
  files, persist narration state, write a lifecycle artifact, or make any lifecycle mutation.
- Do not make a tool-driven TTS invocation. The operator decides whether to run `/ima:speak`.

## Evidence fidelity

Use [code-review](../code-review/SKILL.md) for the verified-review contract.

- Present only retained verified findings as findings.
- Never promote withdrawn, unverified, speculative, or unrelated concerns into findings.
- Preserve the review's outcome, scope, decisions, tradeoffs, verification, and residual risk.
- Distinguish completed verification from unverified paths and residual risk.
- Cite repository-relative `file:line` on screen when the review artifact supplies it. If a cited
  location appears stale, relocate it only through bounded Serena evidence when unambiguous; name
  both the original citation and current location. Otherwise, report the uncertainty.
- The persisted review is authoritative. Current repository navigation may add location context,
  not new findings or changed severity.

## Single-response presentation

Produce one complete developer presentation in a single response. Use intent-first,
speech-friendly prose and omit an empty topic rather than adding filler. A cohesive order is:

1. Outcome and context.
2. Architecture plus control and data flow.
3. Decisions, design patterns, and tradeoffs.
4. Retained verified findings.
5. Verification, residual risk, and conclusion.

Use short headings and pronounceable terms. Explain why a design exists rather than reciting its
implementation. Do not recite substantial source code or raw diffs. Do not use code fences merely
to show reviewed code.

## Narration handoff

- End the visible walkthrough with a concise instruction to run `/ima:speak`.
- `/ima:speak` owns cleanup, automatic segmentation, synthesis, and sequential playback.
- Keep the Markdown response authoritative even when TTS is disabled or unavailable.
- Do not automatically invoke `/ima:speak`, another phase, or `/ima:cycle`.

## Prohibited pagination state

Do not add pagination, bracketed progress markers, a cursor, a ledger, or manual advancement.
Do not ask the operator to use `next` or `continue`. The walkthrough is a single response;
`/ima:speak` handles automatic segmentation and sequential playback for long responses.

## Local presentation quality

Apply [readable-code](../readable-code/SKILL.md) principles to prose: clear names for concepts,
flat structure, cohesive sections, and no abstraction for its own sake. Keep citations visible,
prose concise, and technical details accurate enough for a developer audience.
