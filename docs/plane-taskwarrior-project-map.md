# Taskwarrior-to-Plane Project Mapping

## Purpose

Use this editable worksheet to choose a destination Plane project for every Taskwarrior
project in the approved inventory. The counts are a read-only snapshot captured during
planning; they include projects whose tasks are completed or deleted.

## How to use this worksheet

1. Complete the blank mapping fields for each project: **Migrate?**, **Plane workspace**,
   **Plane project name**, **Plane project key**, **Migration treatment**, and **Notes**.
2. Use a valid, unique Plane project key in the selected workspace. Plane keys are used in
   canonical references such as `plane:<workspace>:PROJECT-123`.
3. Record the treatment for projects that will not migrate, such as skip, archive, or another
   operator-approved outcome.
4. Do not infer a destination from the Taskwarrior name alone; destination values are
   operator decisions.

## Decision guidance

### Dotted Taskwarrior project families

Decide whether related dotted names, such as `ima-bench.artifacts` and
`ima-bench.canaries`, should consolidate into one Plane project or split into multiple Plane
projects. Record that decision in the applicable mapping rows.

### Deleted-only projects

Explicitly decide whether a project containing only deleted tasks should be skipped, archived,
or represented another way in Plane. Record the decision in **Migration treatment** and any
reasoning in **Notes**.

## Inventory snapshot

This approved snapshot contains **35 projects**, **272 tasks**, **57 pending**, **195
completed**, **20 deleted**, and **0 waiting** tasks.

