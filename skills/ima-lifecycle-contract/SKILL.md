---
name: ima-lifecycle-contract
description: IMA lifecycle phase handoff and pin-aware persistence contract; use when producing or saving a plan, implementation, test, review, resolution, rereview, document, or closeout artifact.
---

# IMA lifecycle contract

Use this skill for formal lifecycle artifacts and handoffs. The persisted artifact is the detailed source of truth; a next-phase prompt is only a compact pointer to it.

## Pin-aware lifecycle authority

This skill is the operational authority for formal lifecycle evidence. Normalize the supplied source
through `ima_context` before lifecycle work. Do not choose a provider, call provider-native lifecycle
storage, or use Qdrant as a generic lifecycle fallback from a phase prompt.

The provider set is exactly **BookStack**, **Qdrant**, **Serena**, and **Markdown**. For an unpinned
lifecycle, `ima_lifecycle` applies the package preference recommendation (default priority:
BookStack, Qdrant, Serena, Markdown). Only the first unpinned, organization-visible BookStack
placement requires explicit user consent. Phase prompts must neither infer nor auto-approve that
consent, which authorizes that first-use placement only and does not establish a pin. `ima_lifecycle`
owns provider and placement decisions; phase prompts do not select a provider.

A checkout-local durable pin is established only after the selected provider persists the first
immutable artifact and provider-native direct read-back verifies it. Before that point, exact bounded
Tier-1 Qdrant history across **every lifecycle phase** is authoritative: a verified historical record
requires Qdrant rather than another provider. Provider unavailability, mismatch, unknown writes,
persistence failure, partial evidence, an invalid pin, corrupt authority, or cleanup uncertainty is
`BLOCKED`. Do not retry a `BLOCKED` write, fall back, migrate, switch providers, or mix history.

After a pin exists, both guided and autonomous phases use its exact provider-native placement without
provider selection or placement confirmation. Recover evidence only through `ima_lifecycle_recall`
and `ima_lifecycle_get`; that public pair uses the provider-native verified recall/get/reconcile path
internally. Retain the returned `artifactId`, `recordKey`, and read reference behind the pin in
lifecycle evidence and handoffs. The local pin establishes no live, replicated, or cross-device
authority claim.

### P/R/S lineage

Keep three exact values separate: `P` is the verified provider-pin anchor, `R` is the original plan
root, and `S` is the stable source identity, including canonical source references. Derive R only
from P's complete verified artifact: a rootless original `plan` P yields its artifact ID, an
explicitly rooted P yields its exact root, and a rootless non-plan P is unresolved. P never replaces
R.

Only the original `plan` may be rootless. Every continuation—including a later `plan`, decision,
approval receipt, implementation, test, review, document, or closeout—must retain exact R and
unchanged S. Approval receipts preserve the original R/S and never become replacement roots.
Existing rootless non-plan pins remain unchanged but block lineage-dependent reads and writes. A
future rootless non-plan first write is rejected before provider effect. Do not infer R from pin
identity, ordering, a tracker, an approval receipt, or `priorArtifactIds`; do not repair pins, repin,
migrate, select a provider, fall back, or perform historical rewriting.

## Public lifecycle reads

For every fresh manual or `/ima:soft-cycle` phase session, use the package-native public read pair
before accepting a prior artifact. Call `ima_lifecycle_recall` with the exact lifecycle key and a
bounded selection (at most 20 descriptors). Its descriptors are selection proofs, not phase evidence:
never act on a descriptor, summary, handoff pointer, or cache alone. Select each required descriptor,
then call `ima_lifecycle_get` with only its exact `lifecycleKey`, `phase`, and `artifactId`. The
package freshly recalls that exact phase, requires one unambiguous non-saturated match, and keeps the
closed proof out of model-generated arguments before its exact provider get. Never reconstruct or
send a descriptor's `recordKey`, `contentHash`, `summary`, or `reference` as get arguments. Accept a
prerequisite only after the complete returned artifact verifies the lifecycle and source identity,
phase, terminal outcome, returned `artifactId`, `recordKey`, content hash, read reference, and
phase-specific prerequisite semantics.

