# Qdrant lifecycle provider

> **Provider-native lifecycle authority:** Qdrant is one of the four lifecycle authorities. Provider selection, user confirmation, historical-Qdrant authority, and checkout-local pin handling follow the [lifecycle authority contract](guide.md#lifecycle-authority-memory-and-integrations); this provider preserves its immutable, fail-closed behavior within that decision.

## New-developer readiness boundary

Package/resource discovery and BookStack shared-knowledge access do not require a local Qdrant or Ollama installation. Qdrant prerequisites apply only when a Qdrant capability is requested or when a valid Qdrant pin or historical Qdrant phase establishes authority. Those cases cannot be bypassed with another provider, migration, or repin. If exact historical authority cannot be verified, the operator must stop and preserve it; do not assume every runtime path uniformly blocks unavailable historical recall. See the [new-developer readiness journey](guide.md#new-developer-shared-memory-readiness) and the [BookStack shared-memory runbook](bookstack-knowledge.md) for the separate search/read-first path.

The provider offers `persist`, `get`, `recall`, and `reconcile` to a caller that has selected Qdrant. It returns either verified immutable lifecycle evidence or a bounded blocked result. It does not change a preference or pin, route a command, repair evidence, migrate records, or fall back to another store.

## Identity, projection, and verification

Every operation first accepts only a strict detached projection of its request, selection, or reference. Unsafe or malformed structural inputs, including extra, inherited, sparse, or accessor-backed values, are rejected without invoking accessors. Valid mutable inputs are detached and snapshotted so later caller mutation cannot alter effects or results. Returned evidence and references are detached as well.

A reference binds the provider, artifact ID, deterministic record key, content hash, lifecycle key, phase, and artifact nonce. Direct reads verify all of those identities against the canonical artifact and source references. The verifier accepts only exact compatible schema-v1 or schema-v2 records; schema-v2 detail is reassembled and checked before it is accepted. A malformed, inconsistent, incomplete, duplicate, or unverified record is blocked rather than presented as lifecycle evidence.

## Persistence and recovery

`persist` prepares immutable lifecycle evidence, writes through the institutional manifest path, validates the storage receipt, then performs a direct read-back. It returns `stored` only after that read-back exactly verifies the requested artifact and reference.

The record identity is immutable. A retry of the same verified artifact returns `unchanged`; a changed artifact at that identity blocks. If a write or read-back cannot be verified, the result is blocked and carries only the bounded reference needed for a later exact check where available. It does not retry a write automatically, repair remote data, migrate a record, or use a fallback provider.

`get` retrieves only the exact reference and verifies it. `reconcile` is the same read-only exact-reference operation, including when performed by a fresh provider instance; it never writes.

## Recall boundary

`recall` uses an exact lifecycle-key selection with an optional phase, accepts 1–50 records, and defaults to 50. It obtains the selected manifests and directly retrieves each full record, returning results only when every returned record is exact, unique, complete, and verified. Cancellation is a blocked result at every operation boundary. A terminal result of 49 records can succeed through the public lifecycle read. A terminal result of exactly 50 records is internally complete, but `ima_lifecycle_recall` treats it as public saturation and returns no descriptors; a successful public result never contains 50 descriptors.

Lifecycle-specific recall requires an explicit Qdrant terminal proof: `next_page_offset: null` before any detail reads or successful result. A valid non-null continuation is recall overflow: it blocks before direct detail reads, does not page, and the public lifecycle read exposes only the fixed safe diagnostic `provider_verification_failed` with `step: recall` and `reason: recall_overflow`. Missing or malformed continuation metadata remains the provider-boundary `response_invalid` classification, while missing or corrupt detail chunks remain `record_incomplete`; neither is relabeled as overflow or exposes raw provider data or partial records. This lifecycle-specific completeness requirement does not change public summary recall. Lifecycle integration preserves this provider-completeness boundary and the valid pin.

## Failure behavior

Validation failures, cancellation, unavailable dependencies, invalid receipts, failed read-back, exact-identity mismatch, and unverifiable recall return bounded blocked results. The provider exposes no raw dependency response bodies and performs no fallback, repair, migration, or historical rewrite.

## Configuration and live-integration boundary

- `IMA_QDRANT_URL` and `IMA_OLLAMA_URL` are **non-secret variables**.
- Any Qdrant or Ollama credentials are **secrets** and must not be placed in source-controlled configuration or ordinary variables.
- Local Qdrant data and synthetic fixtures are **local-only values**.
- This provider adds no **platform binding**.

No external Qdrant or Ollama service, live remote persistence, or cross-device acceptance was tested. That absence remains a live-acceptance blocker. Lifecycle integration must preserve these blocked and no-fallback outcomes; a pinned Qdrant failure does not permit fallback, migration, or provider mixing.