| Taskwarrior project               | Total | Pending | Completed | Deleted | Migrate? | Plane workspace | Plane project name | Plane project key | Migration treatment                                          | Notes                                         |
|-----------------------------------|------:|--------:|----------:|--------:|----------|-----------------|--------------------|-------------------|--------------------------------------------------------------|-----------------------------------------------|
| `(none)`                          |     1 |       0 |         0 |       1 | N        |                 |                    |                   | Skip — deleted-only project                                  |                                               |
| `Acad.FNR2946`                    |     7 |       0 |         0 |       7 | N        |                 |                    |                   | Skip — deleted-only project                                  |                                               |
| `avada-builder`                   |     7 |       0 |         7 |       0 | Y        | ima             | Web                | WEB               | Migrate pending and completed history                        |                                               |
| `blog-export-fusion`              |     3 |       1 |         2 |       0 | Y        | ima             | Web                | WEB               | Migrate pending and completed history                        |                                               |
| `blog-migration-plugin`           |     8 |       0 |         8 |       0 | Y        | ima             | Web                | WEB               | Migrate pending and completed history                        |                                               |
| `discourse-sso-merger`            |    14 |       3 |        11 |       0 | Y        | ima             | Web                | WEB               | Migrate pending and completed history                        |                                               |
| `FNR-2976`                        |     1 |       1 |         0 |       0 | Y        | ima             | Web                | WEB               | Migrate pending and completed history                        |                                               |
| `FNR-3007`                        |    35 |       4 |        29 |       2 | Y        | ima             | Web                | WEB               | Migrate pending and completed history; skip 2 deleted tasks  | Deleted tasks are intentionally not migrated. |
| `goose-workstation`               |    13 |       5 |         8 |       0 | Y        | ima             | Skynet             | SKYNET            | Migrate pending and completed history                        |                                               |
| `ima-agentic-kit`                 |    10 |       0 |         0 |      10 | N        |                 |                    |                   | Skip — deleted-only project                                  |                                               |
| `ima-bench.artifacts`             |     1 |       0 |         1 |       0 | Y        | ima             | Skynet             | SKYNET            | Migrate pending and completed history                        |                                               |
| `ima-bench.canaries`              |     2 |       0 |         2 |       0 | Y        | ima             | Skynet             | SKYNET            | Migrate pending and completed history                        |                                               |
| `ima-bench.docs`                  |     1 |       0 |         1 |       0 | Y        | ima             | Skynet             | SKYNET            | Migrate pending and completed history                        |                                               |
| `ima-bench.planning`              |     1 |       0 |         1 |       0 | Y        | ima             | Skynet             | SKYNET            | Migrate pending and completed history                        |                                               |
| `ima-bench.refactor`              |     2 |       0 |         2 |       0 | Y        | ima             | Skynet             | SKYNET            | Migrate pending and completed history                        |                                               |
| `ima-bench.schema`                |     1 |       0 |         1 |       0 | Y        | ima             | Skynet             | SKYNET            | Migrate pending and completed history                        |                                               |
| `ima-bench.scoring`               |     2 |       0 |         2 |       0 | Y        | ima             | Skynet             | SKYNET            | Migrate pending and completed history                        |                                               |
| `ima-bench.workflow`              |     2 |       0 |         2 |       0 | Y        | ima             | Skynet             | SKYNET            | Migrate pending and completed history                        |                                               |
| `ima-mcp-gateway`                 |    10 |       0 |        10 |       0 | Y        | ima             | Skynet             | SKYNET            | Migrate pending and completed history                        |                                               |
| `ima-mcp.serena-gateway`          |    56 |       1 |        55 |       0 | Y        | ima             | Skynet             | SKYNET            | Migrate pending and completed history                        |                                               |
| `ima-mcp.serena-gateway.embedded` |    21 |      21 |         0 |       0 | Y        | ima             | Skynet             | SKYNET            | Migrate pending and completed history                        |                                               |
| `ima-mcp.vestige`                 |     4 |       0 |         4 |       0 | Y        | ima             | Skynet             | SKYNET            | Migrate pending and completed history                        |                                               |
| `ima-pi`                          |    10 |       0 |        10 |       0 | Y        | ima             | Skynet             | SKYNET            | Migrate pending and completed history                        |                                               |
| `ima-pi.context-tool-schema`      |     2 |       0 |         2 |       0 | Y        | ima             | Skynet             | SKYNET            | Migrate pending and completed history                        |                                               |
| `ima-pi.ima-agents`               |     2 |       0 |         2 |       0 | Y        | ima             | Skynet             | SKYNET            | Migrate pending and completed history                        |                                               |
| `ima-pi.ima-mcp-deprecation`      |     5 |       0 |         5 |       0 | Y        | ima             | Skynet             | SKYNET            | Migrate pending and completed history                        |                                               |
| `ima-pi.opportunistic-delegation` |     3 |       0 |         3 |       0 | Y        | ima             | Skynet             | SKYNET            | Migrate pending and completed history                        |                                               |
| `ima-pi.plane`                    |     4 |       2 |         2 |       0 | Y        | ima             | Skynet             | SKYNET            | Migrate pending and completed history                        |                                               |
| `ima-pi.prompt-restoration`       |     9 |       0 |         9 |       0 | Y        | ima             | Skynet             | SKYNET            | Migrate pending and completed history                        |                                               |
| `ima-pi.readable-code`            |     3 |       0 |         3 |       0 | Y        | ima             | Skynet             | SKYNET            | Migrate pending and completed history                        |                                               |
| `ima-pi.review-walkthrough`       |     2 |       0 |         2 |       0 | Y        | ima             | Skynet             | SKYNET            | Migrate pending and completed history                        |                                               |
| `ima-pi.tts`                      |     8 |       0 |         8 |       0 | Y        | ima             | Skynet             | SKYNET            | Migrate pending and completed history                        |                                               |
| `imablog`                         |     8 |       8 |         0 |       0 | Y        | ima             | Web                | WEB               | Migrate pending and completed history                        |                                               |
| `jim-reviewer-workflow`           |     2 |       0 |         2 |       0 | Y        | ima             | Web                | WEB               | Migrate pending and completed history                        |                                               |
| `shared-dev-memory`               |    12 |      11 |         1 |       0 | Y        | ima             | Skynet             | SKYNET            | Migrate pending and completed history                        |                                               |

## Next step

After the operator completes the destination mapping, run a separate read-only preliminary
compatibility check. That assessment will evaluate Taskwarrior-to-Plane field, status, and
relationship compatibility and identify any required Plane configuration changes. This worksheet
does not claim that compatibility has already been assessed.
