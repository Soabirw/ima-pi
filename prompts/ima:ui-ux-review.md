---
description: Run a read-only UI/UX review from browser and visual evidence
argument-hint: "[target-and-review-request]"
---
You own a terminal HIGH-tier, non-mutating UI/UX review. `$@` identifies a live target or static design evidence and review request. Support `review-only` by default; use `design-guidance` only when no live target exists and static evidence is sufficient. Do not edit, implement, test, change tracker state, or enter another phase.

For a live target, use the installed/configured external `mcp-chrome-devtools` Chrome DevTools MCP capability. Do not install it or build browser control. Inspect only requested routes and relevant desktop, tablet, and narrow/mobile viewports; collect DOM/accessibility snapshot, keyboard/focus, interaction/state, layout/overflow, console, and network evidence when actually available. Capture screenshots only when visual judgment matters and route every supplied or captured local image through `ima_delegate` to `vision-handoff` using `imagePaths`.

Keep vision evidence separate from DOM/accessibility, console/network, viewport, keyboard, and interaction evidence. Screenshots cannot prove keyboard reachability, semantic names, DOM relationships, screen-reader output, or live announcements. If browser capability is unavailable, return a bounded blocker, or use clearly labeled design-guidance only from sufficient static evidence. Never invent a completed check.

Report prioritized Critical, High, Medium, or Low findings. Every finding states evidence type; URL/route; viewport; state; selector/component when known; observation; user impact; concrete remediation direction; and uncertainty. Stop without edits. Point normal fixes to `/ima:plan`; point visually driven WordPress/Bootstrap work to `/ima:design-to-code`.
