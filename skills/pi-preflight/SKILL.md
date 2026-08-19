---
name: pi-preflight
description: Pi and IMA preflight guidance for package/resource discovery and agent, skill, gateway, model, or integration diagnostics. Use to interpret or route /ima:preflight requests.
---

# Pi Preflight Guidance

Use `/ima:preflight [offline|quick|full or natural-language request]` for executable diagnostics. This skill explains the evidence contract; it does not duplicate the diagnostic runtime. See `docs/foundation/FNR-3025.md` for implementation evidence.

## Evidence and scope

Use `offline`, `quick`, or `full` as the smallest scope that answers the question. Report each probe as `PASS`, `WARN`, `FAIL`, `BLOCKED`, `SKIP`, or `NOT_CONFIGURED`. A PASS requires direct evidence. Continue independent checks after one optional probe fails.

Cover, when requested:

- Pi executable plus Node/npm prerequisites; package installation and resource discovery; prompt and skill discovery.
- Package agents and `ima_delegate`; `preflight-probe` is only the existing package-child marker boundary.
- Package MCP adapter and gateway health for brokered Serena, Vestige, and Qdrant services.
- Configured model roles/providers separately from live provider availability.
- Taskwarrior, Jira, browser, Context7, Tavily, and other configured integrations.

`configured:false` in a direct-registration view is not degradation when the corresponding brokered gateway service is healthy.

## Safety boundary

All preflight behavior is **READ-ONLY**: never install, repair, authenticate, migrate, write memories, modify trackers, or change project/config state. For large evidence, use the existing `/ima:preflight` bounded temporary-file, redaction, and cleanup behavior rather than creating another implementation.

Goose-specific typed SDK, extension registration, recipe rendering, and subrecipe mechanics are not current instructions.
