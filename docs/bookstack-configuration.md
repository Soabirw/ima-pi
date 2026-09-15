# BookStack shared-memory configuration

## Status

> **Historical T2 record.** This preserves the SKYNET-98 / T2 configuration snapshot and sanitized acceptance evidence. It is not current installation/readiness evidence, a Pi runtime-store migration, a Qdrant cutover, a shared-service rollout, or cleanup authority. For current readiness, use the [new-developer guide](guide.md#new-developer-shared-memory-readiness).

SKYNET-98 / T2 configured the approved non-public shared-memory area in the
existing BookStack instance. This runbook records the configuration and
sanitized API evidence; it is not a Pi runtime-store migration or Qdrant
cutover.

The operator accepted existing populated shelves and books as evidence that
BookStack CRUD is functioning. Access policy, restricted access, and revision
retention are administrator-managed and accepted for T2; this phase does not
independently re-certify them.

## Scope and boundaries

This unit created only the following BookStack resources:

- one `Shared Development Memory` shelf;
- one `Lifecycle Artifacts` book;
- one `Institutional Knowledge` book; and
- two clearly labelled synthetic acceptance pages.

It did not provision BookStack, change server or site-wide settings, create or
alter accounts, roles, tokens, registration mappings, or group mappings, change
unrelated content or permissions, enable webhooks, or change Pi/Qdrant routing.

## Credential and transport handling

The one-shot verification tooling reads these values from the terminal
environment only:

- `BOOKSTACK_BASE_URL`
- `BOOKSTACK_TOKEN_ID`
- `BOOKSTACK_TOKEN_SECRET`

No value is stored in this repository, this runbook, or lifecycle evidence.
The configured base URL was validated as a credential-free HTTPS origin. Native
requests used the same origin, refused redirects, used bounded timeouts and
response sizes, and did not log protected response bodies.

## Configured taxonomy

| Resource | Native type | ID | Relationship |
| --- | --- | ---: | --- |
| Shared Development Memory | `bookshelf` | 65 | References books 63 and 64 only. |
| Lifecycle Artifacts | `book` | 63 | Member of shelf 65. |
| Institutional Knowledge | `book` | 64 | Member of shelf 65. |

Existing BookStack content was not adopted, overwritten, or changed. The IDs
are operational reconciliation evidence, not credentials.

## Resource-level access controls

The instance's native `Public` role was confirmed as ID `4` with system name
`public`. For each new shelf and book, the native content-permissions endpoint
has an explicit Public-role denial for `view`, `create`, `update`, and `delete`.

| Resource | Content-permission target | Public role 4 |
| --- | --- | --- |
| Lifecycle Artifacts | `book/63` | All four operations denied. |
| Institutional Knowledge | `book/64` | All four operations denied. |
| Shared Development Memory | `bookshelf/65` | All four operations denied. |

Only `role_permissions` was sent on each update. Existing role entries were
preserved, while `owner_id` and `fallback_permissions` were omitted. Native
responses confirmed that owner and fallback settings remained unchanged.

The two synthetic pages have no direct role override and inherit their book
permissions. No account, role, or API privilege was added to make acceptance
pass. The administering operator remains responsible for effective
account/group access policy.

## Synthetic API acceptance evidence

The pages below contain no operational lifecycle material. Each was created,
updated once with a distinct revision marker, read immediately, found through
native authorized search, and exported through the Markdown endpoint.

| Book | Page ID | Latest revision marker | Read/search/export |
| --- | ---: | --- | --- |
| Lifecycle Artifacts | 66 | `SKYNET-98-revision-5e2ea113-f4eb-4486-b926-43a4c5d95e5c` | Passed; Markdown export was `application/octet-stream`, 293 bytes. |
| Institutional Knowledge | 67 | `SKYNET-98-revision-f729163c-ec86-4c56-bc98-94b7eb22e18a` | Passed; Markdown export was `application/octet-stream`, 297 bytes. |

The matching initial markers remain in the pages as the preceding synthetic
revision. A portable Markdown export is not a backup, restoration test, full
revision export, or guarantee of indefinite retention.

## Anonymous-denial evidence

Unauthenticated native API requests returned `401` for the new shelf, both
books, both pages, each marker search, and each page Markdown export.
Unauthenticated HTTP navigation to `/books`, `/shelves`, and `/search` returned
a same-origin `302` redirect to `/login`.

These checks supplement the operator-managed access boundary; no separate
restricted-account or browser-route certification is required for T2.

## Operator-managed acceptance

The operator accepted the following evidence and boundaries for this unit:

- Existing populated BookStack shelves and books are sufficient evidence that
  the installed system's CRUD capability is working.
- Access policy and restricted access are managed and already verified by the
  BookStack administrator. This phase does not change or independently test
  those settings.
- The administrator verified the revision system and accepts the current/default
  revision settings as sufficient for T2. This phase neither reads nor changes
  `REVISION_LIMIT`.

This decision does not claim backup/recovery certification, indefinite revision
history, webhook delivery, synchronization, or runtime cutover. Do not enable
public access globally for any further T2 check.

## Webhooks and runtime routing

Webhook configuration and delivery verification are deferred to T4, where a
hosted receiver is available. No personal-machine endpoint is authorized here.

BookStack is not Pi's runtime content store in this unit. Package-native Qdrant
lifecycle routing remains in effect until separately verified migration and
cutover.

## Reconciliation and historical cleanup

This is a historical T2 cleanup boundary, not a rollback procedure for readiness documentation, rollout, or cutover. Do not use cleanup, deletion, revision removal, permission changes, or resource removal as rollback for SKYNET-223 documentation/readiness work or a future cutover. That rollback is documentation-only, non-destructive, and read-only; follow the [new-developer guide](guide.md#documentation-only-non-destructive-rollback).

If a future operation is interrupted, first reconcile the recorded resource IDs
and current BookStack state. Do not blindly retry creates or replace a shelf's
book list.

For an independently approved rollback of the original T2 resource-creation
unit—not SKYNET-223—obtain explicit cleanup approval, verify that no team
content has been added, and remove only the resources created above. Never
delete pre-existing content, clear revisions, reset global permissions, or
weaken access controls to simplify cleanup. Revert this runbook and its README
link independently of remote resource cleanup.

## Verification limits

The API checks are account-specific. Access and revision acceptance are
operator-managed as recorded above, rather than independently certified here.
This record does not establish full backup/recovery, indefinite history,
webhook delivery, synchronization, or Cloudflare discovery freshness.
