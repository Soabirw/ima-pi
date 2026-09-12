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
- applicable security, privacy, FP, brand, and workflow constraints; and, for boundary work,
  the relevant validation, authorization, CSRF, sink-encoding, parameterization, and fail-closed
  requirements;
- the child’s disjoint `writeScope` when it may edit; and
- blockers, risks, changed files, and verification results that must be reported back.

Never rely on parent history, sibling history, or an unstated assumption. A child brief must be self-contained and stand alone.

## Parallel and failure boundaries

Run independent assignments in parallel only when their write scopes do not overlap. Run dependent work in sequence when one result is required by the next.

If a child reports an architectural fork, scope conflict, security concern, missing evidence, unsafe partial state, or failed verification, stop and escalate it to the parent. Retry at most once with a materially improved brief. Do not blindly repeat the same assignment or treat an incomplete child result as a completed phase.

## Cycle phase hosts

A `/ima:cycle` phase host is an isolated lifecycle session owned by the cycle coordinator, not an `ima_delegate` specialist leaf. It may hydrate its source, persist its lifecycle artifact, and invoke bounded specialists under this contract. The coordinator alone accepts verified lifecycle evidence, advances cycle state, forwards literal operator replies, and retains manual tracker close authority.

Specialist children remain non-delegating leaves. When a reviewer succeeds, retain its durable opaque continuation reference in the review artifact; rereview and verified-finding follow-up must resume that eligible reviewer session through `ima_agent_follow_up`, never create a replacement reviewer. Follow-up-eligible direct-session records, cycle-owned records, and exclusive lock sidecars are local-only state. Records survive isolated phase sessions; cycle references remain owner-bound. Do not request concurrent continuations of the same session, including through different reference aliases. Report `session_follow_up_busy` without replacing the reviewer or removing a lock; operator-owned cleanup requires confirming that no live operation owns it. Profile mappings are non-secret configuration and credentials must never be persisted in briefs, records, or reports.
