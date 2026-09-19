---
lifecycle:
  project: "ima-pi"
  lifecycle_key: "ima-pi:plane:ima:SKYNET-225"
  lifecycle_root_memory_id: "8a6962fa-354e-5b1a-9ec3-59207cc5bdc3"
  plane_workspace: "ima"
  plane_work_item: "SKYNET-225"
  source_refs:
    - "plane:ima:SKYNET-225"
  prior_artifact_ids:
    - "8a6962fa-354e-5b1a-9ec3-59207cc5bdc3"
status: "approved"
record_type: "policy-decision"
---

# SKYNET-225: Legacy Store Policy Reconciliation

## Status and source

This approved decision reconciles lifecycle-provider and legacy-store policy for
`ima-pi`. It is documentation-only and derives its identity from
`plane:ima:SKYNET-225`; it does not report an operational action or lifecycle
persistence.

## Decision

### Supported lifecycle providers

The supported lifecycle providers are exactly BookStack, Qdrant, Serena, and
Markdown. Existing durable provider-pin, no-fallback, and fail-closed behavior
is unchanged: after a verified pin is established, later lifecycle work uses
that pinned provider.

Only while a lifecycle is genuinely unpinned, verified historical Qdrant
evidence has lifecycle authority. No fallback, migration, replication, provider
switching, or history mixing is authorized or implied. Missing, unavailable,
partial, mismatched, or unverifiable authority fails closed.

### Per-machine `ima-rag` boundary

`ima-rag` is deprecated per-machine legacy storage, outside `ima-pi`
operational retirement. `ima-pi` does not inventory, mutate, delete, operate,
or clean up per-machine `ima-rag`. Preservation and any future disposition
belong to the relevant machine owner/operator outside `ima-pi` automation.

## Scope

This decision changes no lifecycle provider routing, provider pin, historical
authority, lifecycle code, collection/service operation, or machine-local
storage. It supersedes current policy interpretation only where earlier
documentation conflicts with this decision; SKYNET-12 retains its historical
body and points here for current policy.
