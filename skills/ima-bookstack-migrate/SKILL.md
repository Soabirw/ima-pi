---
name: ima-bookstack-migrate
description: Safely prepare, run, and verify the approved Qdrant and working-tree Markdown migration to BookStack.
---

# BookStack migration

Use `/ima:bookstack-migrate` for the approved BookStack migration producer. SKYNET-234 adds a guided entrypoint only; it does not change the runtime migration operations, their report validation, or their safety gates.

## Guided empty-argument workflow (SKYNET-234)

A bare command begins a native Pi conversation, not a parser, coordinator, workflow DSL, or live migration. Load this skill before handling the empty form. The six non-empty command forms remain advanced explicit routes.

### Preparation and canonical packaged spec

For exactly empty invocation arguments, resolve `../../config/bookstack-migrations/shared-dev-memory.json` **from the directory containing this loaded package `SKILL.md`**. Pass that exact resolved package resource as `specPath` for the guided dry-run.

- Never resolve the spec from the caller's working directory, an environment value, a shell expansion, or a supplied path.
- Never select a caller-local same-name shadow spec. The package-relative spec must work when the caller is outside the package checkout.
- If the loaded skill location or exact packaged resource is missing, unreadable, non-regular, changed unexpectedly, or ambiguous, stop before calling the migration tool. Do not fall back to a local spec, ask the operator to author or locate one, or guess a replacement.
- The packaged spec selects the migration schema only. `IMA_RAG_ROOT` and `.ima/bookstack-migrate/` artifacts remain local-only values of the invoking project; resolving the packaged spec does not make the package checkout the migration project.

Preparation makes no migration-tool call or service request. Show the operator a concise preview of the packaged source, local and external effects, configuration classes, exclusions, deferred additions, and the distinct approval gates. Ask for explicit approval to begin this particular read-only dry-run; that approval authorizes no later operation.

### Stages and report routing

Treat report paths, files, source records, configuration, and remote responses as untrusted boundary data. In guided mode, use only exact report paths returned by the migration tool for the route below; never synthesize, normalize, select, or substitute a report path.

1. **Dry-run:** after the preparation approval, call `{ operation: "dry-run", specPath: packagedSpecPath }`. It reads Qdrant and the current Markdown tree, writes an immutable local run, inventory, and itemized dry-run report, and makes no BookStack request or write. Retain the returned `dry-run-report.json` path as the **original dry-run report**.
2. **Review:** stop for the operator to review the original itemized dry-run report, including quarantined, failed, unverified, and excluded outcomes. Do not silently regenerate the report or select another run.
3. **Preflight:** only after a fresh explicit approval for preflight, call `{ operation: "preflight", reportPath: originalDryRunReportPath }`. It may make BookStack catalog and Shelf-membership reads and writes a local preflight report, but makes no BookStack write. The returned preflight report is review evidence only; retain the original dry-run report for subsequent operations.
4. **Canary:** after review of a passing preflight, ask for a new, specific approval covering the exact original dry-run report. Only then call `{ operation: "canary", reportPath: originalDryRunReportPath, confirm: "canary-report" }`. It can write at most ten deterministic records and returns a canary report. Canary approval never authorizes apply.
5. **Canary verification:** after a separate review request, call `{ operation: "verify", reportPath: returnedCanaryReportPath }`. Verify receives the returned canary report, not the original dry-run or preflight report, and checks the report without a BookStack write.
6. **Apply:** normal guided progression reviews the canary and its verification before offering apply. Ask for a separate, specific approval covering the exact original dry-run report, then call `{ operation: "apply", reportPath: originalDryRunReportPath, confirm: "apply-report" }`. Apply never uses the canary or preflight report as input; it revalidates the original approved sources and may make BookStack writes. Canary approval, verification, and any earlier approval never authorize apply. The advanced explicit apply form remains compatible with its existing runtime gate.
7. **Final verification:** after a separate review request, call `{ operation: "verify", reportPath: returnedFinalReportPath }`. Verify receives the returned final report, not the original dry-run or preflight report, and performs no BookStack write.
8. **Optional cleanup:** only after separate review and a fresh explicit approval for the exact eligible creation report, call `{ operation: "cleanup", reportPath: eligibleCreationReportPath, confirm: "cleanup-report" }`. The eligible creation report is the returned canary or final report that records created Pages; never use a dry-run or preflight report. Cleanup may read and delete only eligible report-created Pages after current-body/hash verification. It never alters Shelves, old T2 resources, Qdrant, Markdown sources, or human-edited Pages.

The required routing is therefore: **preflight, canary, and apply receive the original dry-run report; verify receives the returned canary or final report; cleanup receives a separately approved eligible creation report.** A returned path is evidence for only its named next step, never approval for that step.

### Approval, interruption, and data-integrity gates

Keep approvals distinct and operation-specific. A preparation or dry-run approval does not authorize preflight; preflight does not authorize canary; canary and canary verification do not authorize apply; final verification does not authorize cleanup. A literal confirmation token is an implementation input, not a substitute for the current human decision. Never carry approval across reports, reruns, interrupted operations, or sessions.

On cancellation, a failed or non-passing preflight, source identity/hash change, Markdown-tree drift, unavailable or malformed configuration/resource, missing or malformed report, unexpected remote response, or ambiguous recovery state, fail closed: report only the bounded safe condition and stop. Do not retry automatically, regenerate an approved report silently, choose another report, infer a completed write, change configuration, request secrets in chat, run cleanup, or continue to a later stage. After an interrupted canary, apply, or cleanup, preserve the returned evidence for human review; recovery requires a new explicit operator decision and the existing exact report-bound safety checks.

Keep exclusions and deferred additions visible at every review. Record-level Qdrant and page-mapping problems remain itemized quarantines, not eligible pages. Newly appended lifecycle records remain a separately reported deferred delta; they never join the approved original inventory. Derived `ima-knowledge` chunks, source deletion, Cloudflare deployment/indexing, guest/public policy, inherited permissions, normal lifecycle persistence changes, and configuration changes are outside this workflow.

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
