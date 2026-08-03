---
name: ima-email-creator
description: >-
  Render branded, email-client-safe HTML from editorial copy. Table-based layouts,
  inline CSS, EspoCRM compatibility, and IMA brand styling. Use when: creating email
  HTML templates, rendering newsletter/campaign/drip emails, preparing emails for
  EspoCRM, converting email HTML for paste into EspoCRM source view. Triggers on:
  email HTML, email template, EspoCRM email, branded email, render email, email layout,
  newsletter HTML, campaign email HTML. For email copy/content, see ima-copywriting.
  Always load ima-brand alongside.
---

# IMA Email Creator

Renders IMA-branded email HTML from editorial copy. Platform-agnostic.

**Email HTML is not web HTML.** Tables for layout, inline CSS only, 600px max width. Gmail strips `<style>` blocks. Outlook uses Word's rendering engine — breaks CSS floats and flexbox.

## Decision Tree

```
What type of email?
├── Newsletter / Campaign / Fundraising / Webinar promo
│   → references/newsletter-layout.md
├── Drip / Sequence email (individual)
│   → references/drip-sequence.md
├── WordPress transactional (PHP)
│   → references/wp-transactional.md
├── EspoCRM compatibility info?
│   → references/espocrm-compat.md
└── General email CSS questions?
    → references/email-css-safe.md
```

## Quick Start

1. Get copy from `ima-copywriting` (or user provides)
2. Choose email type → load appropriate reference
3. Render HTML using `assets/base-template.html`
4. Write to a user-specified path; otherwise use a documented project-local ignored output directory or stdout for preview
5. Run EspoCRM prep if needed: `python3 skills/ima-email-creator/scripts/espocrm-prep.py input.html [--out output.html]`
6. User pastes the reviewed result into EspoCRM source view

## Scripts

| Script | Purpose | Usage |
|--------|---------|-------|
| `espocrm-prep.py` | Extract body, migrate styles to div wrapper | `python3 skills/ima-email-creator/scripts/espocrm-prep.py input.html [--out output.html]` |
| `css-inliner.py` | Inline style blocks into element attributes | `python3 skills/ima-email-creator/scripts/css-inliner.py input.html [--out output.html]` |

Optional isolated setup: create a virtual environment, then run `pip install -r skills/ima-email-creator/scripts/requirements.txt`. Do not install dependencies automatically.

## IMA Brand Colors

| Element | Color Name | Hex |
|---------|-----------|-----|
| Headers/headings | Trustworthy Indigo | `#00066F` |
| CTA buttons | Aquatic Pulse | `#00B8B8` |
| CTA fallback (accessibility) | Accessible Teal | `#007BB4` |
| Body text | Gravel | `#494949` |
| Outer background | Clarity Wash | `#F2F3F5` |
| Inner background | White | `#FFFFFF` |
| Footer text | Calm Stone | `#919396` |
| Dividers | Light Gray | `#dddddd` |

## Key Rules

- Tables for ALL layout — Outlook's Word engine breaks floats and flexbox
- Inline CSS only — Gmail strips `<style>` blocks
- 600px max width
- Typography: Lato bold 700 for headings (fallback: Arial, Helvetica, sans-serif); Open Sans regular 400 for body (fallback: Helvetica Neue, Helvetica, Arial, sans-serif)
- 16px minimum body text, 28px main headings, 20px section headings
- Images: absolute URLs, explicit `width`/`height`, `display:block`, meaningful `alt`, 5px border-radius, max-width 580px
- `role="presentation"` on all layout tables
- Medical disclaimer in footer for health content
- Resolve `__SUBJECT__`, `__UTM_CAMPAIGN__`, and `__SECTION_IMAGE_URL__` before distribution; preserve EspoCRM single-brace tokens such as `{Person.firstName}` and `{optOutLink}`
- Use approved HTTPS asset hosts, meaningful image alt text, and no recipient IDs, secrets, or tokens in URLs; UTM attribution is allowed, but ESP analytics are not configured here
- Treat markup as untrusted at boundaries: these helpers transform markup but do not sanitize hostile HTML
- The CSS inliner rejects external stylesheet links and external CSS `@import`/`url(...)` sources before transformation; provide self-contained CSS only, with no remote or local retrieval
- Never embed credentials, recipient data, or tokens; helpers do not fetch, upload, host, send, or track assets
- Preview client rendering manually before distribution

## EspoCRM Variables

Single-brace syntax (NOT Handlebars):
- `{Person.firstName}` — first name (newsletters)
- `{Person.name}` — full name (campaigns)
- `{optOutLink}` — unsubscribe link (all emails, in footer)

## Builder Context

Production emails are built in BeeFree and exported. Match BeeFree output patterns: `nl-container` → `row` → `row-content` stack → `column`. Ensures visual parity on import.

> Brand evolution: emails prior to Brand Book v4.0 used Montserrat/#0296a1/#374751/14px. New emails follow the values above. Structural patterns (BeeFree DOM, VML buttons, CSS resets, EspoCRM variables) remain the same.

## Related Skills

| Skill | Role |
|-------|------|
| `ima-brand` | Color and voice authority — always load alongside |
| `ima-copywriting` | Content source for all email types |
| `ima-editorial-workflow` | Orchestrates Plan → Write → Render → Review |
| `ima-editorial-scorecard` | Reviews final output |