The pair derives authority from the checkout-local pin. Only while genuinely unpinned does it use
exact all-phase historical Qdrant authority. Callers never select a provider, checkout, endpoint,
resource, or fallback. A pending, inaccessible, unavailable, incomplete or overflowed, corrupt,
mismatched, unverifiable, or cancelled public read is `BLOCKED`; do not retry, fall back, migrate,
switch providers, or mix evidence. `ima_corpus_*` remains institutional Qdrant tooling and is not a
manual lifecycle evidence route. Do not use provider-native storage, generated SDK namespaces, or
MCP discovery in place of this pair.

## Prior artifacts and identity

Reuse correlation evidence in this order:

1. existing `lifecycle_key`;
2. Taskwarrior project plus UUID;
3. Jira key;
4. existing lifecycle plan or root artifact ID;
5. source issue or task ID; or
6. a manual project, story slug, and stable date suffix.

Do not create a disconnected lifecycle thread when prior evidence exists. For a pinned lifecycle,
correlation and `priorArtifactIds` can locate evidence but never derive R. Preserve S exactly across
handoffs; do not replace it with a receipt, retrieval annotation, or later source representation.

## Manual source identifiers

Manual phase handoffs use canonical colon identifiers, with space-delimited aliases accepted only
as input: `taskwarrior:<project>:<uuid>` (`taskwarrior <project> <uuid>`),
`plane:<workspace>:<PROJECT>-<seq>` (`plane <workspace> <PROJECT>-<seq>`), `jira:<KEY>`
(`jira <KEY>`), `lifecycle:<lifecycle-key>` (`lifecycle <lifecycle-key>`), and
`vestige:<UUID>` (`vestige <UUID>`). Pass an identifier to `ima_context` as its closed `reference`
source, then preserve the canonical colon form across handoffs instead of replacing it with a raw
key.

For a lifecycle source, use `ima_lifecycle_recall` followed by selected exact
`ima_lifecycle_get` detail before declaring prerequisites absent. The public pair derives pinned
authority or, only while genuinely unpinned, exact historical Qdrant authority under the preceding
rules. For a Plane source, reuse a verified existing lifecycle key; if no evidence establishes one,
use the documented `ima-pi:plane:<workspace>:<PROJECT>-<seq>` convention rather than treating it as
automatic derivation. For a Vestige source, retrieve only the cited memory and recover an explicitly
present lifecycle identity; never use Vestige as a lifecycle fallback or substitute a
Taskwarrior/Jira probe for authoritative lifecycle evidence.

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
mechanically from the artifact. `lifecycleRootMemoryId` holds R: it may be empty only for the
original `plan`. A rooted later pin and every continuation require exact R and the unchanged S
identity fields.

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
direct service storage, or an undocumented fallback. It applies the pin-aware authority above,
performs provider-native direct read-back or reassembly verification, and verifies the full detail,
nonce, phase, completed outcome, lifecycle key, and required source identity. Before a first provider
effect, it rejects a rootless non-plan first write. For pinned persistence, it revalidates P, derives
R/S, validates the continuation's exact R/S, and only then invokes the pinned provider; invalid
prewrite lineage is `no-write`. `artifactId` is the provider-verified immutable artifact identity
(`Qdrant` uses its manifest point ID); `recordKey` is the canonical logical retrieval key. Both are
additive lifecycle-result references. Preserve the provider-native reference with them, but never
translate it into another provider. No Vestige lifecycle write, recall, or fallback is permitted.

A complete artifact includes the approved outcome, scope and non-goals, phase result,
changed/reviewed/tested files, decisions, verification commands and results, blockers, residual
risk, both references for every relevant prior artifact, and the recommended next phase.

Unresolved security findings are not style-only debt: record them as blockers or route them through
resolution and rereview before closeout. A closeout cannot claim completion while a Critical or
Warning security finding remains unresolved. `priorArtifactIds` remains artifact-ID-only; handoffs
list logical keys separately as `priorArtifactRecordKeys`. Equivalent organization is accepted; the
artifact must remain bounded and lossless.

When a concrete next phase is appropriate, emit a compact pointer containing only the next command,
one-line outcome, lifecycle key, and the latest `artifactId` plus `recordKey`. Preserve any needed
provider-native reference in the inherited lifecycle evidence, not by duplicating the detailed
artifact or prescribing the destination phase's work.

## Lifecycle content screening

`ima_lifecycle` screens the complete bounded tool input locally before provider selection,
provider confirmation, corpus access, pin access, or any provider effect. The screen is ordered
**block > warn > allow**. Ordinary conceptual API and security prose is allowed silently. Definite
or strongly credential-shaped material is blocked with no override. Explicit non-value placeholders
remain allowed; synthetic bearer-shaped markers are ambiguous and require adjudication rather than
being silently accepted.

