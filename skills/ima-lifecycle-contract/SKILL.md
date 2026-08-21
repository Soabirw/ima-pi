---
name: ima-lifecycle-contract
description: IMA lifecycle phase handoff and persistence contract; use when producing or saving a plan, implementation, test, review, resolution, rereview, or closeout artifact.
---

# IMA lifecycle contract

Use this skill for formal lifecycle artifacts and handoffs. The persisted artifact is the detailed source of truth; a next-phase prompt is only a compact pointer to it.

## Prior artifacts and identity

Before phase work, search for prior lifecycle artifacts and reuse the existing identity. Reuse correlation evidence in this order:

1. existing `lifecycle_key`;
2. Taskwarrior project plus UUID;
3. Jira key;
4. existing lifecycle plan or root artifact ID;
5. source issue or task ID; or
6. a manual project, story slug, and stable date suffix.

Do not create a disconnected lifecycle thread when prior evidence exists.

## Manual source identifiers

Manual phase handoffs use canonical colon identifiers, with space-delimited aliases accepted only as input: `taskwarrior:<project>:<uuid>` (`taskwarrior <project> <uuid>`), `jira:<KEY>` (`jira <KEY>`), `lifecycle:<lifecycle-key>` (`lifecycle <lifecycle-key>`), and `vestige:<UUID>` (`vestige <UUID>`). Pass an identifier to `ima_context` as its closed `reference` source, then preserve the canonical colon form across handoffs instead of replacing it with a raw key. For lifecycle or Vestige sources, use Vestige recall or memory evidence before declaring prerequisites absent; never substitute a Taskwarrior or Jira probe.

## `ima_lifecycle` identity

Pass `ima_lifecycle.identity` this unwrapped camelCase object. Use empty strings or arrays rather than invented values; pass the lifecycle phase separately as `type`.

```json
{
  "project": "",
  "lifecycleKey": "",
  "lifecycleRootMemoryId": "",
  "taskwarriorProject": "",
  "taskwarriorTask": "",
  "taskwarriorUuid": "",
  "jiraKey": "",
  "sourceRefs": [],
  "priorArtifactIds": []
}
```

Do not pass a `lifecycle:` wrapper or snake_case keys as the tool identity.

## Persisted artifact metadata

`ima_lifecycle` writes the persisted artifact metadata below; it is not the `identity` input shape:

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
  phase: "plan|implementation|test|review|resolution|rereview|closeout"
  prior_artifact_ids: []
```

## Persist and hand off

Persist lifecycle artifacts through `ima_lifecycle`; do not substitute a generated SDK namespace, direct service storage, or an undocumented fallback. `ima_lifecycle` persists directly through Vestige MCP and retains its receipt-plus-nonce semantic-recall verification; callers must not bypass it.

A complete artifact includes the approved outcome, scope and non-goals, phase result, changed/reviewed/tested files, decisions, verification commands and results, blockers, residual risk, prior artifact IDs, and the recommended next phase. These sections are recommended rather than required headings: equivalent organization is accepted, and persistence requires only a non-empty bounded artifact with valid lifecycle identity.

When a concrete next phase is appropriate, emit a compact pointer containing only the next command, one-line outcome, lifecycle key, and latest artifact reference. Do not duplicate the detailed artifact or prescribe the destination phase's work.

## Cycle outcome marker

When `/ima:cycle` dispatched the phase, end the artifact with exactly one cycle outcome marker for the current phase. Do not include any other cycle outcome marker.

```html
<!-- ima-cycle outcome: phase=<phase>; outcome=<outcome> -->
```

Use the phase's approved terminal outcome or `BLOCKED` when safe completion is impossible. Persist only meaningful completed or blocked phase results; never treat an unpersisted result as complete.
