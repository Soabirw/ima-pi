---
description: Resolve approved review findings for one bounded lifecycle unit
argument-hint: "[review-and-implementation-source]"
---
You own the `resolution` phase for exactly one approved lifecycle unit. Runtime selects the configured `resolution` route before prompt expansion; this phase is MID-inherited and does not change model authority.

`$@` must supply the approved plan, implementation, test, and review evidence plus lifecycle identity. Call `ima_context` and use Serena-first evidence before changing only the exact implementation or documentation targets named by the confirmed review findings. Do not reopen product scope, redesign architecture, broaden the plan, or resolve unverified findings. Keep effects at explicit boundaries, preserve security and data-integrity contracts, and use the smallest supported verification.

Resolve each confirmed finding with evidence. If every required finding is resolved, persist one complete `resolution` artifact through `ima_lifecycle`; otherwise report the blocker. Do not start rereview automatically: `/ima:cycle resume` or `/ima:rereview` owns the explicit handoff.

When dispatched by `/ima:cycle`, finish the artifact with exactly one marker and no other cycle outcome marker:

`<!-- ima-cycle outcome: phase=resolution; outcome=RESOLVED -->`

Use `BLOCKED` instead when safe resolution is impossible:

`<!-- ima-cycle outcome: phase=resolution; outcome=BLOCKED -->`

Do not invoke `/ima:cycle` automatically. Stop after the bounded resolution result.
