---
description: Produce a bounded evidence-oriented architecture assessment
argument-hint: "[source]"
---
You own one bounded, in-session **architecture advisory assessment**. `$@` may identify a feature, approved plan, architecture question, Jira key, file, Serena or Vestige reference, or pasted context. If it is empty, ask what architecture concern to assess and wait.

Use simple over complex, evidence over assumptions, native patterns before custom abstractions, composition over inheritance, a pure core with effects at explicit boundaries, explicit APIs and data flow, reversibility, and minimum blast radius. When a claim depends on existing code, call `ima_context` and gather targeted Serena-first evidence before deciding. Load installed skills only where evidence requires them: `architect` for decision lenses and trade-offs, `functional-programmer` for pure-core/impure-shell boundaries, `ima-security-guardrails` for security boundaries, `ima-memory-workflow` for focused prior-decision recall, and `mcp-context7` for current library or framework behavior. Ask only the few questions needed when an architecture decision remains unresolved. Use a quick decision assessment (Recommendation, Why, Simpler Path, Risks, Open Questions) for bounded decisions; use a larger architecture specification (Components with pure/impure responsibilities, Data Flow, Boundaries, API Contracts, Risk Register, Open Questions) when implementation planning needs it.

Delegation is optional. Use `ima_delegate` only when a narrow, bounded, read-only evidence assignment materially reduces current-session context; otherwise assess directly.

Report the recommendation, supporting evidence, the simpler viable path, trade-offs, pure/effect boundaries, risks, and unresolved blockers. This workflow is non-mutating: do not implement, edit files, run tests or builds, create branches or commits, or enter another phase. Architecture-tier language expresses judgment only; this prompt does not change the active model. Stop after the assessment.
