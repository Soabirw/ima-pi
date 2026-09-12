# BookStack lifecycle provider

> **Additive provider capability:** This module is not live lifecycle routing. T9 owns provider selection, durable pins, `/ima:new` continuity, and presentation. Current lifecycle persistence continues to use Qdrant until that work is separately accepted.

`lib/bookstack-lifecycle.ts` provides a BookStack-native lifecycle store for a caller that has already selected BookStack and supplied a caller-approved artifact. It never selects a provider, changes a pin, falls back to another provider, or changes BookStack accounts, roles, permissions, or server configuration. The parallel [Qdrant lifecycle provider contract](qdrant-lifecycle-provider.md) has the same T9 selection and routing boundary.

## Topology and approval

The provider resolves the approved hierarchy by slug:

```text
Shelf: lifecycle-artifacts
└── Book: <caller-supplied project slug>
    └── Chapter: source selector
        └── Page: <phase>-<artifact UUID>
```

The caller supplies a validated lower-case project slug and canonical source reference. The project slug selects the Book; `ima-pi` is an example project, not a provider-wide restriction. Taskwarrior chapters use `taskwarrior-<full-uuid>`; Jira and Plane use their lower-case work-item key; lifecycle and cited legacy sources use `lifecycle-<sha256(lifecycle-key)>`. The complete source identity and lifecycle key remain in every page record; a slug alone never grants authority.

`planPlacement` reads placement without writing and returns the exact reuse/create preview, authoritative ordered shelf membership before and after the approved operation, sharing implications, and required prerequisites. Chapters are resolved only inside the selected project Book. `ensurePlacement` accepts one injected approval callback for the complete preview, requires literal `true`, rechecks the preview immediately before writes, then creates only approved missing resources and verifies slugs and relationships. Declined, missing, non-boolean, thrown, stale, ambiguous, unavailable, or unverifiable approval produces a bounded blocked result and no speculative write.

Before live provisioning, an administrator must confirm all of the following:

- private defaults apply to newly created resources;
- the API account can see complete shelf membership; and
- provisioning and writes for a lifecycle are operationally serialized.

These are **platform/operational prerequisites**, not settings the provider can change. The provider preserves the observed shelf-book order, rechecks it before the replacement-array update, and reads it back afterward. It never attaches an unrelated book based only on a matching slug.

## Artifact behavior

`persist` validates and prepares the standard canonical lifecycle artifact, stores it in an `ima-memory/v1` envelope with a closed versioned provider control block, then performs an authoritative page GET and verifies byte-exact framing, full identity and summary metadata, nonce, terminal marker, deterministic record key, SHA-256 canonical/request/page hashes, revision proof, and the actual Shelf → Book → Chapter → Page relationships. The prepared nonce is the logical artifact UUID; it is distinct from BookStack's page ID.

Pages are immutable through this provider: there is no update operation. Before POST, normal `persist` globally discovers visible pages with the exact canonical page slug; exactly one candidate must verify against the requested placement and immutable record before it returns `unchanged`, while multiple candidates block. Changed content at the same deterministic identity is a conflict. A POST with an unknown outcome returns a recovery descriptor and never automatically repeats the POST. `reconcile` only searches for exactly one matching existing page; zero or multiple matches remain blocked. The provider never deletes partial remote resources.

`get` uses an origin-fingerprinted serialized locator containing the complete Shelf → Book → Chapter placement, canonical `<phase>-<artifact UUID>` page slug, deterministic record key, immutable record/full-page hashes, revision, and bounded update timestamp. It projects that locator into a detached value before any HTTP request, so caller mutation during a read cannot redirect the request or alter its result. Missing, extra, accessor-backed, malformed, or wrong-origin fields fail closed before HTTP. Stale revision/hash proof and moved or missing resources are detected only after authoritative page and hierarchy reads; those failures still perform no write and no fallback.

## Recovery contract

Recovery descriptors retain the existing schema-version-1 wire fields but are a closed discriminated union over `create_shelf`, `create_book`, `attach_book`, `create_chapter`, and `create_page`. Each operation permits only its applicable IDs and proof fields; membership IDs are unique positive safe integers, preserve order, and can contain `new-project-book` only as the final Book-creation placeholder. Container recovery performs only authoritative reads or bounded same-parent discovery. It never provisions, updates membership, retries a write, chooses another endpoint, or falls back to Qdrant.

A recovery-bearing `persist` first validates and detaches the descriptor, then reconstructs the supplied request and placement without I/O. All placement, artifact ID, record key, content hash, and full-page hash evidence must match before reconciliation is allowed. A changed request therefore cannot reuse a prior recovery descriptor. If a shelf was reused rather than created by this operation, failure of its post-preview detail read or membership check before any provisioning write returns a blocked result with `recovery: null`; it does not invent a shelf-create recovery. `recall` returns only matching, verified canonical artifacts for an exact lifecycle/source selection. Neither operation recreates containers, uses Cloudflare excerpts, Qdrant, nor hidden process state.

## Security and runtime configuration

- `BOOKSTACK_BASE_URL` (and the compatible `BOOKSTACK_ORIGIN` alias) are **non-secret variables**. They must be a credential-free HTTPS origin and unequal aliases fail closed.
- `BOOKSTACK_TOKEN_ID` and `BOOKSTACK_TOKEN_SECRET` are **secrets**. Do not put either in source control, logs, or ordinary variables.
- Caller-supplied project/placement slugs are **non-secret inputs**. They are validated; they are not environment requirements.
- A host-retained serialized recovery descriptor is a **local-only value** until T9 defines durable handling.
- This provider introduces no **platform binding**.

Requests deny redirects, use fixed API paths and encoded query values, bound timeout and response size, and require stable exact list totals with pagination capped at 10,000 entries. Public failures contain only allowlisted codes/categories and closed recovery fields; dependency error text and payloads are not returned. Returned Markdown is evidence data, never executable instructions. There is no shell execution, permission escalation, HTML rendering, or deletion path.

## Verification and handoff

Run:

```bash
node --test tests/bookstack-lifecycle-*.test.js tests/bookstack-knowledge.test.js
npm test
git diff --check
```

A separately authorized synthetic BookStack acceptance run may create test-only containers, approve placement once, verify read-back and retry behavior, and retrieve from a fresh provider instance. It must not use real lifecycle content or clean up remote material without separate approval.

T9 may integrate the provider only after independently deciding provider selection, durable pinning, routing, and user presentation. It must preserve the provider's no-fallback and fail-closed results.
