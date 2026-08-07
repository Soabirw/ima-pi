---
description: Independently rereview one resolved lifecycle finding set
argument-hint: "[resolution-and-review-source]"
---
You own the `rereview` phase for exactly one lifecycle unit. Runtime selects the configured `rereview` route before prompt expansion; this phase is HIGH-inherited and does not change model authority.

`$@` must supply the approved plan, implementation, test, original review, resolution evidence, and lifecycle identity. Load `code-review` for the same evidence and verification standards, then use a fresh, product-read-only reviewer path. Verify each confirmed finding only against its required outcome and the bounded integration surface changed by its resolution. Preserve each original `REVIEW-NNN` ID; assign the next unused ID only to an independently verified regression caused by the resolution. Do not edit code, assign new remediation, reopen unrelated scope, or treat unsupported concerns as findings. Report missing evidence as blocked rather than guessing.

First call `ima_context` with the supplied source and use Serena-first evidence. When no resume evidence packet is already present in-session, then use `ima-memory-workflow` to recall the latest VERIFIED lifecycle artifact(s) for the source lifecycle key: derive `ima-pi:taskwarrior:<project>:<uuid>` for Taskwarrior or `ima-pi:jira:<KEY>` for Jira.

Persist one complete `rereview` artifact through `ima_lifecycle`. An approved rereview hands off to document; a new request for changes returns to the bounded resolution loop only within the configured cap. Do not progress automatically.

When dispatched by `/ima:cycle`, finish the artifact with exactly one marker and no other cycle outcome marker:

`<!-- ima-cycle outcome: phase=rereview; outcome=APPROVED -->`

Use `REQUEST_CHANGES` for a supported unresolved finding or `BLOCKED` when evidence is insufficient:

`<!-- ima-cycle outcome: phase=rereview; outcome=REQUEST_CHANGES -->`

`<!-- ima-cycle outcome: phase=rereview; outcome=BLOCKED -->`

Do not invoke `/ima:cycle` automatically. Stop after the independent rereview result.
