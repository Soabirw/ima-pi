# IMA Brand System Reference

Based on IMA Brand Book v4.0 (September 2025). Plugin: `ima-brand` v4.0.0.

**Plugin location**: `wp-content/plugins/ima-brand/`
**Import in SCSS**: `@import "../../../plugins/ima-brand/sass/brand";`

---

## Color Palette

### Primary Colors

| Name | Hex | Variable | Usage |
|------|-----|----------|-------|
| Trustworthy Indigo | `#00066F` | `$ima-brand-primary` | Headers, titles, emphasis |
| Aquatic Pulse | `#00B8B8` | `$ima-brand-secondary` | Buttons, CTAs, links |
| Guidance Sky | `#A2CFF0` | `$ima-brand-sky` | Light backgrounds, accents |
| Soft Mist | `#EDF3F4` | `$ima-brand-mist` | Light blue-gray backgrounds |

### Secondary Colors

| Name | Hex | Variable | Usage |
|------|-----|----------|-------|
| Vital Gold | `#FFCC00` | `$ima-brand-gold` | Warnings, prescriber tags |
| Red Ribbon | `#DD153B` | `$ima-brand-red` | Errors, urgent items |
| Plum Velvet | `#7B024D` | `$ima-brand-plum` | Accent color |

### Grayscale

| Name | Hex | Variable | Usage |
|------|-----|----------|-------|
| Calm Stone | `#919396` | `$ima-brand-gray` | Form labels, secondary text |
| Clarity Wash | `#F2F3F5` | `$ima-brand-gray-light` | Backgrounds, cards |
| Slate Neutral | `#8A93A5` | `$ima-brand-slate` | Alternative gray |
| Gravel | `#494949` | `$ima-brand-gray-dark` | Dark gray |
| White | `#FFFFFF` | `$ima-brand-white` | White text/backgrounds |
| Black | `#000000` | `$ima-brand-black` | Black text |

### Special

| Name | Value | Variable |
|------|-------|----------|
| Accessible Teal | `#007BB4` | `$ima-brand-teal-accessible` |
| Brand Gradient | `150deg, #00066F → #00B8B8` | `$ima-gradient` |

### Semantic Tag Colors

| Tag | Hex | Variable |
|-----|-----|----------|
| Telehealth | `#00066F` | `$ima-tag-telehealth` |
| Prescriber | `#FFCC00` | `$ima-tag-prescriber` |
| Family | `#A2CFF0` | `$ima-tag-family` |

---

## Typography

### Font Families
- **Lato** (`$ima-font-family-primary`): Headings, buttons, labels — Bold/Black weights
- **Proxima Nova / Open Sans** (`$ima-font-family-secondary`): Body text, forms — Regular/Bold weights

### Font Weights
| Variable | Value |
|----------|-------|
| `$ima-font-weight-light` | 300 |
| `$ima-font-weight-normal` | 400 |
| `$ima-font-weight-semibold` | 600 |
| `$ima-font-weight-bold` | 700 |
| `$ima-font-weight-black` | 900 |

### Font Size Scale
| Variable | Size | Usage |
|----------|------|-------|
| `$ima-font-size-xs` | 14px | Form labels |
| `$ima-font-size-sm` | 16px | Body text |
| `$ima-font-size-base` | 18px | Buttons, links |
| `$ima-font-size-md` | 20px | Section headers |
| `$ima-font-size-lg` | 28px | Subsection titles |
| `$ima-font-size-xl` | 32px | Doctor titles |
| `$ima-font-size-xxl` | 40px | Page headers |

### Line Heights
- `$ima-line-height-base`: 1 (headers)
- `$ima-line-height-comfortable`: 1.5 (body text)

---

## Typography Mixins

```scss
@include ima-page-header;         // Lato Bold 40px, uppercase, primary color
@include ima-section-header;      // Lato Bold 20px, primary color
@include ima-provider-title;      // Lato Semi Bold 32px, primary color
@include ima-provider-title-bold; // Lato Bold 1.4em
@include ima-form-label;          // Open Sans 14px, gray
@include ima-button-text;         // Lato Bold 1em, uppercase, 0.04em letter-spacing
@include ima-body-text;           // Proxima Nova Regular 16px
@include ima-h1;                  // Lato Black 40px
@include ima-h2;                  // Lato Bold 32px
@include ima-h3;                  // Lato Regular 28px, red
@include ima-footer-menu;         // Lato Bold 18px, white
```

---

## Component Mixins

### Buttons (Digital Content Guide 2026)
```scss
@include ima-button-teal;         // Teal bg, white text, inverts to outline on hover
@include ima-button-dark;         // Navy bg, white text, inverts to outline on hover
@include ima-button-inverse-teal; // Teal outline, fills to teal on hover
@include ima-button-inverse-dark; // Navy outline, fills to navy on hover
@include ima-button-lg;           // Large variant (2em font, 1.75em/3.75em padding)

// Legacy aliases (still work):
@include ima-button-primary;      // → ima-button-teal
@include ima-button-outline;      // → ima-button-inverse-dark
```
- All buttons: 15px radius, 1.25em/2.5em padding, 0.04em letter-spacing
- Font: Lato Bold 1em, uppercase

### Forms
```scss
@include ima-form-field;   // 15px radius, 1px gray border, 16px padding, teal focus
@include ima-form-label;   // Open Sans 14px, gray (#919396)
```

### Cards
```scss
@include ima-card;         // Light gray bg (#F2F3F5), 10px radius, 24px padding, NO shadow
@include ima-card-white;   // White bg, 1px gray border, 10px radius, 24px padding
```

