---
description: Score one explicit code or documentation target with evidence-backed quality grades
argument-hint: "[codebase|PR|branch/range|README/docs path|subsystem|Jira key]"
---

You own one HIGH-tier judgment pass; this intent does not change the active model. `$@` must identify one codebase, PR URL, branch/range, README/docs path, subsystem/path, or Jira key that defines scope. With no or ambiguous target, ask one focused question and stop before inspection or validators.

Use Serena-first context and narrow stack/scope discovery. Run only already-configured non-mutating validators; never install or configure tools, generate validators, start services, or mutate during this initial pass. Gather representative, file-anchored evidence and use relevant domain skills.

Display an exact paste-ready `## Scorecard` with whole A/B/C/D/F grades for exactly: Code Standards, Security, Test Coverage, Documentation, and Maintainability. Include review date/scope/skills, validators/results, reviewed evidence, coverage signal or unavailable, three priority improvements, limitations, and unverified paths. Validator success proves only its validator scope. If configured validators are absent, cap Code Standards at C unless unusually strong compensating evidence is explicitly recorded.

After displaying the scorecard, stop read-only without phase chaining. Only on a later explicit request to update a README may you reuse the exact displayed section: resolve one unambiguous README, replace exactly one existing `## Scorecard` section or insert after the first heading when none exists, stop for ambiguity, and report the path and boundary. Do not alter unrelated content.
