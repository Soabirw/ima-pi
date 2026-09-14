---
name: ima-memory-workflow
description: Route IMA project, pin-aware lifecycle evidence, preferences, and durable knowledge through Pi, Serena, Vestige, and Qdrant.
---

# IMA memory workflow

Use each memory system for its own job. Do not treat them as interchangeable scratchpads.

## Responsibilities

| System | Owns |
| --- | --- |
| Pi global `AGENTS.md` | Current cross-project user preferences and explicit user decisions. |
| Serena | Stable project instructions, standard memories, code navigation, and refactor-aware repository evidence. |
| Vestige | Explicitly cited legacy evidence and the separate T7 migration source only. |
| `ima_lifecycle` with its durable pin | Formal lifecycle persistence and retrieval through exactly one of BookStack, Qdrant, Serena, or Markdown. |
| Tier-1 Qdrant | Institutional detail, standards, PRDs, architecture records, research, reusable knowledge, and unpinned historical lifecycle authority only. |

## Retrieve in order

1. Hydrate the supplied source with `ima_context`; it establishes source and Serena project context.
2. Routine user preferences are already present through Pi's active global `AGENTS.md` when context files are enabled. Do not call Vestige `session_start` or broad `recall` for routine preference bootstrap. For a preference update, use `/ima:memorize` and `ima-preferences`; it resolves the active global file, performs exact preview and approval, and verifies one native file change.
3. For lifecycle evidence, load `ima-lifecycle-contract` and use its pin-aware route, never Vestige:
   - normalize the source with `ima_context`, then recover the checkout-local pin for that lifecycle key;
   - when pinned, accept only that provider's direct verified recall/get/reconcile evidence and preserve its `artifactId`, `recordKey`, and provider-native reference; never query Qdrant as fallback or mix providers;
   - when unpinned, exact bounded Tier-1 Qdrant recall across all phases decides historical authority. A verified hit requires Qdrant; a verified empty result may proceed to the user-confirmed provider-selection path. Only a provider result proven `no-write` permits pre-pin reevaluation; possible or unknown writes block;
   - Direct retrieval verifies its lifecycle key, phase, nonce, source identity, completion marker, returned record identity, logical `recordKey`, and provider-native reference before accepting an artifact.

   Derive `ima-pi:taskwarrior:<project>:<uuid>` for a Taskwarrior source and `ima-pi:jira:<KEY>` for a Jira source. For a Plane source, reuse a recovered lifecycle key; if no artifact establishes one, use the documented `ima-pi:plane:<workspace>:<PROJECT>-<seq>` convention rather than treating it as automatic derivation. For `lifecycle:<lifecycle-key>`, use the supplied key. For a cited `vestige:<UUID>`, retrieve only that cited legacy memory and recover a lifecycle identity only when it explicitly contains one. Do not substitute a Taskwarrior or Jira probe for unavailable authoritative lifecycle evidence, and do not use Vestige as a lifecycle fallback.
4. Use `ima_corpus_find` only when bounded durable reference material would change the decision or implementation. `ima_corpus_recall` returns manifest summaries only; complete detail requires selected direct `ima_corpus_get`. Those Qdrant-native tools are limited to institutional knowledge or the contract's unpinned historical-Qdrant check, never fallback for a pinned provider; do not discover or invoke Qdrant through package MCP.
5. Read the relevant Serena memories and navigate the smallest necessary repository surface.

State when evidence is partial, stale, or absent.

## Preserve in order

1. When the current lifecycle phase explicitly authorizes persistence, persist a formal plan, implementation, test, review, resolution, rereview, document, decision, or closeout through `ima_lifecycle`. Documentation uses canonical type `document`; terminal human-authorized work remains separate type `closeout`. It requires an explicit one-line `summary`, applies the user-confirmed or historically authoritative provider and durable pin, and completes only after provider-native direct verification. Do not bypass it with direct storage, provider selection, or a Vestige fallback.
2. Current preference persistence routes through `/ima:memorize`, which owns active-global-`AGENTS.md` preview, approval, one native update, and verification. T7 alone owns any Vestige-to-Markdown migration work.
3. Update Serena only for concise, stable project instructions or commands that belong to project memory. Use `ima_corpus_store` for an explicitly authorized non-lifecycle institutional record.

Keep artifacts correlated with the existing lifecycle key. Do not create disconnected task threads when matching source, plan, or lifecycle evidence exists.

## Manual source identifiers

Manual phases accept canonical colon identifiers with space-delimited aliases:
`taskwarrior:<project>:<uuid>` (`taskwarrior <project> <uuid>`),
`plane:<workspace>:<PROJECT>-<seq>` (`plane <workspace> <PROJECT>-<seq>`),
`jira:<KEY>` (`jira <KEY>`), `lifecycle:<lifecycle-key>` (`lifecycle <lifecycle-key>`), and
`vestige:<UUID>` (`vestige <UUID>`). Preserve the canonical colon form in handoffs; use
`ima_context`'s closed `reference` source to normalize an incoming identifier.

## Boundaries

`ima_context` owns source hydration and project bootstrap. `ima-lifecycle-contract` owns lifecycle
provider selection rules, historical-Qdrant authority, durable pins, and fail-closed evidence order;
`ima_lifecycle` owns formal persistence and direct verification through that authority. Pi's global
`AGENTS.md` owns routine current preferences; Tier-1 Qdrant remains institutional knowledge rather
than an unconditional lifecycle backend; Vestige remains a bounded cited-legacy and migration source,
never a routine preference bootstrap or lifecycle fallback. Use this skill to select the right memory
system and evidence order; do not duplicate tool-owned setup or persistence procedures.
