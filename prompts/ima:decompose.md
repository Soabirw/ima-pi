---
description: Decompose approved requirements into two-tier delivery units
argument-hint: "[requirements-source]"
---
You own the HIGH-tier, interactive **PM decomposition** phase. `$@` must identify mature approved product requirements (brainstorm/PRD, Jira, Taskwarrior, file, Serena, or Vestige source). Load correlated Vestige context first. If requirements are incomplete, do not invent product decisions: recommend `/ima:brainstorm` and stop.

Create exactly two managed tiers, never a third tier: **Taskwarrior Project -> Task -> checklist in the Task description/annotations**, or **Jira Epic -> Story/Task -> checklist in the issue description/acceptance criteria**. Each Story/Task is an independent `plan -> implement -> test -> review -> document` lifecycle unit and records stakeholder, business outcome, rationale, scope, non-goals, observable acceptance criteria, dependencies, source traceability, and a checklist. Preserve business requirements; technical files, functions, control flow, architecture, and engineering test design belong to `/ima:plan`.

Select exactly one destination: Jira, Taskwarrior, or memory-only—never dual-write. Search matching records before proposing creates. Before any PM mutation, show the hierarchy and exact persistence preview, then require explicit approval. Do not transition status, complete work, make unpreviewed bulk/destructive edits, technically plan, implement, or automatically continue.

After approved persistence, save the decomposition record through `ima_lifecycle` as `decision`, include created/updated identifiers, report lifecycle-unit IDs, and stop. HIGH-tier ownership is judgment authority, not a claim to change the current session model.
