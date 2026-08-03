# IMA Visual System

Source: IMA Brand Book v4.0, pages 11-25 and 27.

For SCSS implementation (variables, mixins, classes), see the `ima-bootstrap` skill.

---

## Color Palette

### Primary Colors

| Name | Hex | CMYK | RGB | Usage |
|------|-----|------|-----|-------|
| Trustworthy Indigo | `#00066F` | 100/98/20/25 | 0, 6, 111 | Primary brand color — headers, titles, trust elements |
| Aquatic Pulse | `#00B8B8` | 78/0/22/26 | 0, 184, 184 | Interactive elements — buttons, CTAs, links |
| Guidance Sky | `#A2CFF0` | 33/12/0/4 | 162, 207, 240 | Light backgrounds, soft accents |

### Secondary Colors

| Name | Hex | CMYK | RGB | Usage |
|------|-----|------|-----|-------|
| Vital Gold | `#FFCC00` | 0/17/100/0 | 255, 204, 0 | Warnings, attention, prescriber tags |
| Red Ribbon | `#DD153B` | 0/87/62/11 | 221, 21, 59 | Urgency, errors, critical alerts |
| Plum Velvet | `#7B024D` | 30/92/18/22 | 123, 2, 77 | Accent, distinction, premium feel |

### Grayscale

| Name | Hex | Usage |
|------|-----|-------|
| Calm Stone | `#919396` | Form labels, secondary text, muted elements |
| Clarity Wash | `#F2F3F5` | Backgrounds, cards, light sections |
| Slate Neutral | `#8A93A5` | Alternative gray, subtle borders |
| Gravel | `#494949` | Dark gray, body text alternative |
| White | `#FFFFFF` | Clean backgrounds, inverse text |
| Black | `#000000` | Maximum contrast text |

### Special

| Name | Value | Usage |
|------|-------|-------|
| Accessible Teal | `#007BB4` | High-contrast alternative for WCAG compliance |
| Brand Gradient | `150deg, #00066F → #00B8B8` | Hero sections, overlays, premium elements |

### Color Application Rules

- **Primary brand color (Indigo)**: Use for headings, titles, and trust-building elements. Conveys authority.
- **Interactive elements (Aquatic Pulse)**: Buttons, links, CTAs. Users learn to associate teal with action.
- **Never use red/gold for decorative purposes**: Red = urgency/error, Gold = warning/attention. These carry semantic meaning.
- **Print vs Digital**: CMYK values for print, hex/RGB for digital. Always use the exact values — don't approximate.
- **Gradient usage**: Hero banners, footer backgrounds, overlay on dark photography. Not for small elements or text backgrounds.

---

## Typography

### Font Families

| Font | Role | Weights | Fallback |
|------|------|---------|----------|
| **Lato** | Headings, buttons, labels | Bold (700), Black (900), Semi Bold (600) | sans-serif |
| **Proxima Nova** | Body text, forms (preferred) | Regular (400), Bold (700) | Open Sans, sans-serif |
| **Open Sans** | Body text, forms (free alternative) | Regular (400), Bold (700) | sans-serif |

### Type Hierarchy

| Element | Font | Weight | Size | Style |
|---------|------|--------|------|-------|
| H1 / Page header | Lato | Black (900) | 40px | Uppercase |
| H2 / Section header | Lato | Bold (700) | 32px | — |
| H3 / Subsection | Lato | Regular (400) | 28px | — |
| H4 / Section header (small) | Lato | Bold (700) | 20px | — |
| Body text | Proxima Nova / Open Sans | Regular (400) | 16px | — |
| Button text | Lato | Bold (700) | 18px | Uppercase |
| Form labels | Open Sans | Regular (400) | 14px | — |
| Provider/doctor title | Lato | Semi Bold (600) | 32px | — |

### Typography Rules

