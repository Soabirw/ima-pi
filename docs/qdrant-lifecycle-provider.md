# Qdrant lifecycle provider

> **Provider-native lifecycle authority:** Qdrant is one of the four lifecycle authorities. Provider selection, user confirmation, historical-Qdrant authority, and checkout-local pin handling follow the [lifecycle authority contract](guide.md#lifecycle-authority-memory-and-integrations); this provider preserves its immutable, fail-closed behavior within that decision.

## New-developer readiness boundary

Package/resource discovery and BookStack shared-knowledge access do not require a local Qdrant or Ollama installation. Qdrant prerequisites apply only when a Qdrant capability is requested or when a valid Qdrant pin or historical Qdrant phase establishes authority. Those cases cannot be bypassed with another provider, migration, or repin. If exact historical authority cannot be verified, the operator must stop and preserve it; do not assume every runtime path uniformly blocks unavailable historical recall. See the [new-developer readiness journey](guide.md#new-developer-shared-memory-readiness) and the [BookStack shared-memory runbook](bookstack-knowledge.md) for the separate search/read-first path.

The ordinary provider surface offers `persist`, `get`, `recall`, and `reconcile` to a caller that has selected Qdrant. It returns either verified immutable lifecycle evidence or a bounded blocked result. Those ordinary operations do not change a preference or pin, route a command, repair evidence, migrate records, or fall back to another store. The separate report-bound reset below is a bounded local recovery exception: it can replace a verified Qdrant pin with blocking recovery state and clear it only after complete absence proof; it never selects a provider, changes a preference, or uses another store.

## Identity, projection, and verification

Every operation first accepts only a strict detached projection of its request, selection, or reference. Unsafe or malformed structural inputs, including extra, inherited, sparse, or accessor-backed values, are rejected without invoking accessors. Valid mutable inputs are detached and snapshotted so later caller mutation cannot alter effects or results. Returned evidence and references are detached as well.

A reference binds the provider, artifact ID, deterministic record key, content hash, lifecycle key, phase, and artifact nonce. Direct reads verify all of those identities against the canonical artifact and source references. The verifier accepts only exact compatible schema-v1 or schema-v2 records; schema-v2 detail is reassembled and checked before it is accepted. A malformed, inconsistent, incomplete, duplicate, or unverified record is blocked rather than presented as lifecycle evidence.

## Persistence and exact-reference reconciliation

`persist` prepares immutable lifecycle evidence, writes through the institutional manifest path, validates the storage receipt, then performs a direct read-back. It returns `stored` only after that read-back exactly verifies the requested artifact and reference.

The record identity is immutable. A retry of the same verified artifact returns `unchanged`; a changed artifact at that identity blocks. If a write or read-back cannot be verified, the result is blocked and carries only the bounded reference needed for a later exact check where available. It does not retry a write automatically, repair remote data, migrate a record, or use a fallback provider.

`get` retrieves only the exact reference and verifies it. `reconcile` is the same read-only exact-reference operation, including when performed by a fresh provider instance; it never writes.

## Report-bound Qdrant lifecycle reset

The only operator entry point is [`prompts/ima:qdrant-lifecycle-reset.md`](../prompts/ima:qdrant-lifecycle-reset.md), exposed as `/ima:qdrant-lifecycle-reset` and implemented by `ima_qdrant_lifecycle_reset`. It is a bounded reset for one exact Qdrant-pinned lifecycle key, not generic Qdrant administration. Its object-root request accepts only the three exact route projections below; malformed or extra route input blocks. Do not call Qdrant, lifecycle persistence, filesystem helpers, BookStack, tracker, or closeout actions directly.

```text
/ima:qdrant-lifecycle-reset <lifecycle-key>
/ima:qdrant-lifecycle-reset execute <report-path> <report-hash>
/ima:qdrant-lifecycle-reset reconcile <report-path> <report-hash>
```

### Prepare: inventory without Qdrant or pin mutation

`prepare` requires the current exact Qdrant pin and exhaustively inventories that lifecycle key's verified schema-v1 records and schema-v2 manifests plus chunks. It writes a fresh protected checkout-local archive and report in `.ima-cycle/`: the directory is `0700` and each artifact is `0600`. The archive retains the validated inventory; the report binds the expected pin and pin fingerprint, attempt ID, archive name/size/hash, inventory fingerprint, record and point counts, and report-listed point identities. The bounded result exposes only the relative report path, report SHA-256, lifecycle key, and counts. Prepare does not mutate Qdrant or the pin.

### Execute: exact binding, two trusted confirmations, then proof

`execute` accepts only the exact prepared relative report path and its returned SHA-256 as the command confirmation. It verifies the protected report/archive pair, expected pin, archive receipt, inventory fingerprint, and current exact inventory before recovery can proceed. The report hash is necessary but not sufficient:

1. A trusted UI must approve the recovery intent before local recovery state or snapshot creation. The UI shows the lifecycle key, report hash, inventory fingerprint, and exact record/point scope.
2. The reset marks the pin as recovering, creates and verifies a Qdrant snapshot receipt, rechecks the complete report-bound inventory, then requires a separate trusted UI deletion confirmation. That second confirmation displays the verified snapshot receipt and exact report-bound scope; the first confirmation or chat text never authorizes deletion.

Only report-listed UUIDs are sent for deletion. Afterward, the reset directly checks every listed UUID and exhaustively checks the exact lifecycle-key roots and each schema-v2 chunk parent scope for absence. It clears the local recovery/pin entry only after that complete proof.

### Reconcile and fail-closed recovery

`reconcile` requires the same exact report path/hash and matching local recovery binding. It has one trusted UI intent confirmation, performs Qdrant read-only direct and exhaustive absence proof, creates no snapshot, and never deletes. It can clear local recovery only after the same complete proof.

Before recovery starts, malformed, mismatched, inaccessible, or stale report/archive/pin/inventory evidence blocks without mutation. After recovery starts, cancellation, snapshot uncertainty, partial or uncertain deletion, a changed inventory, a denied confirmation, or any verification failure retains blocking recovery. Do not retry an uncertain operation, fall back, migrate, repair, broadly delete, or automatically repin; use only the report-bound read-only reconciliation route to establish absence. While recovery is retained, ordinary lifecycle operations reject immediately before provider effects. After complete proof clears it, the sole repin route is an ordinary first write rooted in a rootless `plan` or `decision`; reset never repins.

Prepare, execute, reconcile, and ordinary lifecycle persistence share one canonical checkout-local lease. Busy, unavailable, or stale/conflicting local state fails closed. The lease does not coordinate external writers or other checkouts, so operators must stop on contention rather than infer distributed safety.

## Recall boundary

`recall` uses an exact lifecycle-key selection with an optional phase, accepts 1–50 records, and defaults to 50. It obtains the selected manifests and directly retrieves each full record, returning results only when every returned record is exact, unique, complete, and verified. Cancellation is a blocked result at every operation boundary. A terminal result of 49 records can succeed through the public lifecycle read. A terminal result of exactly 50 records is internally complete, but `ima_lifecycle_recall` treats it as public saturation and returns no descriptors; a successful public result never contains 50 descriptors.

Lifecycle-specific recall requires an explicit Qdrant terminal proof: `next_page_offset: null` before any detail reads or successful result. A valid non-null continuation is recall overflow: it blocks before direct detail reads, does not page, and the public lifecycle read exposes only the fixed safe diagnostic `provider_verification_failed` with `step: recall` and `reason: recall_overflow`. Missing or malformed continuation metadata remains the provider-boundary `response_invalid` classification, while missing or corrupt detail chunks remain `record_incomplete`; neither is relabeled as overflow or exposes raw provider data or partial records. This lifecycle-specific completeness requirement does not change public summary recall. Lifecycle integration preserves this provider-completeness boundary and the valid pin.

## Failure behavior

Validation failures, cancellation, unavailable dependencies, invalid receipts, failed read-back, exact-identity mismatch, and unverifiable recall return bounded blocked results. The provider exposes no raw dependency response bodies and performs no fallback, repair, migration, or historical rewrite.

## Configuration and live-integration boundary

| Setting or value | Classification and handling |
| --- | --- |
| `IMA_QDRANT_URL` and `IMA_OLLAMA_URL` | **Non-secret variables** when their capability is invoked. For reset, the resolved Qdrant endpoint is a trusted **platform binding**, never an operator-supplied route argument. |
| Qdrant endpoint and institutional collection | **Platform bindings** from trusted configuration. Reset neither selects nor changes them. |
| Qdrant or Ollama credentials/tokens | **Secrets** in environment-only secret storage. Never place them in source-controlled configuration, reports, archives, prompts, or chat output. |
| Lifecycle keys, report paths, report/inventory/pin hashes, counts, and non-sensitive artifact or point IDs | **Non-secret variables**. A report hash is an exact binding/confirmation value, not a credential. |
| Pins, reports, archives, snapshot identifiers/receipts, operation leases, recovery state, local Qdrant data, and synthetic fixtures | **Local-only values**. Keep reset artifacts out of source control and do not disclose their bodies or raw provider responses. |

Reset introduces no configurable setting or platform binding beyond the existing trusted Qdrant endpoint and collection. No live Qdrant execution, snapshot restore, live remote persistence, cross-device coordination, or distributed-writer acceptance was tested. Those remain human-owned operational acceptance boundaries. Lifecycle integration preserves blocked and no-fallback outcomes; a pinned Qdrant failure never permits fallback, migration, or provider mixing.
