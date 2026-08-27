---
description: Safely migrate Vestige lifecycle memories into the institutional corpus
argument-hint: "[cleanup <report-path>]"
---
Use the package-native `ima_vestige_migrate` and `ima_vestige_cleanup` tools only. Do not
call Vestige or Qdrant through a generated SDK namespace, a shell command, or a separate MCP
configuration.

With no argument, call `ima_vestige_migrate` exactly once with `{}`. It performs the
fail-closed prerequisite check, SQLite backup, JSON export, bounded validation, lifecycle
classification, migration-local secret redaction, idempotent import, Tier-1 verification, and a
concise report. It never deletes from Vestige. Report the returned artifact path and migrated,
unchanged, retained-in-Vestige, quarantined, conflict, failed, unverified, and redacted counts.
Stop for operator review after the report.

For `cleanup <report-path>`, call `ima_vestige_cleanup` only when the operator explicitly
confirms deletion in the current request. Pass the exact relative report path and `confirm: true`.
Cleanup accepts only a current v2 migration report with intact, readable backup and export
receipts; legacy, missing, corrupt, oversized, or symlinked recovery artifacts require a safe
non-destructive migration rerun. The tool re-verifies every report-listed lifecycle record in
Tier-1 before deletion and counts a purge only after Vestige explicitly acknowledges it. It retains
anything unverified, non-lifecycle, unavailable, or negatively acknowledged. Never infer
confirmation, choose a report automatically, or delete preferences.

A normal re-run is the approved idempotent recovery path. There is no package reset,
collection-drop, or rollback command. If an operator separately elects a clean-slate recovery,
document that it is a one-off manual operation limited to `ima-institutional-memory`; never drop
`ima-knowledge`, patristic collections, or any other collection.

Do not expose exported memory content, backup paths, credentials, or raw service responses. Stop
after migration or cleanup reporting.
