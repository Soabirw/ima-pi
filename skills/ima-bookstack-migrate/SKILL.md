---
name: ima-bookstack-migrate
description: Safely prepare, run, and verify the approved Qdrant and Git Markdown migration to BookStack.
---

# BookStack migration

Use `/ima:bookstack-migrate` for the approved SKYNET-149 producer only.

1. Run a dry-run against the versioned spec. It performs read-only Qdrant and Git enumeration, writes an immutable local report under `.ima/bookstack-migrate/`, and does not call BookStack.
2. Review its source counts, source fingerprint, conflicts, and intended hierarchy. Obtain a second explicit operator confirmation for the exact report before `apply`.
3. Apply is report-bound and requires the BookStack secret token in the invoking environment. It does not deploy or enable the Cloudflare indexer.
4. Verify the final report before separately handing the target catalog/indexer work to the `ima-memory-search` session.

Configuration classification:

- **Non-secret variables:** `IMA_QDRANT_URL`, `BOOKSTACK_ORIGIN`.
- **Secrets:** `BOOKSTACK_TOKEN_ID`, `BOOKSTACK_TOKEN_SECRET`; keep them outside Git, reports, and chat.
- **Platform binding:** `SYNC_COORDINATOR` belongs to the Worker session, not this tool.
- **Local-only values:** `IMA_RAG_ROOT` and `.ima/bookstack-migrate/` report paths.

Never import the derived `ima-knowledge` chunks, untracked files, or a dirty Git tree. Never delete Qdrant, Git, or BookStack source material through this command.