- **Headings are always Lato** — never use Proxima Nova/Open Sans for headings
- **Body is always Proxima Nova or Open Sans** — never use Lato for body paragraphs
- **Uppercase**: Only for H1/page headers and button text. Don't uppercase body text or H2-H4
- **Line height**: 1.0 for headers, 1.5 for body text
- **Letter spacing**: Default. Don't add custom letter-spacing

---

## Logo System

### Logo Variants

| Variant | Name | Description | Primary Use |
|---------|------|-------------|-------------|
| Primary | Horizontal lockup | IMA logo + "Independent Medical Alliance" side by side | Website header, documents, letterhead |
| Secondary | Vertical/stacked lockup | IMA logo above "Independent Medical Alliance" | Social media profiles, square spaces |
| Tertiary | IMA lettermark | Just the "IMA" letters in brand styling | Favicons, small spaces, app icons |

### Lockup Color Variants

| Lockup | Background | Usage |
|--------|-----------|-------|
| Hero | Brand gradient | Hero sections, premium placements |
| Blue | White/light | Standard usage on light backgrounds |
| Black | White/light | Monochrome/formal contexts |
| Black Text | White/light | Logo mark colored + black text |
| Inverse | Dark/gradient | Dark backgrounds, footer, overlay on photos |

### Logo Rules

**Clear space**: Maintain minimum clear space around the logo equal to the height of the "I" in IMA. No text, images, or other elements may intrude into this space.

**Minimum size**: 200px width for primary and secondary lockups. Below 200px, use the IMA lettermark (tertiary) instead.

**Brand family logos**: IMA Journal and IMA Action have their own lockups that follow the same system.

### Proper Logo Usage

| Background | Logo Variant | Notes |
|-----------|-------------|-------|
| White / light solid | Blue or Black lockup | Standard usage |
| Dark solid | Inverse lockup | White text on dark |
| Brand gradient | Hero lockup | Designed specifically for gradient |
| Photo overlay | Inverse lockup | Ensure sufficient contrast with overlay/scrim |
| Colored solid (brand colors) | Inverse lockup | Only on brand colors, not arbitrary colors |

### Improper Logo Usage (Never Do)

- **Stretch or distort** — Always maintain original aspect ratio
- **Recolor** — Only use approved lockup color variants
- **Place on busy/patterned backgrounds** — Logo must be clearly readable
- **Rotate or skew** — Logo must always be level/horizontal
- **Add shadows or effects** — No drop shadows, glows, outlines, or 3D effects
- **Display below minimum size** — Use lettermark for small applications
- **Crop or obscure** — Full logo must be visible
- **Place too close to other elements** — Respect the clear space rules

---

## Imagery Guidelines

### Photography Style

- **Authentic**: Real people, not overly staged stock photography
- **Professional**: Well-lit, high quality, properly composed
- **Healthcare-appropriate**: Clinical settings should feel welcoming, not sterile
- **Diverse**: Represent the diversity of IMA's global community
- **Warm lighting**: Natural light preferred, warm tones over cold/clinical

### Photography by Content Type

| Content Type | Image Style | Notes |
|-------------|------------|-------|
| Patient stories | Warm, personal, relatable | Real patients when possible (with consent) |
| Medical content | Professional, clinical-but-approachable | Healthcare settings, doctors, labs |
| Community / events | Candid, energetic, inclusive | Group shots, event photography |
| Research / science | Clean, precise, data-oriented | Lab settings, infographics, data viz |
| Fundraising | Emotional, hopeful, impact-focused | People helped, community impact |

### Image Treatment

- **Color overlay**: Brand gradient overlay for hero images (opacity: 60-80%)
- **Duotone**: Indigo + Teal for stylized feature images
- **Never**: Over-saturate, use filters that alter skin tones, or use low-resolution images

---

## Iconography

- **Style**: Clean, simple line icons or flat icons
- **Color**: Brand colors only — Indigo, Teal, or White (on dark backgrounds)
- **Weight**: Consistent stroke weight within a set (2px recommended)
- **Usage**: Supporting content, navigation, feature highlights — not decorative filler
- **Avoid**: Overly detailed icons, 3D icons, clipart, emoji as icons in formal content
