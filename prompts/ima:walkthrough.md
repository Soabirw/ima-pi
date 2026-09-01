---
description: Present a read-only developer walkthrough of a pull request, local changes, or files
argument-hint: "[walkthrough-subject]"
---

You own one terminal advisory **walkthrough** response. This command is read-only,
non-mutating, and does not change the active model. It does not invoke `/ima:cycle`,
another lifecycle phase, or `/ima:speak`.

Use the `code-walkthrough` skill before building the presentation.

Unlike `/ima:narrate` and `/ima:narrated-review`, which only reform the last completed response
or a persisted verified review, this command acquires its own read-only evidence and builds an
entirely new presentation. It is understanding-first, not a review: it never emits `REVIEW-NNN`
findings, a verdict, or a request-changes gate. For a graded verdict use `/ima:review`.

## Select and acquire the subject

`$@` must supply exactly one walkthrough subject. If it is empty, ambiguous, or names multiple
subjects, ask for one subject and stop. Accept:

- A Gitea or GitHub pull request. Normalize `{ host, owner, repo, number }` and preserve it in every metadata and diff call.
  - GitHub: use the original PR URL or `-R owner/repo` for both `gh` calls.
  - Gitea: use `--repo owner/repo` with the host-matched `--login`; if the host cannot map to exactly one login, report the missing prerequisite and stop. Never use the current checkout as an implicit PR target.
- A generic local uncommitted working tree. Acquire `git status --short`, `git diff`, and `git diff --staged`, then enumerate non-ignored untracked paths with `git ls-files --others --exclude-standard`. Read only project-root-contained, non-symlink untracked regular files; stop on unsafe or inaccessible evidence and never execute file content.
- Staged-only changes or a commit range through `git diff --staged` or `git diff <base>...<head>`.
- An explicit set of files, directories, or symbols in the current project.

Activate the project and navigate Serena-first and read-only. Use `mcp-serena` to locate changed
symbols, callers, and surrounding architecture only as far as the walkthrough needs. Route any
supplied image through `vision-handoff`. If the diff or files cannot be read, state the missing
prerequisite concisely and stop; do not invent unread code. This command needs no lifecycle
recall; `ima-memory-workflow` governs Vestige preferences-only boundaries.

## Boundaries

- Do not edit, format, stage, commit, push, install tooling, run builds or tests, or post
  external comments.
- Do not write a lifecycle artifact, persist walkthrough state, or make any lifecycle mutation.
- No pagination, bracketed progress markers, cursor, ledger, or `next`/`continue` advancement;
  emit one complete walkthrough and stop.
- Do not invoke `/ima:cycle`, a workflow DSL, or automatic progression.

## Present and hand off

Emit one complete, visible Markdown response with short headings and speech-friendly,
pronounceable prose covering purpose and context, architecture and organization, control and
data flow, notable decisions and tradeoffs, how to read and verify the change, and non-blocking
observations and open questions. Omit empty topics. Explain the purpose of code rather than
reciting raw syntax, do not use source-display code fences, and cite repository-relative
`file:line` when known.

End every successful walkthrough with: `Run /ima:speak to hear this walkthrough.` Do not
automatically invoke `/ima:speak`. Stop after the walkthrough or the missing-prerequisite
message.
