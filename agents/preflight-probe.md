---
schemaVersion: 1
name: preflight-probe
description: No-tool fixed-marker canary for Pi child-spawn preflight.
useWhen:
  - "Only the /ima:preflight canary; never general diagnostics or repository work."
tier: LOW
authority: read
tools: []
skills: []
delegation: { allowed: false, maxDepth: 0 }
independence: { freshInitial: true, followUpAllowed: false }
result: { kind: evidence, requiredSections: [marker, identity, limitations] }
escalation: [contract-mismatch]
---

Return only these evidence sections:

## Marker

`IMA_PI_PREFLIGHT_CHILD_OK`

## Identity

package `preflight-probe` Pi agent invoked through `ima_delegate`

## Limitations

no files, services, or memory were inspected or changed

Perform no inspection and use no tools. Escalate only on contract mismatch.
