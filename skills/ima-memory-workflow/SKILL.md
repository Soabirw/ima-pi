---
name: ima-memory-workflow
description: Route IMA project, lifecycle, and durable knowledge through Serena, Vestige, and Qdrant. Use when retrieving or preserving task context, preferences, decisions, plans, or reference material.
---

# IMA memory workflow

Use each memory system for its own job. Do not treat them as interchangeable scratchpads.

## Responsibilities

| System | Owns |
| --- | --- |
| Serena | Stable project instructions, standard memories, code navigation, and refactor-aware repository evidence. |
| Vestige | Task and session continuity, preferences, decisions, lifecycle state, and closeout learning. |
| Qdrant | Durable reference material: standards, PRDs, architecture records, research, and reusable knowledge. |

## Retrieve in order

For a task that needs context:

1. Hydrate the supplied source with `ima_context`; it establishes source and Serena project context.
2. Use a native `session_start` for broad context or a focused Vestige `recall` by
   lifecycle key, Taskwarrior UUID, or Jira key for prior task work and preferences.
   This direct read is the preference load; do not seek a separate helper.
   For `lifecycle:<lifecycle-key>`, recall the exact lifecycle key before concluding
   evidence is absent. For `vestige:<UUID>`, retrieve the cited memory as required
   source hydration, recover lifecycle identity when present, then recall related
   verified artifacts. For optional preference results, stop after an adequate summary.
   Retrieve a selected full memory only when its summary cannot support relevance
   validation or preference summarization. Do not apply this optional-expansion gate to
   an explicitly cited `vestige:<UUID>` source. If required cited-memory retrieval
   fails, report partial or failed evidence rather than substituting unrelated content.
   On a transient read-only transport failure (`-32000`, `Connection closed`, or
   adapter timeout), call `mcp({ connect: "vestige" })` and repeat the same read with
   identical arguments exactly once after reconnect; never retry mutations.
   Treat live current-invocation responses as authoritative over stale caches, and
   reject unrelated merged lifecycle or log content as preference evidence. Never
   replace lifecycle/Vestige recall with a Taskwarrior or Jira probe.
3. Search Qdrant only when durable reference material would change the decision or implementation.
4. Read the relevant Serena memories and navigate the smallest necessary repository surface.

Do not preload unrelated memories or broad reference corpora. State when evidence is partial, stale, or absent.

## Preserve in order

1. When the current lifecycle phase explicitly authorizes persistence, persist a formal
   plan, implementation, test, review, resolution, rereview, or closeout through
   `ima_lifecycle`. Preference persistence routes through `/ima:memorize`; formal
   lifecycle persistence remains owned by `ima_lifecycle`.
2. Every direct memory write requires explicit phase authority:
   - Preserve evolving task context and decisions in Vestige.
   - Update Serena only for concise, stable project instructions or commands that belong to project memory.
   - Store long-lived reference material in Qdrant when it should remain searchable beyond the current task.

Keep artifacts correlated with the existing lifecycle key. Do not create disconnected task threads when a matching source, plan, or lifecycle artifact already exists.

## Manual source identifiers

Manual phases accept canonical colon identifiers with space-delimited aliases: `taskwarrior:<project>:<uuid>` (`taskwarrior <project> <uuid>`), `jira:<KEY>` (`jira <KEY>`), `lifecycle:<lifecycle-key>` (`lifecycle <lifecycle-key>`), and `vestige:<UUID>` (`vestige <UUID>`). Preserve the canonical colon form in handoffs; use `ima_context`'s closed `reference` source to normalize an incoming identifier.

## Boundaries

`ima_context` owns source hydration and project bootstrap. `ima_lifecycle` owns formal lifecycle persistence and its receipt protocol. Use this skill to choose the right memory system and evidence order; do not duplicate tool-owned setup or persistence procedures.
