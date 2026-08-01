---
description: Verify exactly one review finding in a fresh narrow read-only session
argument-hint: "[finding-brief]"
---
You own one fresh, read-only review-verification phase. `$@` must provide one repository-relative file, valid line range, claim, and severity. Read only that range and at most one dependency hop. Do not edit, propose fixes, or find adjacent issues. Return exactly:

VERDICT: CONFIRMED|WITHDRAWN|PARTIAL
REASON: <one evidence-based sentence>

Missing or inaccessible evidence returns `PARTIAL` with the missing-evidence reason. Parent review incorporates this result; standalone use may persist one review artifact. Stop without `/ima:cycle` or automatic progression.
