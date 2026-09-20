---
name: ima-preferences
description: Manage one user's durable Pi preferences in the supported global lower-case AGENTS.md with exact previews and explicit approval.
---

# Pi User Preferences

## Ownership and destination

Pi's global context-file precedence determines whether the supported lower-case `AGENTS.md` is an
eligible destination for current cross-project user preferences and decisions. Resolve
a non-empty `PI_CODING_AGENT_DIR`; otherwise use `~/.pi/agent`.

Before any preview or mutation, use only Pi's built-in read/file operations to establish whether
regular `AGENTS.override.md`, lower-case `AGENTS.md`, and `AGENTS.MD` files exist. If a regular
`AGENTS.override.md` exists, stop with `unsupported-active-layout` and perform no mutation. If
lower-case `AGENTS.md` is absent while regular `AGENTS.MD` exists, stop with
`would-shadow-active-file` and perform no mutation. Otherwise the lower-case `AGENTS.md` is the
supported canonical destination. Do not edit an override, uppercase AGENTS file, or `CLAUDE`
variant, and do not implement a custom context resolver or loader.

Serena owns stable project instructions and code navigation. Formal lifecycle persistence uses
`ima_lifecycle`; formal lifecycle reads use `ima_lifecycle_recall` followed by selected exact
`ima_lifecycle_get` under the durable provider pin across BookStack, Qdrant, Serena, or Markdown.
Only while genuinely unpinned does the public lifecycle read pair internally use exact all-phase
historical Qdrant authority. Tier-1 Qdrant, through `ima_corpus_*`, owns durable institutional
knowledge. Vestige is retained only for explicitly cited legacy evidence and the separate T7
migration. Never use Vestige for routine preference reads or writes.

## Eligible content

Accept only explicit, durable user preferences or decisions. Reject secrets, credentials, tokens,
raw logs, transcripts, lifecycle state, transient context, and project-specific facts. Keep accepted
preferences as concise imperative bullets under meaningful headings beneath `# User Preferences`.
Record unresolved contradictions under `## Conflicts` rather than silently choosing a winner.

## Read and analyze

Read the whole destination before proposing a change. Preserve all unrelated content. Treat an
exact or semantic duplicate as a no-op or a consolidation opportunity. Replace an unambiguously
superseded preference only after showing the exact replacement. Ask the user to resolve ambiguous
precedence or an uncertain edit location; never broadly rewrite the file to force a change.

If the supported lower-case destination is absent, infer a meaningful heading before approval. If
one cannot be inferred safely, ask the user and perform no mutation. Otherwise preview one complete
document:

```markdown
# User Preferences

## <the meaningful heading shown in the preview>

- <the exact approved preference wording>
```

After approval, create that complete document in one native write, re-read it, and verify both the
heading and exact preference. Never create a heading-only initialization. If the destination is
unreadable, fail without mutation. A file near or above 500 lines is a maintenance signal: advise
consolidation, but never block an approved write or silently delete a preference to meet the
advisory target.

## Preview, approval, and verification

Before every mutation, present the resolved destination, exact wording, duplicate or conflict
disposition, and one native edit or write. Require explicit approval immediately before
that one operation. Re-read the file afterward and verify the exact approved result, then stop.

Use Pi's built-in file tools only. Do not add a parser, store library, custom tool, lock, hash,
backup, versioning layer, or Vestige write path.
