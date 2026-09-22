# Markdown lifecycle provider

> **Provider-native lifecycle authority:** `lib/markdown-lifecycle-record.ts` and `lib/markdown-lifecycle.ts` provide the local Markdown provider, one of the four lifecycle authorities. Provider selection, user confirmation, and checkout-local pin handling follow the [lifecycle authority contract](guide.md#lifecycle-authority-memory-and-integrations). Markdown remains local-only and has no distributed guarantee.

## New-developer readiness boundary

Package/resource discovery does not configure this provider, and BookStack shared-memory access is not managed lifecycle persistence. Markdown applies only after valid user selection or a valid Markdown pin; it is never a substitute when another provider's pin or historical authority is unavailable. If exact historical authority cannot be verified, the operator must stop and preserve existing evidence rather than fall back, repin, migrate, or mix providers. See the [new-developer readiness journey](guide.md#new-developer-shared-memory-readiness) for owner gates and its non-destructive rollback boundary.

## Lifecycle integration boundary

Lifecycle integration preserves user confirmation, provider selection, the checkout-local pin, and every blocked/no-fallback result. That includes integrations with `ima_lifecycle`, `ima_context`, `/ima:cycle`, `/ima:new`, or other user-facing lifecycle flow. The adapter accepts no preference, pin, route, command, or configuration that makes that decision. It supplies no fallback, migration, adoption, closeout, or recovery tooling; this document claims no live-provider or cross-device acceptance.

## P/R/S lineage authority

For operator use, **P** is the verified provider-pin anchor, **R** is the original lifecycle-seed root, and **S** is the stable source identity. A rootless `plan` or `decision` is a valid lifecycle seed and establishes R. Later records retain its original R and S, and a rooted initial pin retains R. Approval receipts preserve the original R and S; they never become or replace the lifecycle-seed root.

An existing legacy rootless phase other than `plan` or `decision` remains unchanged but blocks. There is no repair, migration, repinning, or fallback. A future rootless first write for a phase other than `plan` or `decision` rejects before any effect. A `decision` never satisfies approved technical-plan selection; cycle adoption and closeout require a distinct approved `plan`. Before tracker effects, closeout revalidates the exact P/R/S lineage and blocks on missing or mismatched evidence; it does not auto-close a tracker. This policy does not change the public, provider-neutral recall or get signatures.

The approved lineage authority is baseline canonical source `plane:ima:SKYNET-230`, final approved rereview `d2ffc65d-35ae-57cd-bfc2-ed9f3c65c69c`, with assessment `direct:d7f62171-e139-422b-a05b-7b59b929fef1`; verified decision-seed correction `plane:ima:SKYNET-245`.

## API and value contracts

`createMarkdownLifecycleAdapter({ checkoutRoot })` returns the standalone `MarkdownLifecycleAdapter`:

```ts
{
  persist(request, signal?): Promise<MarkdownLifecycleVerifiedResult | MarkdownLifecycleBlockedResult>;
  get(reference, signal?): Promise<MarkdownLifecycleVerifiedResult | MarkdownLifecycleBlockedResult>;
  recall(selection, signal?): Promise<MarkdownLifecycleVerifiedResult[] | MarkdownLifecycleBlockedResult>;
}
```

There is no exported `reconcile`, delete, overwrite, adoption, migration, or fallback operation. `get` is the exact read-only reference operation and can be used by a fresh adapter configured for the same checkout.

`persist` accepts a strict own-data request:

```ts
{
  schemaVersion: 1;
  phase: "plan" | "implementation" | "test" | "review" | "resolution" | "rereview" | "document" | "decision" | "closeout";
  identity: LifecycleIdentity;
  summary: string;
  artifact: string;
  expectedHash: string; // lowercase SHA-256 of artifact
}
```

The caller must prepare the complete canonical lifecycle artifact first. The adapter validates the exact canonical UTF-8 artifact framing, lifecycle identity, phase, deterministic artifact UUID/nonce, terminal verification marker, and SHA-256 before filesystem effects. It does not generate, repair, redact, or transform caller content. Strict projections reject extra, inherited, sparse, accessor-backed, malformed, noncanonical, or recognized credential-shaped inputs.

A verified result has the exact shape below; `stored` means publication completed and read back, while `unchanged` means the same verified immutable record already existed:

```ts
{
  provider: "markdown";
  status: "verified";
  disposition: "stored" | "unchanged";
  storageSchemaVersion: 1;
  sourceId: "markdown:lifecycle:<artifactId>";
  checkoutRoot: string;
  lifecycleKey: string;
  phase: LifecyclePhase;
  artifactId: string;
  contentHash: string;
  receiptHash: string;
  identity: LifecycleIdentity;
  summary: string;
  artifact: string;
  reference: MarkdownLifecycleReference;
}
```

Every failure is a bounded `{ provider: "markdown", status: "blocked", code, reference? }` result. The possible codes are `markdown_request_invalid`, `markdown_secret_detected`, `aborted`, `markdown_checkout_invalid`, `markdown_containment_violation`, `markdown_lease_active`, `markdown_lease_lost`, `markdown_lease_release_failed`, `markdown_lease_unavailable`, `markdown_operation_failed`, `markdown_partial_evidence`, `markdown_path_invalid`, `markdown_recall_unverifiable`, `markdown_record_not_found`, `markdown_reference_invalid`, `markdown_selection_invalid`, `markdown_target_conflict`, `markdown_target_unverifiable`, `markdown_verification_failed`, `markdown_write_failed`, and `markdown_write_uncertain`. The result exposes no raw filesystem error body.

### Provider-neutral lifecycle read surface

The public package tools are provider-neutral; callers do not invoke this adapter directly. `ima_lifecycle_recall({ lifecycleKey, phase?, limit? })` returns at most 20 verified descriptors. The recommended model-facing exact read is `ima_lifecycle_get({ lifecycleKey, phase, artifactId })`: the package freshly recalls that exact phase, requires one unambiguous non-saturated match, projects the descriptor proof internally, and returns exactly one complete verified artifact. The complete descriptor form remains accepted for compatibility and is verified strictly, but models must not reconstruct or resend its proof fields. A recall descriptor contains only `lifecycleKey`, exact `phase`, `artifactId`, `recordKey`, `contentHash`, `summary`, and a closed `reference` proof. `document` is exact and never expands to `closeout`.

After a lifecycle is pinned, its durable pin is the sole authority for both public tools. Only while genuinely unpinned may the tools use exact all-phase historical Qdrant authority. Provider, checkout path, endpoint, credential, and destination remain internal; a closed reference is proof of a verified binding, not bearer authorization or provider-selection input. A pending, changed, unavailable, malformed, mismatched, secret-shaped, or incomplete read fails closed with no provider selection, mutation, pinning, fallback, repair, migration, or partial output. `ima_corpus_*` remains the separate Qdrant-native institutional corpus API.

A `MarkdownLifecycleReference` is a strict exact binding:

```ts
{
  schemaVersion: 1;
  provider: "markdown";
  checkoutRoot: string;
  lifecycleKey: string;
  phase: LifecyclePhase;
  artifactId: string;
  contentHash: string;
  receiptHash: string;
}
```

The receipt is canonical UTF-8 JSON followed by one newline. It contains `schemaVersion`, `provider`, `lifecycleKey`, `phase`, `artifactId`, the complete `identity`, `summary`, and `contentHash`. Its SHA-256 is `receiptHash`. A read verifies the exact receipt bytes, receipt hash, artifact bytes/content hash, canonical lifecycle artifact, identity, phase, artifact ID, and checkout-root reference before returning evidence.

## Exact local layout and publication

For lifecycle key `K`, `D = sha256(K)` as lowercase hexadecimal. The only lifecycle scope is:

```text
<checkoutRoot>/.ima/lifecycle/markdown/v1/<D>/
  <phase>-<artifactId>.md
  <phase>-<artifactId>.commit.json
  .lifecycle.lock                 (only while an adapter holds its lease)
```

The versioned root is exactly `.ima/lifecycle/markdown/v1`; `K` never becomes a pathname. The adapter requires an absolute, canonical checkout root that is an existing non-symlink directory. It creates scope directories with mode `0700` and new artifact, receipt, and lock files with mode `0600`.

Publication is artifact-first, read-back, receipt-last:

1. validate the caller-prepared canonical UTF-8 artifact and construct its canonical receipt;
2. acquire the per-lifecycle `.lifecycle.lock` with exclusive creation;
3. inspect any existing artifact/receipt pair;
4. create the artifact once and read back byte-exact content;
5. create the receipt once; then read and verify the complete pair; and
6. release the lease only when it remains owned.

Only the final verified pair yields `stored`. A pre-existing exact pair yields `unchanged`. Existing but changed evidence is `markdown_target_conflict`; invalid evidence is `markdown_target_unverifiable`; a one-file pair is `markdown_partial_evidence`. Create-only writes, no-follow reads/creates, canonical containment checks, and byte-exact read-back prevent this adapter from overwriting or completing existing evidence.

## Reads, recall, locking, and recovery boundary

`get(reference, signal?)` performs no write. It requires the reference checkout root to exactly equal this adapter's checked checkout root, blocks while a lease is present, and returns `unchanged` only for a complete exact verified pair. Missing records, partial pairs, invalid evidence, changing scope, and reference/hash mismatch remain blocked.

`recall({ lifecycleKey, phase?, limit? }, signal?)` is also read-only. It scopes only to `sha256(lifecycleKey)`, accepts an optional valid phase, defaults `limit` to 20, and accepts only limits 1–20. It enumerates at most 10,000 directory entries, verifies every lifecycle-looking artifact/receipt pair, rejects malformed names, unmatched pairs, duplicate artifact IDs, invalid records, scope changes, or lease activity, and returns no partial authoritative result. A missing scope returns `[]`; a successful result is sorted by receipt filename, optionally phase-filtered, and then limited.

The lease is cooperative local serialization, not a retry protocol. A present lock blocks independent adapters; no lock is stolen, expired, or removed by this adapter. Cancellation is checked at entry and I/O boundaries and returns `aborted`; it does not authorize retry, fallback, or later evidence authority. Write failure, uncertain write, lost/release-failed lease, partial evidence, conflict, or failed verification can leave evidence or a lock for inspection. **Recovery is operator-owned:** this provider offers no cleanup, completion, deletion, lock removal, automatic retry, or adoption path.

## Ordinary-filesystem threat model and limits

This is a local ordinary-filesystem adapter, not a shared-service durability or distributed-lock guarantee. It checks checkout and child-directory containment, canonical paths, directory/file identity around operations, exact UTF-8 decoding, no-follow file access, symlinks, hard links, substitutions, file growth, and changes observed during reads. It does not follow symlinks and treats unsafe or unstable evidence as blocked.

Those controls do not make a checkout trustworthy against a privileged or concurrently malicious local actor, filesystem/kernel defects, a crashed process after a write, lost local storage, or coordinated writers outside this protocol. The receipt establishes locally verified evidence only; it does not establish provider selection, routing, lifecycle readiness, remote replication, migration, or tracker closeout. Ordinary non-lifecycle files in the checkout and lifecycle scope are not adopted, altered, or deleted.

## Configuration and data classification

- Checkout paths, Markdown artifacts, receipts, references, locks, synthetic fixtures, local Qdrant state, and machine Serena state are **local-only values**. They are not portable provider configuration or shared state.
- Lifecycle keys, phases, artifact IDs, record keys, content hashes, and closed public-read reference fields are **non-secret variables**. Closed references remain verification proof, not bearer authorization.
- Credentials and tokens are **secrets** and are forbidden in requests, artifacts, receipts, references, locks, fixtures, documentation examples, and configuration. The adapter rejects only recognized credential-shaped forms; callers remain responsible for never supplying credentials.
- Configured provider service, project, or workspace destinations are **platform bindings** where applicable and remain internal to the public read surface. This adapter adds no environment variable.

## Reviewed verification evidence

The approved canonical source is `plane:ima:SKYNET-209`, with lifecycle `ima-pi:plane:ima:SKYNET-209`. Reviewed lifecycle evidence is: approved plan `91a1b8d8-d065-5fb1-837d-c03a909ca522` / `ima-pi:plane:ima:SKYNET-209:plan:0c4fd96129ac`; implementation `fd0b30ef-d554-5f66-bf04-f795180dfa6b` / `ima-pi:plane:ima:SKYNET-209:implementation:fb82ecb88d75`; PASS test `14445b9e-a34d-5f44-87b7-78cb37b19f0e` / `ima-pi:plane:ima:SKYNET-209:test:41c43bf5a43f`; review `REQUEST_CHANGES` `8bc53e2a-b083-5b18-95ce-1ec2c94935d9`; resolution `e187c181-d4c2-5168-a2ce-9063d8d849bf`; and same-reviewer approval `db760b9d-4d07-5da3-8109-a96079af04ff` / `ima-pi:plane:ima:SKYNET-209:rereview:20e5041030ff`.

The reviewed focused coverage is `tests/markdown-lifecycle-record.test.js` and `tests/markdown-lifecycle.test.js`. It exercises canonical artifact/receipt/reference construction; strict input and recognized-secret rejection; artifact-first read-back; immutable retries and conflicts; partial evidence; exact fresh-adapter `get`; bounded recall; ordinary-file preservation; containment and symlink/hard-link resistance; lease contention; cancellation; and bounded non-reflecting failures. These local tests do not prove live-provider integration, distributed coordination, crash recovery, or activation.

## Lifecycle integration requirements

Lifecycle integration must supply an existing canonical checkout root, pass only caller-prepared canonical artifact data, retain and use exact references, surface blocked outcomes without fallback, and leave recovery to an operator. When unordered selection reaches Markdown, it is exact rather than inferred. This local-only contract does not provide migration, distributed coordination, or cross-device acceptance.
