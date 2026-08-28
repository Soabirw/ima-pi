---
description: Safely migrate Vestige lifecycle memories and other institutional records into the institutional corpus
argument-hint: "[cleanup <report-path>]"
---
Use the package-native `ima_vestige_migrate` and `ima_vestige_cleanup` tools only. Do not
call Vestige or Qdrant through a generated SDK namespace, a shell command, or a separate MCP
configuration. This restricts the agent invocation path; the package tool may internally use the
approved Vestige CLI to write its migration artifacts.

With no argument, call `ima_vestige_migrate` exactly once with `{}`. It performs the
fail-closed prerequisite check, SQLite backup, JSON export, bounded validation,
institutional-by-default classification, migration-local secret redaction, idempotent logical
record import, direct Tier-1 verification, and a concise source-level report. Only positively
identified standalone preferences remain in Vestige; mixed, lifecycle, planning, decision, and
unknown records migrate intact. Records through 160 KB use one logical record. Larger sources use
ordered Unicode-safe bounded parts and an index stored only after every part verifies. It never
deletes from Vestige. Report the returned artifact path and migrated, unchanged,
retained-in-Vestige, quarantined, conflict, failed, unverified, and redacted source counts. Never
include exported content, raw record details, or secrets in chat output. Stop for operator review
after the report.

For `cleanup <report-path>`, call `ima_vestige_cleanup` only when the operator explicitly
confirms deletion in the current request. Pass the exact relative report path and `confirm: true`.
Cleanup accepts only a current schema-v2 `source-bundles` migration report with intact, readable
backup and export receipts. Old v2 layouts, legacy, missing, corrupt, oversized, or symlinked
recovery artifacts require a new non-destructive migration rerun. Before one source is deleted,
the tool directly retrieves and validates every listed destination record, including the ordered
parts and index for a bundle. It retains the entire source if any part is missing, conflicting,
unverified, unavailable, or negatively acknowledged. Never infer confirmation, choose a report
automatically, or delete preferences.

A normal re-run is the approved idempotent recovery path. There is no package reset,
collection-drop, or rollback command. If an operator separately elects a clean-slate recovery,
document that it is a one-off manual operation limited to `ima-institutional-memory`; never drop
`ima-knowledge`, patristic collections, or any other collection.

Do not expose exported memory content, backup paths, credentials, or raw service responses. Stop
after migration or cleanup reporting.
