---
name: ima-brand
description: >-
  IMA Brand Book v4.0 knowledge — identity, voice, logo rules, content guidelines,
  audience profiles, and visual standards. Use when: writing IMA content, choosing brand voice/tone,
  applying logo usage rules, selecting brand colors for design decisions, creating social media
  content, drafting medical disclaimers, or reviewing brand compliance. Triggers on: IMA brand,
  brand guidelines, brand voice, logo usage, brand colors, content tone, social media guidelines,
  medical disclaimer, brand identity, IMA imagery, brand values, brand persona, IMA mission,
  IMA audience. For CSS/SCSS implementation, see ima-bootstrap skill instead.
---

# IMA Brand Guidelines

Brand Book v4.0 (September 2025) — Independent Medical Alliance.

## Decision Tree

```
What type of brand question?
├── Identity (who we are, mission, values)
│   → references/brand-identity.md
├── Audience (who we're talking to, messaging)
│   → references/brand-identity.md
├── Voice & Tone (how we sound, copywriting)
│   → references/brand-identity.md
├── Colors (palette, usage, accessibility)
│   → references/visual-system.md
├── Typography (fonts, hierarchy, weights)
│   → references/visual-system.md
├── Logo (usage rules, lockups, clear space)
│   → references/visual-system.md
├── Imagery (photography, iconography style)
│   → references/visual-system.md
├── Social Media (platforms, sizes, content)
│   → references/digital-standards.md
├── Legal (disclaimers, copyright, compliance)
│   → references/digital-standards.md
├── Accessibility (WCAG, contrast ratios)
│   → references/digital-standards.md
└── CSS/SCSS implementation?
    → Use ima-bootstrap skill instead
```

## Color Palette

| Name | Hex | Usage |
|------|-----|-------|
| Trustworthy Indigo | `#00066F` | Primary brand, headers, trust |
| Aquatic Pulse | `#00B8B8` | CTAs, buttons, links |
| Accessible Teal | `#007BB4` | Hover states, WCAG compliance |
| Guidance Sky | `#A2CFF0` | Light accents, backgrounds |
| Vital Gold | `#FFCC00` | Warnings, attention |
| Red Ribbon | `#DD153B` | Urgency, errors |
| Plum Velvet | `#7B024D` | Accent, distinction |
| Calm Stone | `#919396` | Secondary text, labels |
| Clarity Wash | `#F2F3F5` | Backgrounds, cards |
| Soft Mist | `#EDF3F4` | Light blue-gray backgrounds |
| Brand Gradient | `150deg, #00066F → #00B8B8` | Hero sections, overlays |

## Typography

| Element | Font | Weight | Size | Notes |
|---------|------|--------|------|-------|
| Page headers | Lato | Bold/Black | 40px | |
| Section headers | Lato | Bold | 20px | |
| Body text | Proxima Nova / Open Sans | Regular | 16px | |
| Buttons (small) | Lato | Bold | 1em, uppercase | 0.04em letter-spacing, 15px radius |
| Buttons (large) | Lato | Bold | 2em, uppercase | 0.04em letter-spacing, 15px radius |
| Form labels | Open Sans | Regular | 14px | |

## Voice & Tone

| Context | Tone | Example |
|---------|------|---------|
| Website / General | Professional + Friendly | "We're here to support your health journey" |
| Medical content | Professional + Informative | "Research suggests..." with citations |
| Social media | Friendly + Inspirational | "Join thousands who've found better health" |
| Crisis / Urgent | Supportive + Professional | "If you're experiencing..." with clear next steps |
| Newsletters | Friendly + Supportive | "Here's what we've been working on for you" |
| Fundraising | Inspirational + Supportive | "Your support makes independent research possible" |

## Brand Terminology

| Avoid | Use | Why |
|-------|-----|-----|
| Honest Medicine | Honest Medicine™ | IMA campaign/tagline usage requires the trademark mark |
| "FLCCC" in new content | IMA or Independent Medical Alliance | Rebranded; FLCCC is legacy |

**Honest Medicine™ rule:** In public-facing IMA content, headings, CTAs, newsletter closes, campaign names, page copy, metadata, alt text, and UI labels must use `Honest Medicine™` on every visible occurrence. Do not leave unmarked `Honest Medicine` for editors/designers to fix later. Preserve source quotes, URLs, slugs, code identifiers, filenames, and historical/legal references unless explicitly asked to update them.

## Anti-Patterns

| BAD | GOOD | Why |
|-----|------|-----|
| "Honest Medicine" in public-facing content | "Honest Medicine™" | Trademark consistency |
| "FLCCC" in new content | "IMA" or "Independent Medical Alliance" | Rebranded; FLCCC is legacy |
| Stretching or recoloring logo | Use approved lockup variants | Brand integrity |
| Logo on busy/patterned backgrounds | White, light, dark, or gradient bg only | Readability |
| Logo below 200px width | Min 200px; use IMA lettermark for small sizes | Legibility |
| Jargon-heavy copy | Plain language with medical terms defined | Patient accessibility |
| Fear-based messaging | Solution-oriented, empowering language | Brand persona |
| Missing medical disclaimer | Include standard disclaimer on health content | Legal compliance |
| Inconsistent tone across channels | Match tone to context (see Voice table) | Brand consistency |
| Non-brand colors for key elements | Brand palette only for primary UI | Visual consistency |

## Cross-References

- **CSS/SCSS implementation** (variables, mixins, components): `ima-bootstrap` skill
- **SCSS source files**: `~/IMA/dev/ima-brand/sass/`
- **Brand identity deep dive**: [references/brand-identity.md](references/brand-identity.md)
- **Visual system details**: [references/visual-system.md](references/visual-system.md)
- **Digital & legal standards**: [references/digital-standards.md](references/digital-standards.md)
