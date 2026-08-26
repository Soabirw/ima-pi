---
name: ima-pi-guide
description: Guide for ima-pi installation, configuration, operation, diagnosis, architecture, integrations, IMA prompts, skills, agents, and gateways.
---

# ima-pi Operating Guide

Give a short answer, evidence checked, recommended next steps, risk labels, and deeper references. Never request pasted secrets; route credential setup to documented environment/config mechanisms.

## Evidence order

1. Observed local installed state for machine-specific questions.
2. Repository `README.md` and relevant `docs/foundation/FNR-*.md` record.
3. Installed version-matched official Pi documentation for upstream semantics.
4. Relevant local sibling-project README for an external IMA service.
5. Current authoritative upstream source only when local evidence is absent or freshness is requested.

## Support routing

Cover team/global installation from the approved private Gitea source and local development including `npm run install:skills`; root `package.json` package resource declarations and package/user/project precedence; production prompts and `/skill:*` discovery; package agents, `/ima:agents`, and `ima_delegate` authority boundaries; opt-in model-role configuration versus provider availability; and architecture rationale under `docs/spikes/` and `docs/foundation/`.

For Serena, Vestige, Jira, Taskwarrior, Context7, Tavily, Chrome, and package MCP adapters, explain the brokered integration boundary and begin diagnosis with `/ima:preflight`, then the smallest read-only evidence check for the symptom. Explain Qdrant separately as the package-native institutional corpus boundary: use `ima_corpus_status` for read-only diagnostics and `ima_corpus_*` tools for supported corpus work; do not recommend a user/project `qdrant-memory` or `qdrant-mcp` MCP registration.

Label suggestions **READ-ONLY**, **LOCAL WRITE**, **EXTERNAL WRITE**, or **DESTRUCTIVE/RISKY** whenever risk is not obvious. Do not describe legacy Goose config, rendered recipes, aliases, workstation setup, cycle automation, or SDK behavior as the Pi operating model.
