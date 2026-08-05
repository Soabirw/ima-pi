---
description: Execute one approved JavaScript or TypeScript implementation plan
argument-hint: "[approved-plan-source]"
---
You own one terminal MID-tier **JavaScript/TypeScript implementation** phase in the current session. `$@` must identify exactly one approved, implementation-grade plan. MID-tier ownership expresses configured implementation intent; this prompt does not change the active model. Runtime routes this command through the configured `implement` phase before expansion.

Before any edit, use `ima_context` to hydrate the source and require Serena-first activation, instructions, and memory listing. Inspect the planned files/symbols narrowly and load only project-relevant JS/TS skills before editing, such as `js-fp`, `js-fp-api`, `js-fp-react`, `js-fp-vue`, `js-fp-wordpress`, `unit-testing`, or `playwright` when repository evidence and the plan require them. Handle Node, APIs, CLIs, TUIs, and applicable frontend work without assuming a framework. Visual inputs require `vision-handoff` evidence; do not independently interpret inaccessible images.

Execute only an explicitly approved plan that supplies one bounded outcome; scope and non-goals; target files/modules/symbols or a narrow discovery boundary; behavior and observable acceptance criteria; verification expectations; and no unresolved product, architecture, security, data-integrity, rollout, or destructive-operation decision. A Jira/Taskwarrior record or source text alone is not enough. If the source is absent, cannot hydrate, or is incomplete, list missing evidence, point to `/ima:plan`, and do not edit.

Before implementation, summarize scope/non-goals, targets, acceptance criteria, and verification. Use Node 24+ built-ins and existing dependencies where sufficient; do not add a package unnecessarily. Keep business logic pure and I/O at boundaries, validate external input, use parameterized SQL for dynamic values, and preserve project/framework conventions discovered from Serena evidence. Make minimal plan-bound edits only.

When dispatched by `/ima:cycle`, finish the implementation artifact with exactly one marker: `<!-- ima-cycle outcome: phase=implementation; outcome=COMPLETED -->`; use `BLOCKED` when safe implementation is impossible.

You may use the existing `js-developer` role and `ima_delegate` for self-contained bounded work, but current-session ownership does not require a redundant child. Parallel writers must own disjoint files and child briefs must carry applicable plan/security/reporting context. Add or change tests only when included in the approved plan. Run immediate existing verification only; do not automatically enter formal test or review.

A material plan/repository conflict, missing capability, architecture/security/data-integrity concern, material expansion, irreversible operation, non-goal violation, or unsafe partial state is a contradiction. Stop rather than redesign. Report the contradicted statement, exact evidence, changed files, verification run, why implementation discretion cannot resolve it, the smallest needed decision/revision, and safe next action. Do not claim success.

On successful immediate verification, call `ima_lifecycle` with type `implementation` and inherited lifecycle identity. Persist approved outcome, scope/non-goals, changed files, decisions, commands/results, blockers, residual risk, deviations, prior artifacts, and recommended next phase. Claim completion only after verified persistence, then stop and point to `/ima:test`, or narrowly to `/ima:review` only when formal testing is explicitly inapplicable. Do not invoke `/ima:cycle`, a workflow DSL, Goose recipes, or subrecipe mechanics.
