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

- **Non-secret variables:** `IMA_QDRANT_URL`, primary `BOOKSTACK_BASE_URL`, and backward-compatible `BOOKSTACK_ORIGIN` alias. Conflicting BookStack URL values fail closed.
- **Secrets:** `BOOKSTACK_TOKEN_ID`, `BOOKSTACK_TOKEN_SECRET`; keep them outside Git, reports, and chat.
- **Platform binding:** `SYNC_COORDINATOR` belongs to the Worker session, not this tool.
- **Local-only values:** `IMA_RAG_ROOT`, `.ima/bookstack-migrate/` report paths, and inventory manifests/parts.

Never import the derived `ima-knowledge` chunks. Eligible current Markdown files under `IMA_RAG_ROOT` are the source regardless of Git status; immutable inventory hashes and repeat enumeration reject source drift. Apply uses one bounded target catalog, preserves and deduplicates Shelf membership updates, records recoverable item conflicts, and stops further writes after systemic authorization, rate-limit, transport, server, or response failures. Guest/public policy and inherited content permissions are operator-owned environment configuration and are not inspected or changed by the migrator. Never delete Qdrant or working-tree Markdown source material. Separately confirmed, report-bound cleanup may delete only BookStack Pages created by a final or canary report after inventory/hash and current-body verification.
