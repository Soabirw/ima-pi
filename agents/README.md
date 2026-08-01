# IMA agents

FNR-3014 and FNR-3022 provide eleven package-defined, inspectable specialists: `explore`, `implementer`, `js-developer`, `wordpress-developer`, `tester`, `reviewer`, `review-verifier`, `adversary-a`, `adversary-b`, `documenter`, and `vision-handoff`.

Each `*.md` file has one leading YAML frontmatter block and a non-empty Markdown prompt. Required metadata covers schema version, name, description, model tier, authority, tools, skills, zero-depth delegation, independence, result contract, and escalation categories. Unknown fields, invalid names, empty prompts, unsupported tools, duplicate same-source names, and unsafe authority/tool combinations are rejected with diagnostics.

Definitions resolve by full replacement—trusted project, then user, then package—without field merging. Paths are `<package>/agents`, `~/.pi/agent/ima/agents`, and trusted `<project>/.pi/ima/agents`; project definitions are loaded only when `IMA_PI_PROJECT_TRUSTED=true`. Symlinks outside each definition directory are refused.

Use `/ima:agents` to inspect resolved name, source, tier, authority, and description without exposing prompts. The catalog is deliberately bounded: `review-verifier` is fresh and read-only; `adversary-a` and `adversary-b` are complementary, provider-neutral, fresh read-only agents with no follow-up or nested delegation. They receive the same coordinator brief only after distinct configured routes pass preflight; `documenter` can mutate only exact approved Markdown/text documentation targets, and it adds neither arbitrary nested agents nor a workflow engine.


## Fast read-only exploration

FNR-3020 reuses `explore` as the fast read-only exploration target. It is invoked through `ima_delegate`, not exposed as a duplicate standalone command. Give it a complete, bounded assignment and request evidence rather than implementation, for example:

```json
{
  "title": "Locate package prompt discovery path",
  "assignments": [
    {
      "id": "explore-prompt-discovery",
      "agent": "explore",
      "goal": "Locate the package prompt discovery path and report relevant files, findings, and blockers.",
      "context": "Read only. Fast targeted exploration of the repository; do not edit or run mutating commands.",
      "paths": [],
      "constraints": ["Read only; do not edit or run mutating commands"],
      "nonGoals": [],
      "expectedOutput": "Evidence with findings, files, and blockers",
      "writeScope": []
    }
  ]
}
```

The production tool remains authoritative for the actual assignment contract and routing.


## Visual evidence

`vision-handoff` is evidence-only. An `ima_delegate` assignment may provide one to four `imagePaths` only when it targets that vision-tier agent; each must be an accessible absolute local PNG, JPEG, WebP, or GIF under 20 MiB. Any invalid source blocks before prompting—there is no partial omission or text-only fallback. Child briefs and results expose opaque source IDs and safe basenames, never bytes, base64, or full paths.

```json
{ "title": "Review visual evidence", "assignments": [{ "id": "visual", "agent": "vision-handoff", "goal": "Report direct visual facts and uncertainty.", "context": "Evidence only.", "paths": [], "constraints": ["No implementation decisions"], "nonGoals": ["Planning"], "expectedOutput": "Visual evidence", "writeScope": [], "imagePaths": ["/absolute/local/mockup.png"] }] }
```
