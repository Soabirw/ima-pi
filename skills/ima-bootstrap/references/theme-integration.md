# Theme Integration Reference

How IMA brand integrates with Bootstrap 5.3 via the Picostrap5 child theme.

---

## SCSS Pipeline

The compilation order is critical — variables must be set before Bootstrap reads them.

```
main.scss
├── _bootstrap-loader.scss          ← Bootstrap import chain
│   ├── bootstrap5/functions        ← 1. Bootstrap functions
│   ├── ninjabootstrap/variables    ← 2. Picostrap parent theme vars
│   ├── _theme_variables.scss       ← 3. OUR OVERRIDES (loads IMA brand)
│   │   └── @import ima-brand/sass/brand  ← IMA colors, typography, spacing
│   ├── bootstrap5/variables        ← 4. Bootstrap defaults (our values take precedence)
│   ├── bootstrap5/variables-dark   ← 5. Dark mode variables
│   ├── bootstrap5/maps             ← 6. Sass maps
│   ├── bootstrap5/mixins           ← 7. Mixins
│   ├── bootstrap5/root             ← 8. CSS custom properties
│   ├── bootstrap5/utilities        ← 9. Utility definitions
│   ├── [all Bootstrap components]  ← 10. Component styles
│   ├── ninjabootstrap/*            ← 11. Picostrap extensions
│   └── bootstrap5/utilities/api    ← 12. Generates utility classes
├── _wp_basic_styles.scss           ← WordPress basics
├── _picostrap.scss                 ← Parent theme styles
├── _woocommerce.scss               ← WooCommerce styles
└── _custom.scss                    ← OUR CUSTOM STYLES (last = highest priority)
    ├── plugins/ima-login/sass/login
    ├── plugins/ima-forms/sass/ima-forms
    ├── base/global-base
    ├── base/header
    ├── components/site-components
    ├── components/forms
    ├── components/badges
    └── pages/*                     ← Page-specific styles
```

## Key Insight: Variable Override Strategy

**`_theme_variables.scss`** loads _before_ Bootstrap's variables file. Since Bootstrap uses `!default`, our values take precedence:

```scss
// In _theme_variables.scss (loaded BEFORE Bootstrap)
$primary: $ima-brand-primary !default;  // #040C53

// In bootstrap5/_variables.scss (loaded AFTER)
$primary: $blue !default;  // This is IGNORED because $primary already exists
```

This means **every Bootstrap component automatically uses IMA brand values** without any custom CSS.

## What _theme_variables.scss Overrides

### Theme Colors
```scss
$primary:   $ima-brand-primary;        // #040C53 Trustworthy Indigo
$secondary: $ima-brand-secondary;      // #0296A1 Aquatic Pulse
$success:   $ima-color-success;        // #28A745
$warning:   $ima-brand-gold;           // #FFCC00 Vital Gold
$danger:    $ima-brand-red;            // #DD153B Red Ribbon
$info:      $ima-brand-teal-accessible; // #007BB4 WCAG teal
$light:     $ima-brand-gray-light;     // #F2F3F5 Clarity Wash
$dark:      $ima-brand-primary;        // #040C53
```

### Typography
```scss
$font-family-base:      $ima-font-family-secondary;    // Proxima Nova/Open Sans
$headings-font-family:  $ima-font-family-primary;      // Lato
$headings-font-weight:  $ima-font-weight-bold;         // 700
$headings-color:        $ima-brand-primary;            // #040C53
$body-color:            $ima-brand-black;              // #000000
$font-size-base:        $ima-font-size-sm;             // 1rem (16px)
$h1-font-size:          $ima-font-size-xxl;            // 40px
$h2-font-size:          $ima-font-size-xl;             // 32px
$h3-font-size:          $ima-font-size-lg;             // 28px
$h4-font-size:          $ima-font-size-md;             // 20px
$h5-font-size:          $ima-font-size-base;           // 18px
```

### Links
```scss
$link-color:            $ima-brand-secondary;          // #0296A1 teal
$link-hover-color:      $ima-brand-accent-teal;        // #00B8B8 brighter
$link-decoration:       none;
$link-hover-decoration: underline;
```

