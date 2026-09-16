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
| `ima_lifecycle`, `ima_lifecycle_recall`, and `ima_lifecycle_get` with a durable pin | Formal lifecycle persistence and exact retrieval through exactly one of BookStack, Qdrant, Serena, or Markdown. |
| Tier-1 Qdrant | Institutional detail, standards, PRDs, architecture records, research, and reusable knowledge; unpinned historical lifecycle authority is reached only through the public lifecycle read pair. |

## Retrieve in order

1. Hydrate the supplied source with `ima_context`; it establishes source and Serena project context.
2. Routine user preferences are already present through Pi's active global `AGENTS.md` when context files are enabled. Do not call Vestige `session_start` or broad `recall` for routine preference bootstrap. For a preference update, use `/ima:memorize` and `ima-preferences`; it resolves the active global file, performs exact preview and approval, and verifies one native file change.
3. For lifecycle evidence, load `ima-lifecycle-contract` and use its public pin-aware read pair, never Vestige:
   - normalize the source with `ima_context`, then call `ima_lifecycle_recall` for the exact lifecycle key and a bounded selection;
   - treat every returned descriptor as a selector only. Pass each required descriptor unchanged to `ima_lifecycle_get`. Its selected direct retrieval verifies its lifecycle key, phase, source identity and completion marker, returned `artifactId`, logical `recordKey`, content hash, read reference, and the phase-specific prerequisite before accepting an artifact;
   - the pair derives the checkout-local pin. When pinned, it uses only that provider's verified route; only while genuinely unpinned does it use exact all-phase historical Qdrant authority. Both guided and autonomous phases neither select a provider nor query Qdrant as fallback or mix evidence;
   - a pending, inaccessible, unavailable, incomplete or overflowed, corrupt, mismatched, unverifiable, or cancelled read is `BLOCKED`; do not retry, fall back, migrate, switch providers, or mix history. Autonomous storage flow pauses for explicit user consent only when the first unpinned, organization-visible BookStack placement lacks it. Consent does not pin; only verified persistence plus provider-native direct read-back does.
   - for pinned evidence, verify `P` as the provider-pin anchor, derive original-plan root `R` and stable source identity `S` only from its complete record, then accept only records with exact R/S. Only the original `plan` may be rootless; a rootless non-plan P blocks unchanged. Never infer R from ordering, a receipt, tracker data, or `priorArtifactIds`.

   Derive `ima-pi:taskwarrior:<project>:<uuid>` for a Taskwarrior source and `ima-pi:jira:<KEY>` for a Jira source. For a Plane source, reuse a recovered lifecycle key; if no artifact establishes one, use the documented `ima-pi:plane:<workspace>:<PROJECT>-<seq>` convention rather than treating it as automatic derivation. For `lifecycle:<lifecycle-key>`, use the supplied key. For a cited `vestige:<UUID>`, retrieve only that cited legacy memory and recover a lifecycle identity only when it explicitly contains one. Do not substitute a Taskwarrior or Jira probe for unavailable authoritative lifecycle evidence, and do not use Vestige as a lifecycle fallback.
4. Use `ima_corpus_find` only when bounded institutional reference material would change the decision or implementation. `ima_corpus_recall` returns corpus manifest summaries only; complete institutional detail requires selected direct `ima_corpus_get`. Formal lifecycle evidence—including unpinned historical Qdrant authority—uses `ima_lifecycle_recall` followed by selected `ima_lifecycle_get`, never `ima_corpus_*`, provider-native reads, or package MCP discovery.
5. Read the relevant Serena memories and navigate the smallest necessary repository surface.

State when evidence is partial, stale, or absent.

## Preserve in order

1. When the current lifecycle phase explicitly authorizes persistence, persist a formal plan, implementation, test, review, resolution, rereview, document, decision, or closeout through `ima_lifecycle`. Documentation uses canonical type `document`; terminal human-authorized work remains separate type `closeout`. It requires an explicit one-line `summary`, applies historical authority or the contract's recommendation before the first pin and the durable pin thereafter, and completes only after provider-native direct verification. Only the original `plan` may be rootless; a non-plan first write needs explicit R/S and is rejected before provider effect when rootless. Once P is verified, every later artifact preserves exact R/S; approval receipts never replace the original root. Explicit user consent is required only for the first unpinned, organization-visible BookStack placement; once a pin is verified, later persistence has no provider-selection or placement-confirmation prompt. Do not bypass it with direct storage, provider selection, or a Vestige fallback.
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

`ima_context` owns source hydration and project bootstrap. `ima-lifecycle-contract` owns first-use
BookStack consent, provider and placement rules, historical-Qdrant authority, durable pins, P/R/S
lineage, and fail-closed evidence order; `ima_lifecycle` owns formal persistence, while
`ima_lifecycle_recall` and `ima_lifecycle_get` own formal lifecycle reads and complete direct
verification through that authority. Neither this workflow nor a phase prompt selects or approves a
provider, derives/replaces roots, repairs pins, or repeats a storage approval after a verified pin.
Pi's global `AGENTS.md` owns routine current preferences; Tier-1 Qdrant remains institutional
knowledge rather than an unconditional lifecycle backend; Vestige remains a bounded cited-legacy and
migration source, never a routine preference bootstrap or lifecycle fallback. Use this skill to
select the right memory system and evidence order; do not duplicate tool-owned setup, read, or
persistence procedures.
