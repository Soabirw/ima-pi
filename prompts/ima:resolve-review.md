---
description: Resolve approved review findings for one bounded lifecycle unit
argument-hint: "[review-and-implementation-source]"
---
You own the `resolution` phase for exactly one approved lifecycle unit. Runtime selects the configured `resolution` route before prompt expansion; this phase is MID-inherited and does not change model authority.

`$@` must supply the approved plan, implementation, test, and review evidence plus lifecycle identity. Call `ima_context` and use Serena-first evidence before changing only the exact implementation or documentation targets named by the confirmed review findings. Load `code-review` for finding structure, `ima-security-guardrails` for applicable target checks, and `functional-programmer` for pure/effect boundaries; load `ima-delegation-contract` before using `ima_delegate`. Do not reopen product scope, redesign architecture, broaden the plan, or resolve unverified findings. Keep effects at explicit boundaries, preserve security and data-integrity contracts, and use the smallest supported verification.

After `ima_context` hydration, when no resume evidence packet is already present in-session, use `ima-memory-workflow` and `ima-lifecycle-contract` to recall the latest VERIFIED Tier-1 lifecycle artifact(s) through pin-aware authority. Recover a durable pin first and use only its verified provider-native recall/get evidence; without a pin, exact Tier-1 Qdrant history across every phase establishes historical Qdrant authority. Derive `ima-pi:taskwarrior:<project>:<uuid>` for Taskwarrior or `ima-pi:jira:<KEY>` for Jira. For a Plane source, reuse a recovered lifecycle key; if no artifact establishes one, use the documented `ima-pi:plane:<workspace>:<PROJECT>-<seq>` convention rather than treating it as automatic derivation. For `lifecycle:<lifecycle-key>`, use the supplied lifecycle key directly. For `vestige:<UUID>`, retrieve only the cited memory, recover lifecycle identity when present, then use the contract's authoritative route. Never substitute a Taskwarrior or Jira probe for unavailable lifecycle corpus evidence, fall back after a pin, or declare prerequisites missing before the applicable lookup is empty or insufficient.

## Manual phase source identifiers

When `$@` is an identifier, accept these canonical colon forms with space-delimited aliases: `taskwarrior:<project>:<uuid>` (`taskwarrior <project> <uuid>`), `plane:<workspace>:<PROJECT>-<seq>` (`plane <workspace> <PROJECT>-<seq>`), `jira:<KEY>` (`jira <KEY>`), `lifecycle:<lifecycle-key>` (`lifecycle <lifecycle-key>`), and `vestige:<UUID>` (`vestige <UUID>`). Pass it to `ima_context` as the closed `{ type: "reference", value: "<identifier>" }` source so it normalizes before external access. Preserve the canonical colon form in handoff pointers. For lifecycle sources, recover the durable pin and selected direct detail through `ima-lifecycle-contract`; only without a pin, use exact Tier-1 Qdrant manifest recall plus selected direct detail to establish historical Qdrant authority. For a Plane source, reuse a recovered lifecycle key; if no artifact establishes one, use the documented `ima-pi:plane:<workspace>:<PROJECT>-<seq>` convention rather than treating it as automatic derivation. For Vestige sources, read only the cited memory then use any explicit lifecycle identity through the contract's authoritative route; neither path has a Vestige lifecycle fallback.

## Review-resolution preflight

For each requested original `REVIEW-NNN`, before editing verify that it remains retained and not withdrawn; its precise evidence, required observable outcome, decided files/symbols, required control/data/error behavior, tests and acceptance checks, and constraints/non-goals are complete; the verifier verdict is `CONFIRMED`; named files and symbols still match repository evidence; and resolution ordering/dependencies are explicit. If any condition fails, do not edit or select a replacement design: report the exact missing or conflicting field and persist a `BLOCKED` resolution artifact when lifecycle evidence is sufficient. Mechanical line-number adjustment is allowed only when the named symbols and required behavior still match.

Resolve only confirmed findings with their exact plan-bound instructions. For every requested original `REVIEW-NNN`, the `ima_lifecycle` resolution artifact must map it to `resolved`, `blocked`, or `not attempted`, including instructions executed, files changed, verification/result, deviations, and residual risk. If every required finding is resolved, persist one complete `resolution` artifact through `ima_lifecycle`; otherwise report the blocker. Do not start rereview automatically: `/ima:cycle resume` or `/ima:rereview` owns the explicit handoff.

When dispatched by `/ima:cycle`, finish the artifact with exactly one marker and no other cycle outcome marker:

`<!-- ima-cycle outcome: phase=resolution; outcome=RESOLVED -->`

Use `BLOCKED` instead when safe resolution is impossible:

`<!-- ima-cycle outcome: phase=resolution; outcome=BLOCKED -->`

Do not invoke `/ima:cycle` automatically. Stop after the bounded resolution result.
