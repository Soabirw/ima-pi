# Serena lifecycle provider (T15)

> **Additive provider capability:** This function-based Serena lifecycle record, client, and provider is independently usable only by a caller that has already selected Serena. It is not live lifecycle selection or routing. T9 exclusively owns preferences, user confirmation, provider selection, fallback, durable pins, live routing, and dedicated-session construction.

The provider persists an immutable lifecycle record, gets an exact reference, recalls a bounded exact lifecycle selection, and read-only reconciles an exact reference. It reserves the versioned `ima-serena-lifecycle-v1` memory-name namespace. It does not create or select a Serena project, use a Taskwarrior project as Serena identity, alter preferences or pins, fall back to another provider, repair or migrate evidence, delete memories or locks, retry an uncertain write, or activate live routing.

## Approved scope and evidence

The approved canonical source is `plane:ima:SKYNET-210` with lifecycle key `ima-pi:plane:ima:SKYNET-210`. Approved evidence is the plan artifact `46b08007-e96c-5112-8b3d-5bfdb3e63793`, corrected final PASS test artifact `ac8dd9d6-7a5a-5a4f-b14d-efab42f3ddbf`, and final APPROVE rereview artifact `702612f3-875e-5baf-865e-ebbdc24a6104`.

Those source identifiers, lifecycle keys, artifact IDs, caller-provided project identity, selections, and references are **non-secret inputs/evidence values**. They are validated and are not configuration credentials.

## Operation, result, and reference contracts

- `persist(request, signal?)` snapshots and validates the canonical lifecycle request, then returns a verified `stored` or `unchanged` result only after the required proof. A same immutable target with a different validated request is `serena_target_conflict`; it is never overwritten.
- `get(reference, signal?)` activates the exact Serena project, finds exactly the referenced memory name, reads it, and verifies the complete reference and record. It is read-only.
- `reconcile(reference, signal?)` is the same read-only exact-reference operation as `get`, including when invoked by a fresh provider instance.
- `recall(selection, signal?)` accepts only an exact lifecycle key, optional lifecycle phase, and a limit of 1–20. It returns only complete verified records or one bounded blocked result; it never returns authoritative partial evidence.

A verified result carries detached immutable evidence: provider/schema, project fingerprint and Serena project name, deterministic memory name/logical ID/record key, artifact ID/nonce, content/request/canonical hashes, lifecycle key/phase, summary/artifact/identity/source references, timestamp, and a detached exact reference. A reference binds the project fingerprint, memory name, all record identities and hashes, lifecycle key, phase, and nonce. Results and inputs are strict own-data projections; malformed, inherited, sparse, accessor-backed, or later-mutated values fail closed or cannot change an in-flight operation.

## Exact Serena protocol

The client accepts only advertised schemas for these tools:

- `activate_project({ project: string })`
- `list_memories({})` (the advertised optional `topic: string` is not used)
- `read_memory({ memory_name: string })`
- `write_memory({ memory_name: string, content: string })` (the advertised optional `max_chars: integer` is not used)

It accepts only one bounded text response per call. Activation succeeds only when the first line is exactly:

```text
The project with name '<projectName>' at <projectPath> is activated.
```

A bounded remainder is permitted but not used as activation authority. A created-project receipt, any prefix/suffix/lookalike, error response, unsupported/missing/extra tool schema, or unavailable project fails closed.

`list_memories` must return a bounded JSON object with no unknown fields. `memories` and `read_only_memories` are independently optional; when present, each must be a bounded unique list, and a name may not occur in both. The provider treats both categories as authoritative listing evidence. Memory names, contents, and serialized records are size-bounded; malformed or duplicate listings and responses fail closed.

## Project, layout, and visibility prerequisites

Provider v1 requires an already registered, existing canonical Serena project. The caller supplies exact absolute project name/path identity; the registration must contain that exact canonical project path, and activation must prove the same name and path. A Taskwarrior project is never substituted for the Serena project identity.

Before MCP operations, inspection requires all of the following:

1. The user Serena configuration at the local project environment path `~/.serena/serena_config.yml` is readable, safe, and registers the project path.
2. The project uses the default `project_serena_folder_location` of `$projectDir/.serena` (or omits that setting) in both the user and project configuration.
3. The project contains the default local-only layout `<project-path>/.serena/project.yml` and `<project-path>/.serena/memories`.
4. `project_name` in the project configuration exactly matches the selected Serena project name.
5. The effective `ignored_memory_patterns` setting is absent or an empty list in both configurations. Any nonempty or malformed filter blocks rather than hiding lifecycle evidence.
6. Project root, `.serena`, `memories`, configuration files, and the selected memory target are canonical non-symlink paths. Inspection compares device/inode identity around reads and target checks; absent targets are allowed only for the pending initial write.

Alternative layout, unregistered/unavailable project, relative/noncanonical path, inaccessible path, symlink, directory/file replacement, unstable filesystem identity, or missing required directory/configuration is blocked before the related MCP action. This is a prerequisite boundary, not an instruction to create or repair Serena state.

