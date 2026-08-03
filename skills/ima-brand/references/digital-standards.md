# IMA Digital Standards

Source: IMA Brand Book v4.0, pages 26-30.

For CSS/SCSS implementation details, see the `ima-bootstrap` skill.

---

## Digital Style Guide

### Web Color Palette

Same brand colors as print, using hex values. Key digital-specific notes:

- **Background**: White (`#FFFFFF`) or Clarity Wash (`#F2F3F5`) for content areas
- **Text**: Gravel (`#494949`) for body, Trustworthy Indigo (`#00066F`) for headings
- **Links**: Aquatic Pulse (`#00B8B8`), hover → Accessible Teal (`#007BB4`)
- **Gradient**: Reserve for hero sections and premium elements, not for small UI

### Typography Hierarchy (Digital)

| Element | Font | Size | Color | WCAG Ratio | Level |
|---------|------|------|-------|------------|-------|
| H1 | Lato Black | 40px | `#00066F` | 16.5:1 | AAA |
| H2 | Lato Bold | 32px | `#00B8B8` | 5.04:1 | AA |
| H3 | Lato Regular | 28px | `#DD153B` | 4.94:1 | AA |
| Body | Proxima Nova | 16px | `#494949` | 9:1 | AAA |

### Button Specifications

| Type | Background | Text | Padding | Radius |
|------|-----------|------|---------|--------|
| Primary | `#00B8B8` | White | 20px / 40px | 10px |
| Primary (hover) | `#007BB4` | White | 20px / 40px | 10px |
| Primary wide | `#00B8B8` | White | 20px / 80px | 10px |
| Large/digital | `#00B8B8` | White | 20px / 40px | 20px |
| Outline | Transparent | `#00066F` | 20px / 40px | 10px |

---

## Accessibility (WCAG)

### Contrast Ratios

| Combination | Ratio | Level | Pass |
|-------------|-------|-------|------|
| Indigo `#00066F` on White | 16.5:1 | AAA | Yes |
| Aquatic Pulse `#00B8B8` on White | 3.07:1 | — | Large text only |
| Red Ribbon `#DD153B` on White | 4.94:1 | AA | Yes |
| Body text `#494949` on White | 9:1 | AAA | Yes |
| Accessible Teal `#007BB4` on White | 4.58:1 | AA | Yes |

### Accessibility Requirements

- **Color is not the only indicator**: Always pair color with text, icons, or patterns
- **Alt text**: All images must have descriptive alt text
- **Link text**: Descriptive links, not "click here" or "read more" alone
- **Focus states**: Visible focus indicators on all interactive elements
- **Font sizes**: Minimum 16px for body text, 14px for labels
- **Touch targets**: Minimum 44x44px for mobile interactive elements
- **High-contrast teal**: Use `#007BB4` when Aquatic Pulse (`#00B8B8`) doesn't meet contrast needs

---

## Social Media

### Platforms

| Platform | Primary Content | Tone |
|----------|----------------|------|
| **Instagram** | Visual stories, infographics, community highlights | Friendly + Inspirational |
| **Facebook** | Articles, community engagement, events, fundraising | Friendly + Supportive |
| **X (Twitter)** | News, quick updates, engagement, threads | Professional + Friendly |
| **Telegram** | Community updates, direct communication | Supportive + Informative |

### Image Sizes

| Platform | Format | Dimensions |
|----------|--------|------------|
| Instagram | Post (square) | 1080 x 1080px |
| Instagram | Story / Reel | 1080 x 1920px |
| Instagram | Carousel | 1080 x 1080px per slide |
| Facebook | Post | 1200 x 630px |
| Facebook | Cover | 820 x 312px |
| X (Twitter) | Post | 1200 x 675px |
| X (Twitter) | Header | 1500 x 500px |

### Content Pillars

1. **Educational**: Health information, protocol summaries, research findings
2. **Community**: Patient stories, testimonials, support group highlights
3. **Advocacy**: Policy updates, medical freedom, patient rights
4. **Behind the scenes**: Team spotlights, research process, organizational updates
5. **Engagement**: Polls, Q&A, community questions, awareness campaigns

### Social Media Voice

- **Be human**: Conversational but professional, not robotic or corporate
- **Be responsive**: Engage with comments, answer questions, acknowledge feedback
- **Be visual**: Lead with compelling images/video, not just text
- **Be consistent**: Same brand voice across all platforms, adjusted for format
- **Be timely**: Post when audience is active, respond within 24 hours

---

## Content Guidelines

### Copywriting & Formatting

- **Headlines**: Clear, benefit-focused, under 10 words
- **Paragraphs**: Short (2-3 sentences max for digital)
- **Lists**: Use bullets for 3+ items
- **Links**: Descriptive text, not URLs or "click here"
- **CTAs**: One primary CTA per page/post, action-oriented ("Learn More", "Join Us", "Donate")

### User-Generated Content (UGC) Rules

- Always get written permission before reposting
- Credit the original creator
- Ensure content aligns with brand values
- Do not use UGC that makes unverified medical claims
- Moderate comments for harmful or misleading health information

---

## Legal & Compliance

### Medical Disclaimer

The following disclaimer (or equivalent) must appear on all content containing health information:

> The information provided by the Independent Medical Alliance (IMA) is for educational and informational purposes only. It is not intended as a substitute for professional medical advice, diagnosis, or treatment. Always seek the advice of your physician or other qualified health provider with any questions you may have regarding a medical condition. Never disregard professional medical advice or delay in seeking it because of something you have read on this website or in our publications.

### Where to Place Disclaimers

| Content Type | Disclaimer Placement |
|-------------|---------------------|
| Website pages (health content) | Footer of the page |
| Blog posts / articles | End of article, before comments |
| Social media | Bio/about section + link to full disclaimer |
| Email newsletters | Footer |
| Videos | Description/caption + end card |
| Downloadable resources | First or last page |

### Copyright

- Standard format: `2020-{current year} Independent Medical Alliance. All rights reserved.`
- All original content is IMA property
- Proper attribution required when citing external sources

### Sponsored Content Disclosure

- Clearly label all sponsored or partnership content
- Use "Sponsored", "Partner Content", or "In collaboration with [name]"
- Disclosure must be visible before user engages with content (not buried)
- Follow FTC guidelines for influencer/partner disclosures

---

## Approval Workflow

### Content Creation Process

```
1. Create    → Draft content following brand guidelines
2. Review    → Brand review for voice, tone, visual consistency
3. Approve   → Designated approver signs off
4. Publish   → Schedule/publish via approved tools
5. Monitor   → Track engagement, respond to comments
```

### Recommended Tools

| Function | Tool |
|----------|------|
| Social scheduling | Hootsuite, Buffer |
| Content calendar | Notion |
| Design | Canva (with brand kit), Figma |
| Analytics | Platform-native analytics |
| Project management | Jira (see mcp-atlassian skill) |
