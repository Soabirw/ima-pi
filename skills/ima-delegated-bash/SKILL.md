---
name: ima-delegated-bash
description: Safe, observable Bash sequencing for delegated IMA specialist work without weakening adapter enforcement.
---

# Delegated Bash

## Mandatory sequence

Use one logical command per delegated Bash call. Await each call and inspect a successful result before issuing a dependent call. Do not turn a sequence into one shell command merely to save tool calls.

Prefer native `read`, search, `edit`, and `write` tools whenever they express the operation. Use repository-relative delegated paths only; do not use absolute or `./` paths.

## Shell operator semantics

- `&&` runs its right-hand command only when the left-hand command succeeds.
- `;` starts the next command after the preceding command finishes; it does not itself require success.
- `&` backgrounds the preceding job, allowing the shell to continue without waiting for it.

Those are normal shell semantics. They are not a delegated authorization sequence: composition is unsupported because each operation requires independent authorization and observation.

## No composition bypass

Do not use separators, backgrounding, pipes, command/process substitutions, redirects, shell wrappers, alternate shells, or indirect execution to combine or hide work. Do not use any of them to bypass delegated tool restrictions or ownership checks.

If a requested verification is denied or unsupported, stop dependent work and report the exact unrun verification and reason to the parent. Never claim that verification ran or passed.

## Enforcement boundary

This guidance supplements rather than replaces adapter enforcement. The adapter remains authoritative for tool availability, ownership, authorization, and fail-closed Bash handling; this skill neither expands an allowlist nor permits an otherwise denied command.
