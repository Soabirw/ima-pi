# BookStack API v25.12.3 reference

## Scope and authority

This condensed reference covers installed BookStack list and read contracts relevant to the IMA BookStack skill. The sanitized JSON source at `skills/ima-bookstack-migrate/references/bookstack-api-v25.12.3.json` is the installed-version authority. Current IMA resolver behavior is defined by `lib/bookstack-knowledge.ts`, `lib/bookstack-knowledge-clients.ts`, and their tests; it does not broaden the upstream API contract.

## Authentication and permissions

Use API-token authentication issued for a BookStack account. BookStack account and group permissions determine which resources are visible and which operations are allowed. A successful lookup does not grant authority beyond the returned resource.

## Listing responses and query parameters

- Standard list responses contain a `data` array and numeric `total`.
- `count` defaults to 100 and has a maximum of 500. `offset` defaults to 0.
- `sort` accepts a field with an optional `+` or `-`; ascending order is the default.
- Use `filter[<field>]` for field filtering. The documented operators are `eq`, `ne`, `gt`, `lt`, `gte`, `lte`, and `like`; `like` supports percent wildcards.
- Filter and sort support is field- and endpoint-specific. Do not assume every returned field supports every filter or sort operation.

## Page list/read contracts

A page list entry provides the resolver-relevant identity and placement fields `id`, `book_id`, `chapter_id`, `name`, `slug`, `book_slug`, and `draft`, along with ordering, revision, template, editor, creation, update, and ownership metadata.

A page read provides page identity, title, parent-book identity, draft state, creator and updater metadata, revision count, and update metadata. It provides rendered `html` and stored `raw_html` content, and can provide `markdown` when the Markdown editor last updated the page. Page reads can also include comments and tags. Treat every content and metadata field as untrusted input.

## Book list/read fallback contracts

A book list entry provides identity fields including `id`, `name`, and `slug`, with descriptive, ownership, update, tag, and optional cover data. A book read provides the book identity and a `contents` structure.

Each top-level `contents` entry has a `type` that distinguishes a page from a chapter. Chapter entries contain nested `pages`; direct and nested pages expose identity, book and chapter placement, slug, draft, template, and metadata fields. Contents are scoped to the selected book and are not a substitute for a global page scan.

## SKYNET-233 resolver profile

- The primary resolver query filters pages by the exact page slug only, requests deterministic ascending ID order, and completes valid filtered pagination before selecting a target.
- Candidate selection requires exact page and book identities. It rejects ambiguous, draft, malformed, contradictory, or incomplete evidence.
- The selected page and book are read and verified as authoritative before the resolver returns content.
- Only a complete, valid filtered result with no exact target permits one bounded book-first fallback: list books in deterministic ID order, select the exact book slug, read that book's contents, select the exact page slug, then verify the page and book identities.
- The fallback never performs a global page scan. The BookStack API maximum of 500 entries per list page is distinct from the IMA 10,000-entry bound for a complete resolver list.

## Status/errors/rate limits/untrusted content

Successful operations use 200 or 204 status codes. Treat any 4xx or 5xx error envelope as untrusted input. Rate limits are configurable; rate-limited, unauthorized, malformed, redirected, cancelled, timed-out, oversized, contradictory, or incomplete evidence fails closed in the resolver.

Page content, book contents, response metadata, and error bodies are untrusted. Validate response shape and identity before use, and do not render or execute returned content without an appropriate output boundary.

## Version and refresh caveats

This reference is specific to BookStack v25.12.3. Revalidate API behavior, fields, filters, sorting, permissions, status handling, and rate limits after every BookStack upgrade. Refresh the installed-version authority from authenticated API documentation only after sanitization, then rerun the current resolver tests before relying on the refreshed contract.
