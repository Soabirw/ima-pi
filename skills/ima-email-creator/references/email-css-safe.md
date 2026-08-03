# Email CSS Safety Reference

## Safe CSS Properties

| Property | Gmail | Outlook | Apple Mail | Notes |
|---|---|---|---|---|
| `color` | ✓ | ✓ | ✓ | Always inline |
| `font-family` | ✓ | ✓ | ✓ | Include fallback stack |
| `font-size` | ✓ | ✓ | ✓ | Use px, not rem/em |
| `font-weight` | ✓ | ✓ | ✓ | Use numeric values (400, 700) |
| `background-color` | ✓ | ✓ | ✓ | On `<td>`, not `<div>` for Outlook |
| `text-align` | ✓ | ✓ | ✓ | Also use HTML `align=""` for Outlook |
| `text-decoration` | ✓ | ✓ | ✓ | — |
| `line-height` | ✓ | ✓ | ✓ | Unitless values safest; add `mso-line-height-alt` for Outlook |
| `border` | ✓ | ✓ | ✓ | Shorthand works |
| `padding` on `<td>` | ✓ | ✓ | ✓ | Use `<td>` not `<p>`/`<div>` |
| `vertical-align` | ✓ | ✓ | ✓ | Use on `<td>` |
| `width` | ✓ | ✓ | ✓ | Also set HTML `width=""` attribute |
| `height` | ✓ | ✓ | ✓ | Also set HTML `height=""` attribute |

## Partially Supported

| Property | Issue |
|---|---|
| `border-radius` | Outlook ignores it entirely |
| `max-width` | Gmail app (Android) ignores; use `width` on table instead |
| `margin` | Outlook collapses margins unpredictably; avoid on block elements |
| `padding` on `<p>`/`<div>` | Outlook unreliable; wrap in `<td>` instead |
| `background-image` | Outlook (Word engine) ignores CSS background images |

## Never Use in Email

| Property | Reason |
|---|---|
| `position` | Broken across all clients |
| `float` | Outlook ignores; use tables |
| `display: flex` / `grid` | Not supported in Outlook or Gmail app |
| `box-shadow` | Stripped by most clients |
| `opacity` | Inconsistent; prefer solid colors |
| `calc()` | Not supported |
| CSS variables (`--var`) | Not supported |
| `@media` queries | Gmail app strips; limit use |

## Layout Rules

- Tables ONLY for layout — Outlook uses the Word rendering engine, not a browser
- `role="presentation"` on all layout tables
- Always set `cellpadding="0" cellspacing="0" border="0"` explicitly
- Use HTML `width` attributes on `<table>` and `<td>` (not just CSS) for Outlook
- 600px max width for email body
- Use `align="center"` on wrapper table, not CSS margin auto

## Typography

**Google Fonts import** (wrap in MSO conditional so Outlook skips it):
```html
<!--[if !mso]><!-->
<link href="https://fonts.googleapis.com/css2?family=Lato:wght@700&family=Open+Sans:wght@400" rel="stylesheet">
<!--<![endif]-->
```

| Element | Primary | Fallback Stack |
|---|---|---|
| Headings | Lato | Arial, Helvetica, sans-serif |
| Body / Footer | Open Sans | "Helvetica Neue", Helvetica, Arial, sans-serif |
| Monospace | Courier New | Courier, monospace |

**Font sizes (production):**

| Element | Size | Weight | Line-height | Outlook `mso-line-height-alt` |
|---|---|---|---|---|
| Main H1 | 28px | 700 | 1.2 | 34px |
| Section H1 | 20px | 700 | 1.2 | 24px |
| Body | 16px | 400 | 1.2 | 19px |
| Button | 16px | 700 | — | — |

## CSS Reset

```css
* { box-sizing: border-box; }
body { margin: 0; padding: 0; }
a[x-apple-data-detectors] { color: inherit !important; text-decoration: inherit !important; }
#MessageViewBody a { color: inherit; text-decoration: none; }
p { line-height: inherit; }
```

## Image Rules

- Always: absolute URLs (`https://`), explicit `width` + `height` attributes, `display:block`, meaningful `alt` text
- Standard content images: `border-radius: 5px`
- Never: CSS `background-image` (Outlook won't render), rely on images for critical content
- Retina: serve 2x images with 1x `width`/`height` attributes
- Max image width: match container (typically 600px or less)

## Color Accessibility

| Color | Use | Ratio | Status |
|---|---|---|---|
| Body text `#494949` (Gravel) | Body/footer text | 7.7:1 | ✓ WCAG AA |
| Headings `#00066F` (Trustworthy Indigo) | H1/H2 on white | >10:1 | ✓ WCAG AAA |
| `#007BB4` (Accessible Teal) | Links, small CTA | 4.6:1 | ✓ WCAG AA |
| `#00B8B8` (Aquatic Pulse) | Large text/buttons only | 3.0:1 | ✗ Body text; use 18px+ or bold 16px+ |

Minimum 4.5:1 for body text (WCAG AA). Use `#00B8B8` only on large text or solid-fill buttons where background provides contrast.
