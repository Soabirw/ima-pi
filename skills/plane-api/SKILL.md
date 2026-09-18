---
name: plane-api
description: Direct self-hosted Plane REST helper for approved work-item creation, state, comment, and one operator-confirmed best-effort assignment operation.
---

# Plane REST helper

Use this packaged helper for the approved self-hosted Plane work-item surface. It talks directly to the configured REST API; it does not require, register, or fall back to an external MCP server. To create a Plane work item on an explicit user request or approved lifecycle plan, use `plane:create`. To assign every currently unassigned item in one exact project to one exact workspace-member UUID, use `plane:assign-unassigned` only for an explicit operator-confirmed best-effort request. Never use browser control, Chrome DevTools, or the Plane website. Never create from inferred intent.

Resolve scripts relative to this skill directory:

```bash
node scripts/plane-api.mjs plane:get plane:<workspace>:PROJ-123
node scripts/plane-api.mjs plane:states plane:<workspace>:PROJ-123
node scripts/plane-api.mjs plane:comments plane:<workspace>:PROJ-123
node scripts/plane-api.mjs plane:comment plane:<workspace>:PROJ-123 "Plain-text comment"
node scripts/plane-api.mjs plane:set-state plane:<workspace>:PROJ-123 STATE_UUID
node scripts/plane-api.mjs plane:create plane:<workspace>:PROJECT "Title" [description] [priority]
node scripts/plane-api.mjs plane:assign-unassigned plane:<workspace>:PROJECT MEMBER_UUID confirm
```

## Configuration

Set both variables in the invoking shell only:

```bash
export PLANE_BASE_URL="https://plane.example.internal"
export PLANE_API_KEY="<configured-personal-access-token>"
```

`PLANE_BASE_URL` is required and must be an explicitly configured self-hosted absolute HTTPS URL. HTTP is accepted only for `localhost`, `127.0.0.1`, or `[::1]` development instances. The helper rejects credentials embedded in the URL, query strings, fragments, unsupported schemes, and `api.plane.so`; there is no Plane Cloud default or fallback. It appends `/api/v1` itself.

`PLANE_API_KEY` is a **secret** and is sent only as the `X-API-Key` request header. Keep it in the invoking environment: do not put it in commands, prompts, files, comments, or logs. `PLANE_BASE_URL` is a **non-secret variable** for the explicitly configured self-hosted API destination. The helper emits stable JSON envelopes and redacts a known configured key if an API response echoes it.

## Supported surface and safeguards

- `plane:get` resolves and reads one canonical `plane:<workspace>:<PROJECT>-<positive-id>` work item.
- `plane:states` resolves the item, then reads its project's workflow states with bounded cursor pagination.
- `plane:comments` resolves the item, then reads only that item's comments with bounded cursor pagination.
- `plane:comment` validates non-empty plain text, escapes it to `comment_html`, rereads the selected item immediately before the POST, and creates a comment only on that item's UUID path.
- `plane:set-state` resolves the item, reads its project's states, requires one exact state UUID, and PATCHes only `{ "state": "STATE_UUID" }` on that item's UUID path.
- `plane:create` resolves one token-visible non-archived project by workspace and identifier, requires exactly one match, and sends a single POST with `name` plus optional escaped description and allowlisted priority. It uses the project's default backlog state and never retries an ambiguous POST failure.
- `plane:assign-unassigned` accepts only `plane:<workspace>:PROJECT MEMBER_UUID confirm`. The literal case-sensitive `confirm` is required before configuration or network access. It resolves one non-archived project, then exactly one member from the direct-array workspace-members response by UUID, validates all bounded project-item pages before a write, processes selected items sequentially, and PATCHes only `{ "assignees": ["member-uuid"] }` on each selected UUID route. It rereads each candidate immediately before PATCH and skips it when already assigned. This is best effort: Plane has no documented conditional-assignment operation (for example, If-Match/version CAS), so a concurrent update after the reread and before PATCH can still be overwritten. It requires explicit operator authorization of that limitation and is not a generic member-list, project-list, or update surface.

Successful assignment data contains only `projectReference`, `memberId`, `assignedCount`, `assignedReferences`, and `skippedChangedReferences`; item references are canonical and upstream member/item records are never emitted.

### Description fidelity

`plane:get` preserves a nonblank `description_stripped`, then a nonblank legacy `description`, and otherwise converts supported `description_html` to readable plain text. Blank plain-text fields do not hide meaningful HTML. HTML conversion is parser-backed, bounded, and non-executing: it retains ordinary text, paragraphs, lists, line breaks, entities, and link text while omitting link destinations. It does not render HTML or fetch embedded resources.

