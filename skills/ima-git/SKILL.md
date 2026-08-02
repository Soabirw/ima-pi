---
name: "ima-git"
description: "IMA trunk-based Git release policy. Use for release preparation, release branches, immutable production tags, hotfixes, deploy/preflight failures, or Git promotion decisions."
---

# IMA Git Release Policy

Use this policy before release preparation. Project-specific workflow details belong in its Serena memory; this skill provides the shared safety boundary.

## Branch model

| Ref | Role | Rule |
| --- | --- | --- |
| `main` | development trunk | all ordinary work lands here first |
| `release/*` | staging candidate | advances from `main` by fast-forward only |
| `v*` annotated tag | production release | cut from a pushed `release/*` commit and immutable |
| `hotfix/*` | emergency repair | branches from the production tag, then returns to `main` |

## Core rules

1. Do not commit directly to a release branch or merge sideways into one.
2. Refuse dirty worktrees rather than stashing, cleaning, discarding, or committing unrelated work.
3. Never force-push, rewrite history, move, replace, or delete a tag.
4. Verify the remote ref after every intended release-branch or tag push: compare a branch’s direct remote SHA with its expected commit; for an annotated tag, require the direct remote tag-object ref to exist and require only its peeled remote `^{}` target to equal the expected release commit.
5. Treat a project `ship-it` dry-run as the authoritative project-specific preflight. `/ima:ship-it` prepares refs and dry-runs only; a human owns actual deployment authority.

## Readiness and deploy gate

Before publishing a ref, confirm an accessible Git root, `origin`, a clean `git status --short --branch`, `git fetch origin --tags --prune`, and a `package.json` `ship-it` script. Read `.ima-ship-it.json` when present; its absence is not a failure, but report material policy disagreement.

Fresh remote deploy gates do not see unpushed local commits. A release branch or tag must be pushed and its remote SHA verified before its dry-run. When a project has an authoritative JSONL ship-it/deploy log, inspect its latest entry. On conflict between shell output and log evidence, fail closed.

| Exit code | Meaning |
| --- | --- |
| 0 | success |
| 1 | generic failure |
| 2 | validation or configuration error |
| 3 | preflight failure |
| 4 | remote push failure |

## Failure triage

A failed staging dry-run preserves the pushed release branch; fixes originate on `main` and later fast-forward into the release branch. A failed production dry-run preserves the immutable tag; fixes follow normal trunk/release flow and require a later new incremented tag. Do not recommend deployment after a failed or conflicting preflight.
