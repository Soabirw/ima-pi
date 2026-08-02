---
name: "rg"
description: "Ripgrep (rg) - fast recursive search tool. Prefer over grep/find for code search. Respects .gitignore, searches recursively, supports regex. Use for file content search, file listing, pattern matching. Triggers on: ripgrep, rg, search files, find in files, grep, search code, find pattern."
---

# Ripgrep (rg)

Use `rg` instead of `grep` or `find -name`. Faster, better defaults, respects `.gitignore`.

## Basic Search

```bash
rg "pattern"                    # Recursive from cwd
rg "pattern" src/               # Specific directory
rg -i "pattern"                 # Case-insensitive
rg -w "function"                # Whole words only
rg -F "exact.string.match"      # Fixed string (not regex)
```

## Output Control

```bash
rg -C 3 "pattern"               # 3 lines context before+after
rg -B 2 -A 5 "pattern"          # 2 before, 5 after
rg -c "pattern"                 # Count matches per file
rg -l "pattern"                 # Files with matches only
rg --files-without-match "pat"  # Files without matches
rg -o "pattern"                 # Matched text only (not full line)
```

## File Filtering

```bash
rg -t ts "pattern"              # TypeScript only
rg -t py "pattern"              # Python only
rg -T js "pattern"              # Exclude JavaScript
rg -g "*.vue" "pattern"         # By glob
rg -g "!*.test.ts" "pattern"    # Exclude test files
rg -g "src/**/*.ts" "pattern"   # Scoped glob
rg -g "*.ts" -g "*.vue" "pat"   # Multiple globs
```

## List Files (No Search)

```bash
rg --files                      # All files that would be searched
rg --files -g "*.ts"            # Files matching glob
rg --files src/components/      # Files in directory
```

## Bypass Filters

```bash
rg -u "pattern"     # Ignore .gitignore
rg -uu "pattern"    # + include hidden files
rg -uuu "pattern"   # + include binary files
rg --hidden "pat"   # Include hidden files only
```

## Advanced

```bash
rg -U "start.*\n.*end"                    # Multiline
rg -P "(?<=prefix)pattern(?=suffix)"      # PCRE2 (lookahead/lookbehind)
rg "old" -r "new"                         # Replace preview (no file modification)
rg "fn (\w+)" -r "function $1"            # Capture groups in replace
rg --json "pattern"                       # JSON output for scripting
```

## Common Recipes

```bash
# Function/class definitions
rg "^(export )?(async )?(function|const|class) \w+"   # JS/TS
rg "^(async )?def \w+|^class \w+"                     # Python
rg "^(public |private |protected )?(static )?function \w+"  # PHP

# Imports
rg "^import .+ from"
rg "require\(['\"]"

# TODOs
rg "TODO|FIXME|HACK|XXX" -g "!node_modules"

# Files by extension
rg --files -g "*.{ts,tsx}"
rg --files -g "!*.test.*"

# Search-replace preview
rg "oldFunction" -r "newFunction" --passthru
```

## vs grep/find

| Task | avoid | prefer |
|------|-------|--------|
| Search text | `grep -r "pat" .` | `rg "pat"` |
| Find files | `find . -name "*.ts"` | `rg --files -g "*.ts"` |
| Case insensitive | `grep -ri "pat" .` | `rg -i "pat"` |
| Whole word | `grep -rw "word" .` | `rg -w "word"` |
| Context | `grep -r -C 3 "pat" .` | `rg -C 3 "pat"` |
| Files only | `grep -rl "pat" .` | `rg -l "pat"` |

## Configuration

```shell
# ~/.ripgreprc
--smart-case
--max-columns=150
--max-columns-preview
--type-add
web:*.{html,css,js,ts,vue}
```

```bash
export RIPGREP_CONFIG_PATH="$HOME/.ripgreprc"
rg --type-list   # View all built-in types
```

Common types: `ts`, `js`, `py`, `rust`, `go`, `java`, `php`, `ruby`, `css`, `html`, `json`, `yaml`, `md`, `sh`
