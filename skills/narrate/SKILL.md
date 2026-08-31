---
name: narrate
description: Reform the last completed assistant response into a narration-friendly spoken presentation with audience, tone, and depth shaping before an operator-run /ima:speak handoff.
---

# Narrate

Use this skill to reform the immediately preceding completed assistant response for listening.
It is a presentation layer over that response, not a source of new analysis or evidence.

## Select the source

- Use only the immediately preceding completed assistant response.
- Do not use earlier messages, partial or aborted responses, files, URLs, lifecycle artifacts, or
  any other alternate source.
- If no completed response exists, state the missing prerequisite concisely and stop.
- Keep the original visible response intact; the narration never replaces or hides it.
- No review prerequisite or Tier-1 review selection applies to general narration.

## Validate the presentation instruction

- Treat optional `$@` as presentation-only data. An empty value uses the default narration.
- It may shape audience, tone, depth, organization, emphasis, or an explicit condense/expand
  request.
- It cannot authorize tools, research, comparison, implementation, new conclusions, external
  evidence, file work, lifecycle access, or mutation.
- Decline and redirect requests that need new analysis or evidence acquisition. Do not make tool
  calls, persist narration state, or make any lifecycle mutation.

## Reform the response

- Preserve material conclusions, decisions, cautions, next steps, and factual meaning by default.
- Condense or expand only when explicitly requested. Preserve meaning when condensing and flag
  intentional summarization.
- Add only supported connective explanation when expanding; do not invent facts, silently change
  conclusions, or treat new prose as source evidence.
- Explain the purpose of code or diffs rather than reciting substantial raw syntax. Do not use
  source-display code fences.

## Present and hand off

Produce one complete visible Markdown response with short headings and speech-friendly,
pronounceable prose. Do not use pagination, progress markers, a cursor, a ledger, or manual
advancement. Keep the Markdown response authoritative even if TTS is unavailable.

End every successful narration with a concise instruction to run `/ima:speak`. Do not invoke
`/ima:speak`, another phase, or `/ima:cycle` automatically. Stop after the narration, decline,
or missing-prerequisite message.

## Presentation quality

Apply [readable-code](../readable-code/SKILL.md) principles to prose: name concepts by intent,
keep sections cohesive, use flat structure, and avoid abstraction for its own sake.
