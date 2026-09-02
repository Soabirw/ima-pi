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
