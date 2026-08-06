---
name: code-review
description: FP-aware, security-first, read-only review methodology with integration contracts, independent verification, and implementation-grade findings.
---

# Code review

Review behavior and contracts, not style preferences. Prefer one well-supported Critical finding over several hedged Warnings. Read the diff twice, then inspect callers only when a changed public symbol or integration contract requires it.

## Boundaries

- Reviewers, verifiers, and adversaries never edit, push, install tooling, or post external comments.
- The invoking phase owns source hydration, target/diff acquisition, configured non-mutating validators, and formal lifecycle persistence through `ima_lifecycle`.
- Run only already-configured validators. Record commands and results; do not create tooling to make a review possible.
- Do not broaden the target beyond a changed public symbol, caller, subscriber, hook, route, or external contract that needs inspection.
- Route visual sources through [ima-vision-handoff](../ima-vision-handoff/SKILL.md). Do not claim visual findings from inaccessible evidence.

## Supporting skills

Use [mcp-serena](../mcp-serena/SKILL.md) for narrow symbol and reference discovery, [ima-security-guardrails](../ima-security-guardrails/SKILL.md) for applicable security checks, and [functional-programmer](../functional-programmer/SKILL.md) for pure/effect and mutation concerns. Use [ima-delegation-contract](../ima-delegation-contract/SKILL.md) for bounded independent verification or adversarial assignments.

## Four passes

### 1. Contract discovery

Before walking the diff line by line, identify each non-trivial changed symbol and its meaningful callers, subscribers, hooks, routes, types, ordering assumptions, and side effects. Use `mcp-serena` before broad reading. Report an Integration Contract:

```
Integration Contract
- Public symbols changed: <list>
- Callers identified: <count and key files>
- Assumptions: <types, side effects, ordering, or state>
- Diff respects assumptions: <yes|no|partial with file:line>
- Cross-file ripple risk: <low|medium|high>
```

### 2. Reviewer pass

Check the bounded change against approved acceptance criteria, the Integration Contract, and configured validator results. Cap formal findings at ten and prioritize concrete correctness, security, data integrity, integration, test adequacy, and public-copy impact. Suggestions are nonblocking.

Apply these lenses only when they match the target:

- Correctness: null/undefined behavior, missing return or error paths, ordering, races, stale state, boundaries, and rollback behavior.
- Security: input validation, authorization, secrets, injection, output handling, and framework-specific protections from `ima-security-guardrails`.
- Functional design: pure core versus effect shell, argument or shared-state mutation, explicit dependencies, and unnecessary abstraction.
- WordPress: nonce/capability checks, prepared queries, contextual escaping, hook signatures, asset handling, and hook-based cross-plugin contracts.
- Brand and public copy: load `ima-brand` for visible terminology; public-facing `Honest Medicine` is `Honest Medicine™` unless it is a source quote, URL, slug, identifier, filename, or historical/legal reference.

### 3. Independent verification

Every candidate Critical or Warning receives one fresh, narrow `review-verifier` second opinion. Dispatch independent candidates in parallel only when their briefs and ranges are disjoint. Each brief must be self-contained:

```
Candidate severity: <Critical|Warning>
Evidence range: <repo-relative file:start-end>
Finding: <one sentence>
Evidence and root cause: <specific behavior and cause>
Required outcome: <observable invariant>
Decided remediation: <exact files, symbols, control/data/error behavior>
Constraints and non-goals: <preserved behavior and prohibited alternatives>
Acceptance checks: <tests or observable checks>
```

The verifier reads the exact range and at most one needed dependency hop, then returns exactly:

```
VERDICT: CONFIRMED|WITHDRAWN|PARTIAL
REASON: <one evidence-based sentence>
```

Missing or inaccessible evidence is `PARTIAL`; do not guess. Only `CONFIRMED` candidates become formal Critical or Warning findings. For `PARTIAL`, retain only an independently supported concern after correcting its exact claim or severity and obtaining confirmation; otherwise exclude it. `WITHDRAWN` candidates are excluded.

### 4. Final report

Report Verdict, Integration Contract, Validators Run, findings by severity, Resolution Order and Dependencies, Withdrawn During Review, and Residual Risk. Assign `REVIEW-NNN` only after independent confirmation. Visual findings cite the URL or route, viewport, state, selector or component when known, and supplied visual-source identity.

## Findings are implementation handoffs

A retained Critical or Warning must let a lower-capability implementation agent act without redesigning. “Consider,” “possibly,” “handle appropriately,” and “refactor as needed” are not remediation instructions.

For each retained finding provide:

1. location, failing behavior, root cause, and affected contract or callers;
2. required observable outcome;
3. exact files, symbols, signature or data-shape changes, and control/data/error behavior;
4. tests and acceptance checks;
5. constraints, non-goals, and material rejected alternatives; and
6. verifier verdict and reason.

Use code or pseudocode when operation ordering, replacement logic, or data shape is material. Keep Suggestions concise and nonblocking.

## Request-changes gate

Fail closed. A `REQUEST_CHANGES` verdict is valid only when each retained Critical or Warning has a stable `REVIEW-NNN`, precise evidence, a plausible failure mode, a confirmed verifier verdict, a complete decided remediation, tests and acceptance checks, explicit constraints, and stated resolution ordering. Otherwise keep the review blocked or report a nonblocking concern; do not emit an implementation handoff.

## Adversarial reconciliation

Give both adversaries identical evidence packets and keep their reports isolated. Deduplicate overlap; retain only claims with precise evidence and plausible failure modes; independently verify a strong single-adversary claim; resolve disagreements with repository evidence; separate ugly from wrong; and list dropped claims with reasons. Dual no-findings is credible only when both document meaningful disproof attempts.

## External comments

Draft first, show the draft, and get explicit approval before posting to a PR or tracker. Never silently post or approve/reject an external review.
