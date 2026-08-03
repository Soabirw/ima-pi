---
name: ima-editorial-scorecard
description: "Score and assess any piece of IMA content against editorial standards and brand guidelines. Generates a visual scorecard with letter grades across Brand Voice, Evidence Quality, Audience Clarity, Structural Craft, and CTA Effectiveness. Use when: user wants an editorial review, content quality check, draft assessment, brand compliance review, or asks to 'score this,' 'review this draft,' 'how does this stack up,' or 'editorial feedback.' Works on newsletters, webinar emails, blog posts, press releases, fundraising emails, op-eds, and social posts."
metadata:
  version: 2.0.0
---

# IMA Editorial Scorecard

Score IMA content against editorial best practices and brand standards. Honest grades that help writers improve.

## Skill invocation

```
/skill:ima-editorial-scorecard [paste or attach content]
/skill:ima-editorial-scorecard [content type: newsletter | webinar | blog | press-release | fundraising | op-ed | social]
```

Auto-detect content type if not specified.

## Process

### Step 1: Identify Content Type

| Content Type | Key Signals |
|-------------|-------------|
| Newsletter | "Dear {Person.firstName}", Quick Links block, multiple sections |
| Webinar Email | "Watch Now!", "In this episode, you'll learn", short format |
| Blog Post | H2 headers, long-form prose, embedded media references |
| Press Release | "FOR IMMEDIATE RELEASE", dateline, "###" |
| Fundraising | "Donate Now", match language, P.S. block, gift impact |
| Op-Ed | Named author byline, argumentative structure, word count |
| Social Post | Short format, @ mentions, platform-native CTAs, hashtags |

### Step 2: Load Scoring References

- **[references/scoring-rubrics.md](references/scoring-rubrics.md)** — grade criteria for all 5 categories
- **[references/format-expectations.md](references/format-expectations.md)** — voice and structural expectations by content type

### Step 3: Score Across Five Categories

| Category | What to Evaluate |
|----------|-----------------|
| **Brand Voice** | Sounds like IMA? Tone match for channel? Terminology compliance? |
| **Evidence Quality** | Claims supported? Sources cited? Precise language? |
| **Audience Clarity** | Target reader understands AND respects this? Plain language with precision? |
| **Structural Craft** | Follows IMA format patterns? Logical flow? Scannable? |
| **CTA Effectiveness** | Reader knows what to do? CTAs specific and well-placed? |

### Step 4: Assign Grades

**Non-negotiable formatting rules:**
- Exact emoji: `🟢` `🟡` `🔴` — never text substitutes
- Whole letter grades only: A, B, C, D, F — no `+` or `-`
- Format: `🟢 A` (emoji + space + letter)
- Notes: 5-15 words max

| Grade | Indicator | Meaning |
|-------|-----------|---------|
| A | 🟢 A | Excellent — meets or exceeds IMA standards |
| B | 🟢 B | Good — minor improvements possible |
| C | 🟡 C | Adequate — notable gaps to address |
| D | 🔴 D | Poor — significant issues |
| F | 🔴 F | Failing — does not meet IMA standards |

### Step 5: Compile & Present

```markdown
## Editorial Scorecard

**Content Type:** [Newsletter / Webinar Email / Blog Post / Press Release / Fundraising / Op-Ed / Social Post]

| Category | Grade | Notes |
|----------|-------|-------|
| Brand Voice | 🟢 A | Brief justification |
| Evidence Quality | 🟡 C | Brief justification |
| Audience Clarity | 🟢 B | Brief justification |
| Structural Craft | 🟢 A | Brief justification |
| CTA Effectiveness | 🟡 C | Brief justification |

> Reviewed: YYYY-MM-DD · Content Type: [type]
```

Then provide editorial memo:

**What's Working** (2-3 bullets) — specific strengths, quote actual text

**Priority Fixes** (2-3 bullets, ordered by impact) — "Change X to Y" not "Improve the tone"

**Line-Level Notes** (if applicable) — flag specific sentences, suggest rewrites, call out AI tells or unsupported claims

## Special Checks

### AI Detection Flags

Flag these patterns; if 3+ detected, deduct one letter grade from Brand Voice:

- Openers: "In today's rapidly evolving...", "In the realm of..."
- Transitions: Repeated "Moreover," "Furthermore," "It's worth noting"
- Hedges: "That being said," "It is important to note that"
- Closers: "In conclusion," at paragraph start
- Filler: "Navigate the complexities," "At its core," "Delve into"
- Unnatural formality: passive constructions where IMA uses active voice

### Disclaimer Check

For health content, verify:
- Medical disclaimer present
- "Not medical advice" language where needed
- "Consult your physician" for patient-facing content

### Trademark Check

For public-facing IMA content, verify:
- Every visible `Honest Medicine` occurrence in `/skill:ima-editorial-scorecard` output reads `Honest Medicine™`
- Headings, CTAs, newsletter closes, metadata, alt text, and UI labels comply
- Source quotes, URLs, slugs, code identifiers, filenames, and historical/legal references are left alone unless the brief asks to update them

Deduct from Brand Voice for unmarked public-facing usage and list exact replacements in Priority Fixes.

### Independence Signal

Verify at least one marker:
- "Independent" in organizational description
- "No pharma funding" or equivalent
- "501(c)(3) nonprofit" identification
- "funded by people/donors" language

Social posts exempt from individual independence check — profile bio carries it.

## Guidelines

- Honest scores only — an all-A scorecard is useless
- Notes are terse: 5-15 words per note
- Grade format-aware: newsletter ≠ press release ≠ social post
- Prioritize fixes by impact — what single change improves this most?
- Show rewrites, don't just describe them
- Date stamp every scorecard

## Related Skills

- `ima-copywriting` — write or rewrite drafts
- `ima-brand` — source of truth for voice, tone, terminology
