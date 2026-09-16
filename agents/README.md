# IMA agents

FNR-3014, FNR-3022, and FNR-3025 provide seventeen package-defined, inspectable specialists: `adversary-a`, `adversary-b`, `brainstormer`, `decomposer`, `document-assessor`, `documenter`, `explore`, `implementer`, `investigator`, `js-developer`, `planner`, `preflight-probe`, `review-verifier`, `reviewer`, `tester`, `vision-handoff`, and `wordpress-developer`.

Each `*.md` file has one leading YAML frontmatter block and a non-empty Markdown prompt. Required metadata covers schema version, name, description, bounded `useWhen` applicability cues, model tier, optional lifecycle phase, authority, tools, skills, zero-depth delegation, independence, result contract, and escalation categories. Package agents must declare one to three non-empty single-line cues of at most 180 characters; legacy user or trusted-project definitions without `useWhen` receive a normalized description fallback. Unknown fields, invalid names, empty prompts, unsupported tools, invalid applicability, duplicate same-source names, and unsafe authority/tool combinations are rejected with diagnostics.

The lifecycle-specialist evidence agents are `brainstormer` for bounded ideation, `planner` for plan-level analysis and decisions, `decomposer` for independent delivery-unit decomposition, and `investigator` for deep root-cause evidence.

Definitions resolve by full replacement—trusted project, then user, then package—without field merging. Paths are `<package>/agents`, `~/.pi/agent/ima/agents`, and trusted `<project>/.pi/ima/agents`; project definitions are loaded only when `IMA_PI_PROJECT_TRUSTED=true`. Symlinks outside each definition directory are refused.

Use `/ima:agents` to inspect resolved name, source, tier, authority, description, and applicability cues without exposing prompts. On ordinary turns where `ima_delegate` is active, Pi adds the resolved catalog to the parent prompt so it can delegate a clear bounded match opportunistically or honor an explicit “use `<name>` agent” request through the same tool. If no agent fits, the parent handles the work; no confirmation loop is introduced, and existing activity remains visible. Writers still require exact disjoint ownership, and children cannot delegate. Terminal fresh and focused-continuation results return a 400-line/10 KiB bounded summary and a structured session pointer; the full child-authored report remains in its Pi JSONL session. The catalog is withheld as one sanitized unavailable notice if any definition has diagnostics.

The catalog is deliberately bounded: `review-verifier` is fresh and read-only; `adversary-a` and `adversary-b` are complementary, provider-neutral, fresh read-only agents with no follow-up or nested delegation. They may be requested only as one pair with a matching complete evidence packet, and receive that same coordinator brief only after distinct configured routes pass preflight; `document-assessor` is read-only and produces manifest-only documentation assessments, while `documenter` can mutate only exact approved Markdown/text documentation targets. Neither adds arbitrary nested agents nor a workflow engine.


## Fast read-only exploration

FNR-3020 reuses `explore` as the fast read-only exploration target. `explore` is LOW-tier, fast, shallow, and bounded mapping; `investigator` is HIGH-tier, deep, thorough multi-file root-cause evidence and does not replace `explore`. `explore` is invoked through `ima_delegate`, not exposed as a duplicate standalone command. Give it a complete, bounded assignment and request evidence rather than implementation, for example:

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

The production tool remains authoritative for the actual assignment contract and routing. `implementer`, `js-developer`, and `wordpress-developer` use `implement`; `tester` uses `test`; `reviewer` uses `review`; and `document-assessor` plus `documenter` use `document`. Phase routing selects the configured phase mapping while `tier` remains the capability and authority boundary.

## Delegated Bash

`implementer`, `js-developer`, `wordpress-developer`, `tester`, and `documenter` declare `ima-delegated-bash`. Whenever a resolved definition—including a trusted custom definition—contains `bash` or `test`, fresh and focused-continuation prompts receive the same concise mandatory sequencing guidance. It requires one logical Bash command per call, independent observation before dependent work, repository-relative paths, native tools where possible, and reporting unsupported verification rather than claiming it.

The deterministic prompt contract does not prove universal model compliance. Adapter ownership and fail-closed Bash enforcement remain authoritative; the guidance does not expand available tools or authorize separators, backgrounding, pipes, substitutions, redirects, wrappers, or indirect execution.

## Visual evidence

`vision-handoff` is evidence-only. An `ima_delegate` assignment may provide one to four `imagePaths` only when it targets that vision-tier agent; each must be an accessible absolute local PNG, JPEG, WebP, or GIF under 20 MiB. Any invalid source blocks before prompting—there is no partial omission or text-only fallback. Child briefs and results expose opaque source IDs and safe basenames, never bytes, base64, or full paths.

```json
{ "title": "Review visual evidence", "assignments": [{ "id": "visual", "agent": "vision-handoff", "goal": "Report direct visual facts and uncertainty.", "context": "Evidence only.", "paths": [], "constraints": ["No implementation decisions"], "nonGoals": ["Planning"], "expectedOutput": "Visual evidence", "writeScope": [], "imagePaths": ["/absolute/local/mockup.png"] }] }
```


## Preflight child canary

`preflight-probe` is a no-tool, fixed-marker canary used only by `/ima:preflight` through `ima_delegate`. It returns `IMA_PI_PREFLIGHT_CHILD_OK` with its package-agent identity and limitations, is always fresh with no follow-up or delegation, and is not a general diagnostic agent. It does not replace parent preflight orchestration.
