---
name: ima-editorial-workflow
description: "Orchestrates the IMA editorial process — Plan, Write, Review, Approve, Learn. Use as `/skill:ima-editorial-workflow` for natural-language requests to draft, rewrite, create, improve, fix, edit, brainstorm, or prepare an editorial deliverable. Use `/skill:ima-editorial-scorecard` for standalone editorial review. Routes to ima-copywriting for drafting and ima-editorial-scorecard for review. Always load ima-brand alongside."
metadata:
  version: 1.0.0
---

# IMA Editorial Workflow

Traffic controller for all editorial requests. Delegates writing to `ima-copywriting`, scoring to `ima-editorial-scorecard`.

## Request routing

Use this skill for these request forms:

```
/skill:ima-editorial-workflow draft a [type] → Plan and draft new content
/skill:ima-editorial-workflow rewrite this   → Review existing content, then improve
/skill:ima-editorial-workflow plan a social post → Plan and draft social content
/skill:ima-editorial-workflow brainstorm [topic] → Explore ideas before committing
```

Also triggers on: "draft a newsletter," "improve this," "write a press release," etc.

**Content types (draft request):** `newsletter` · `webinar` · `blog` · `press-release` · `fundraising` · `op-ed` · `social`

**Categories (social request):** `video` · `statement` · `action` · `media-hit` · `announcement` · `journal` · `webinar-promo`

## Workflow Sequence

```
PLAN → WRITE → REVIEW → APPROVE → LEARN
```

No diving straight into drafts. Gather context once, execute, review honestly.

## PLAN

### Intent Detection

| Signal | Intent | Path |
|--------|--------|------|
| Draft, "create," "new" | Create | Plan → Write → Review → Approve |
| Rewrite, "improve," "fix," "edit," "make better" | Rewrite | Plan → Review → Write → Review → Approve |
| Social-post request | Create social | Plan → Write → Review → Approve |
| Brainstorm request | Explore | Brainstorm → Plan (when ready) |
| Content pasted, no instructions | Ambiguous | Ask: "Score this or rewrite it?" |
| "Continue," "next version," "apply fixes" | Iterate | Skip Plan → Write |

`/skill:ima-editorial-scorecard` handles standalone editorial scoring, not this workflow.

### Context Gathering (One Prompt, Not a Chain)

Collect 2–3 answers in one structured prompt. Skip already-answered questions. Default aggressively — ask only what's genuinely missing. For iteration requests, skip Plan entirely. If user says "just do it," write with available context, note assumptions, flag gaps with `[brackets]`.

**Draft request:**
- Core message — ONE takeaway
- Reader action (widget: Read / Watch / Donate / Share / Sign / Attend / Download)
- Source material (widget multi-select: Study · Webinar · Quote · Press release · External article · None)
- Subject matter expert (optional)
- Responding to external events? (optional)
- Audience segment (widget: General supporters · Healthcare pros · Donors · Media · New subscribers)

**Rewrite request:**
- What's wrong with it?
- Keep structure or rebuild? (widget: Keep structure · Rebuild)
- Preserve specific elements? (optional)

**Social request:**
- Category if not specified
- What are you promoting/announcing?
- Link or media to attach?
- Quote to feature? (optional)

**Brainstorm request:**
- Topic or event
- Format preference (widget: Newsletter · Blog · Social · Op-ed · No preference)
- Goal (widget: Drive awareness · Drive action · Respond to news · Celebrate win · Educate)

## WRITE

1. Load `ima-brand` (always)
2. Load `ima-copywriting` (format template for content type)
3. Check project Files for published examples as style benchmarks
4. Write draft
5. Enforce brand terminology: public-facing `Honest Medicine` must read `Honest Medicine™`
6. Self-check against Quality Checklist in `ima-copywriting`

Deliver draft with brief note on key editorial choices. Use `[brackets]` for missing data. Never invent evidence.

## REVIEW

1. Load `ima-editorial-scorecard`
2. Auto-detect content type or use specified
3. Run the trademark check before scoring: public-facing `Honest Medicine` must read `Honest Medicine™`
4. Score: Brand Voice · Evidence Quality · Audience Clarity · Structural Craft · CTA Effectiveness
5. Present: scorecard table → What's Working → Priority Fixes → Line-Level Notes

For self-review: be honest. Separate what you can fix from what the user must provide (missing data, quotes, approvals).

For user-submitted content: score first, then ask if they want a rewrite.

## APPROVE

Present the approval choices explicitly:

| Option | Next |
|--------|------|
| Approve | Ready. Move to Learn. |
| Revise | Apply changes. Return to Write. |
| Rebuild | Different approach. Return to Plan. |
| Discuss | Talk through section before deciding. |

## LEARN

After approval, capture what worked:

> "Noted for future [content type] drafts: [pattern or correction]"

Examples:
- "Noted: Dr. Varon prefers 'the IMA' in formal quotes."
- "Noted: Year-end fundraising leads with match mechanic, not mission statement."

If learning should persist, ask: "Want me to remember this?" ask for explicit approval before saving it to memory.

## Related Skills

- **ima-brand**: Voice, tone, terminology (ALWAYS load alongside)
- **ima-copywriting**: Format templates, writing principles, quality checklist
- **ima-editorial-scorecard**: Scoring rubric (invoke `/skill:ima-editorial-scorecard` for standalone editorial scoring)
