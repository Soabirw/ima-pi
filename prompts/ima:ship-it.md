---
description: Prepare and validate staging release branches or immutable production tags without deploying
argument-hint: "stg|prod [project-path] [release details]"
---
You own one terminal release-preparation operation. Treat `$@` as natural-language input, not a flag grammar. Load the `ima-git` skill before any release operation.

Resolve exactly one target environment: `stg` or `prod`. The primary forms are `/ima:ship-it stg [project-path]` and `/ima:ship-it prod [project-path]`. Default an omitted project path to the current working directory. Natural-language details may request a `release/*` branch or `v*` tag. If the environment is missing or ambiguous, ask one focused question before mutation. Ask only when production branch or tag selection remains consequentially ambiguous after the stated precedence.

## Authority and stop boundary

This invocation authorizes local checkout changes, `origin` fetches, creation/fast-forward/push of one staging release branch, creation/push of one new annotated production tag, detached checkout at that tag, and the matching dry-run. It never authorizes a deployment, commit, stash, discard, clean, force operation, tag movement/deletion, or history rewrite. Do **not** execute `npm run ship-it -- stg` or `npm run ship-it -- prod`; those commands may only be recommended after a successful dry-run. Report the outcome and stop; do not invoke `/ima:cycle`, persist a lifecycle artifact, or enter a workflow DSL.

## Shared readiness sequence

Before any modifying Git command:

1. Resolve the path, run `git rev-parse --show-toplevel`, and confirm `origin` exists; sanitize an origin URL before displaying it if needed.
2. Run `git status --short --branch` and require an entirely clean worktree, including untracked files. Stop rather than alter it.
3. Run `git fetch origin --tags --prune`.
4. Read `package.json` and require an npm ship-it script. Read optional `.ima-ship-it.json`; report material disagreement with IMA policy but do not fail merely because it is absent.
5. Make only the narrow local and remote ref checks required by the selected flow. The matching `npm run ship-it -- <env> --dry-run` is authoritative for project-specific preflight behavior.

## Staging (`stg`)

1. `git switch main`, then `git pull --ff-only origin main`.
2. Use an explicitly requested valid `release/*` name or default to `release/YYYY-MM-DD` using the local date.
3. Inspect local and remote branch existence. A new branch starts from updated `main`. An existing branch must be able to advance to `main` by fast-forward: refuse divergence, sideways merges, and release-only commits.
4. Fast-forward the release branch to current `main`, push it to `origin` without force, capture its SHA, and verify the remote branch resolves to that SHA. Leave checkout on the release branch.
5. Run `npm run ship-it -- stg --dry-run` unconditionally. Inspect the latest project ship-it/deploy log when available, especially on failure or conflicting evidence.
6. On success, recommend exactly `npm run ship-it -- stg` and state it was not executed. On failure, preserve the pushed branch, do not deploy, and state that fixes begin on `main`.

## Production (`prod`)

1. Select the release branch in order: an explicit valid `release/*`; the current `release/*` branch; today’s existing `release/YYYY-MM-DD`; otherwise ask the user to choose from relevant remote release branches.
2. Require the branch on `origin`, switch to it, run `git pull --ff-only origin <release-branch>`, and require local HEAD to equal the pushed candidate.
3. Use an explicitly requested valid unused `v*` tag, or derive `vYYYY.MM.DD-1` and increment its final number until both local and remote checks show it unused. Refuse non-`v*` names and any attempt to move, replace, delete, or force-update a tag.
4. Capture `git rev-parse HEAD` as the release commit SHA, create an annotated tag at that commit, and require `git cat-file -t <tag>` to report `tag`. Push only that tag without force. Query both exact remote refs with shell-quoted refspec arguments: `refs/tags/<tag>` must exist as the direct tag object, and `refs/tags/<tag>^{}` must exist and equal the captured release commit SHA. Fail closed if the local object is not a tag or either remote ref is absent or mismatched; preserve the immutable pushed tag and do not run the dry-run. Only then `git switch --detach <tag>`.
5. Run `npm run ship-it -- prod --dry-run` unconditionally and inspect the latest project log when available.
6. On success, recommend exactly `npm run ship-it -- prod` and state it was not executed. On failure, preserve the immutable tag, do not deploy, and require a later invocation to create a new incremented tag after normal fixes.

## Final response

Report current ref; created or advanced branch or created tag; SHA; remote verification; dry-run result; any blocker; and the exact next command only after preflight passes. Classify exit evidence as success (0), generic failure (1), validation/config error (2), preflight failure (3), or remote push failure (4). Fail closed on conflicting shell/log evidence.
