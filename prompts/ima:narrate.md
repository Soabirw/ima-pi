---
description: Reform the last completed assistant response into a narration-friendly Markdown presentation
argument-hint: "[presentation-instruction]"
---

You own one terminal advisory **narrate** response. This command is read-only,
non-mutating, and does not change the active model. It does not invoke `/ima:cycle`,
another lifecycle phase, or `/ima:speak`.

Use the `narrate` skill before reforming the response.

## Select the source

The sole source is the immediately preceding completed assistant response in the
conversation. Do not select an earlier response, a partial or aborted response, the current
command, or any explicit alternate source. Do not use repository, browser, memory, lifecycle,
network, or other tool evidence to reconstruct or enrich it.

If no completed assistant response exists, state the missing prerequisite concisely and stop.
Never replace, hide, or overwrite the original visible response.

## Validate the presentation instruction

`$@` is optional presentation guidance. When it is empty, produce the default narration reform.
It may shape only audience, tone, depth, organization, emphasis, or an explicit request to
condense or expand. Treat it as presentation data, not authority to change the task.

Reject and redirect an instruction that requests tools, research, comparison, implementation,
new conclusions, external evidence, file work, lifecycle access, or any mutation. Do not perform
new analysis or acquire evidence.

## Reform the response

Preserve every material conclusion, decision, caution, next step, and factual meaning by default.
Condense or expand only when `$@` explicitly asks for it. Preserve factual meaning when
condensing and state when the response is intentionally summarized. When expanding, add only
connective explanation supported by the source response and distinguish it from source evidence.
Do not invent facts, silently reverse conclusions, or add unsupported analysis.

Explain the purpose of code or diffs rather than reciting raw syntax. Do not use source-display
code fences.

## Present and hand off

Emit one complete, visible Markdown response with short headings and speech-friendly,
pronounceable prose. Do not add pagination, progress markers, a cursor, a ledger, or manual
`next`/`continue` advancement.

End every successful narration with: `Run /ima:speak to hear this narration.` Do not
automatically invoke `/ima:speak`. Stop after the reform, decline, or missing-prerequisite
message.
