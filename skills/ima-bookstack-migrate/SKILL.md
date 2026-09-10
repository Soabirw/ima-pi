---
name: ima-bookstack-migrate
description: Safely prepare, run, and verify the approved Qdrant and working-tree Markdown migration to BookStack.
---

# BookStack migration

Use `/ima:bookstack-migrate` for the approved SKYNET-149 producer only.

1. Run a dry-run against the versioned spec. It performs read-only Qdrant and working-tree Markdown enumeration, always writes an immutable itemized local report under `.ima/bookstack-migrate/`, persists `inventory.json` as a deterministic manifest plus bounded immutable parts, and does not call BookStack. Record-level source and page-mapping problems are quarantined in the report; filesystem security-boundary failures still fail closed.
2. Review its source counts, source fingerprint, quarantines, conflicts, and intended hierarchy. Obtain a second explicit operator confirmation for the exact report before `apply`.
3. Apply is report-bound and requires the BookStack secret token in the invoking environment. It does not deploy or enable the Cloudflare indexer.
4. Verify the final report before separately handing the target catalog/indexer work to the `ima-memory-search` session.

Configuration classification:

- **Non-secret variables:** `IMA_QDRANT_URL`, `BOOKSTACK_ORIGIN`.
- **Secrets:** `BOOKSTACK_TOKEN_ID`, `BOOKSTACK_TOKEN_SECRET`; keep them outside Git, reports, and chat.
- **Platform binding:** `SYNC_COORDINATOR` belongs to the Worker session, not this tool.
- **Local-only values:** `IMA_RAG_ROOT`, `.ima/bookstack-migrate/` report paths, and inventory manifests/parts.

Never import the derived `ima-knowledge` chunks. Eligible current Markdown files under `IMA_RAG_ROOT` are the source regardless of Git status; immutable inventory hashes and repeat enumeration reject source drift. Never delete Qdrant or working-tree Markdown source material. Separately confirmed, report-bound cleanup may delete only BookStack Pages created by that report after inventory/hash and current-body verification.
