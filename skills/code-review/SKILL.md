---
name: code-review
description: FP-aware, security-first, read-only review methodology with integration contracts, independent verification, and implementation-grade findings.
---

# Code review

Review behavior and contracts, not style preferences. Prefer one well-supported Critical finding over several hedged Warnings. Read the diff twice, then inspect callers only when a changed public symbol or integration contract requires it.

## Boundaries

- Reviewers, verifiers, and adversaries never edit, push, install tooling, or post external comments.
- The invoking phase owns source hydration, target/diff acquisition, configured non-mutating validators, and formal lifecycle persistence through `ima_lifecycle`.
- External pull-request peer review is the exception to lifecycle persistence: an externally authored PR has no IMA lifecycle unit, plan, implementation, or test artifact, so it never requires Tier-1 lifecycle recall and produces an advisory report rather than a persisted lifecycle artifact. See [Peer review of an external pull request](#peer-review-of-an-external-pull-request).
- Run only already-configured validators. Record commands and results; do not create tooling to make a review possible.
- Do not broaden the target beyond a changed public symbol, caller, subscriber, hook, route, or external contract that needs inspection.
- Route visual sources through [ima-vision-handoff](../ima-vision-handoff/SKILL.md). Do not claim visual findings from inaccessible evidence.

## Supporting skills

Use [mcp-serena](../mcp-serena/SKILL.md) for narrow symbol and reference discovery, [ima-security-guardrails](../ima-security-guardrails/SKILL.md) for applicable security checks, and [functional-programmer](../functional-programmer/SKILL.md) for pure/effect and mutation concerns. Use [ima-delegation-contract](../ima-delegation-contract/SKILL.md) for bounded independent verification or adversarial assignments. Use [readable-code](../readable-code/SKILL.md) as the canonical rule set when reviewing readability.

## Peer review of an external pull request

Use this mode for a final peer review of a Gitea or GitHub pull request authored outside the IMA lifecycle: another developer executed the story, and the only evidence is the PR plus the project space. Do not demand a plan, implementation, or test lifecycle artifact, and do not treat their absence as a missing prerequisite. Do not substitute a Tier-1 lifecycle recall, and never fabricate approved acceptance criteria.

### Target identity and read-only acquisition

Normalize the supplied PR as `{ host, owner, repo, number }` before acquiring evidence. Preserve every field in metadata and diff calls; never fall back to the current checkout's repository.

- For GitHub, use [gh-cli](../gh-cli/SKILL.md) and preserve the original PR URL in both `gh pr view <pr-url> --json title,body,author,files` and `gh pr diff <pr-url>`. When using normalized fields instead, pass `-R owner/repo` to both commands with `<number>`.
- For Gitea, use [tea-gitea](../tea-gitea/SKILL.md), map `host` to exactly one configured Tea login, and use `tea pr <n> --repo owner/repo --login <login> --fields index,title,state,author,body,diff`. If that mapping is absent or ambiguous, report the missing prerequisite and stop. Never rely on the current directory for target selection.
- Activate the project through Serena for the surrounding codebase, conventions, and callers.
- Follow the linked issue or tracker reference only for read-only intent, not as an approval.

Derive acceptance intent, since no approved criteria exist: reconstruct the change's intended behavior from the PR title, description, linked issue, and repository conventions. State each inferred expectation as an explicit assumption and flag where intent is unverifiable. Judge the diff against that inferred contract and the repository's own conventions, not against a private preference.

Apply the full four-pass methodology, independent verification, implementation-grade handoffs, and the request-changes gate unchanged. `REVIEW-NNN` IDs remain local to the advisory report because there is no lifecycle thread.

Report as advisory. Do not persist an `ima_lifecycle` artifact for externally authored work. If the operator wants the verdict posted to the PR, follow [External comments](#external-comments): draft first, show the draft, obtain explicit approval, and never silently approve, reject, or comment.

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
- Readability: Check the change against the codified [readable-code](../readable-code/SKILL.md) principles — intent-revealing names, focused single-responsibility functions, flat control flow via guard clauses/early returns, named constants over magic values, comprehensible parameter lists, pure core with effects at boundaries, and no abstraction for its own sake. Emit each concrete, rule-anchored violation as a Warning (blocking under the closeout rule), citing the specific violated principle and `file:line`. These are codified readability rules, not ad-hoc style preferences: do not raise taste-based or style-only findings. Defer numeric function-size and FP depth to `functional-programmer`. Treat a changed file that exceeds the `functional-programmer` >500-line file-size smell without a recorded cohesion-based justification as a Warning (blocking under the closeout rule); require splitting by responsibility/cohesion rather than mechanical counting. Do not impose an indentation width or a numeric nesting-depth limit.
- WordPress: nonce/capability checks, prepared queries, contextual escaping, hook signatures, asset handling, and hook-based cross-plugin contracts.
- Brand and public copy: load `ima-brand` for visible terminology; public-facing `Honest Medicine` is `Honest Medicine™` unless it is a source quote, URL, slug, identifier, filename, or historical/legal reference.

### Security data-flow inventory

For each materially changed trust boundary or sink, record the source, transformations, authorization decision, effect, and output sink. Then trace at least one realistic path from source to sink. Verify behavior in code and configured tests; a grep hit, helper name, route guard, or UI condition is not proof that the control reaches the sink.

Check applicable controls separately: validation, sanitization, authentication, authorization, CSRF protection, parameterization, contextual encoding, and secret handling. In particular, confirm that protected operations authorize the affected resource rather than relying on route access or nonce possession, and that dynamic SQL structure, paths, URLs, commands, and redirects use allowlists where placeholders cannot apply.

If evidence for a material boundary is unavailable or cannot be inspected, fail closed: report the review as blocked or retain a precisely scoped concern. Do not infer safe behavior from conventions, marker tests, or a happy-path response.

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

The verifier reads the exact range and at most one needed dependency hop, then should prefer this concise shape:

```
VERDICT: CONFIRMED|WITHDRAWN|PARTIAL
REASON: <one evidence-based sentence>
```

The parent interprets the verdict in natural language; a missing, ambiguous, or conflicting verdict remains unresolved. Missing or inaccessible evidence is `PARTIAL`; do not guess. Only `CONFIRMED` candidates become formal Critical or Warning findings. For `PARTIAL`, retain only an independently supported concern after correcting its exact claim or severity and obtaining confirmation; otherwise exclude it. `WITHDRAWN` candidates are excluded.

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

Apply this requirement equally during rereview: when rereview retains or sharpens a finding, append the same six-part corrective handoff under the preserved `REVIEW-NNN` rather than merely restating the failure without corrective instructions. An independently verified regression caused by the resolution gets the next unused ID with the same complete handoff. The prohibition on unrelated redesign must never suppress the corrective instructions a retained finding needs.

Use code or pseudocode when operation ordering, replacement logic, or data shape is material. Keep Suggestions concise and nonblocking.

## Request-changes gate

Fail closed. A `REQUEST_CHANGES` verdict is valid only when each retained Critical or Warning has a stable `REVIEW-NNN`, precise evidence, a plausible failure mode, a confirmed verifier verdict, a complete decided remediation, tests and acceptance checks, explicit constraints, and stated resolution ordering. Otherwise keep the review blocked or report a nonblocking concern; do not emit an implementation handoff.

This gate applies identically to review and rereview `REQUEST_CHANGES` verdicts.

## Adversarial reconciliation

Give both adversaries identical evidence packets and keep their reports isolated. Deduplicate overlap; retain only claims with precise evidence and plausible failure modes; independently verify a strong single-adversary claim; resolve disagreements with repository evidence; separate ugly from wrong; and list dropped claims with reasons. Dual no-findings is credible only when both document meaningful disproof attempts.

## External comments

Draft first, show the draft, and get explicit approval before posting to a PR or tracker. Never silently post or approve/reject an external review.
