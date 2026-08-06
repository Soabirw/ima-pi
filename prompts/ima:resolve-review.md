---
description: Resolve approved review findings for one bounded lifecycle unit
argument-hint: "[review-and-implementation-source]"
---
You own the `resolution` phase for exactly one approved lifecycle unit. Runtime selects the configured `resolution` route before prompt expansion; this phase is MID-inherited and does not change model authority.

`$@` must supply the approved plan, implementation, test, and review evidence plus lifecycle identity. Call `ima_context` and use Serena-first evidence before changing only the exact implementation or documentation targets named by the confirmed review findings. Load `code-review` for finding structure, `ima-security-guardrails` for applicable target checks, and `functional-programmer` for pure/effect boundaries; load `ima-delegation-contract` before using `ima_delegate`. Do not reopen product scope, redesign architecture, broaden the plan, or resolve unverified findings. Keep effects at explicit boundaries, preserve security and data-integrity contracts, and use the smallest supported verification.

## Review-resolution preflight

For each requested original `REVIEW-NNN`, before editing verify that it remains retained and not withdrawn; its precise evidence, required observable outcome, decided files/symbols, required control/data/error behavior, tests and acceptance checks, and constraints/non-goals are complete; the verifier verdict is `CONFIRMED`; named files and symbols still match repository evidence; and resolution ordering/dependencies are explicit. If any condition fails, do not edit or select a replacement design: report the exact missing or conflicting field and persist a `BLOCKED` resolution artifact when lifecycle evidence is sufficient. Mechanical line-number adjustment is allowed only when the named symbols and required behavior still match.

Resolve only confirmed findings with their exact plan-bound instructions. For every requested original `REVIEW-NNN`, the `ima_lifecycle` resolution artifact must map it to `resolved`, `blocked`, or `not attempted`, including instructions executed, files changed, verification/result, deviations, and residual risk. If every required finding is resolved, persist one complete `resolution` artifact through `ima_lifecycle`; otherwise report the blocker. Do not start rereview automatically: `/ima:cycle resume` or `/ima:rereview` owns the explicit handoff.

When dispatched by `/ima:cycle`, finish the artifact with exactly one marker and no other cycle outcome marker:

`<!-- ima-cycle outcome: phase=resolution; outcome=RESOLVED -->`

Use `BLOCKED` instead when safe resolution is impossible:

`<!-- ima-cycle outcome: phase=resolution; outcome=BLOCKED -->`

Do not invoke `/ima:cycle` automatically. Stop after the bounded resolution result.
