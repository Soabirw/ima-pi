---
description: Independently rereview one resolved lifecycle finding set
argument-hint: "[resolution-and-review-source]"
---
You own the `rereview` phase for exactly one lifecycle unit. Runtime selects the configured `rereview` route before prompt expansion; this phase is HIGH-inherited and does not change model authority.

`$@` must supply the approved plan, implementation, test, original review, resolution evidence, and lifecycle identity. Load `code-review` for the same evidence and verification standards, then use a fresh, product-read-only reviewer path. Verify each confirmed finding only against its required outcome and the bounded integration surface changed by its resolution. Preserve each original `REVIEW-NNN` ID; assign the next unused ID only to an independently verified regression caused by the resolution. Do not edit code, assign new remediation, reopen unrelated scope, or treat unsupported concerns as findings. Report missing evidence as blocked rather than guessing.

First call `ima_context` with the supplied source and use Serena-first evidence. When no resume evidence packet is already present in-session, then use `ima-memory-workflow` to recall the latest VERIFIED Tier-1 lifecycle artifact(s): derive `ima-pi:taskwarrior:<project>:<uuid>` for Taskwarrior or `ima-pi:jira:<KEY>` for Jira. For `lifecycle:<lifecycle-key>`, use the supplied lifecycle key directly. For `vestige:<UUID>`, retrieve only the cited memory, recover lifecycle identity when present, then recall related Qdrant manifest/direct-detail evidence. Never substitute a Taskwarrior or Jira probe for unavailable lifecycle corpus evidence; declare prerequisites missing only after the applicable lookup is empty or insufficient.

## Manual phase source identifiers

When `$@` is an identifier, accept these canonical colon forms with space-delimited aliases: `taskwarrior:<project>:<uuid>` (`taskwarrior <project> <uuid>`), `jira:<KEY>` (`jira <KEY>`), `lifecycle:<lifecycle-key>` (`lifecycle <lifecycle-key>`), and `vestige:<UUID>` (`vestige <UUID>`). Pass it to `ima_context` as the closed `{ type: "reference", value: "<identifier>" }` source so it normalizes before external access. Preserve the canonical colon form in handoff pointers. For lifecycle sources, use exact Tier-1 Qdrant manifest recall plus selected direct detail. For Vestige sources, read only the cited memory then use any explicit lifecycle identity to recall Qdrant; neither path has a Vestige lifecycle fallback.

Persist one complete `rereview` artifact through `ima_lifecycle`. An approved rereview hands off to document; a new request for changes returns to the bounded resolution loop only within the configured cap. Do not progress automatically.

When dispatched by `/ima:cycle`, finish the artifact with exactly one marker and no other cycle outcome marker:

`<!-- ima-cycle outcome: phase=rereview; outcome=APPROVED -->`

Use `REQUEST_CHANGES` for a supported unresolved finding or `BLOCKED` when evidence is insufficient:

`<!-- ima-cycle outcome: phase=rereview; outcome=REQUEST_CHANGES -->`

`<!-- ima-cycle outcome: phase=rereview; outcome=BLOCKED -->`

Do not invoke `/ima:cycle` automatically. Stop after the independent rereview result.
