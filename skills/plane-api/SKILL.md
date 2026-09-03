---
name: plane-api
description: Direct self-hosted Plane REST helper for approved work-item, state, and comment operations.
---

# Plane REST helper

Use this packaged helper for the approved self-hosted Plane work-item surface. It talks directly to the configured REST API; it does not require, register, or fall back to an external MCP server.

Resolve scripts relative to this skill directory:

```bash
node scripts/plane-api.mjs plane:get plane:<workspace>:PROJ-123
node scripts/plane-api.mjs plane:states plane:<workspace>:PROJ-123
node scripts/plane-api.mjs plane:comments plane:<workspace>:PROJ-123
node scripts/plane-api.mjs plane:comment plane:<workspace>:PROJ-123 "Plain-text comment"
node scripts/plane-api.mjs plane:set-state plane:<workspace>:PROJ-123 STATE_UUID
```

## Configuration

Set both variables in the invoking shell only:

```bash
export PLANE_BASE_URL="https://plane.example.internal"
export PLANE_API_KEY="<configured-personal-access-token>"
```

`PLANE_BASE_URL` is required and must be an explicitly configured self-hosted absolute HTTPS URL. HTTP is accepted only for `localhost`, `127.0.0.1`, or `[::1]` development instances. The helper rejects credentials embedded in the URL, query strings, fragments, unsupported schemes, and `api.plane.so`; there is no Plane Cloud default or fallback. It appends `/api/v1` itself.

`PLANE_API_KEY` is sent only as the `X-API-Key` request header. Keep it in the environment: do not put it in commands, prompts, files, comments, or logs. The helper emits stable JSON envelopes and redacts a known configured key if an API response echoes it.

## Supported surface and safeguards

- `plane:get` resolves and reads one canonical `plane:<workspace>:<PROJECT>-<positive-id>` work item.
- `plane:states` resolves the item, then reads its project's workflow states with bounded cursor pagination.
- `plane:comments` resolves the item, then reads only that item's comments with bounded cursor pagination.
- `plane:comment` validates non-empty plain text, escapes it to `comment_html`, rereads the selected item immediately before the POST, and creates a comment only on that item's UUID path.
- `plane:set-state` resolves the item, reads its project's states, requires one exact state UUID, and PATCHes only `{ "state": "STATE_UUID" }` on that item's UUID path.

The calling lifecycle plan or operator establishes approval for the requested comment or state action. The helper does not add a write-level `--confirm` prompt, and it exposes no generic URL, method, or JSON-body passthrough. It never creates cycles, modules, milestones, projects, work items, states, or comments other than the explicitly requested comment action.

Read API metadata before every write. Every request rejects HTTP redirects rather than following or replaying an authenticated operation. State names are never accepted in place of a state UUID. Missing or invalid configuration, references, responses, pagination cursors, comments, and states fail before an unsafe dependent request. Errors do not expose request URLs, response bodies, raw fetch failures, headers, or credentials.

## Dedicated Taskwarrior migration runner

The approved Taskwarrior-to-Plane migration uses its own runner. It does not widen the general `plane:*` CLI surface.

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

The runner creates or reuses only the plan-approved work items and relations. It never automatically deletes created Plane items or rolls them back; any cleanup requires a separately approved destructive plan. The general `plane-api.mjs` commands remain limited to read, comment, and state operations.

## Interactive zero-write preparation

In a Pi TUI, `/ima:plane-migrate` prepares a migration without reading or editing the Markdown worksheet and without modifying Plane work items. It requires `PLANE_BASE_URL`, `PLANE_API_KEY`, and one explicit `PLANE_WORKSPACE` in the invoking environment.

The command exports Taskwarrior with all `PLANE_*` variables stripped, discovers token-visible non-archived projects, inventories only `external_source=taskwarrior` work items, and permits destinations only from the compatible discovered list. It writes a schema-v2 `source.json`, the existing plan shape, a dry-run report, and bounded readiness evidence. A compatible empty destination is valid: state and identity-route discovery are recorded as `READY`, while work-item creation and relation checks remain `UNVERIFIED_WRITE` for the later apply phase.

Escape or cancellation occurs before artifact creation and never mutates Plane. The legacy runner remains worksheet-based for its separate apply workflow.

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

Run live comment or state mutations only after selecting the exact item and action, record the original state before a temporary state change, reread the selected item afterward, and restore it when appropriate.
