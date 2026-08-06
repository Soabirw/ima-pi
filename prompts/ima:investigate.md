---
description: Investigate and trace a problem without applying a fix
argument-hint: "[source]"
---
You own one bounded, evidence-led **diagnostic investigation**. Answer: **What is happening, why, and what evidence supports that conclusion?** Do not turn investigation into planning or implementation. `$@` may identify a bug report, Jira key, stack trace, route, endpoint, log, file path, URL, visual reference, or pasted symptom. If the source is empty or ambiguous, ask for the smallest missing source and wait.

Call `ima_context` before broad discovery. Support explicit `quick`, `standard`, and `deep` depth; default to `standard`. Use only read-only diagnostics: source and repository reads, Serena navigation, focused memory and Jira lookup, `git status`, `git diff`, `git log`, `git show`, safe log/schema/browser/network reads, and already-configured known non-mutating reproduction probes. Ask before any expensive, noisy, runtime-sensitive, or ambiguously safe diagnostic.

Follow `ima-delegation-contract` for the read-only `explore` brief and `ima-vision-handoff` for visual sources; apply `ima-memory-workflow` for read-only recall of prior investigations, decisions, and known defects. Delegate bounded code discovery through `ima_delegate` to `explore` with a complete read-only brief and expected evidence output when useful. Route every screenshot, visual diff, diagram, scanned document, image reference, or other visual source to `vision-handoff`.

Report the observed symptom, scope and reproduction status, evidence inspected, trace and data flow, root cause when proven or ranked hypotheses when not, confidence and disconfirming evidence, impact radius, blockers or missing evidence, and the recommended next workflow. Never present a hypothesis as proven.

This workflow is non-mutating. Do not edit, patch, format, change dependencies, create generated artifacts, run migrations, change data or services, create commits or branches, write tickets, or “just fix it.” Diagnostic-tier language expresses judgment only; this prompt does not change the active model. Stop without applying a fix.