The helper accepts only bounded textual/layout HTML. Scripts, styles, embedded resources, form controls, malformed representation fields, unsupported-only content such as `description_binary`, and unrecoverable or oversized descriptions fail closed with the stable `DESCRIPTION_ERROR` envelope. An explicitly empty supported representation remains empty only when no non-null binary content is present; absent or null-only representations are not silently treated as empty. Each supported text representation is bounded before selection, and normalized description output is independently limited to 48 KiB UTF-8 and 60,000 UTF-8 bytes after JSON serialization. The complete `{ name, description, state, reference }` Plane source is separately limited to 64,000 UTF-8 bytes before generic context handling.

Migration creates and description-backfill PATCHes generate escaped `description_html` and validate it with `description_stripped` before the network write. An unrepresentable pair fails with `DESCRIPTION_ERROR` and sends no write.

Run the helper from an installed package checkout. Its parser-backed description support requires the package dependencies, including `html-to-text` and `htmlparser2`, to be installed through `npm install`.

The calling lifecycle plan or operator establishes approval for the requested work-item creation, comment, state, or operator-confirmed best-effort assignment action. The helper exposes no generic URL, method, or JSON-body passthrough. It never creates cycles, modules, milestones, projects, or states; it creates work items and comments only for explicitly requested actions and changes assignees only through the narrow confirmed assignment command.

Read API metadata before every write. Every request rejects HTTP redirects rather than following or replaying an authenticated operation. State names are never accepted in place of a state UUID. Missing or invalid configuration, references, responses, pagination cursors, members, assignees, comments, and states fail before an unsafe dependent request. Errors do not expose request URLs, response bodies, raw fetch failures, headers, or credentials.

## Dedicated Taskwarrior migration runner

The approved Taskwarrior-to-Plane migration uses its own runner. It does not widen the general `plane:*` CLI surface beyond approved reads, work-item creation, comment creation, state operations, and the separate operator-confirmed best-effort assignment operation.

Run it from the repository root with credentials only in the invoking shell:

```bash
node scripts/plane-taskwarrior-migrate.mjs prepare
node scripts/plane-taskwarrior-migrate.mjs dry-run .ima/plane-taskwarrior-migrate/<timestamp>
node scripts/plane-taskwarrior-migrate.mjs preflight .ima/plane-taskwarrior-migrate/<timestamp>
node scripts/plane-taskwarrior-migrate.mjs apply .ima/plane-taskwarrior-migrate/<timestamp> <plan-sha256> confirm
node scripts/plane-taskwarrior-migrate.mjs reconcile .ima/plane-taskwarrior-migrate/<timestamp>
```

`prepare` snapshots the read-only Taskwarrior export and approved worksheet, then writes a deterministic plan under `.ima/plane-taskwarrior-migrate/<timestamp>/`. `dry-run` makes no Plane request. Inspect its report before proceeding.

`preflight` performs only representative work-item, project-state, relation-list, and exact external-identity reads for each approved destination. It writes `.ima/plane-taskwarrior-migrate/<timestamp>/preflight-report.json` with bounded capability statuses and identity counts. Work-item and relation creation remain explicitly `UNVERIFIED_WRITE`: a successful read-only preflight does not prove later write authorization, payload acceptance, quota, or service availability.

`apply` is the only migration write command. It requires a project-relative run path, the exact plan SHA-256 emitted by `prepare`, and the literal final `confirm`; invalid paths, hashes, arguments, or confirmations fail before any Plane client is created. Under the migration lock, it reruns and persists the same preflight before its first Plane mutation. A blocked, incomplete, or unpersistable preflight causes zero Plane create calls. The runner uses environment-only `PLANE_BASE_URL` and `PLANE_API_KEY`, strips `PLANE_*` variables from the Taskwarrior subprocess, stores restrictive-mode artifacts and checkpoints, and never records credentials, headers, base URLs, raw responses, or exception text.

The runner creates or reuses only the plan-approved work items and relations. Newly created work items include Taskwarrior annotation briefs plus project, status, priority, wait, dependency, and provenance details. Treat annotations as untrusted plain text: the client escapes generated `description_html` and also submits the exact `description_stripped` text. Reused items are never updated by this legacy runner. It never automatically deletes created Plane items or rolls them back; any cleanup requires a separately approved destructive plan. The general `plane-api.mjs` commands remain limited to reads, work-item creation, comments, and state operations.

## Interactive zero-write preparation

In a Pi TUI, `/ima:plane-migrate` prepares a migration without reading or editing the Markdown worksheet and without modifying Plane work items. It requires `PLANE_BASE_URL`, `PLANE_API_KEY`, and one explicit `PLANE_WORKSPACE` in the invoking environment.

