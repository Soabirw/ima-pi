---
name: ima-delegation-contract
description: Delegate bounded IMA repository work through ima_delegate with complete briefs, clear authority, and safe integration. Use when a focused specialist can independently explore, implement, test, review, document, or inspect visual evidence.
---

# IMA delegation contract

The parent owns the outcome and integration. A child owns only the bounded assignment in its brief.

## When to delegate

Use `ima_delegate` only when work is separable, independently verifiable, and cheaper or clearer for a specialist. Do not spawn a child that duplicates the parent’s current responsibility. Delegate one to four bounded assignments at a time.

Keep architecture choices, approval gates, lifecycle transitions, and integration decisions in the parent session. Use the configured agent only for work within its declared authority.

## Complete brief

Every assignment must state:

- the goal and exact expected report;
- the approved plan or other source evidence the child needs;
- relevant paths, symbols, acceptance criteria, and non-goals;
- whether the assignment is read-only, test-only, documentation-only, or allowed to write;
- applicable security, privacy, FP, brand, and workflow constraints;
- the child’s disjoint `writeScope` when it may edit; and
- blockers, risks, changed files, and verification results that must be reported back.

Never rely on parent history, sibling history, or an unstated assumption. A child brief must be self-contained and stand alone.

## Parallel and failure boundaries

Run independent assignments in parallel only when their write scopes do not overlap. Run dependent work in sequence when one result is required by the next.

If a child reports an architectural fork, scope conflict, security concern, missing evidence, unsafe partial state, or failed verification, stop and escalate it to the parent. Retry at most once with a materially improved brief. Do not blindly repeat the same assignment or treat an incomplete child result as a completed phase.