### Tags/Badges
```scss
@include ima-tag-telehealth;  // Dark blue bg, white text, 5px radius
@include ima-tag-prescriber;  // Gold bg, black text
@include ima-tag-family;      // Sky blue bg, black text
```
- Padding: 4px 16px, Lato Bold 14px uppercase

### Layout
```scss
@include ima-gradient-bg;  // Brand gradient background

// Utility classes (in HTML):
.ima-section           // 48px vertical, 24px horizontal padding
.ima-container-sm      // 720px max-width, centered
.ima-container-md      // 960px max-width, centered
.ima-container-lg      // 1140px max-width, centered
```

### Container Query Grid

Container-responsive 12-column grid using CSS Container Queries (`@container`).
Columns respond to their **parent container's width**, not the viewport — works correctly
in sidebars, modals, cards, and any narrow context on wide screens.

```html
<!-- Stacked by default, side-by-side when container ≥ 400px -->
<div class="ima-row">
  <div class="ima-col-sm-6">First Name</div>
  <div class="ima-col-sm-6">Last Name</div>
</div>

<!-- Three columns when container is wide enough -->
<div class="ima-row">
  <div class="ima-col-md-4">Col 1</div>
  <div class="ima-col-md-4">Col 2</div>
  <div class="ima-col-md-4">Col 3</div>
</div>

<!-- Always 50% (no breakpoint) -->
<div class="ima-row">
  <div class="ima-col-6">Left</div>
  <div class="ima-col-6">Right</div>
</div>
```

**Container breakpoints** (based on parent width):

| Class prefix | Container width | Use case |
|-------------|----------------|----------|
| `ima-col-sm-` | ≥ 400px | Sidebar forms, narrow widgets |
| `ima-col-md-` | ≥ 600px | Medium columns, cards |
| `ima-col-lg-` | ≥ 800px | Wide columns, full-width areas |
| `ima-col-` | Always | Fixed layout (no breakpoint) |

**When to use which grid:**
- **Bootstrap** `.row` + `.col-md-*` → Page-level layouts (responds to viewport)
- **IMA** `.ima-row` + `.ima-col-sm-*` → Reusable components (responds to container)

**SCSS variables** (all `!default`, overridable):
```scss
$ima-cq-columns: 12;
$ima-cq-gap: 1rem;
$ima-cq-breakpoints: (sm: 400px, md: 600px, lg: 800px);
```

Source: `ima-brand/sass/_container-grid.scss`

---

## Spacing Variables

| Variable | Value |
|----------|-------|
| `$ima-spacer` | 1rem (16px) |
| `$ima-spacing-0` | 0 |
| `$ima-spacing-1` | 4px |
| `$ima-spacing-2` | 8px |
| `$ima-spacing-3` | 16px |
| `$ima-spacing-4` | 24px |
| `$ima-spacing-5` | 48px |

## Border Radius

| Variable | Value | Usage |
|----------|-------|-------|
| `$ima-border-radius-sm` | 5px | Tags, small badges |
| `$ima-border-radius-md` | 10px | Cards |
| `$ima-border-radius-lg` | 15px | Form fields |
| `$ima-border-radius-xl` | 20px | Reserved |
| `$ima-button-border-radius` | 15px | All buttons (unified) |

## Component Spacing

| Variable | Value |
|----------|-------|
| `$ima-button-padding-y` | 1.25em |
| `$ima-button-padding-x` | 2.5em |
| `$ima-button-lg-padding-y` | 1.75em |
| `$ima-button-lg-padding-x` | 3.75em |
| `$ima-button-letter-spacing` | 0.04em |
| `$ima-form-field-padding` | 16px |
| `$ima-form-field-margin-bottom` | 24px |
| `$ima-card-padding` | 24px |

---

## Bootstrap Integration

The IMA brand plugin maps to Bootstrap's theme colors:

```scss
$primary:   $ima-brand-primary;        // #00066F
$secondary: $ima-brand-secondary;      // #00B8B8
$success:   #28A745;
$warning:   $ima-brand-gold;           // #FFCC00
$danger:    $ima-brand-red;            // #DD153B
$info:      $ima-brand-teal-accessible; // #007BB4
$light:     $ima-brand-gray-light;     // #F2F3F5
$dark:      $ima-brand-primary;        // #00066F
```

This means `.btn-primary`, `.bg-primary`, `.text-primary` etc. all use IMA brand colors automatically.

---

## WCAG Accessibility

| Element | Ratio | Level |
|---------|-------|-------|
| Header 1 (Lato Black) | 16.5:1 | AAA |
| Header 2 (Lato Bold) | 5.04:1 | AA |
| Header 3 (Lato Regular) | 4.94:1 | AA |
| Body Text (Proxima Nova) | 9:1 | AAA |

High-contrast teal alternative: `$ima-brand-teal-accessible` (#007BB4)

---

## Design Notes

1. **No drop shadows** on cards (per brand feedback)
2. **Uppercase buttons** standard (text-transform: uppercase, 0.04em letter-spacing)
3. **Button radius: 15px unified** (all sizes, Digital Content Guide 2026)
4. **Form radius: 15px**, form labels: Open Sans 14px gray (not Lato)
5. **Page headers**: uppercase
6. **Font-weight fixes** included for Chrome/Brave consistency
7. **4 button variants**: teal, dark, inverse-teal, inverse-dark (hover inverts fill/outline)
