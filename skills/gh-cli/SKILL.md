---
name: gh-cli
description: >-
  GitHub CLI (gh) for pull requests, issues, releases, Actions, code review, and repo
  management. Primary tool for GitHub operations — reliable, fast, always available.
  Use when: creating PRs, reviewing PRs, managing issues, checking CI status, creating
  releases, searching GitHub, or any github.com operation. Triggers on: GitHub, gh,
  pull request, PR, issue, release, actions, workflow, CI status, code review, merge PR.
  NOT for Gitea — use tea-gitea for internal repos.
---

# GitHub CLI (`gh`)

## Prerequisites

```bash
gh auth status  # must pass before any operations
```

## Command Reference

### Pull Requests

| Operation | Command |
|-----------|---------|
| Create PR | `gh pr create --title "..." --body "..." --base main` |
| Create PR (fill from commits) | `gh pr create --fill` |
| Create draft PR | `gh pr create --draft --title "..." --body "..."` |
| List open PRs | `gh pr list` |
| List PRs by state | `gh pr list --state closed` |
| List PRs by author | `gh pr list --author "@me"` |
| List PRs by label | `gh pr list --label "bug"` |
| View PR details | `gh pr view 123` |
| View PR in browser | `gh pr view 123 --web` |
| View PR diff | `gh pr diff 123` |
| Check CI status | `gh pr checks 123` |
| Checkout PR locally | `gh pr checkout 123` |
| Merge PR (squash) | `gh pr merge 123 --squash` |
| Merge PR (rebase) | `gh pr merge 123 --rebase` |
| Merge PR (merge commit) | `gh pr merge 123 --merge` |
| Merge + delete branch | `gh pr merge 123 --squash --delete-branch` |
| Close PR | `gh pr close 123` |
| Reopen PR | `gh pr reopen 123` |
| Edit PR | `gh pr edit 123 --title "..." --body "..."` |
| Add reviewer | `gh pr edit 123 --add-reviewer username` |
| Add label | `gh pr edit 123 --add-label "bug"` |
| Mark as ready | `gh pr ready 123` |
| Comment on PR | `gh pr comment 123 --body "..."` |
| Review PR (approve) | `gh pr review 123 --approve --body "LGTM"` |
| Review PR (request changes) | `gh pr review 123 --request-changes --body "..."` |
| Review PR (comment only) | `gh pr review 123 --comment --body "..."` |
| My PR status | `gh pr status` |

### Issues

| Operation | Command |
|-----------|---------|
| Create issue | `gh issue create --title "..." --body "..."` |
| Create issue with labels | `gh issue create --title "..." --label "bug" --label "priority"` |
| Create issue with assignee | `gh issue create --title "..." --assignee "@me"` |
| List open issues | `gh issue list` |
| List by state | `gh issue list --state closed` |
| List by label | `gh issue list --label "bug"` |
| List by assignee | `gh issue list --assignee "@me"` |
| View issue | `gh issue view 42` |
| View in browser | `gh issue view 42 --web` |
| Close issue | `gh issue close 42` |
| Close with comment | `gh issue close 42 --comment "Fixed in v2.11.0"` |
| Reopen issue | `gh issue reopen 42` |
| Comment on issue | `gh issue comment 42 --body "..."` |
| Edit issue | `gh issue edit 42 --title "..." --body "..."` |
| Add label | `gh issue edit 42 --add-label "in-progress"` |
| Remove label | `gh issue edit 42 --remove-label "triage"` |
| Assign | `gh issue edit 42 --add-assignee username` |
| Pin issue | `gh issue pin 42` |
| Transfer issue | `gh issue transfer 42 owner/other-repo` |
| My issue status | `gh issue status` |

### Repositories

| Operation | Command |
|-----------|---------|
| View repo | `gh repo view owner/name` |
| View in browser | `gh repo view --web` |
| Clone repo | `gh repo clone owner/name` |
| Fork repo | `gh repo fork owner/name` |
| Create repo | `gh repo create name --public --description "..."` |
| Create private repo | `gh repo create name --private` |
| List my repos | `gh repo list` |
| List org repos | `gh repo list org-name` |
| Sync fork | `gh repo sync owner/name` |
| Set default repo | `gh repo set-default owner/name` |

### Releases & Tags

