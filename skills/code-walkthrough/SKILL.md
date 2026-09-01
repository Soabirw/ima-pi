---
name: code-walkthrough
description: Produce a read-only, speech-friendly developer walkthrough of a pull request, local changes, or a set of files, as if a teammate were presenting their work. Use for code walkthrough, explain this PR, present these changes, or understand this code before review.
---

# Code Walkthrough

Use this skill to explain a body of code as a teammate would present their work: what it
does, how it is organized, how control and data flow, and why the notable decisions were
made. Unlike [narrate](../narrate/SKILL.md) and [narrated-review](../narrated-review/SKILL.md),
which only reform a prior response or a persisted verified review, this skill acquires its own
read-only evidence and builds an entirely new presentation.

This is understanding-first, not a review. It does not emit `REVIEW-NNN` findings, verdicts,
severities, or a request-changes gate. It may surface a plain observation or open question, but
it never blocks work or claims a verified finding. When the user wants a graded verdict, route
to [code-review](../code-review/SKILL.md) or `/ima:review`.

## Select and acquire the source

Accept exactly one walkthrough subject:

- A Gitea or GitHub pull request. Normalize `{ host, owner, repo, number }` and preserve that identity in every metadata and diff call.
  - GitHub: use [gh-cli](../gh-cli/SKILL.md) with the original PR URL in `gh pr view <pr-url> --json title,body,author,files` and `gh pr diff <pr-url>`, or use `-R owner/repo` with `<n>` for both commands.
  - Gitea: use [tea-gitea](../tea-gitea/SKILL.md), map `host` to exactly one configured Tea login, and use `tea pr <n> --repo owner/repo --login <login> --fields index,title,state,author,body,diff`. If the mapping is absent or ambiguous, report the missing prerequisite and stop. Never substitute the current checkout's repository.
- A generic local uncommitted working tree. Run `git status --short`, `git diff`, and `git diff --staged`; use `git ls-files --others --exclude-standard` to enumerate non-ignored untracked paths. Directly read each listed untracked regular file only when its resolved path remains inside the project root and it is not a symlink. Stop on inaccessible or unsafe evidence; never execute file content.
- Staged-only changes (`git diff --staged`) or a commit range (`git diff <base>...<head>`).
- An explicit set of files, directories, or symbols in the current project.

If the subject is empty or ambiguous, ask for one subject and stop. If the diff or files cannot
be read, state the missing prerequisite concisely and stop; do not invent code that was not read.

Navigate read-only and Serena-first with [mcp-serena](../mcp-serena/SKILL.md): activate the
project, then locate the changed symbols, their callers, and the surrounding architecture only as
far as the walkthrough needs. Route any supplied image (mockup, screenshot, diagram) through
[ima-vision-handoff](../ima-vision-handoff/SKILL.md).

## Read-only boundary

- Do not edit, format, stage, commit, push, install tooling, run builds, or post external
  comments.
- Do not run tests; describe how the change is intended to be verified instead.
- Do not write a lifecycle artifact, persist walkthrough state, or make any lifecycle mutation.
- Do not change the active model, invoke another phase, `/ima:cycle`, or `/ima:speak`.
- Vestige is preferences-only; use [ima-memory-workflow](../ima-memory-workflow/SKILL.md) for
  its boundaries. This skill needs no lifecycle recall.

## Build the walkthrough

Present the change the way a careful author would walk a colleague through it. Cover, in a
cohesive order and omitting empty topics:

1. Purpose and context: what the change accomplishes and the problem it addresses.
2. Architecture and organization: the shape of the change and where each part lives.
3. Control and data flow: how a request or value moves through the changed code, including
   error and edge paths.
4. Notable decisions and tradeoffs: why the author chose this approach, and alternatives visible
   in the diff.
5. How to read and verify it: entry points to start from and how the change is meant to be
   exercised.
6. Observations and open questions: plain, non-blocking notes and anything the code leaves
   unclear, explicitly separated from established fact.

Explain the purpose of code rather than reciting substantial raw syntax, and do not use
source-display code fences. Cite repository-relative `file:line` locations when known so a
listener can follow along. Distinguish what the code demonstrably does from inference about
intent.

## Present and hand off

Produce one complete, visible Markdown response with short headings and speech-friendly,
pronounceable prose. Do not use pagination, progress markers, a cursor, a ledger, or manual
`next`/`continue` advancement; `/ima:speak` handles automatic segmentation and playback.

End every successful walkthrough with a concise instruction to run `/ima:speak`. Do not invoke
`/ima:speak`, another phase, or `/ima:cycle` automatically. Stop after the walkthrough or the
missing-prerequisite message.

## Presentation quality

Apply [readable-code](../readable-code/SKILL.md) principles to prose: name concepts by intent,
keep sections cohesive, use flat structure, and avoid abstraction for its own sake.
