---
name: tea-gitea
description: >-
  Gitea CLI expertise for the `tea` command. Use for internal Gitea repositories,
  pull requests, issues, code review comments, approvals/rejections, releases,
  repo metadata, and direct Gitea API calls. Triggers on: tea, Gitea, internal PR,
  pull request, issue, review comment, approve PR, reject PR, merge PR, repo
  operations. NOT for GitHub; use gh-cli for github.com.
---

# `tea` / Gitea CLI

Use `tea` for Gitea-hosted repositories. Use `gh` only for GitHub.

## First Checks

```bash
tea --version
tea login list --output json
tea pr list --state open --output json
```

If a command matters, verify local syntax with `tea <command> --help`. `tea`
version behavior varies, and installed help wins over upstream examples.

## Targeting

Prefer explicit target flags in automation:

```bash
tea pr list --repo owner/repo --login gitea --output json
tea pr 123 --repo owner/repo --login gitea --fields index,title,state,author,body,diff
```

Use `--repo owner/repo` when the current directory is not the target repo. Use
`--login <name>` when multiple Gitea instances are configured.

## Pull Requests

```bash
# List
tea pr list --state open --fields index,title,state,author,updated --output json

# View with diff
tea pr 123 --fields index,title,state,author,body,diff

# Checkout
tea pr checkout 123

# Approve or request changes
tea pr approve 123 "LGTM"
tea pr reject 123 "Blocking reason"

# Merge
tea pr merge 123 --help
```

For review status with substantial Markdown, do not inline the body. Post the
long comment first with the safe comment pattern below, then use a short approve
or reject reason.

## Safe Comment Posting

`tea comment <index> "<body>"` is only safe for short one-line text. Shell
quoting, argument handling, and `tea` string joining can mangle large Markdown,
tables, code fences, and generated review reports.

For any multi-line or complex comment:

```bash
tmp="$(mktemp)"
cat > "$tmp" <<'EOF'
## Review

- Finding with `code`
- Fenced blocks, tables, and long text stay intact here.
EOF

tea comment 123 < "$tmp"
rm -f "$tmp"
```

Do not use command substitution such as `tea comment 123 "$(cat report.md)"` for
large comments; that still turns the content into one shell argument.

If stdin comment posting fails on the installed `tea`, use the authenticated API
fallback after checking `tea api --help`:

```bash
tea api -X POST '/repos/{owner}/{repo}/issues/123/comments' -F "body=@review.md"
```

Some upstream docs show `tea api -d @file`; local `tea` 0.12.0 documents
`-F key=@file` for file input. Always verify the local flag before using API
body posting.

## Issues

```bash
tea issue list --state open --output json
tea issue 42 --fields index,title,state,author,body,comments
tea issue create --title "Title" --description "Short body"
tea issue close 42
tea issue reopen 42
```

For long issue bodies, check `tea issue create --help` and prefer file/API input
over inline Markdown when available.

## Direct API

Use `tea api` when the high-level command cannot express the operation safely.
It authenticates with the configured login and expands `{owner}` / `{repo}` from
repo context.

```bash
tea api '/repos/{owner}/{repo}'
tea api '/repos/{owner}/{repo}/issues?state=open&type=pulls'
tea api -X POST '/repos/{owner}/{repo}/issues/123/comments' -F "body=@comment.md"
```

Use `-f key=value` for strings and `-F key=value` for typed values or file input
if local help documents it. Quote endpoints containing `?` or `&`.

## Output

Prefer machine-readable output for agent work:

```bash
tea pr list --output json
tea issue list --output json
tea login list --output json
```

If JSON output is unavailable or malformed for a command, fall back to table only
for human inspection and avoid brittle parsing.

## Review Workflow

```bash
tea login list --output json
tea pr 123 --fields index,title,state,author,body,diff
tea pr 123 --fields comments
```

Draft the review locally. Ask for approval before posting. When approved:

```bash
tea comment 123 < review-comment.md
tea pr approve 123 "Approved"
# or
tea pr reject 123 "Changes requested"
```

Posting comments and review status changes is non-reversible. Never post without
explicit user approval.

## Common Pitfalls

| Pitfall | Safer Pattern |
|---------|---------------|
| Inline long Markdown in `tea comment` | `tea comment <N> < file.md` |
| Command substitution for reports | Temp file + stdin redirection |
| Assuming upstream flags match local install | `tea <cmd> --help` first |
| Parsing tables | `--output json` |
| Relying on current directory repo detection | Add `--repo owner/repo` |
| Multiple Gitea logins | Add `--login name` |