| Operation | Command |
|-----------|---------|
| Create release | `gh release create v1.0.0 --title "v1.0.0" --notes "..."` |
| Create draft release | `gh release create v1.0.0 --draft --title "v1.0.0" --notes "..."` |
| Create release from tag | `gh release create v1.0.0 --generate-notes` |
| Upload assets | `gh release upload v1.0.0 ./dist/*.tar.gz` |
| List releases | `gh release list` |
| View release | `gh release view v1.0.0` |
| Download assets | `gh release download v1.0.0` |
| Delete release | `gh release delete v1.0.0` |
| Edit release | `gh release edit v1.0.0 --title "..." --notes "..."` |

### GitHub Actions

| Operation | Command |
|-----------|---------|
| List workflows | `gh workflow list` |
| View workflow | `gh workflow view workflow-name` |
| Run workflow | `gh workflow run workflow-name` |
| Run with inputs | `gh workflow run workflow-name -f key=value` |
| Disable workflow | `gh workflow disable workflow-name` |
| Enable workflow | `gh workflow enable workflow-name` |
| List recent runs | `gh run list` |
| List runs for workflow | `gh run list --workflow workflow-name` |
| View run details | `gh run view 12345` |
| View run logs | `gh run view 12345 --log` |
| Watch run progress | `gh run watch 12345` |
| Download artifacts | `gh run download 12345` |
| Rerun failed jobs | `gh run rerun 12345 --failed` |
| Cancel run | `gh run cancel 12345` |

### Search

| Operation | Command |
|-----------|---------|
| Search repos | `gh search repos "query" --sort stars` |
| Search issues | `gh search issues "query" --repo owner/name` |
| Search PRs | `gh search prs "query" --state open` |
| Search code | `gh search code "pattern" --repo owner/name` |
| Search commits | `gh search commits "query" --repo owner/name` |

### Labels

| Operation | Command |
|-----------|---------|
| List labels | `gh label list` |
| Create label | `gh label create "name" --color "0075ca" --description "..."` |
| Edit label | `gh label edit "name" --new-name "..." --color "..."` |
| Delete label | `gh label delete "name" --yes` |
| Clone labels to another repo | `gh label clone source-owner/source-repo` |

### Raw API Access

```bash
# GET
gh api repos/{owner}/{repo}/topics

# POST
gh api repos/{owner}/{repo}/labels -f name="priority" -f color="ff0000"

# Paginated
gh api repos/{owner}/{repo}/issues --paginate

# GraphQL
gh api graphql -f query='{ viewer { login } }'

# JSON + jq
gh api repos/{owner}/{repo}/pulls --jq '.[].title'
```

## Decision Logic

```
github.com remote? → use gh (this skill)
Gitea remote?      → use tea-gitea
Local git ops      → use git CLI directly

PRs                → gh pr ...
Issues             → gh issue ...
Releases           → gh release ...
CI/CD              → gh run ... / gh workflow ...
Search             → gh search ...
Anything else      → gh api ...
```

## Common Workflows

### PR with HEREDOC body

```bash
gh pr create --title "feat: add gh-cli skill" --body "$(cat <<'EOF'
## Summary
- Added gh-cli skill for GitHub CLI operations

## Test plan
- [ ] Verify gh auth status
- [ ] Test PR creation workflow
EOF
)"
```

### Check CI then merge

```bash
gh pr checks 123
gh pr merge 123 --squash --delete-branch
```

### Release with auto-changelog

```bash
gh release create v2.12.0 \
  --title "v2.12.0 — Add gh-cli skill" \
  --generate-notes \
  --latest
```

### Cross-repo issue search

```bash
gh search issues "is:open assignee:@me label:bug" --limit 20
gh search prs "is:open review-requested:@me" --limit 20
```

### PR comments via API

```bash
gh api repos/{owner}/{repo}/pulls/123/comments --jq '.[].body'
gh api repos/{owner}/{repo}/issues/123/comments --jq '.[] | "\(.user.login): \(.body)"'
```

## Output & Targeting

```bash
# Structured output
gh pr list --json number,title,state
gh pr list --json number,title --jq '.[] | "\(.number): \(.title)"'

# Target any repo
gh pr list -R owner/other-repo
gh issue create -R owner/other-repo --title "..."
gh run list -R owner/other-repo
```

## When NOT to Use

| Situation | Use Instead |
|-----------|-------------|
| Gitea-hosted repos | `tea-gitea` skill and `tea` CLI |
| Local git operations (commit, diff, stash) | `git` CLI directly |
| Reading local files | Read tool |
| Pushing/pulling code | `git push` / `git pull` |
