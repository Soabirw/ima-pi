---
lifecycle:
  project: "ima-pi"
  lifecycle_key: "ima-pi:lifecycle:memory-two-tier-qdrant-migration-2026-08-25"
  taskwarrior_project: "ima-pi"
  taskwarrior_task: "39"
  taskwarrior_uuid: "0f1bd176-962c-4a6c-8ed8-31c87c3868c5"
  source_refs:
    - "taskwarrior:ima-pi:0f1bd176-962c-4a6c-8ed8-31c87c3868c5"
    - "file:docs/decisions/2026-08-25-shared-qdrant-institutional-corpus-plan.md"
    - "file:docs/decisions/2026-08-26-shared-qdrant-institutional-corpus-implementation.md"
phase: "test"
status: "passed-with-live-environment-gap"
record_type: "lifecycle-test"
date: "2026-08-26"
persistence_note: >-
  Markdown fallback while Vestige lifecycle retrieval is unreliable. This file is the
  reviewable test record; historical Vestige artifact 283859cb-48b7-4641-a42f-c021546a4bfa
  is correlation evidence only.
---

# Test: Pi-native Qdrant institutional-memory corpus (Story A)

## Testing contract

- Node 24 ESM with the built-in `node:test` runner and `node:assert/strict`.
- Canonical full suite: `npm test` -> `node --test tests/*.test.js`.
- Tests are behavior-named and use local record/response factories with injected clients or
  `fetch` boundaries. Unit tests use no real network, filesystem, or timers.
- Runtime verified: Node `v24.15.0`, npm `11.12.1`.

## Test support added

`tests/institutional-memory.test.js` gained six named negative-path tests for:

1. unavailable Qdrant with stable sanitized failure text;
2. missing approved embedding model;
3. incompatible collection vector configuration;
4. malformed and oversized Qdrant responses without response-text exposure;
5. corrupt immutable full-record payload rejection; and
6. arbitrary durable-knowledge collection rejection before any external request.

No production behavior, dependency, configuration, or unsupported test infrastructure changed.

## Behaviors covered

The focused and full suites cover immutable normalization and byte bounds, deterministic IDs and
content hashes, idempotent/concurrent store flow, strict native tool schemas, endpoint validation,
Qdrant/Ollama prerequisites, collection bootstrap, semantic-result and lifecycle-recall detail
exclusion, deterministic full retrieval, direct `ima_context` durable-knowledge integration, and
sanitized error boundaries.

JavaScript/TypeScript external endpoints and responses are applicable security boundaries and are
covered through injected transport tests. SQL, WordPress, PHP, browser, visual-regression, and
Bootstrap paths are outside this Story.

## Verification results

- `node --test tests/institutional-memory.test.js tests/integrations.test.js` — **PASS**: 60 passed, 0 failed, 0 skipped.
- `node --test tests/institutional-memory.test.js` — **PASS**: 23 passed, 0 failed, 0 skipped.
- `npm test` — **PASS**: 464 passed, 0 failed, 1 optional skipped (465 total).
- `git diff --check` — **PASS**: no output, exit 0.

## Live-environment evidence gap

A fresh isolated attempt used a temporary `PI_CODING_AGENT_DIR` with the documented
non-interactive `ima_corpus_status` command. Pi exited before tool invocation because the configured
provider reported `You have no credits remaining`; the temporary agent directory was removed. No live
Qdrant/Ollama result or corpus mutation was produced. This replaces the earlier duplicate-extension
startup observation with a current, separately isolated evidence gap.

Therefore live Qdrant/Ollama status/store/find/recall/get acceptance remains unverified. This is an
environment evidence gap, not a passing live-service result. A reviewer should require an isolated
read-only status result and separately authorized external-write store acceptance before closing the
Story.

## Review handoff

Review from the Taskwarrior Markdown artifact index. Start with the approved plan, then this test
record and the implementation record; inspect the changed files listed there. The recommended next
phase remains:

```text
/ima:review taskwarrior:ima-pi:0f1bd176-962c-4a6c-8ed8-31c87c3868c5
```