## Persistence ordering, immutability, and concurrency

`persist` follows this order: snapshot/validate request; acquire a per-project native exclusion; activate and inspect the project; list names; read and verify an existing exact target when present; otherwise prepare the deterministic immutable record; perform at most one write; and directly read back and byte-for-byte/full-reference verify it. It returns `stored` only after that direct read-back. An existing exact verified same request returns `unchanged`; an existing changed, malformed, ambiguous, or unverifiable target blocks with no overwrite, repair, fallback, or second write.

The memory name is deterministic and reserved to the versioned digest namespace: `ima-serena-lifecycle-v1-<sha256(lifecycle-key)>-<phase>-<artifact-id>`. This prevents ordinary project memories from being lifecycle candidates. The provider validates canonical artifact framing, nonce, lifecycle identity, hashes, record key, timestamp, serialized bytes, and project/reference binding before treating a record as evidence.

The native per-project exclusion uses a local retained lease sidecar. Safe outcomes release it: verified/unchanged evidence, pre-dispatch failure, known settled cancellation, known read-back/verification failure, conflict, and normal blocked pre-write outcomes. Lease acquisition/release failure is itself a bounded blocked result. Concurrent writers do not receive an automatic retry or a lock-steal path.

A dispatched write whose settlement is unknown, including cancellation after an unsettled dispatch, retains the cooperative exclusion and returns the exact recovery reference where available. **Uncertain-write exclusions require operator-authorized recovery and are never automatically retried, expired, or deleted.** A successful exact `get` or `reconcile` can establish evidence but does not itself remove a retained exclusion; an operator must separately establish that no live operation owns it before any cleanup.

## Recall, cancellation, and failure behavior

Recall filters only memory names under the digest prefix for one exact lifecycle key, optionally one phase, sorts selected names, and directly reads/verifies every selection. It ignores ordinary and other-lifecycle memories. More records than the requested limit or 20, malformed matching namespace names, duplicated/invalid listings, unavailable/malformed selected reads, duplicate logical identities, or any unverified record makes the entire recall `serena_recall_unverifiable`; no partial result is authoritative. A successful empty result is possible only when the bounded exact listing contains no matching names.

All operations honor cancellation at entry and after each I/O boundary. Cancellation returns blocked `aborted`, makes no later provider operation authoritative, and does not cause a fallback or retry. Before dispatch it prevents the write; after a known settled dispatch it still prevents read-back authority; after an unsettled dispatch it additionally retains the exclusion as described above.

The provider fails closed with a bounded code and, only where safe, a recovery reference for unsupported protocol, unavailable or mismatched project, alternative layout/filters, unsafe path/symlink/replacement evidence, invalid request/reference/selection/record, target conflict, unknown write, failed direct read-back, incomplete or overflow recall, cancellation, and lease failure. It exposes no dependency error body, secret, token, or raw filesystem/MCP payload. `get` and `reconcile` remain read-only in every outcome.

## Configuration and data classification

- `SERENA_HOME`, if an integrator elects to use it outside this provider, is a **non-secret variable**. Provider v1 does not use or configure it; its inspected Serena paths are the default local layout above.
- Serena project paths, `~/.serena` configuration, project `.serena` configuration/memories, synthetic fixtures, and retained lease sidecars are **local-only values**. Do not source-control, publish, or treat them as portable shared configuration.
- Any Serena, MCP, service, or platform credentials/tokens are **secrets**. They must not be stored in documentation, configuration, lifecycle artifacts, fixtures, logs, or ordinary variables.
- This provider introduces no **platform binding**.

## Verification, acceptance boundary, and residual risk

Focused synthetic coverage comprises 38 tests across record, client, provider, and continuity contracts; compatibility coverage comprises 61 tests. The recorded full-suite result is 1,153 tests total: 1,149 pass, zero fail, and four existing opt-in skips. The focused contract covers strict protocol parsing, project/layout inspection, filters, symlink/replacement resistance, immutable persistence/direct read-back, exact bounded recall, cancellation, retained uncertain exclusions, and fresh-instance read-only recovery.

Run the local checks:

```bash
node --test tests/serena-lifecycle-record.test.js tests/serena-lifecycle-client.test.js tests/serena-lifecycle-provider.test.js tests/serena-lifecycle-continuity.test.js
npm test
git diff --check
```

Live synthetic Serena acceptance is unperformed and separately authorized. Synthetic tests do not prove real MCP transport timing, server protocol variation, project registration behavior, or resistance to privileged external mutation between filesystem checks and remote writes. They also do not authorize live writes, routing, selection, fallback, pins, or cleanup of retained exclusions.

## T9 integration boundary

T9 may only consume this provider after independently implementing and accepting user confirmation, preference and provider selection, fallback policy, durable pins, live provider-aware routing, and dedicated-session construction. It must preserve the provider's strict existing-project prerequisites, no-fallback behavior, bounded blocked outcomes, immutable semantics, operator-authorized uncertain-write recovery, and read-only `get`/`reconcile`. This document does not implement or authorize any of those T9 responsibilities.
