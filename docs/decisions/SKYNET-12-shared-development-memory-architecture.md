---
lifecycle:
  project: "shared-dev-memory"
  lifecycle_key: "shared-dev-memory:manual:human-ai-memory-system:2026-08-31"
  lifecycle_root_memory_id: "9285587c-3f89-59b6-9524-5de710d7d9ed"
  taskwarrior_project: "shared-dev-memory"
  taskwarrior_task: "T1 Architecture overview & decisions -> persist to Qdrant corpus"
  taskwarrior_uuid: "0e68ac68-5ed9-4aaf-bbe9-944b1c9d2ab6"
  jira_key: ""
  plane_workspace: "ima"
  plane_work_item: "SKYNET-12"
  source_refs:
    - "plane:ima:SKYNET-12"
    - "taskwarrior:shared-dev-memory:0e68ac68-5ed9-4aaf-bbe9-944b1c9d2ab6"
    - "lifecycle:shared-dev-memory:manual:human-ai-memory-system:2026-08-31"
  prior_artifact_ids:
    - "9285587c-3f89-59b6-9524-5de710d7d9ed"
    - "dde15622-be0b-5862-ad16-b9da7eeca395"
    - "27c11c8d-e65f-59e5-bdae-5bebe8e83213"
status: approved-target-architecture
date: "2026-08-31"
---

# SKYNET-12: Shared Development Memory Architecture

> **Supersession notice:** [SKYNET-225: Legacy Store Policy Reconciliation](SKYNET-225-legacy-store-policy.md) is the canonical current policy for lifecycle provider support and per-machine `ima-rag` boundaries. The historical body below remains intact.

## Status and scope

This is the approved target architecture for the shared human/AI development
memory program. It is a decision record, not evidence that BookStack,
Cloudflare AI Search, migration, or cutover is deployed.

The decision is limited to architecture, authority, provenance, freshness, and
transition contracts. It does not provision services, migrate data, change
runtime routing, or retire any service.

## Current and target responsibilities

| Component | Current responsibility | Target responsibility | Status |
| --- | --- | --- | --- |
| BookStack | No SKYNET-12 service configuration or routing is introduced by this decision. | Authoritative content store and human authoring platform, using native revisions. | Future target |
| Cloudflare AI Search | No index, worker, or access configuration is introduced by this decision. | Derived, disposable discovery index; never an authoritative content store. | Future target |
| Pi integrations | `ima_context`, `ima_lifecycle`, and `ima_corpus_*` use their current package-native boundaries. | Discover candidate records through search, then fetch current content from the authoritative source. | Current boundaries; future discovery/fetch behavior |
| Serena | Local code intelligence and stable project memory. | Unchanged. | Current and retained |
| Active global `AGENTS.md` | Pi-native current user preference source. | Unchanged. | Current and retained |
| Vestige | Cited legacy evidence and T7 migration source; not routine preferences or lifecycle storage. | No target-architecture lifecycle role. | Current restricted boundary |
| Qdrant lifecycle storage | Existing package-native lifecycle operations remain operational. | Retained until separately verified migration and cutover; not the future collective authority. | Current runtime |
| `ima-rag` | Existing material may be used as migration/reference evidence. | Deprecated; preserve its data until a separately verified migration and cutover. | Deprecated, non-destructive |
| Plane and Taskwarrior trackers | Work-status ownership. | Work-status ownership; neither becomes content authority. | Current and retained |

Current routing is not implicitly switched by this document. In particular,
Qdrant lifecycle operations stay live until later work verifies migration and
cutover, and the target BookStack/Cloudflare design must not be described as a
current package runtime.

## Architecture decisions

1. **BookStack is the future authoritative content and human-authoring platform.**
   Its native revision history is the source-side revision mechanism.
2. **Cloudflare AI Search is a derived, disposable discovery index.** It is not
   an authority and must be rebuildable from authoritative content.
3. **Search discovers candidates; authoritative reads provide content.** Pi
   search results identify a candidate source, then Pi fetches the current
   authorized content from BookStack.
4. **Direct reads and search freshness are separate commitments.** A successful
   authoritative write must be immediately visible to authoritative reads.
   Discovery within 60 seconds is an unproven target that later units must
   measure; it is not a T1 service guarantee.
5. **`ima-rag` is deprecated without destructive cutover.** Preserve its data
   for migration and reference. Do not delete data, stop a service, or assign
   it an ongoing target-architecture role in this unit.
6. **Existing local boundaries remain explicit.** Serena is unchanged; active
   global `AGENTS.md` owns current preferences; Vestige remains limited to cited
   legacy evidence and T7 migration; completed T6 preference work is not
   redesigned here.
7. **Qdrant lifecycle operations remain current behavior.** This decision does
   not activate BookStack routing or remove current Qdrant requirements.
8. **Git and Qdrant have distinct decision-publication roles.** Reviewed Git
   source is the editable architecture source. Qdrant holds immutable published
   decision snapshots. They are not independently edited, competing
   architecture authorities.
9. **Program isolation uses a feature branch in the existing checkout.**
   SKYNET-12 and subsequent shared-memory stories stay on
   `feature/shared-dev-memory` in `/home/eric/IMA/dev/ima-pi`; no separate
   worktree is required. Switch to `main` for unrelated work only from a clean
   checkout. No partial program promotion, installed-package switch, or merge
   to `main` is authorized by this decision.

