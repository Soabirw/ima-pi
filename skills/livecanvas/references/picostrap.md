# PicoStrap Theme Integration

PicoStrap5 — free, open-source Bootstrap 5 starter theme by the LiveCanvas team. Ultra-lightweight, no bloat.

**GitHub**: https://github.com/livecanvas-team/picostrap5

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [SCSS Pipeline](#scss-pipeline)
4. [Child Theme Setup](#child-theme-setup)
5. [NinjaBootstrap](#ninjabootstrap)
6. [Dark Mode](#dark-mode)
7. [Customizer Options](#customizer-options)

---

## Overview

- Pure Bootstrap 5.3 — no extras, no jQuery
- Built-in browser-based SCSS compiler (no CLI tools needed)
- Hit Publish in Customizer → Bootstrap recompiles on the fly
- jQuery-free (vanilla JS Bootstrap)
- No icon fonts (inline SVGs)
- RFS (Responsive Font Sizing) enabled by default
- WooCommerce support out of the box
- Clean HTML head (removes WP default header bloat)
- GPL licensed
- LiveCanvas auto-detects PicoStrap5 and enables Bootstrap 5 mode

## Architecture

```
picostrap5/
├── header.php
├── footer.php
├── index.php
├── page.php
├── single.php
├── archive.php
├── search.php
├── 404.php
├── functions.php
├── inc/
│   ├── template-tags.php        # Hooks and filters
│   └── clean-head.php           # Remove WP bloat
├── sass/
│   ├── main.scss                # Entry point
│   ├── _bootstrap-loader.scss   # Bootstrap import
│   └── _custom.scss             # Theme customizations
├── css-output/
│   └── main.css                 # Compiled output
├── loops/                       # Loop templates
├── partials/                    # Template parts
├── woocommerce/                 # WC template overrides
└── livecanvas/
    ├── pages/                   # Readymade page templates
    └── sections/                # Custom section library
```

## SCSS Pipeline

Compilation order:

```
main.scss
  └── _bootstrap-loader.scss
        ├── Bootstrap 5.3 source SCSS
        ├── NinjaBootstrap extensions
        └── _custom.scss (your overrides)
```

### Variable Override Strategy

Bootstrap uses `!default` — your variables take precedence when defined before Bootstrap's imports:

```scss
// In child theme sass/_custom.scss
$primary: #your-brand-color;
$font-family-base: 'Your Font', sans-serif;
$border-radius: 0.5rem;

// These override Bootstrap defaults because they're loaded first
```

### Where to Customize

| What | Where |
|------|-------|
| Bootstrap variable overrides | Child theme `sass/_custom.scss` |
| Custom component styles | Child theme `sass/_custom.scss` |
| Theme structure/templates | Child theme PHP files |
| LiveCanvas page templates | Child theme `livecanvas/pages/` |
| LiveCanvas sections | Child theme `livecanvas/sections/` |

### Recompiling

1. Go to Appearance → Customize
2. Change any SASS variable or save `_custom.scss`
3. Hit Publish — SCSS recompiles in browser
4. Output → `css-output/main.css`

No Node.js, no webpack, no CLI tools required.

---

## Child Theme Setup

PicoStrap provides a blank child theme starter:

```
picostrap5-child/
├── style.css                    # Theme header (Template: picostrap5)
├── functions.php                # Child functions
├── sass/
│   └── _custom.scss             # Bootstrap variable overrides + custom CSS
├── livecanvas/
│   ├── pages/                   # Custom readymade page templates
│   └── sections/                # Custom section library
└── woocommerce/                 # WC template overrides (optional)
```

### Key Override Points

**Colors**:
```scss
$primary:   #your-color;
$secondary: #your-color;
$success:   #your-color;
$info:      #your-color;
$warning:   #your-color;
$danger:    #your-color;
$light:     #your-color;
$dark:      #your-color;
```

**Typography**:
```scss
$font-family-base: 'Your Font', system-ui, sans-serif;
$font-family-monospace: 'Your Mono', monospace;
$font-size-base: 1rem;
$line-height-base: 1.5;
$headings-font-family: 'Your Heading Font', serif;
$headings-font-weight: 700;
```

**Spacing & Sizing**:
```scss
$spacer: 1rem;
$border-radius: 0.375rem;
$border-radius-lg: 0.5rem;
$border-radius-sm: 0.25rem;
```

**Components**:
```scss
$btn-border-radius: 0.375rem;
$card-border-radius: 0.5rem;
$input-border-radius: 0.375rem;
$navbar-padding-y: 0.5rem;
```

For IMA-specific overrides, see the `ima-bootstrap` skill's `references/theme-integration.md`.

---

## NinjaBootstrap

Built into PicoStrap v3+. Extends Bootstrap 5.3 with additional utility classes:

- **10 color shades per theme color**: `.text-primary-100` through `.text-primary-900`, `.bg-primary-100` through `.bg-primary-900`
- **Automatic dark mode inversion**: Shades flip appropriately in `[data-bs-theme="dark"]`
- **Extra utilities**: Additional spacing, sizing, and display helpers beyond Bootstrap defaults

Usage in LiveCanvas:
```html
<section class="bg-primary-100 py-5">
  <div class="container">
    <h2 class="text-primary-800">Section Title</h2>
    <p class="text-primary-600">Subtitle text with lighter shade</p>
  </div>
</section>
```

---

## Dark Mode

PicoStrap supports Bootstrap 5.3's native dark mode via `data-bs-theme` attribute:

```html
<!-- Page-level -->
<html data-bs-theme="dark">

<!-- Component-level -->
<div data-bs-theme="dark" class="card">
  <div class="card-body">Always dark</div>
</div>

<!-- Toggle via JavaScript -->
<script>
document.documentElement.setAttribute('data-bs-theme',
  document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark'
);
</script>
```

NinjaBootstrap color shades automatically invert in dark mode.

---

## Customizer Options

PicoStrap exposes key Bootstrap variables through the WordPress Customizer:

- **Colors**: All theme colors (primary, secondary, etc.)
- **Typography**: Font families, sizes, weights
- **Spacing**: Base spacer value
- **Components**: Border radius, button styles
- **AI Color Palette**: Generate harmonious color schemes

Changes trigger SCSS recompilation on Publish.

### Export/Import

PicoStrap supports Customizer Export/Import for sharing design system settings across sites. Useful for team standardization.
