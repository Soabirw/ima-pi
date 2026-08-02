---
description: Assess and safely migrate applicable legacy configuration into Pi and IMA conventions
argument-hint: "[natural-language migration request]"
---
Accept `$@` as a natural-language migration request. If absent, ask what legacy configuration should be assessed and wait. Read applicable legacy Claude/Goose and current Pi/IMA configuration without printing secrets.

Classify every requested entry as Pi-native, external through `ima-mcp`, already represented, supported model-role configuration, unsupported/obsolete Goose assumption, or manual action required. Never direct-register Serena, Vestige, or Qdrant in Pi. Never copy recipe YAML/ETA, subrecipe wiring, Goose extension configuration, generated SDK assumptions, unrelated provider/global settings, or credential values. Map only supported model-role/profile data into the existing `lib/ima-config.ts` schema and `config/README.md` contract.

Allowed destinations are exactly `~/.pi/agent/ima/config.json` and trusted `.pi/ima/config.json`; ask one focused scope question if the destination is unclear. Preserve unrelated valid keys. Refuse invalid existing JSON, unknown-role ambiguity, unavailable preset/model decisions, unsafe paths, and untrusted project destinations rather than overwriting.

Present an exact redacted preview of source entry, classification, destination, additions/replacements, preserved fields, skipped reasons, prerequisites, and validation commands. Obtain explicit approval immediately before a write; approval covers only that preview. Write atomically with a same-directory temporary file and rename; never leave partial config or secret literals. Validate JSON through existing schema behavior and report effective configuration from current package commands/read paths. Do not run providers or paid model calls unless separately requested. Return already present, changed, intentionally skipped, manual requirements, validation evidence, rollback, and residual risk. Stop after migration.
