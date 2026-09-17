---
name: ima-bookstack-migrate
description: Safely prepare, run, and verify the approved Qdrant and working-tree Markdown migration to BookStack.
---

# BookStack migration

Use `/ima:bookstack-migrate` for the approved SKYNET-149 producer only.

## Installed-version API reference

Before changing BookStack request or response handling, consult the sanitized local [`v25.12.3` API capture](references/bookstack-api-v25.12.3.json) and its [provenance/refresh notes](references/README.md). This capture comes from the installed instance's authenticated `/api/docs.json`; it contains no runtime credentials or session data. Re-capture it after a BookStack upgrade instead of guessing from generic or stale API documentation.

1. Run a dry-run against the versioned spec. It performs read-only Qdrant and working-tree Markdown enumeration, always writes an immutable itemized local report under `.ima/bookstack-migrate/`, persists `inventory.json` as a deterministic manifest plus bounded immutable parts, and does not call BookStack. Record-level source and page-mapping problems are quarantined in the report; filesystem security-boundary failures still fail closed.
2. Run `preflight` for the exact dry-run report. It validates the inventory, current approved sources, BookStack configuration, target shelves, and the membership data needed to preserve existing Shelf assignments without BookStack writes. Newly appended lifecycle records are reported as a deferred delta; any approved-source change or Markdown-tree drift fails closed.
3. After reviewing a passing preflight, an operator may explicitly confirm a deterministic canary of at most ten records. Canary never escalates to full apply.
4. Apply is report-bound, separately confirmed, circuit-broken on systemic failures, and requires the BookStack secret token in the invoking environment. It does not deploy or enable the Cloudflare indexer.
5. Verify the final report before separately handing the target catalog/indexer work to the `ima-memory-search` session.

Configuration classification:

- **Non-secret variables:** `IMA_QDRANT_URL`; BookStack origin through primary `BOOKSTACK_BASE_URL` or backward-compatible `BOOKSTACK_ORIGIN`; and direct client inputs `requestIntervalMs` and `timeoutMs`. Conflicting BookStack URL values fail closed. `requestIntervalMs` defaults to `1,100` ms and must be a positive safe integer no greater than `120,000` ms. `timeoutMs` defaults to `30,000` ms and must be a safe integer from `1` through `120,000` ms. The registered migration tool does not map either client input from an environment variable.
- **Secrets:** `BOOKSTACK_TOKEN_ID`, `BOOKSTACK_TOKEN_SECRET`; keep them outside Git, reports, and chat.
- **Platform binding:** none introduced by this migration tool; `SYNC_COORDINATOR` remains a Worker-session binding outside it.
- **Local-only values:** `IMA_RAG_ROOT`, migration report paths, inventory manifests/parts, and migration locks under `.ima/bookstack-migrate/`.

## Request pacing and operational limits

Each `createBookStackClient` owns one FIFO request-start schedule. The first admitted request starts immediately; later starts default to at least `1,100` ms after the previous start, and idle time does not accumulate burst credits. Concurrent callers of the same client share that schedule. Every client request path shares it, including paginated lists and catalog reads, Shelf reads and writes, page/chapter/book writes, post-write read-backs, and cleanup reads/deletes.

The `1,100` ms default is an operator-selected provisional starting policy inspired by Plane. It is not evidence of an unknown BookStack or proxy quota and does not guarantee avoidance of HTTP `429`. Scheduling is per client only: it does not coordinate independent client instances, processes, migration runs, or unrelated BookStack traffic. For a request count of `n`, minimum pacing alone is approximately `(n - 1) × 1.1 seconds`, plus processing and network time.

The scheduler uses monotonic `performance.now()` by default and supports an injectable clock, strictly positive interval, and abort-aware wait. Timing faults, unsuccessful waits, and cancellation fail closed. Cancellation is checked before admission, after waits, and immediately before fetch; each network timeout starts when its request is issued, not while queued. Cleanup composes its operation and client cancellation signals.

An unexpected HTTP `429` fails closed. During apply, it records the failure and trips the existing systemic-failure breaker for remaining pages; there is no retry or automatic interval adjustment. The synthetic 1,566-page model (all unchanged, zero writes, zero synthetic-quota violations, 1,575 starts) is test-only evidence, not a verified deployed quota or a live migration.

Never import the derived `ima-knowledge` chunks. Eligible current Markdown files under `IMA_RAG_ROOT` are the source regardless of Git status; immutable inventory hashes and repeat enumeration reject source drift. Apply uses one bounded target catalog, preserves and deduplicates Shelf membership updates, records recoverable item conflicts, and stops further writes after systemic authorization, rate-limit, transport, server, or response failures. Guest/public policy and inherited content permissions are operator-owned environment configuration and are not inspected or changed by the migrator. Never delete Qdrant or working-tree Markdown source material. Separately confirmed, report-bound cleanup may delete only BookStack Pages created by a final or canary report after inventory/hash and current-body verification.