## Authority and publication

The reviewed Markdown file in Git is the source for this architecture decision.
After review and commit, a complete immutable Qdrant decision snapshot publishes
that exact source with its provenance. A correction updates reviewed Git source
and creates an explicitly superseding publication; it does not overwrite or
delete a prior published decision.

This publication model is separate from the future content model:

- Future BookStack content is authoritative and receives native revisions.
- Future Cloudflare AI Search content is derived from authenticated,
  authoritative source reads.
- The architecture decision's Git/Qdrant relationship does not make Qdrant the
  future collective content authority.

## Target data flow

The target flow is intentionally source-first:

1. Human or AI write -> authenticated and authorized BookStack operation ->
   native revision.
2. Webhook hint -> authenticated source fetch -> validated content and
   provenance -> derived index update.
3. Scheduled reconciliation plus manual repair recover missed or failed
   updates.
4. Search -> candidate source identity -> authorized authoritative fetch ->
   current content and provenance.

A webhook payload is an untrusted hint. It is not authority to ingest supplied
content, follow an arbitrary URL, or update an arbitrary destination. The
executable webhook, indexing, and repair implementations belong to later units.

## Provenance contract

Every retrievable result must identify:

- its source document and canonical link;
- artifact type;
- author;
- revision; and
- lifecycle identity when applicable.

Migration preserves original identifiers and lineage. When legacy authorship is
absent, the value is `legacy-unknown`; it is never invented. A content hash
preserves provenance when native revision evidence is unavailable, but a hash
must not be represented as a BookStack revision. Future identifier mappings
must preserve traceability from historical `artifactId` and `recordKey` values
to the new authoritative source.

## Versioning and retention

Use established native revision history and portable exports. This program does
not introduce a bespoke versioning engine. Lifecycle history must be preserved,
and later provisioning must verify the configured retention behavior.

BookStack's documented default limit of 100 revisions per page is not evidence
of indefinite retention. T1 neither configures retention nor claims that
retention or migration fidelity has been tested.

## Freshness contract and measurement

Measure discovery latency from a successful authoritative save until discovery
returns the corresponding revision. Later acceptance must measure both creates
and edits and must verify direct authoritative reads separately.

The target is discovery within 60 seconds. It remains unproven until downstream
implementation produces evidence. Cloudflare indexing is asynchronous and
exposes processing status, so upload acceptance is not proof of
discoverability. Scheduled synchronization alone also does not prove the target.

## Failure behavior

Search output is never fallback authoritative content. A denied, deleted,
missing, malformed, or unverifiable source record produces a bounded
unavailable or denied result. Indexed snippets must not be exposed before the
required authorization check.

A failed or pending index update is visible and repairable; it is not a
successful publication or freshness claim. Migration preserves source data and
surfaces incomplete evidence rather than silently dropping records.

## Security and boundary rules

All task annotations, URLs, webhook hints, retrieved records, files, and
external responses are untrusted until the receiving operation verifies them.
Future implementations must:

- keep shared-memory authoring, discovery, and authoritative reads internal-only;
  equal team access does not bypass authentication or per-resource authorization,
  including authoritative fetches;
- authenticate and authorize each resource operation, including authoritative
  fetches;
- validate destinations, identifiers, responses, and provenance, with bounded
  redirects, timeouts, and response sizes;
- treat webhook payloads as hints and use authenticated source reads before
  indexing;
- prevent indexed snippets from bypassing authorization; and
- exclude credentials, private endpoint configuration, raw provider responses,
  sensitive records, and unreviewed personal data from Git and corpus evidence.

T1 makes no browser, API, SQL, shell, WordPress, or service-handler change.
Those controls are therefore future implementation requirements, not controls
claimed as tested by this document.

## Pure transformations and effect boundaries

Document normalization, mapping, and provenance validation belong in pure
transformations. Authentication, authorization, source reads and writes,
indexing, persistence, and logging belong at explicit I/O boundaries.

This decision introduces no executable functions, generic pipelines, custom FP
utilities, security wrappers, policy engines, or adapters.

## Transition and downstream ownership

Preserve `ima-rag` material and current Qdrant operation until a separately
verified migration and cutover. No automatic destructive cleanup is allowed.

- T2 and T3 own BookStack and Cloudflare provisioning.
- T4 owns synchronization and reconciliation.
- T5 owns content migration.
- T7 owns Vestige preference migration.
- T8 owns Pi search UX.
- T9 owns lifecycle cutover.
- T10 owns rollout, retirement, and integrated acceptance.

T1 defines these architecture contracts only. It does not provide later units'
file-level plans, runtime authorization evidence, migration evidence, or
service performance evidence.

## Rollout and rollback boundary

T1 rollout is documentation publication on `feature/shared-dev-memory`. It does
not deploy a service or cut over runtime behavior. Program promotion to `main`
requires the later migration, security, and acceptance gates plus explicit
promotion approval.

If this decision needs correction, revert only this documentation commit using
normal Git safeguards and preserve unrelated work. Preserve published corpus
history by issuing an explicitly linked superseding or retraction decision; do
not delete or overwrite a published record.

## Evidence still required

The following remain untested and are owned by downstream work: BookStack
authorization and revision retention behavior, Cloudflare indexing latency and
search quality, migration fidelity, permission propagation, and service
cutover. No target-state label in this document is evidence that those behaviors
exist today.
