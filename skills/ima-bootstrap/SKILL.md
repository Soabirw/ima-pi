---
name: "ima-bootstrap"
description: "Bootstrap 5.3 with IMA brand integration for WordPress/Picostrap5 sites. Utility-first CSS, component patterns, SCSS customization, and IMA brand system (colors, typography, mixins). Use when: writing HTML with Bootstrap classes, creating Bootstrap components, styling WordPress templates, customizing Bootstrap Sass variables, working with IMA brand colors/typography/components, building responsive layouts, or when user mentions Bootstrap, btn-, card, modal, accordion, grid, container, row, col, d-flex, text-center, bg-primary, or IMA brand colors."
---

# IMA Bootstrap

Bootstrap 5.3 + IMA brand for WordPress/Picostrap5 child theme sites.

**Utility-first: prefer Bootstrap utility classes over custom CSS.**

```
Spacing/display/flex/text? → Bootstrap utility class
IMA brand color/typography? → IMA SCSS variable or mixin
Component? → Bootstrap component + IMA brand overrides
Bootstrap API details? → Context7: /websites/getbootstrap
```

## Decision Tree

```
Writing HTML?
├── Layout (viewport) → .container, .row, .col-{bp}-{n}
├── Layout (container) → .ima-row, .ima-col-{bp}-{n} ← USE FOR COMPONENTS
├── Spacing → .m{side}-{size}, .p{side}-{size}
├── Display → .d-{value}, .d-{bp}-{value}
├── Flex → .d-flex, .justify-content-{v}, .align-items-{v}
├── Text → .text-{align}, .fw-{weight}, .fs-{size}
├── Colors → .text-{color}, .bg-{color}
├── Component → card, modal, accordion, btn, badge, alert, navbar
└── Custom? → IMA brand mixins first, then SCSS

Writing SCSS?
├── IMA variable → $ima-brand-{color}, $ima-font-{prop}
├── IMA mixin → @include ima-{component}
├── Bootstrap override → Set $variable BEFORE @import "bootstrap5/variables"
└── Custom utility? → Bootstrap probably has it
```

### Grid: Bootstrap vs IMA Container

| Need | Use | Why |
|------|-----|-----|
| Columns at viewport breakpoint | `.row` + `.col-md-6` | Page-level layouts |
| Columns at container breakpoint | `.ima-row` + `.ima-col-sm-6` | Components, forms, sidebars, modals |

`.col-md-6` breaks at viewport ≥768px — useless in a narrow sidebar. `.ima-col-sm-6` breaks at container ≥400px regardless of viewport.

## Anti-Patterns

| BAD | GOOD |
|-----|------|
| `margin-top: 16px` | `class="mt-3"` |
| `display: flex` | `class="d-flex"` |
| `color: #040C53` | `$ima-brand-primary` / `.text-primary` |
| `font-family: Lato` | `$ima-font-family-primary` |
| Custom `.my-card { padding: 24px }` | `class="card"` |
| `@media (min-width: 768px)` for layout | `class="col-md-6"` |
| `.col-md-6` in reusable component | `.ima-col-sm-6` |

## Bootstrap Utility Reference

### Spacing (rem-based, 0-5)
- Pattern: `{property}{side}-{size}` → `mt-3`, `px-4`, `mb-0`
- Properties: `m` margin, `p` padding
- Sides: `t` `b` `s` `e` `x` `y` (blank = all)
- Sizes: `0`=0, `1`=0.25rem, `2`=0.5rem, `3`=1rem, `4`=1.5rem, `5`=3rem, `auto`

### Display & Flex
- `d-none`, `d-block`, `d-flex`, `d-grid`, `d-inline-block`
- Responsive: `d-{bp}-{value}` → `d-none d-md-block`
- `flex-row`, `flex-column`, `flex-wrap`
- `justify-content-{start|center|end|between|around|evenly}`
- `align-items-{start|center|end|stretch|baseline}`
- `gap-{0-5}`, `row-gap-{n}`, `column-gap-{n}`

### Grid (12-col, viewport-based)
- `.container`, `.container-fluid`
- `.col`, `.col-{1-12}`, `.col-{bp}-{1-12}`
- Breakpoints: `sm`≥576, `md`≥768, `lg`≥992, `xl`≥1200, `xxl`≥1400
- `.offset-{bp}-{n}`, `.order-{bp}-{n}`

### IMA Container Grid (12-col, container-based)
- `.ima-row` — container query context + CSS grid
- `.ima-col-{1-12}`, `.ima-col-{bp}-{1-12}`
- Breakpoints: `sm`≥400px, `md`≥600px, `lg`≥800px (container width)
- Source: `ima-brand/sass/_container-grid.scss`

### Text & Typography
- `text-start`, `text-center`, `text-end`
- `fw-bold`, `fw-semibold`, `fw-normal`, `fw-light`
- `fs-1` (largest) through `fs-6`
- `text-uppercase`, `text-truncate`, `text-nowrap`

### Colors (IMA-mapped)
- Text: `text-primary` (indigo), `text-secondary` (teal), `text-danger`, `text-warning`, `text-muted`
- Background: `bg-primary`, `bg-secondary`, `bg-light`, `bg-dark`, `bg-body-tertiary`
- Subtle: `text-{color}-emphasis`, `bg-{color}-subtle`

### Sizing & Position
- `w-25/50/75/100/auto`, `mw-100`, `h-25/50/75/100/auto`
- `position-relative`, `position-absolute`, `position-fixed`, `position-sticky`
- `top-0`, `start-0`, `end-0`, `bottom-0`, `translate-middle`

