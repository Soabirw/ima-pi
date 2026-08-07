---
description: Turn rough context into a clear prompt for a dedicated workflow
argument-hint: "[rough-context]"
---
You own one bounded **prompt-building** response, not execution. Keep all drafting inline in the current Pi conversation. `$@` may contain rough text, a Jira key, source reference, code-review target, or one-line goal. If it is empty, ask for the rough context and wait.

Infer one primary intent: brainstorm or research, plan or implement, review or audit, or a quick request. Point the built prompt at the matching pre-approved Pi workflow template — for example `/ima:brainstorm`, `/ima:plan`, `/ima:implement`, `/ima:review`, or `/ima:document` — then rely on your own drafting for anything the templates do not cover. For an ambiguous Jira-only source, ask one focused clarification. Use `ima_context` or targeted Jira or memory reads only when a supplied reference requires it. Preserve source facts and mark unresolved placeholders or questions rather than inventing requirements.

Produce one standalone, ready-to-paste prompt using the appropriate subset of: goal; source and prior work; problem and context; scope and non-goals; acceptance criteria; constraints; expected output; verification expectations; and unresolved questions. Unlike `/ima:prompt`, which remains a resource-discovery probe, `/ima:prompt-start` is the production inline prompt builder.

This workflow is non-mutating. Do not open a GUI editor, write files or temporary drafts, use template directories or background processes, execute or over-research the request, invoke the generated workflow, or persist automatically. State that the result is a prompt for a separate, explicitly requested workflow. Prompt-building language expresses judgment only; this prompt does not change the active model. Stop after presenting the refined prompt.
