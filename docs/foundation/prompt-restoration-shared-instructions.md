# Prompt-restoration shared instructions

## Purpose

Unit 1 of `ima-pi.prompt-restoration` establishes the reusable instruction sources that later prompt-restoration units reference by name. Each skill owns one cross-cutting concern; downstream prompts and agents load the applicable skill instead of copying its rules.

This document is the wire pattern, not a runtime include and not a replacement for `ima_context` or `ima_lifecycle`.

## Shared skill catalog

| Skill | Single responsibility | Current named wiring |
| --- | --- | --- |
| `ima-memory-workflow` | Route task context and preservation between Serena, Vestige, and Qdrant. | Planned for later prompt units. |
| `ima-security-guardrails` | Apply WordPress/PHP, JavaScript/TypeScript, FP, and Bootstrap security boundaries. | Planned for later prompt units. |
| `ima-vision-handoff` | Route visual evidence through `ima_delegate` to the evidence-only `vision-handoff` agent. | `agents/vision-handoff.md` declares it. |
| `ima-delegation-contract` | Bound specialist delegation, self-contained briefs, ownership, and failure escalation. | Unit 3 `ima:review`, `ima:adversarial-review`, and `ima:test` reference it. |
| `code-review` | FP-aware, security-first, read-only review methodology with verified findings and implementation-grade remediation. | `reviewer`, `review-verifier`, `adversary-a`, and `adversary-b` declare it; Unit 3 review prompts reference it. |

## Consumption pattern

1. A prompt or agent identifies a relevant concern from its approved source and loads the named skill.
2. The prompt references the skill by name instead of reproducing its detailed instructions.
3. The phase retains only its phase-specific methodology, acceptance criteria, and lifecycle authority.
4. `ima_context` remains the source-hydration boundary; `ima_lifecycle` remains the formal artifact-persistence boundary.

No prompt body is changed by this unit. Later units own their own prompt edits and must preserve this separation.

## Planned consumers

| Follow-on unit | Prompts | Skills to reference after that unit is approved |
| --- | --- | --- |
| Unit 2 — implementation | `ima:implement`, `ima:implement-js`, `ima:implement-wp`, `ima:resolve-review` | `ima-security-guardrails`, `ima-delegation-contract`, and `ima-memory-workflow` when task continuity matters. |
| Unit 3 — review and test | `ima:review`, `ima:rereview`, `ima:review-verify`, `ima:adversarial-review`, `ima:test` | `code-review`, `ima-security-guardrails`, `ima-delegation-contract`, and `ima-memory-workflow`; `ima:test` also uses `unit-testing`, `functional-programmer`, and `ima-vision-handoff` when applicable. |
| Unit 4 — documentation and knowledge | `ima:document`, `ima:memorize`, `ima:scorecard` | `ima-memory-workflow`. |
| Unit 5 — research | `ima:medical-research`, `ima:patristic-research`, `ima:investigate` | `ima-memory-workflow` and `ima-delegation-contract` where bounded discovery is needed. |
| Unit 6 — web and visual | `ima:design-to-code`, `ima:ui-ux-review` | `ima-vision-handoff`, `ima-delegation-contract`, and `ima-memory-workflow`. |
| Unit 7 — planning and ideation | `ima:architect`, `ima:brainstorm`, `ima:decompose` | `ima-memory-workflow` and `ima-delegation-contract`. |

## Fold-in dispositions

### Practitioner persona and MOIM

No standalone persona skill is created. The approved persona lens is already represented by the project `AGENTS.md` principles and the existing `architect` and `functional-programmer` skills: simple over complex, evidence over assumptions, native patterns, pure/effect boundaries, and explicit trade-offs.

`MOIM` has no separately defined repository source. Until a named source defines it, treat it as a persona or multi-minds label within that existing practitioner lens, not as a distinct runtime capability or new skill.

### FP principles

No duplicate FP-principles skill is created. `functional-programmer` remains the language-neutral principles source; `js-fp`, `php-fp`, `py-fp`, and `ruby-fp` remain language-specific sources. `ima-security-guardrails` carries only the cross-cutting prohibition on custom FP utility layers.

## Ownership

Unit 1 owns these shared skills, this wiring document, and the `vision-handoff` agent reference. Units 2–7 own any future prompt-level references. Do not copy a shared rule into a prompt merely because it is convenient; update the named skill when the rule itself changes.
