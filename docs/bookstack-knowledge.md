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

## Read-first onboarding and operation prerequisites

Package/resource discovery is not shared-memory access: seeing the package's commands or skills does not prove Cloudflare or BookStack access. Follow this read-first journey before relying on shared content:

1. Use `/ima:bookstack-search` or `ima_bookstack_search` only to discover a bounded, derived candidate and its `sourceId`.
2. Use `ima_bookstack_read` with that `sourceId` when current content matters. Its authorized current read and provenance, not the search excerpt, establish authority.
3. If the read is denied, missing, malformed, or unverifiable, stop. Do not quote or promote a returned snippet as authoritative content.
4. Use `ima_bookstack_write` only for explicit general BookStack authoring. Creation requires no `sourceId`, `expectedRevisionCount`, or `expectedUpdatedAt`; an update requires all three. Even when writing a `lifecycle` corpus page, it is not managed lifecycle persistence and cannot select, create, change, or bypass a provider pin.

Both creation and updates require a valid approved destination/book context, authorized BookStack access, validated content, and successful direct verification.

| Operation | Shared-service prerequisites | Owner role | Stop gate |
| --- | --- | --- | --- |
| Candidate discovery | Private Cloudflare search configuration and authorization | Shared-service administrator and developer | Missing access, configuration, or usable candidate stops discovery. |
| Authoritative current read | A candidate `sourceId` or a supported URL plus authorized BookStack access | Authorized developer | A denied or unverifiable read stops the claim. |
| Create a BookStack page | `sourceId`, `expectedRevisionCount`, and `expectedUpdatedAt` are all absent | Authorized BookStack author | Stop if any of those fields is supplied or a common authoring control fails; do not substitute lifecycle persistence. |
| Update an existing BookStack page | Exact `sourceId`, `expectedRevisionCount`, and `expectedUpdatedAt`; the expected revision values match the reread page | Authorized BookStack author | Stop on missing or mismatched concurrency proof or a common authoring control failure; do not substitute lifecycle persistence. |
| Managed lifecycle persistence | User-confirmed provider selection or valid pin and that provider's prerequisites | Lifecycle operator and provider owner | Use the [lifecycle authority contract](guide.md#lifecycle-authority-memory-and-integrations); no fallback, repin, or provider mixing. |

The configuration table above classifies every shared-memory setting: non-secret variables stay credential-free, secrets stay out of source control and command arguments, `SYNC_COORDINATOR` remains a Worker platform binding, and the invoking shell remains local-only. For the complete onboarding, readiness gates, and non-destructive rollback boundary, see the [new-developer guide](guide.md#new-developer-shared-memory-readiness).

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

`project` and `artifact_type` have a 64 UTF-8-byte limit. `lifecycle_key`, when present, has a 512 UTF-8-byte limit. The selected configured book depends only on `corpus`. Both creation and update require a valid approved destination/book context, authorized BookStack access, validated content, and successful direct verification.

**Create.** `ima_bookstack_write` creates only when `sourceId` is absent and `expectedRevisionCount` and `expectedUpdatedAt` are also absent.

**Update.** Updating an existing page requires its exact `sourceId`, `expectedRevisionCount`, and `expectedUpdatedAt`; the tool rereads the page, rejects any mismatch, writes, then verifies the revision advanced. This reduces accidental overwrites but is not an atomic conditional write.

## Search and authoritative reads

Search accepts a natural-language query plus optional exact filters over the five indexed fields: `corpus`, `project`, `artifact_type`, `lifecycle_hash`, and `source_id`. Filter values are limited to a 64 UTF-8-byte prefix. Search returns only bounded excerpts, score, metadata, `source_id`, and a BookStack `/link/<page-id>` canonical URL.

Use `ima_bookstack_read` with the returned `sourceId` when current content matters. It returns bounded Markdown and provenance: canonical URL, title, book/page IDs, creator/updater IDs, revision count, and update time. Do not treat a Cloudflare excerpt as authoritative.

### URL reads

`ima_bookstack_read` preserves existing `sourceId` reads and also accepts one `url` target. Supply exactly one of `sourceId` or `url`; provider-facing schema exposes both bounded properties, while local validation rejects missing or combined targets.

The only supported URL path is `/books/{bookSlug}/page/{pageSlug}` at the exact configured HTTPS BookStack origin. That origin is the credential-free **non-secret variable** `BOOKSTACK_BASE_URL`, or the compatible **non-secret variable** `BOOKSTACK_ORIGIN`; if both are set, they must match. The UI URL is parsed and validated before I/O, but is never fetched.

Authenticated BookStack API page listings are directly filtered by the exact page slug. Pagination covers matching slugs only—there is no global page scan. The resolver selects the exact book/page identity and verifies authoritative page and book detail before it returns bounded content and provenance. A bounded book-first fallback is permitted only after a complete, valid filtered result contains zero exact targets.

BookStack account and group authorization remain the authority for access. Malformed, ambiguous, draft, unauthorized, redirected, rate-limited, cancelled, timed-out, oversized, contradictory, or incomplete evidence fails closed and never starts fallback. URL reads do not fetch arbitrary URLs, support `/link/{id}`, scrape HTML, use Cloudflare as fallback, retry, cache, or represent the result as an atomic snapshot.

## Safe local verification

Run provider-free checks with synthetic credentials only:

```bash
npm test
git diff --check
```

Live use requires explicit operator-authorized developer credentials in the local environment. Never copy those credentials into a test fixture, command line, repository file, chat, report, or lifecycle artifact.
