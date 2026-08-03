#!/usr/bin/env python3
"""Convert project context files into suggested Serena memory blocks.

The script is intentionally conservative: it reads common harness context files
and prints reviewable Markdown for standard Serena memories. It does not call
Serena or write memories automatically.
"""

from __future__ import annotations

import argparse
import datetime as dt
from pathlib import Path


SOURCE_FILES = (".goosehints", "CLAUDE.md", "AGENTS.md")

MEMORIES = (
    "core",
    "conventions",
    "tech_stack",
    "suggested_commands",
    "task_completion",
    "memory_maintenance",
)

ORG_STANDARD_SEEDS = {
    "conventions": [
        "## Org Standard: Vestige Task Lifecycle",
        "- For task-scoped project work, use Vestige as the living task memory across planning, implementation, review, resolution, and closeout.",
        "- Before planning, implementing, reviewing, or closing a task, search Vestige by the Taskwarrior ID/UUID, Jira key, project task key, and related task keys.",
        "- Store lifecycle updates with a shared task key so future recipe sessions can reconstruct the task history.",
        "- Serena stores stable project instructions; Vestige stores the evolving task thread.",
        "## Org Standard: Testing Contract",
        "- Inspect project evidence before choosing a test level; choose the smallest supported level that proves the behavior.",
        "- Do not introduce unsupported integration or E2E infrastructure implicitly.",
    ],
    "tech_stack": [
        "## Org Standard: Testing Infrastructure",
        "- Record configured test frameworks, dependency evidence, test configuration paths, and available test infrastructure.",
    ],
    "suggested_commands": [
        "## Org Standard: Vestige Task Lookup",
        "- Search Vestige for the active task key before acting, then search related keys and feature names when the first result is incomplete.",
        "- Useful search examples: `CM-001`, `CM-010`, `CM-011`, Jira keys, Taskwarrior UUIDs, and user-provided feature names.",
        "- When using Taskwarrior, read the task first, capture the UUID or stable project key, then use that key in Vestige updates.",
        "## Org Standard: Testing Commands",
        "- Record canonical targeted and broader test commands plus required environment prerequisites.",
    ],
    "task_completion": [
        "## Org Standard: Vestige Closeout",
        "- Before marking a Taskwarrior task or equivalent tracker item complete, update Vestige with the final outcome.",
        "- Include verification performed, review concerns resolved, changed files or modules, remaining risk, and follow-up task references.",
        "- If review found issues, re-read the Vestige review memory before resolving and store the resolution summary afterward.",
        "## Org Standard: Testing Completion",
        "- Record mandatory validation gates, expected signals, and unverified-path reporting.",
    ],
    "memory_maintenance": [
        "## Org Standard: Memory Roles",
        "- Serena memories hold stable project context loaded at startup.",
        "- Vestige memories carry the living task lifecycle from plan to implementation, review, resolution, and closeout.",
        "- Keep the Vestige lifecycle rule in Serena `conventions`, `suggested_commands`, and `task_completion` so recipes load it consistently.",
        "- Treat the testing-contract seeds as reusable guidance alongside the lifecycle seeds.",
    ],
}

COMMAND_KEYWORDS = (
    "task ",
    "npm ",
    "pnpm ",
    "yarn ",
    "composer ",
    "ddev ",
    "wp ",
    "goose ",
    "git ",
    "pytest",
    "phpunit",
    "vitest",
    "playwright",
    "make ",
    "docker ",
)

CONVENTION_KEYWORDS = (
    "always",
    "never",
    "prefer",
    "avoid",
    "must",
    "should",
    "policy",
    "security",
    "standard",
    "convention",
    "version",
    "release",
)

COMPLETION_KEYWORDS = (
    "before finishing",
    "before final",
    "verification",
    "validate",
    "test",
    "changelog",
    "readme",
    "commit",
    "pull request",
    "closeout",
)