### Borders & Shadows
- `border`, `border-top`, `border-0`
- `rounded`, `rounded-{0-5}`, `rounded-circle`, `rounded-pill`
- `shadow-none`, `shadow-sm`, `shadow`, `shadow-lg`

## Key Components

### Cards (IMA: no shadow, 10px radius, 24px padding)
```html
<div class="card">
  <div class="card-header">Title</div>
  <div class="card-body">
    <h5 class="card-title">Heading</h5>
    <p class="card-text">Content</p>
    <a href="#" class="btn btn-primary">Action</a>
  </div>
</div>
```

### Modals
```html
<button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#myModal">Open</button>
<div class="modal fade" id="myModal" tabindex="-1" aria-hidden="true">
  <div class="modal-dialog modal-dialog-centered">
    <div class="modal-content">
      <div class="modal-header">
        <h5 class="modal-title">Title</h5>
        <button class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
      </div>
      <div class="modal-body">Content</div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
        <button class="btn btn-primary">Save</button>
      </div>
    </div>
  </div>
</div>
```

### Accordion
```html
<div class="accordion" id="acc1">
  <div class="accordion-item">
    <h2 class="accordion-header">
      <button class="accordion-button" data-bs-toggle="collapse" data-bs-target="#c1">Item 1</button>
    </h2>
    <div id="c1" class="accordion-collapse collapse show" data-bs-parent="#acc1">
      <div class="accordion-body">Content</div>
    </div>
  </div>
</div>
```

### Buttons (IMA: Lato Bold 18px, 20px/40px padding, 10px radius)
```html
<button class="btn btn-primary">Primary (teal)</button>
<button class="btn btn-outline-primary">Outline</button>
<button class="btn btn-lg btn-primary">Large (20px radius)</button>
```

### Tables
```html
<div class="table-responsive">
  <table class="table table-striped table-hover">
    <thead><tr><th>Column</th></tr></thead>
    <tbody><tr><td>Data</td></tr></tbody>
  </table>
</div>
```

## IMA Brand

### Colors
| Name | Hex | SCSS Variable | Bootstrap Class |
|------|-----|---------------|-----------------|
| Trustworthy Indigo | `#040C53` | `$ima-brand-primary` | `.text-primary`, `.bg-primary` |
| Aquatic Pulse | `#0296A1` | `$ima-brand-secondary` | `.text-secondary`, `.bg-secondary` |
| Bright Teal | `#00B8B8` | `$ima-brand-accent-teal` | (hover states) |
| Guidance Sky | `#A2CFF0` | `$ima-brand-sky` | — |
| Vital Gold | `#FFCC00` | `$ima-brand-gold` | `.text-warning`, `.bg-warning` |
| Red Ribbon | `#DD153B` | `$ima-brand-red` | `.text-danger`, `.bg-danger` |
| Clarity Wash | `#F2F3F5` | `$ima-brand-gray-light` | `.bg-light` |

### Typography Mixins
```scss
@include ima-page-header;        // Lato Bold 40px, uppercase, primary
@include ima-section-header;     // Lato Bold 20px, primary
@include ima-provider-title;     // Lato Semi Bold 32px, primary
@include ima-button-text;        // Lato Bold 18px, uppercase
@include ima-body-text;          // Proxima Nova Regular 16px
@include ima-form-label;         // Open Sans 14px, gray
```

### Component Mixins
```scss
@include ima-button-primary;      // Teal bg, white text, 20px/40px padding
@include ima-button-primary-wide; // Same, 80px horizontal padding
@include ima-button-outline;      // Transparent bg, primary border
@include ima-form-field;          // 15px radius, gray border, teal focus
@include ima-card;                // Light gray bg, no shadow, 10px radius
@include ima-card-white;          // White bg, 1px gray border
@include ima-gradient-bg;         // 150deg gradient, #00066F → #00B8B8
```

## SCSS Architecture

```
picostrap5-child-base/sass/
├── main.scss                    ← Entry point
├── _bootstrap-loader.scss       ← Bootstrap import chain
├── _theme_variables.scss        ← Variable overrides (loads IMA brand)
├── _custom.scss                 ← Modular custom styles
└── bootstrap5/                  ← Bootstrap 5.3 source (DO NOT EDIT)

plugins/ima-brand/sass/
├── _variables.scss              ← Colors, typography, spacing
├── _typography.scss             ← Font mixins
├── _spacing.scss                ← Component mixins, layout
└── _container-grid.scss         ← .ima-row/.ima-col-*
```

**Import order**: Bootstrap functions → IMA brand → theme variables → Bootstrap variables → Bootstrap components → custom styles

## Reference Files

| File | Contains |
|------|----------|
| [`references/ima-brand.md`](references/ima-brand.md) | Full brand variables, colors, mixins |
| [`references/theme-integration.md`](references/theme-integration.md) | SCSS architecture, Bootstrap override chain |
| [`references/bootstrap-patterns.md`](references/bootstrap-patterns.md) | Extended utilities, Sass customization |

## Context7

```
mcp__context7__query-docs({ libraryId: "/websites/getbootstrap", query: "..." })
```

## Success Metrics
- Bootstrap utility usage ≥80% vs custom CSS
- IMA brand variables 100% (no hardcoded brand colors)
- Custom CSS only for patterns with no Bootstrap equivalent
