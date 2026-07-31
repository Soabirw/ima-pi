# IMA agents

FNR-3014 provides seven package-defined, inspectable specialists: `explore`, `implementer`, `js-developer`, `wordpress-developer`, `tester`, `reviewer`, and `vision-handoff`.

Each `*.md` file has one leading YAML frontmatter block and a non-empty Markdown prompt. Required metadata covers schema version, name, description, model tier, authority, tools, skills, zero-depth delegation, independence, result contract, and escalation categories. Unknown fields, invalid names, empty prompts, unsupported tools, duplicate same-source names, and unsafe authority/tool combinations are rejected with diagnostics.

Definitions resolve by full replacement—trusted project, then user, then package—without field merging. Paths are `<package>/agents`, `~/.pi/agent/ima/agents`, and trusted `<project>/.pi/ima/agents`; project definitions are loaded only when `IMA_PI_PROJECT_TRUSTED=true`. Symlinks outside each definition directory are refused.

Use `/ima:agents` to inspect resolved name, source, tier, authority, and description without exposing prompts. The initial catalog is deliberately bounded: it adds neither arbitrary nested agents nor a workflow engine.
