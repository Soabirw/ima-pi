---
description: Score one explicit code or documentation target with evidence-backed quality grades
argument-hint: "[codebase|PR|branch/range|README/docs path|subsystem|Jira key]"
---

You own one HIGH-tier judgment pass; this intent does not change the active model. `$@` must identify one codebase, PR URL, branch/range, README/docs path, subsystem/path, or Jira key that defines scope. With no or ambiguous target, ask one focused question and stop before inspection or validators.

Use Serena-first context and narrow stack/scope discovery. Load `code-review` as the required technical-review methodology for evidence discipline and integration-contract awareness, while retaining this command's five-grade scorecard output rather than turning it into a lifecycle review. Select only relevant domain skills: `php-fp`, `php-fp-wordpress`, `phpunit-wp`, `js-fp`, `js-fp-api`, `js-fp-react`, `js-fp-vue`, `js-fp-wordpress`, `py-fp`, `ruby-fp`, `ima-bootstrap`, `unit-testing`, or `playwright`; use `gh-cli` or `tea-gitea` for PR context and `mcp-serena` or `rg` for discovery.

Establish scope, then detect the stack and configured checks from `composer.json`, `package.json`, `pyproject.toml`, `Gemfile`, test directories, CI configuration, and README evidence. Locate only already-configured validators: Composer `check`, `test`, `phpcs`, or coverage scripts; npm `test`, `lint`, `typecheck`, `check`, or coverage scripts; and equivalent repository-supported commands. Run only non-mutating validators; never install or configure tools, generate validators, start services, or mutate during this initial pass. Gather representative, file-anchored evidence.

Evaluate Code Standards for native conventions, FP boundaries, naming, formatting, and configured checks; Security for validation, authorization, injection, secrets, and escaping; Test Coverage for meaningful tests of critical paths and any coverage signal; Documentation for setup, usage, and public contracts; and Maintainability for complexity, coupling, boundaries, organization, and dependency risk. Validator success proves only its validator scope. If configured validators are absent, cap Code Standards at C unless unusually strong compensating evidence is explicitly recorded.

Display an exact paste-ready `## Scorecard` with whole A/B/C/D/F grades for exactly: Code Standards, Security, Test Coverage, Documentation, and Maintainability. Follow it with `## Evidence` covering validators, reviewed files/ranges, and coverage signal or unavailable; then `## Top Improvements` with exactly three priority improvements. Include review date/scope/skills, limitations, and unverified paths.

After displaying the scorecard, stop read-only without phase chaining. Only on a later explicit request to update a README may you reuse the exact displayed section: resolve one unambiguous README, replace exactly one existing `## Scorecard` section or insert after the first heading when none exists, stop for ambiguity, and report the path and boundary. Do not alter unrelated content.
