---
name: ima-lifecycle-contract
description: IMA lifecycle phase handoff and Qdrant persistence contract; use when producing or saving a plan, implementation, test, review, resolution, rereview, document, or closeout artifact.
---

# IMA lifecycle contract

Use this skill for formal lifecycle artifacts and handoffs. The persisted artifact is the detailed source of truth; a next-phase prompt is only a compact pointer to it.

## Prior artifacts and identity

Before phase work, search for prior lifecycle artifacts in the Tier-1 Qdrant corpus and reuse the
existing identity. Reuse correlation evidence in this order:

1. existing `lifecycle_key`;
2. Taskwarrior project plus UUID;
3. Jira key;
4. existing lifecycle plan or root artifact ID;
5. source issue or task ID; or
6. a manual project, story slug, and stable date suffix.

Do not create a disconnected lifecycle thread when prior evidence exists.

## Manual source identifiers

Manual phase handoffs use canonical colon identifiers, with space-delimited aliases accepted only
as input: `taskwarrior:<project>:<uuid>` (`taskwarrior <project> <uuid>`),
`plane:<workspace>:<PROJECT>-<seq>` (`plane <workspace> <PROJECT>-<seq>`), `jira:<KEY>`
(`jira <KEY>`), `lifecycle:<lifecycle-key>` (`lifecycle <lifecycle-key>`), and
`vestige:<UUID>` (`vestige <UUID>`). Pass an identifier to `ima_context` as its closed `reference`
source, then preserve the canonical colon form across handoffs instead of replacing it with a raw
key.

For a lifecycle source, recall the exact Qdrant lifecycle key and directly fetch selected detail
before declaring prerequisites absent. For a Plane source, reuse a verified existing lifecycle key;
if no evidence establishes one, use the documented `ima-pi:plane:<workspace>:<PROJECT>-<seq>`
convention rather than treating it as automatic derivation. For a Vestige source, retrieve only the
cited memory, recover an explicitly present lifecycle identity, then recall related Qdrant evidence;
never use Vestige as a lifecycle fallback or substitute a Taskwarrior/Jira probe for corpus evidence.

## `ima_lifecycle` input

Pass `ima_lifecycle.identity` as this unwrapped camelCase object. Use empty strings or arrays
rather than invented values; pass phase separately as `type`.

```json
{
  "type": "plan|implementation|test|review|resolution|rereview|document|decision|closeout",
  "identity": {
    "project": "",
    "lifecycleKey": "",
    "lifecycleRootMemoryId": "",
    "taskwarriorProject": "",
    "taskwarriorTask": "",
    "taskwarriorUuid": "",
    "jiraKey": "",
    "planeWorkspace": "",
    "planeWorkItem": "",
    "sourceRefs": [],
    "priorArtifactIds": []
  },
  "summary": "Required approved one-line phase outcome; at most 2,000 UTF-8 bytes.",
  "artifact": "Complete detailed artifact."
}
```

Do not pass a `lifecycle:` wrapper or snake_case keys as the tool identity. `planeWorkspace` and
`planeWorkItem` are optional as a pair: omit both, or send both empty, for a non-Plane identity; for
a Plane identity, send both nonempty values. A partial pair is invalid. `summary` is explicit,
non-empty, control-character-safe, and used for manifest-only semantic retrieval; do not extract it
mechanically from the artifact.

## Persisted artifact metadata

`ima_lifecycle` serializes the artifact metadata below. It is not the `identity` input shape.

```yaml
lifecycle:
  project: ""
  lifecycle_key: ""
  lifecycle_root_memory_id: ""
  taskwarrior_project: ""
  taskwarrior_task: ""
  taskwarrior_uuid: ""
  jira_key: ""
  source_refs: []
  phase: "plan|implementation|test|review|resolution|rereview|document|closeout"
  prior_artifact_ids: []
```

For a complete Plane identity, the serialized metadata additionally contains both fields:

```yaml
  plane_workspace: "<workspace>"
  plane_work_item: "<PROJECT>-<seq>"
```

Neither field is emitted for an omitted or empty pair.

## Persist and hand off

Persist lifecycle artifacts through `ima_lifecycle`; do not substitute a generated SDK namespace,
direct service storage, or an undocumented fallback. It stores deterministic Qdrant schema-v2
manifest/detail chunks in chunks-first, manifest-last order, then directly reassembles and verifies
the full detail, nonce, phase, completed outcome, lifecycle key, and required source identity.
`artifactId` is the deterministic Qdrant manifest point ID; `recordKey` is the canonical logical
retrieval key. Both are additive lifecycle-result references, and `ima_corpus_get` accepts either
value through its compatible `recordKey` argument. No Vestige lifecycle write, recall, or fallback
is permitted.

A complete artifact includes the approved outcome, scope and non-goals, phase result,
changed/reviewed/tested files, decisions, verification commands and results, blockers, residual
risk, both references for every relevant prior artifact, and the recommended next phase.

Unresolved security findings are not style-only debt: record them as blockers or route them through
resolution and rereview before closeout. A closeout cannot claim completion while a Critical or
Warning security finding remains unresolved.
`priorArtifactIds` remains point-ID-only; handoffs list logical keys separately as
`priorArtifactRecordKeys`. Equivalent organization is accepted; the artifact must remain bounded
and lossless.

When a concrete next phase is appropriate, emit a compact pointer containing only the next command,
one-line outcome, lifecycle key, and the latest `artifactId` plus `recordKey`. Do not duplicate the
detailed artifact or prescribe the destination phase's work.

## Document and closeout boundary

Persist documentation and learning evidence with lifecycle type `document`; human-authorized terminal work uses the separate `closeout` type. Manual and `/ima:soft-cycle` non-plan artifacts state their approved outcome explicitly in their summary and detail and do not add an `ima-cycle` marker. Storage verification and direct read-back do not by themselves establish a document `READY` outcome.

## Cycle outcome marker

When `/ima:cycle` dispatched the phase, end the artifact with exactly one cycle outcome marker for
the current phase. Do not include any other cycle outcome marker.

```html
<!-- ima-cycle outcome: phase=<phase>; outcome=<outcome> -->
```

Use the phase's approved terminal outcome or `BLOCKED` when safe completion is impossible. Persist
only meaningful completed or blocked phase results; never treat an unpersisted result as complete.

## Manual-plan reuse

A manually approved `plan` artifact also ends with exactly one canonical plan outcome marker. That marker makes the immutable, verified plan eligible for `/ima:cycle` adoption; it does not start a cycle, alter its mode, or grant autonomous authority.

For an older verified plan with no plan outcome marker, cycle may obtain one explicit TUI confirmation of the exact artifact. It persists a small `plan` approval artifact with one strict versioned `ima-plan-approval` JSON reference to the original artifact ID, logical record key, and content hash, plus `plan=APPROVED`. The approval artifact must reference—not embed—the original serialized plan, and confirmation references never chain.

When cycle evidence identifies an `approvedPlan` original contract separately from its approval artifact, downstream phases retain both artifact IDs and logical record keys. Before implementation, directly retrieve and verify the original contract; an approval receipt alone is not an implementation-grade plan.
