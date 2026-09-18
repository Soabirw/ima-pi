# Serena lifecycle provider (T15)

> **Provider-native lifecycle authority:** Serena is one of the four lifecycle authorities. Provider selection, user confirmation, and checkout-local pin handling follow the [lifecycle authority contract](guide.md#lifecycle-authority-memory-and-integrations). This provider preserves immutable, fail-closed behavior within that decision; it does not select a provider or activate live routing.

## Approved scope and evidence

The approved lifecycle source is `plane:ima:SKYNET-238`. Its verified provider-pin and original-plan anchor is `647cd414-4ab0-50ae-89ba-096a02969fb5`; the approved plan is `fe00fab6-8136-5ba9-aff3-affab0924cc0`. Implementation evidence is `77aca407-d95e-53e0-99f6-4c8fcefe37aa` and `f96a9841-e687-51f9-8bde-c1b08a91e58f`; resolution evidence is `783750d0-a531-5931-b1db-c6b67ad1e5b2` and `147a8d8e-b9fb-5910-921c-45a03ac60e9f`; final approval is `197cd4f7-fc17-5f13-ab6b-99df9276d3d2`.

Those source identifiers and ordinary artifact IDs are **non-secret evidence values**. They are not credentials, configuration, session state, or authorization.

## New-developer readiness boundary

Package/resource discovery and BookStack shared-memory access do not require a Serena lifecycle project. An existing registered Serena project and its local layout are prerequisites only when Serena is selected or pinned for managed lifecycle persistence; this provider never creates or repairs that state to pass readiness. If exact historical authority cannot be verified, the operator must stop and preserve it rather than fall back, repin, migrate, or mix providers. See the [new-developer readiness journey](guide.md#new-developer-shared-memory-readiness) for configuration classes, owner gates, and non-destructive rollback.

The provider persists an immutable lifecycle record, obtains an exact reference, recalls a bounded exact lifecycle selection, and read-only reconciles an exact reference. It reserves the versioned `ima-serena-lifecycle-v1` memory-name namespace. It does not create or select a Serena project, use a Taskwarrior project as Serena identity, alter preferences or pins, fall back to another provider, repair or migrate evidence, delete memories or locks, retry an uncertain write, or activate live routing.

## Same-connection Serena protocol

Every package-owned Serena operation discovers advertised capabilities and performs the accepted calls on the **same MCP connection**. Discovery is not a second connection, reconnect, or fallback path. Only these advertised tools are accepted:

- `activate_project` with the required project field;
- `initial_instructions`;
- `list_memories` (its advertised optional topic is not used);
- `read_memory` with the required memory-name field; and
- `write_memory` with required memory-name/content fields (its advertised optional maximum-length field is not used).

Each tool schema must have the exact supported fields, types, required set, and harmless annotations only. Unsupported schema semantics, unknown/extra fields, duplicate tool declarations, ambiguous session-field names, or inconsistent session-field names are rejected before a Serena tool effect. Each non-instruction tool may independently require no private session field or exactly one supported field; all session-bearing tools must use the same field, and each call receives private state only when its own discovered schema requires it. An instruction tool may use that field only when it is the same field.

When any accepted operation requires a session, the package loads instructions before activation, listing, reads, or writes. It accepts session evidence only from the MCP initialization result and/or the instruction result. All present supported carriers must be valid and agree. JSON-shaped text is parsed and validated as JSON before opaque text is considered, and the exact bounded Serena instruction marker is extracted from matching text and structured-result carriers without treating arbitrary prose as state. Malformed, duplicate, ambiguous, invalid, or disagreeing carriers cannot become session text. An SDK-normalized structured-only instruction response with empty content is accepted only when its structured state carries a valid session value. Invalid or absent-required session state blocks without a subsequent Serena effect.

The package never projects private session state into context, lifecycle, provider, or delegated-child output. It makes no reconnect, fallback, effectful retry, or alternate-session attempt.

### Legacy compatibility

A legacy caller that does not expose capability discovery retains the unparameterized historical protocol: activate the exact existing checkout, load instructions, list memories, and read listed standard memories. It sends no discovery request and no private session field. The normal package MCP client does expose same-connection discovery; this compatibility path exists only for callers predating it.

In both session-aware and legacy modes, activation succeeds only after the exact existing-project receipt confirms the selected checkout name and canonical path. Created-project receipts, generic success text, lookalikes, and mismatched paths fail before instruction/list/read/write continuation.

## Context bootstrap

For session-aware context, the order is discovery, instructions, exact activation, memory listing, then reads of every listed standard memory. The six standard memories are:

1. `core`
2. `conventions`
3. `tech_stack`
4. `suggested_commands`
5. `task_completion`
6. `memory_maintenance`

A missing standard memory is explicit degraded context; it is never created. A failed instruction, activation, listing, or read remains bounded degraded evidence and does not trigger a write, reconnect, fallback, or retry. Legacy bootstrap retains its historical activation-first order while applying the same exact activation verification and six-memory list.

## Project, layout, and visibility prerequisites

Provider v1 requires an already registered, existing canonical Serena project. The caller supplies exact absolute project name/path identity; registration must contain that exact canonical project path, and activation must prove the same name and path. A Taskwarrior project is never substituted for the Serena project identity.

Before lifecycle MCP operations, inspection requires all of the following:

1. The user Serena configuration at the local project environment path `~/.serena/serena_config.yml` is readable, safe, and registers the project path.
2. The project uses the default `project_serena_folder_location` of `$projectDir/.serena` (or omits that setting) in both user and project configuration.
3. The project contains the default local-only layout `<project-path>/.serena/project.yml` and `<project-path>/.serena/memories`.
4. `project_name` in the project configuration exactly matches the selected Serena project name.
5. The effective `ignored_memory_patterns` setting is absent or an empty list in both configurations. Any nonempty or malformed filter blocks rather than hiding lifecycle evidence.
6. Project root, `.serena`, memories, configuration files, and the selected memory target are canonical non-symlink paths. Inspection compares device/inode identity around reads and target checks; absent targets are allowed only for the pending initial write.

Alternative layout, unregistered/unavailable project, relative/noncanonical path, inaccessible path, symlink, directory/file replacement, unstable filesystem identity, or missing required directory/configuration is blocked before the related MCP action. This is a prerequisite boundary, not an instruction to create or repair Serena state.

## Lifecycle operation, immutability, and failure behavior

- `persist(request, signal?)` snapshots and validates the canonical lifecycle request; acquires a per-project native exclusion; prepares the MCP session; activates and inspects the project; lists names; reads and verifies an existing exact target when present; otherwise performs at most one write; then directly reads back and fully verifies it. It returns `stored` only after that direct read-back. An exact same request returns `unchanged`; a changed, malformed, ambiguous, or unverifiable target blocks with no overwrite, repair, fallback, or second write.
- `get(reference, signal?)` and `reconcile(reference, signal?)` use the exact session protocol, activate the exact project, find exactly the named memory, read it, and verify the complete reference and record. Both are read-only.
- `recall(selection, signal?)` accepts only an exact lifecycle key, optional lifecycle phase, and a limit of 1–20. It returns only complete verified records or one bounded blocked result; it never returns authoritative partial evidence.

The deterministic memory name is `ima-serena-lifecycle-v1-<lifecycle-key-digest>-<phase>-<artifact-id>`. The provider validates canonical artifact framing, nonce, lifecycle identity, record key, content/request/canonical integrity values, timestamp, serialized bytes, and project/reference binding before treating a record as evidence.

The native per-project exclusion uses a local retained lease sidecar. Safe outcomes release it: verified/unchanged evidence, pre-dispatch failure, known settled cancellation, known read-back/verification failure, conflict, and normal blocked pre-write outcomes. Lease acquisition/release failure is itself a bounded blocked result. Concurrent writers do not receive an automatic retry or a lock-steal path.

A dispatched write whose settlement is unknown, including cancellation after an unsettled dispatch, retains the cooperative exclusion and returns a recovery reference where safe. **Uncertain-write exclusions require operator-authorized recovery and are never automatically retried, expired, or deleted.** A successful exact `get` or `reconcile` can establish evidence but does not remove a retained exclusion; an operator must separately establish that no live operation owns it before cleanup.

Recall filters only the digest namespace for one exact lifecycle key, optionally one phase, sorts selected names, and directly reads/verifies every selection. Overflow, malformed matching names, duplicated/invalid listings, unavailable/malformed selected reads, duplicate logical identities, or any unverified record makes the entire recall unverifiable; no partial result is authoritative. Cancellation is checked at entry and after each I/O boundary and cannot cause a retry, fallback, or later authoritative operation.

## Configuration and data classification

- Serena MCP is a **platform binding**. It is an external configured service boundary, not a source-controlled package setting or public lifecycle input.
- Serena project paths, `~/.serena` configuration, project `.serena` configuration/memories, checkout-local pins, private session state, retained leases, and local Serena configuration are **local-only values**. Do not source-control or publish them.
- Serena/MCP/service credentials and tokens are **secrets**. They must not appear in documentation, configuration, lifecycle artifacts, fixtures, logs, or ordinary variables.
- Provider preferences, canonical source identifiers, and ordinary artifact IDs are **non-secret variables/evidence values**. `SERENA_HOME`, if used outside this provider, is a **non-secret variable**; provider v1 does not configure or consume it.

## Verification, acceptance boundary, and residual risk

Recorded provider-free verification covers same-connection capability discovery, legacy compatibility, session-carrier agreement, JSON-first carrier parsing, structured-only SDK normalization, pre-effect schema rejection, exact activation in both modes, six-memory context hydration, immutable one-write/direct-read-back behavior, exact get/reconcile, bounded recall, cancellation, and retained uncertain-write exclusions. The recorded full suite result is 1,456 passing tests, zero failures, and four unchanged opt-in skips; `git diff --check` passed.

This is not live-service acceptance. Synthetic verification does not prove production MCP transport timing, server protocol variation, project registration behavior, or resistance to privileged external mutation between filesystem checks and remote writes. It does not authorize live writes, routing, selection, fallback, pins, cleanup, tracker closure, or provider migration.

## Lifecycle integration boundary

Lifecycle integration preserves the user's selection, checkout-local pin, strict existing-project prerequisites, no-fallback behavior, bounded blocked outcomes, immutable semantics, operator-authorized uncertain-write recovery, and read-only `get`/`reconcile`. An uncertain Serena write blocks rather than permitting reevaluation, fallback, migration, or provider mixing. This document makes no live-provider, cross-device, or tracker-closure claim.
