# Drip Sequence Reference

Patterns for individual drip/sequence emails. EspoCRM handles timing — this skill only produces standalone HTML.

## What This Covers

Individual email HTML for sequences. The sequencing logic (delays, conditions, triggers) lives in EspoCRM's BPM/Workflows — not in this skill.

## Common Sequence Types

| Sequence | Emails | Goal |
|----------|--------|------|
| Welcome | 3-5 | Onboard new member, set expectations |
| Donor nurture | 4-6 | First donation → recurring donor |
| Re-engagement | 2-3 | Win back inactive members |
| Event follow-up | 2-3 | Post-webinar engagement |

## Individual Email Patterns

**Welcome Email 1 (Immediate)**
- Warm, personal tone (Friendly + Supportive)
- Confirm what they signed up for
- Set expectations (what they'll receive, how often)
- One clear CTA: "Complete Your Profile »" or "Explore Resources »"
- Keep short — they just signed up, don't overwhelm

**Welcome Email 2 (Day 2-3)**
- Highlight one valuable resource
- Social proof (member count, impact stats)
- CTA: engage with specific content

**Welcome Email 3 (Day 5-7)**
- Deeper engagement — invite to community, events
- Ask for feedback or preferences
- CTA: "Join the Conversation »" or similar

## Design Rules for Sequences

- Each email MUST stand alone (reader may not have seen previous ones)
- Progressive disclosure — don't front-load all information
- Consistent header/footer across sequence
- Vary CTA text (don't repeat "Learn More" 5 times)
- Subject lines should work independently (no "Part 2 of 5")
- Match production email styling: Lato headings / Open Sans body, #00B8B8 CTA color, #494949 body text, 16px body size

## HTML Structure

Each drip email uses the same BeeFree-style HTML structure:
`nl-container → row → row-content → column`

Use `assets/base-template.html` as the starting skeleton for every email.

## EspoCRM Variables

Use single-brace syntax: `{Person.firstName}`, `{optOutLink}`, `{accountName}`

Do NOT use Handlebars double-brace syntax. Resolve the template build tokens `__SUBJECT__`, `__UTM_CAMPAIGN__`, and `__SECTION_IMAGE_URL__` before distribution.

## EspoCRM Integration Note

Each email is a separate EspoCRM Email Template. The BPM process handles:
- Trigger conditions (signup, purchase, inactivity period)
- Delays between emails
- Exit conditions (unsubscribe, completed action)

The skill outputs individual HTML files; configure sequencing in EspoCRM.
