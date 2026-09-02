---
description: Run an independent product-read-only review with verified findings
argument-hint: "[lifecycle evidence or external PR]"
---
You own one terminal HIGH-tier **review** phase. Runtime selects the configured `review` route before expansion. This prompt has two mutually exclusive source paths: formal lifecycle review and advisory external pull-request review. Do not cross their effect boundaries.

## Source classifier

Classify `$@` before any lifecycle operation:

- An external pull request is a Gitea or GitHub PR URL, or `gitea <owner>/<repo>#<n>` / `github <owner>/<repo>#<n>`.
- A formal lifecycle source supplies approved plan, implementation, test evidence, and lifecycle identity.

If `$@` matches neither form, ask for one valid source and stop.

## External pull-request peer review

For an external PR, do not enter the formal lifecycle section. Activate Serena for project conventions and surrounding code, then follow the `code-review` **Peer review of an external pull request** section to normalize the supplied target, acquire its exact metadata and diff read-only through `tea-gitea` or `gh-cli`, and reconstruct acceptance intent as explicit assumptions.

Apply the full four-pass methodology, independent verification, implementation-grade handoffs, and request-changes gate. Emit an advisory report with report-local `REVIEW-NNN` IDs. If the operator requests PR posting, draft the comment, show it, and obtain explicit approval before posting.

Do not call `ima_context`, recall Tier-1 lifecycle artifacts, emit a cycle marker, or call `ima_lifecycle` for this branch. Stop after the advisory report, or after reporting a missing external-PR prerequisite.

## Formal lifecycle review

For a formal lifecycle source, `$@` must supply approved plan, implementation, test evidence, and lifecycle identity. Call `ima_context` and use Serena-first evidence.

After hydration, when no resume evidence packet is already present in-session, use `ima-memory-workflow` to recall the latest VERIFIED Tier-1 lifecycle artifact(s): derive `ima-pi:taskwarrior:<project>:<uuid>` for Taskwarrior or `ima-pi:jira:<KEY>` for Jira. For a Plane source, reuse a recovered lifecycle key; if no artifact establishes one, use the documented `ima-pi:plane:<workspace>:<PROJECT>-<seq>` convention rather than treating it as automatic derivation. For `lifecycle:<lifecycle-key>`, use the supplied key directly. For `vestige:<UUID>`, retrieve only the cited memory, recover lifecycle identity when present, then recall related Qdrant manifest/direct-detail evidence. Never substitute a Taskwarrior or Jira probe for unavailable lifecycle corpus evidence; declare prerequisites missing only after the applicable lookup is empty or insufficient.

### Manual phase source identifiers

When `$@` is an identifier, accept these canonical colon forms with space-delimited aliases: `taskwarrior:<project>:<uuid>` (`taskwarrior <project> <uuid>`), `plane:<workspace>:<PROJECT>-<seq>` (`plane <workspace> <PROJECT>-<seq>`), `jira:<KEY>` (`jira <KEY>`), `lifecycle:<lifecycle-key>` (`lifecycle <lifecycle-key>`), and `vestige:<UUID>` (`vestige <UUID>`). Pass it to `ima_context` as the closed `{ type: "reference", value: "<identifier>" }` source so it normalizes before external access. Preserve the canonical colon form in handoffs. For lifecycle sources, use exact Tier-1 Qdrant manifest recall plus selected direct detail. For a Plane source, reuse a recovered lifecycle key; if no artifact establishes one, use the documented `ima-pi:plane:<workspace>:<PROJECT>-<seq>` convention rather than treating it as automatic derivation. For Vestige sources, read only the cited memory then use any explicit lifecycle identity to recall Qdrant; neither path has a Vestige lifecycle fallback.

The invoking session acquires the target/diff and runs only configured non-mutating validators; the fresh, product-read-only `reviewer` session inspects candidates without stable IDs. Before line-by-line review, establish the `code-review` Integration Contract for changed public symbols and affected callers. Every Critical or Warning candidate requires a separate fresh `review-verifier` second opinion, each limited to one exact range and claim with a self-contained evidence/remediation brief. Prefer configured `reviewVerify`; when absent, visibly use fresh-HIGH fallback. Retain only `CONFIRMED` findings; retain independently supported concern for `PARTIAL` only after correction and confirmation; withdraw unsupported candidates. Apply the `code-review` request-changes gate: assign `REVIEW-NNN` only after verification and never emit `REQUEST_CHANGES` unless each retained finding has decided files/symbols, control/data/error behavior, tests, acceptance checks, constraints, and resolution order.

Route supplied visual sources through `vision-handoff`. UI findings must cite URL/route, viewport, state, selector/component when known, and screenshot or visual source identity as applicable. Never fix code or publish unverified Critical/Warning findings.

When dispatched by `/ima:cycle`, finish the formal review artifact with exactly one marker: `<!-- ima-cycle outcome: phase=review; outcome=APPROVED -->`; use `REQUEST_CHANGES` or `BLOCKED` when appropriate. Persist a complete `review` artifact through `ima_lifecycle` and stop. Do not invoke `/ima:cycle` or automatic progression.
