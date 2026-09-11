# BookStack shared-memory tools

SKYNET-84 adds a private Pi-native discovery and authoring path for shared BookStack knowledge. `ima_bookstack_search` queries the private Cloudflare AI Search index, `ima_bookstack_read` retrieves authoritative BookStack content, and `ima_bookstack_write` creates or optimistic-concurrency updates an indexable BookStack page. `/ima:bookstack-search <question>` is the read-focused user entry point.

This feature is BookStack-specific. It does not introduce a generic memory/corpus backend, change Qdrant lifecycle persistence, embed search into BookStack, enable public Cloudflare/MCP endpoints, provision Cloudflare or BookStack, deploy the synchronization Worker, or migrate real content.

## Configuration

Set these only in the invoking developer shell; never commit them or pass secrets as command arguments.

| Setting | Classification | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Non-secret variable | Account containing the private `ima-memory-search` instance. |
| `BOOKSTACK_BASE_URL` | Non-secret variable | Primary credential-free HTTPS BookStack origin. |
| `BOOKSTACK_ORIGIN` | Non-secret variable | Backward-compatible alias for `BOOKSTACK_BASE_URL`; when both are set, unequal values fail closed. |
| `BOOKSTACK_LIFECYCLE_BOOK_ID` | Non-secret variable | Configured BookStack book for `lifecycle` pages. |
| `BOOKSTACK_KNOWLEDGE_BOOK_ID` | Non-secret variable | Configured BookStack book for `ima-knowledge` pages. |
| `CLOUDFLARE_API_MEMORY` | Secret | Cloudflare token scoped to AI Search:Edit and AI Search:Run. |
| `BOOKSTACK_TOKEN_ID` | Secret | BookStack API token ID. |
| `BOOKSTACK_TOKEN_SECRET` | Secret | BookStack API token secret. |
| `SYNC_COORDINATOR` | Platform binding | Worker-only binding; not consumed by these Pi tools. |
| Shell environment | Local-only value | Per-developer configuration location. |

Local Qdrant and Ollama are not required. Cloudflare instance privacy, token issuance, BookStack access policy, configured books, index freshness, and content availability remain external runtime prerequisites. Missing, malformed, denied, or unverifiable configuration fails closed with a stable sanitized code.

## Authoring contract

`ima_bookstack_write` accepts `lifecycle` or `ima-knowledge`, a project, artifact type, title, and Markdown. `lifecycle` additionally requires a lifecycle key. The tool prepends exactly this envelope before the supplied Markdown:

```markdown
---
schema: ima-memory/v1
project: shared-dev-memory
artifact_type: plan
lifecycle_key: shared-dev-memory:manual:human-ai-memory-system:2026-08-31
---
# Page body
```

`project` and `artifact_type` have a 64 UTF-8-byte limit. `lifecycle_key`, when present, has a 512 UTF-8-byte limit. The selected configured book depends only on `corpus`. Updating an existing page requires its exact `sourceId`, `expectedRevisionCount`, and `expectedUpdatedAt`; the tool rereads the page, rejects any mismatch, writes, then verifies the revision advanced. This reduces accidental overwrites but is not an atomic conditional write.

## Search and authoritative reads

Search accepts a natural-language query plus optional exact filters over the five indexed fields: `corpus`, `project`, `artifact_type`, `lifecycle_hash`, and `source_id`. Filter values are limited to a 64 UTF-8-byte prefix. Search returns only bounded excerpts, score, metadata, `source_id`, and a BookStack `/link/<page-id>` canonical URL.

Use `ima_bookstack_read` with the returned `sourceId` when current content matters. It returns bounded Markdown and provenance: canonical URL, title, book/page IDs, creator/updater IDs, revision count, and update time. Do not treat a Cloudflare excerpt as authoritative.

## Safe local verification

Run provider-free checks with synthetic credentials only:

```bash
npm test
git diff --check
```

Live use requires explicit operator-authorized developer credentials in the local environment. Never copy those credentials into a test fixture, command line, repository file, chat, report, or lifecycle artifact.