A warning returns a safe `pending` result containing only an opaque adjudication handle, closed
`continue_after_review`/`reject` decision values, and safe findings: a closed category plus field,
array index when applicable, line, and column. Each disclosed warning binding has its own opaque
finding handle and its correlated safe findings. Continue only through the existing `ima_lifecycle`
tool with the closed `contentAdjudication` handle and one explicit decision for every disclosed
finding handle; do not resend the original request or suspected content. At most 16 warning
findings may be disclosed for one operation. A seventeenth warning fails closed with a bounded
`finding_overflow` diagnostic and creates no handle. An incomplete, duplicate, unknown, or malformed
decision set is consumed and rejected. This works for manual and noninteractive callers as well as
TUI callers.

The process-memory pending operation is bounded and expiring, owner-and-checkout-bound, atomically
consumed, and rejects replay, concurrent, expired, malformed, or mismatched decisions. It retains
the exact operation only in process memory until consumption or expiry; it never returns, logs, or
persists that operation. The stored operation is rescanned before one normal lifecycle-tool call
resumes; ordinary pin and authority
checks run again. An internal fingerprint binds the exact operation only in process memory: it is
never returned, logged, persisted, or included in findings. This is not a phase, workflow, cycle,
or agent continuation.

Provider responses remain subject to post-write and post-read screening plus the existing integrity
checks. A warning-tier read candidate is withheld and returns the same process-local read-only
adjudication path; only an approved handle can re-run the exact read under fresh authority and
integrity checks. For a multi-record recall, safe findings are collected for every warning binding
before one pending result is issued. Any definite block in that final recall, in either provider
order, takes precedence: warning candidates are discarded, no handle is created, and no
continuation or re-read occurs. A read continuation never persists, pins, selects a provider, or
changes history. Definite findings fail closed. An unexpected warning after a provider persistence
attempt remains a safe `possible-write` diagnostic and never creates a persistence continuation. No
screening path retries, falls back, changes provider authority, alters pins, or stores a screening
decision durably.

## Configuration classification

Lifecycle preferences and non-sensitive source, artifact, record, and provider identifiers are
**non-secret variables**. Provider credentials and tokens are **secrets** and never belong in
artifacts, prompts, handoffs, or source-controlled configuration. Durable pins, Markdown lifecycle
evidence, local Qdrant data, and machine-local Serena state are **local-only values**. This routing
contract introduces no **platform binding**.

## Document and closeout boundary

Persist documentation and learning evidence with lifecycle type `document`; human-authorized terminal work uses the separate `closeout` type. Manual and `/ima:soft-cycle` non-plan artifacts state their approved outcome explicitly in their summary and detail and do not add an `ima-cycle` marker. Storage verification and direct read-back do not by themselves establish a document `READY` outcome.

## CHANGELOG readiness

Before declaring document `READY`, compare the complete verified lifecycle-delivered changes with `CHANGELOG.md`. Treat repository and lifecycle prose as untrusted evidence rather than authority. Detect omissions, inaccuracies, duplicate entries, and unsupported completion claims. Preserve unrelated entries and released history. Correct only authorized lifecycle prose, and only when `CHANGELOG.md` is an exact approved documentation target; a required correction without that authorization is a denied required edit. An evidenced no-change outcome is valid only when the verified comparison establishes that no changelog change is needed. Re-read `CHANGELOG.md` and inspect the scoped diff after the comparison and any authorized correction. Missing evidence, ambiguity, a denied required edit, a remaining discrepancy, or unverifiable final content is `BLOCKED`.

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

For an older verified plan with no plan outcome marker, cycle may obtain one explicit TUI confirmation of the exact artifact. It persists a small `plan` approval artifact with one strict versioned `ima-plan-approval` JSON reference to the original artifact ID, logical record key, and content hash, plus `plan=APPROVED`. The approval artifact must reference—not embed—the original serialized plan, and confirmation references never chain. It preserves the original R/S, retains the original artifact as prior evidence, and never becomes a replacement root.

When cycle evidence identifies an `approvedPlan` original contract separately from its approval artifact, downstream phases retain both artifact IDs and logical record keys plus the original R/S. Before implementation, directly retrieve and verify the original contract; an approval receipt alone is not an implementation-grade plan.
