---
description: Verify exactly one review finding in a fresh narrow read-only session
argument-hint: "[finding-brief]"
---
You own one fresh, read-only review-verification phase. Load `code-review` for its verifier-brief contract. `$@` must provide one self-contained candidate severity, repository-relative evidence range, claim, root cause, required outcome, decided remediation, named files/symbols, constraints, and acceptance checks. Read only that evidence range and at most one dependency hop, named in the brief when necessary to evaluate the claim and decided remediation. Do not edit, propose replacement fixes, or find adjacent issues. Return exactly:

VERDICT: CONFIRMED|WITHDRAWN|PARTIAL
REASON: <one evidence-based sentence>

A malformed brief or missing/inaccessible evidence returns `PARTIAL` with the missing-evidence reason; do not infer omitted decisions. Parent review incorporates this result; standalone use may persist one review artifact. Stop without `/ima:cycle` or automatic progression.
