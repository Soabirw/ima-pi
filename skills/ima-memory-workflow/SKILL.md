---
name: ima-memory-workflow
description: Route IMA project, lifecycle, preferences, and durable knowledge through Serena, Vestige, and Qdrant.
---

# IMA memory workflow

Use each memory system for its own job. Do not treat them as interchangeable scratchpads.

## Responsibilities

| System | Owns |
| --- | --- |
| Serena | Stable project instructions, standard memories, code navigation, and refactor-aware repository evidence. |
| Vestige | Bounded user preferences and explicit preference decisions only. |
| Tier-1 Qdrant | Formal lifecycle artifacts, institutional detail, standards, PRDs, architecture records, research, and reusable knowledge. |

## Retrieve in order

1. Hydrate the supplied source with `ima_context`; it establishes source and Serena project
   context.
2. When preference context is relevant, use one native Vestige `session_start` for broad context
   or one focused `recall` for the exact preference topic. This is the preference load. Accept
   only live, explicit, topic-relevant preference/decision evidence; reject unrelated lifecycle
   or log content. Retrieve `vestige_memory` `{ action: "get", id }` only for a selected
   insufficient summary. On a transient read-only `-32000`, `Connection closed`, or adapter
   timeout, reconnect with `mcp({ connect: "vestige" })` and repeat the identical read once.
   Never retry a mutation.
3. For lifecycle evidence, use package-native Tier-1 Qdrant tools, never Vestige:
   - `ima_corpus_recall` with the exact lifecycle key returns bounded manifest summaries only;
   - prefer a selected summary's logical `recordKey` for `ima_corpus_get` when complete detail is
     required; a known manifest `artifactId` point UUID is also accepted through that compatible
     `recordKey` argument;
   - accept an artifact only after full direct retrieval verifies its lifecycle key, phase, nonce,
     source identity, completion marker, and the returned record's identity plus logical
     `recordKey`.

   Derive `ima-pi:taskwarrior:<project>:<uuid>` for a Taskwarrior source and
   `ima-pi:jira:<KEY>` for a Jira source. For `lifecycle:<lifecycle-key>`, use the supplied key.
   For a cited `vestige:<UUID>`, retrieve that cited preference memory as source evidence, recover
   a lifecycle identity only when it explicitly contains one, then recall related Qdrant lifecycle
   manifests. Do not substitute a Taskwarrior or Jira probe for unavailable lifecycle evidence.
4. Use `ima_corpus_find` only when bounded durable reference material would change the decision or
   implementation. Do not discover or invoke Qdrant through package MCP.
5. Read the relevant Serena memories and navigate the smallest necessary repository surface.

Do not preload unrelated memories or broad reference corpora. State when evidence is partial,
stale, or absent.

## Preserve in order

1. When the current lifecycle phase explicitly authorizes persistence, persist a formal plan,
   implementation, test, review, resolution, rereview, decision, or closeout through
   `ima_lifecycle`. It requires an explicit one-line `summary`, writes a Qdrant manifest plus
   deterministic vectorless detail chunks, and completes only after direct reassembly/read-back.
   Do not bypass it with direct storage or a Vestige fallback.
2. Preference persistence routes through `/ima:memorize`, which owns approval and verification.
3. Update Serena only for concise, stable project instructions or commands that belong to project
   memory. Use `ima_corpus_store` for an explicitly authorized non-lifecycle institutional record.

Keep artifacts correlated with the existing lifecycle key. Do not create disconnected task threads
when matching source, plan, or lifecycle evidence exists.

## Manual source identifiers

Manual phases accept canonical colon identifiers with space-delimited aliases:
`taskwarrior:<project>:<uuid>` (`taskwarrior <project> <uuid>`), `jira:<KEY>` (`jira <KEY>`),
`lifecycle:<lifecycle-key>` (`lifecycle <lifecycle-key>`), and `vestige:<UUID>`
(`vestige <UUID>`). Preserve the canonical colon form in handoffs; use `ima_context`'s closed
`reference` source to normalize an incoming identifier.

## Boundaries

`ima_context` owns source hydration and project bootstrap. `ima_lifecycle` owns formal lifecycle
persistence and corpus receipt/direct-reassembly verification. Use this skill to select the right
memory system and evidence order; do not duplicate tool-owned setup or persistence procedures.
