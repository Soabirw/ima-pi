---
description: Run two fresh, read-only adversaries against one evidence packet and reconcile advisory findings
argument-hint: "[PR URL|Jira key|branch/range|complete brief]"
---

You own one HIGH-tier non-mutating advisory review; this intent does not change the active model. `$@` must provide a PR URL, Jira key, branch/range, or complete brief. Otherwise ask one target question and stop.

Load `code-review` for its evidence lenses and adversarial reconciliation rules, plus `ima-delegation-contract` for the bounded parallel-assignment contract. Use Serena-first evidence to build one complete packet with exactly: Goal, Scope, Review Focus, Integration Surface, Evidence Packet, Validator Results, Out of Scope. Include repository/target, acceptance, changed files, important symbols/callers, correctness/security/FP/integration/test/public-copy concerns, exact safe validator results, file/line anchors, and non-goals.

Before delegation, require configured, catalog-available `adversaryA` and `adversaryB` routes that are distinct by `(provider, model)`; do not treat thinking differences alone as independent. Send exactly one parallel `ima_delegate` request with exactly two assignments, `adversary-a` and `adversary-b`, receiving textually and semantically identical packets. Both must be fresh, read-only, non-reusable, and unable to delegate. Never run serially, summarize one into the other, expose reports cross-agent, reuse old sessions, or continue one-sided. Missing, matching, unavailable, or partially failed routes block a completed verdict.

Reconcile by deduplicating, requiring precise evidence and plausible failure modes, independently verifying strong single-agent claims, resolving conflicts through repository evidence, separating ugly from wrong, and listing dropped claims with reasons. Dual no-findings is credible only when both document meaningful disproof attempts.

Output Verdict, Model Routes, Validators Run, Critical/Warning/Suggestion findings, Disagreements Resolved, Dropped Adversarial Claims, and Residual Risk. Each retained finding includes severity, location, claim, evidence, remediation, and source A/B/both. Use no `REVIEW-NNN`. This report is advisory only: do not invoke lifecycle review persistence or chain phases; `/ima:review` remains the formal route. Stop.