The command exports Taskwarrior with all `PLANE_*` variables stripped, discovers token-visible non-archived projects, inventories only `external_source=taskwarrior` work items, and permits destinations only from the compatible discovered list. It writes a schema-v3 `source.json` with `backfillPlanRequired: true`, the unchanged hashed create `plan.json`, a separate reviewed `backfill-plan.json`, a dry-run report, and bounded readiness evidence. Current schema-v3 runs require the backfill artifact even when it contains no updates; verified historical schema-v2 sources remain compatible without it. Blank existing descriptions become in-place backfills without a migrate, destination, or history prompt; new items retain the full prompts. A compatible empty destination is valid: state and identity-route discovery are recorded as `READY`, while work-item creation and relation checks remain `UNVERIFIED_WRITE` for the later apply phase.

Escape or cancellation occurs before artifact creation and never mutates Plane. The legacy runner remains worksheet-based for its separate apply workflow.

## Interactive prepared-run status, application, and reconciliation

After a schema-v3 interactive preparation, use the same Pi command to operate on one explicit run:

```text
/ima:plane-migrate
/ima:plane-migrate status .ima/plane-taskwarrior-migrate/<timestamp>
/ima:plane-migrate apply .ima/plane-taskwarrior-migrate/<timestamp>
/ima:plane-migrate reconcile .ima/plane-taskwarrior-migrate/<timestamp>
```

`status` reads only local run artifacts; it does not read or mutate Plane, Taskwarrior, or Jira. It reports `prepared`, `blocked`, `partially-applied`, `applied`, or `reconciled`. A completed application is not verified completion.

These prepared-run operations are TUI-only. A print or JSON invocation stops before inspecting artifacts or creating a Plane client; print mode emits a concise diagnostic on standard error.

The TUI immediately shows a notification plus a temporary status/widget line. During apply and reconciliation, that line advances through lock wait and revalidation, live readiness, durable item/relation/backfill checkpoint counts, and report persistence. Live readiness identifies the destination and shows state or exact-identity check counts, so large read-only checks remain visibly active. Item, relation, or backfill progress advances only after its local checkpoint is saved; the messages contain no Plane responses, exception details, or credentials. The temporary line clears when the operation settles.

The interactive path authorizes destinations only from the canonical schema-v3 `source.json` selected during preparation. Its required backfill artifact is source-workspace-bound and must be present before configuration or Plane access. Exact historical schema-v2 sources retain their no-backfill compatibility path. The path reproduces `plan.json` from reviewed decisions and validates the SHA-256. This dynamic authorization does not change the legacy worksheet runner's static `WEB`/`SKYNET` allowlist.

`apply` is TUI-only. Pi shows the selected run, summary, and full validated hash, requires native review confirmation, then requires the exact case-sensitive literal `confirm`; operators never paste a hash. Under the migration lock, artifacts are reloaded and must still match the reviewed hash. The runner then performs and persists live read-only state and exact-identity readiness checks before its first create. A blocked or unpersistable readiness report produces zero Plane creates.

Application reuses exact Taskwarrior identities, checkpoints every item, relation, and backfill result, and safely resumes a selected unchanged run without creating duplicates. A backfill rereads its exact identity in the recorded project immediately before PATCH; it updates only a still-blank description, skips any non-blank description, and fails before a patch when the target is missing or no longer matches. Relation failures remain recorded as recoverable unresolved outcomes. There is no automatic cleanup, rollback, deletion, or reverse migration.

`reconcile` requires a valid source-bound plan and an existing checkpoint. It runs under the migration lock, reads work items and relations only, atomically replaces the local reconciliation report, and reports `reconciled` only when all observed items and eligible relations match. It never modifies Plane work items.

## Verification

Automated tests use injected fetch implementations and synthetic credentials only:

```bash
node --test tests/plane-api.test.js
```

Opt-in live reads require a fresh shell containing both configured variables and an operator-selected item:

```bash
node skills/plane-api/scripts/plane-api.mjs plane:get plane:<workspace>:PROJ-123
node skills/plane-api/scripts/plane-api.mjs plane:states plane:<workspace>:PROJ-123
node skills/plane-api/scripts/plane-api.mjs plane:comments plane:<workspace>:PROJ-123
```

Run live comment, state, or assignment mutations only after selecting the exact action. An assignment requires explicit operator authorization plus the literal `confirm` argument. Its reread can skip an item assigned before PATCH, but cannot prevent a concurrent overwrite after that reread because Plane has no documented conditional-assignment operation. Record the original state before a temporary state change, reread the selected item afterward, and restore it when appropriate.