TECH_KEYWORDS = (
    "typescript",
    "javascript",
    "python",
    "php",
    "ruby",
    "go ",
    "node",
    "react",
    "vue",
    "wordpress",
    "laravel",
    "rails",
    "ddev",
    "docker",
    "sqlite",
    "postgres",
    "mysql",
    "redis",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert .goosehints, CLAUDE.md, and AGENTS.md into Serena memory suggestions.",
    )
    parser.add_argument(
        "--root",
        default=".",
        help="Project root containing context files. Defaults to current directory.",
    )
    parser.add_argument(
        "--include-org-standards",
        action="store_true",
        help="Add shared IMA/agent workflow seeds, including Vestige lifecycle and testing-contract guidance.",
    )
    return parser.parse_args()


def read_sources(root: Path) -> list[tuple[str, str]]:
    sources: list[tuple[str, str]] = []
    for name in SOURCE_FILES:
        path = root / name
        if path.exists() and path.is_file():
            sources.append((name, path.read_text(encoding="utf-8")))
    return sources


def route_line(line: str) -> str:
    lowered = line.strip().lower()
    if not lowered:
        return "core"
    if lowered.startswith(("$", "```")) or any(token in lowered for token in COMMAND_KEYWORDS):
        return "suggested_commands"
    if any(token in lowered for token in COMPLETION_KEYWORDS):
        return "task_completion"
    if any(token in lowered for token in TECH_KEYWORDS):
        return "tech_stack"
    if any(token in lowered for token in CONVENTION_KEYWORDS):
        return "conventions"
    return "core"


def build_memories(
    sources: list[tuple[str, str]],
    include_org_standards: bool = False,
) -> dict[str, list[str]]:
    buckets = {name: [] for name in MEMORIES}
    current_heading = ""

    for source_name, content in sources:
        buckets["core"].append(f"## Source: {source_name}")
        for raw_line in content.splitlines():
            line = raw_line.rstrip()
            stripped = line.strip()
            if stripped.startswith("#"):
                current_heading = stripped.lstrip("#").strip()
                buckets["core"].append(f"\n### {current_heading}")
                continue

            target = route_line(line)
            prefix = f"- [{source_name}]"
            if current_heading:
                prefix += f" ({current_heading})"
            if stripped:
                buckets[target].append(f"{prefix} {stripped}")

    if include_org_standards:
        for memory_name, lines in ORG_STANDARD_SEEDS.items():
            buckets[memory_name].extend(lines)

    source_list = ", ".join(name for name, _ in sources) if sources else "(none)"
    today = dt.date.today().isoformat()
    buckets["memory_maintenance"].extend(
        [
            f"## Context Migration",
            f"- Migrated source files: {source_list}",
            f"- Migration date: {today}",
            "- Standard memory names: core, conventions, tech_stack, suggested_commands, task_completion, memory_maintenance.",
            "- Refresh these memories when the source context files change.",
            "- Treat Serena memories as the runtime source of truth across Goose, Claude Code, Codex, and other harnesses.",
        ]
    )
    if include_org_standards:
        buckets["memory_maintenance"].append(
            "- Included org-standard seeds, including Vestige lifecycle and testing-contract guidance."
        )
    return buckets


def print_memories(memories: dict[str, list[str]]) -> None:
    for name in MEMORIES:
        lines = [line for line in memories[name] if line.strip()]
        if not lines:
            continue
        print(f"\n===== Serena memory: {name} =====\n")
        print("\n".join(lines))


def main() -> int:
    args = parse_args()
    root = Path(args.root).expanduser().resolve()
    sources = read_sources(root)
    if not sources and not args.include_org_standards:
        print(f"No context files found in {root}: {', '.join(SOURCE_FILES)}")
        return 1

    print(f"Project root: {root}")
    print(f"Sources: {', '.join(name for name, _ in sources) if sources else '(none)'}")
    print_memories(build_memories(sources, include_org_standards=args.include_org_standards))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