### Buttons
```scss
$btn-padding-y:         $ima-button-padding-y;         // 20px
$btn-padding-x:         $ima-button-padding-x;         // 40px
$btn-font-size:         $ima-button-font-size;         // 18px
$btn-font-weight:       $ima-button-font-weight;       // Bold
$btn-font-family:       $ima-button-font;              // Lato
$btn-border-radius:     $ima-border-radius-md;         // 10px
$btn-border-radius-lg:  $ima-border-radius-xl;         // 20px
$btn-border-radius-sm:  $ima-border-radius-sm;         // 5px
$btn-box-shadow:        none;
$btn-active-box-shadow: none;
```

### Forms
```scss
$input-border-color:      $ima-brand-gray;             // #919396
$input-border-radius:     $ima-form-field-border-radius; // 15px
$input-padding-y:         $ima-spacing-3;              // 16px
$input-padding-x:         $ima-spacing-3;              // 16px
$input-focus-border-color: $ima-brand-secondary;       // #0296A1 teal
$form-label-color:        $ima-form-label-color;       // #919396
$form-label-font-size:    $ima-form-label-size;        // 14px
```

### Cards
```scss
$card-border-radius:    $ima-border-radius-md;         // 10px
$card-box-shadow:       $ima-card-shadow;              // none
$card-spacer-y:         $ima-spacing-4;                // 24px
$card-spacer-x:         $ima-spacing-4;                // 24px
```

### Navbar
```scss
$navbar-light-color:        $ima-brand-primary;        // Dark blue links
$navbar-light-hover-color:  $ima-brand-secondary;      // Teal on hover
$navbar-light-active-color: $ima-brand-accent-teal;    // Bright teal active
```

### Global
```scss
$border-radius:     $ima-border-radius-md;             // 10px
$border-radius-sm:  $ima-border-radius-sm;             // 5px
$border-radius-lg:  $ima-border-radius-lg;             // 15px
$border-color:      $ima-brand-gray-light;
$badge-border-radius: $ima-badge-border-radius;        // 5px
```

---

## Picostrap Extensions (ninjabootstrap)

The theme includes Picostrap's extended Bootstrap utilities:
- `ninjabootstrap/positioning` — Extra positioning utilities
- `ninjabootstrap/sizing` — Extended sizing classes
- `ninjabootstrap/letter-spacing` — Letter spacing utilities
- `ninjabootstrap/borders` — Extra border utilities
- `ninjabootstrap/tailwind_grays` — Tailwind-style gray palette
- `ninjabootstrap/theme_colors_shades` — Shade variants for theme colors

---

## _custom.scss Structure

The custom styles file uses a modular import structure:

```scss
// Plugin styles
@import "plugins/ima-login/sass/login";    // Login page styles
@import "plugins/ima-forms/sass/ima-forms"; // IMA Forms library

// Base
@import "base/global-base";               // Global typography, links
@import "base/header";                     // Site header

// Components
@import "components/site-components";       // Reusable components
@import "components/forms";                 // Form overrides
@import "components/badges";                // Badge styles

// Pages
@import "pages/activation-page";
@import "pages/listing-single";
@import "pages/directory-layout";
@import "pages/listing-cards";
@import "pages/my-account";
```

---

## Where to Add New Styles

| Type | Location |
|------|----------|
| Bootstrap variable override | `_theme_variables.scss` |
| New IMA brand variable | `ima-brand/sass/_variables.scss` |
| New IMA mixin | `ima-brand/sass/_typography.scss` or `_spacing.scss` |
| Global base styles | `sass/base/global-base.scss` |
| Reusable component | `sass/components/` (new file + import in _custom.scss) |
| Page-specific styles | `sass/pages/` (new file + import in _custom.scss) |
| Plugin styles | Import from plugin's sass directory in _custom.scss |

## How to Recompile

After SCSS changes: **Appearance > Customize > "RECOMPILE SASS"** in WordPress admin.

---

## Legacy Migration Reference

| Old FLCCC Variable | New IMA Variable |
|---------------------|------------------|
| `$flccc-blue-dark` (#040C53) | `$ima-brand-primary` (exact match) |
| `$flccc-blue` (#89CEDB) | `$ima-brand-sky` (#A2CFF0) |
| `$flccc-blue-darker` (#496978) | `$ima-brand-secondary` (#0296A1) |
| `$flccc-red` (#C90000) | `$ima-brand-red` (#DD153B) |
| `$flccc-grey` (#707070) | `$ima-brand-gray` (#919396) |
| `$flccc-grey-light` (#EDEDED) | `$ima-brand-gray-light` (#F2F3F5) |
| Montserrat | `$ima-font-family-primary` (Lato) |
| Open Sans | `$ima-font-family-secondary` (Proxima Nova/Open Sans) |
