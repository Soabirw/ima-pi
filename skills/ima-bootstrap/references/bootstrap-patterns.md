# Bootstrap 5.3 Patterns Reference

Extended reference for Bootstrap patterns beyond the quick reference in SKILL.md.

---

## Sass Customization

### Variable Override Pattern

Variables must be set **before** Bootstrap's `_variables.scss` is imported. Bootstrap uses `!default` so first-defined wins.

```scss
// 1. Functions first
@import "bootstrap5/functions";

// 2. YOUR overrides (before Bootstrap variables)
$primary: #040C53;
$font-family-base: 'Open Sans', sans-serif;

// 3. Bootstrap variables (respects your overrides)
@import "bootstrap5/variables";
@import "bootstrap5/variables-dark";

// 4. Maps (after variables, before mixins)
@import "bootstrap5/maps";
@import "bootstrap5/mixins";
@import "bootstrap5/root";
```

### Adding Custom Theme Colors

```scss
// After @import "variables" but before @import "maps"
$custom-colors: (
  "brand-teal": #00B8B8,
  "brand-sky": #A2CFF0
);
$theme-colors: map-merge($theme-colors, $custom-colors);
```

This generates `.text-brand-teal`, `.bg-brand-teal`, `.btn-brand-teal` etc.

### Extending the Utility API

Add custom utilities via the `$utilities` map (before `utilities/api` import):

```scss
$utilities: map-merge(
  $utilities,
  (
    "custom-property": (
      property: custom-property,
      class: custom,
      values: (
        1: value-1,
        2: value-2,
      )
    )
  )
);
```

---

## Grid System Details

### Basic Grid
```html
<div class="container">
  <div class="row">
    <div class="col-md-8">Main content</div>
    <div class="col-md-4">Sidebar</div>
  </div>
</div>
```

### Auto-Layout Columns
```html
<div class="row">
  <div class="col">Equal</div>    <!-- auto-size -->
  <div class="col">Equal</div>
  <div class="col">Equal</div>
</div>
```

### Responsive Breakpoints (VIEWPORT-based)

| Breakpoint | Class infix | Dimensions |
|-----------|-------------|------------|
| Extra small | (none) | <576px |
| Small | `sm` | ≥576px |
| Medium | `md` | ≥768px |
| Large | `lg` | ≥992px |
| Extra large | `xl` | ≥1200px |
| Extra extra large | `xxl` | ≥1400px |

**Important limitation:** These breakpoints respond to the browser viewport, NOT the
parent container. A `.col-md-6` in a narrow sidebar on a desktop will NOT stack — the
viewport is still wide. For container-responsive layouts, use the IMA Container Grid
(`.ima-row` + `.ima-col-sm-6`) from `ima-brand/sass/_container-grid.scss`.

### Gutters
- Default: `1.5rem` (24px)
- Remove: `class="g-0"` on `.row`
- Custom: `gx-{0-5}` (horizontal), `gy-{0-5}` (vertical), `g-{0-5}` (both)

### Nesting
```html
<div class="row">
  <div class="col-md-8">
    <div class="row">  <!-- Nested row -->
      <div class="col-6">Nested left</div>
      <div class="col-6">Nested right</div>
    </div>
  </div>
</div>
```

---

## Responsive Patterns

### Hide/Show by Breakpoint
```html
<!-- Hidden on mobile, visible from md up -->
<div class="d-none d-md-block">Desktop only</div>

<!-- Visible on mobile, hidden from md up -->
<div class="d-block d-md-none">Mobile only</div>

<!-- Visible only on md -->
<div class="d-none d-md-block d-lg-none">Tablet only</div>
```

### Responsive Text Alignment
```html
<p class="text-center text-md-start">Centered on mobile, left on desktop</p>
```

### Responsive Flex
```html
<div class="d-flex flex-column flex-md-row">
  <!-- Stacked on mobile, side by side on desktop -->
</div>
```

---

## Forms

### Standard Form Layout
```html
<form>
  <div class="mb-3">
    <label for="email" class="form-label">Email</label>
    <input type="email" class="form-control" id="email">
  </div>
  <div class="mb-3">
    <label for="msg" class="form-label">Message</label>
    <textarea class="form-control" id="msg" rows="3"></textarea>
  </div>
  <button type="submit" class="btn btn-primary">Submit</button>
</form>
```

### Inline Form
```html
<form class="row row-cols-lg-auto g-3 align-items-center">
  <div class="col-12">
    <input type="text" class="form-control" placeholder="Search">
  </div>
  <div class="col-12">
    <button type="submit" class="btn btn-primary">Go</button>
  </div>
</form>
```

### Form Validation
```html
<form class="needs-validation" novalidate>
  <div class="mb-3">
    <input type="text" class="form-control" required>
    <div class="valid-feedback">Looks good!</div>
    <div class="invalid-feedback">Required field.</div>
  </div>
</form>
```

### Select, Checkbox, Radio
```html
<select class="form-select">
  <option selected>Choose...</option>
  <option value="1">One</option>
</select>

<div class="form-check">
  <input class="form-check-input" type="checkbox" id="check1">
  <label class="form-check-label" for="check1">Check me</label>
</div>

<div class="form-check">
  <input class="form-check-input" type="radio" name="radio1" id="radio1">
  <label class="form-check-label" for="radio1">Option 1</label>
</div>
```

### Input Groups
```html
<div class="input-group mb-3">
  <span class="input-group-text">@</span>
  <input type="text" class="form-control" placeholder="Username">
</div>
```

---

## Navbar Patterns

### Standard Responsive Navbar
```html
<nav class="navbar navbar-expand-lg navbar-light bg-light">
  <div class="container">
    <a class="navbar-brand" href="#">Brand</a>
    <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navContent">
      <span class="navbar-toggler-icon"></span>
    </button>
    <div class="collapse navbar-collapse" id="navContent">
      <ul class="navbar-nav me-auto mb-2 mb-lg-0">
        <li class="nav-item"><a class="nav-link active" href="#">Home</a></li>
        <li class="nav-item"><a class="nav-link" href="#">About</a></li>
        <li class="nav-item dropdown">
          <a class="nav-link dropdown-toggle" href="#" data-bs-toggle="dropdown">Services</a>
          <ul class="dropdown-menu">
            <li><a class="dropdown-item" href="#">Service 1</a></li>
          </ul>
        </li>
      </ul>
    </div>
  </div>
</nav>
```

---

## Common Component Patterns

### Alert with Dismiss
```html
<div class="alert alert-warning alert-dismissible fade show" role="alert">
  <strong>Warning!</strong> Something needs attention.
  <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
</div>
```

### Badge
```html
<span class="badge text-bg-primary">New</span>
<span class="badge rounded-pill text-bg-danger">4</span>
```

### List Group
```html
<ul class="list-group">
  <li class="list-group-item active">Active item</li>
  <li class="list-group-item">Regular item</li>
  <li class="list-group-item list-group-item-action">Clickable</li>
</ul>
```

### Offcanvas
```html
<button class="btn btn-primary" data-bs-toggle="offcanvas" data-bs-target="#sidebar">Menu</button>
<div class="offcanvas offcanvas-start" id="sidebar" tabindex="-1">
  <div class="offcanvas-header">
    <h5 class="offcanvas-title">Menu</h5>
    <button class="btn-close" data-bs-dismiss="offcanvas" aria-label="Close"></button>
  </div>
  <div class="offcanvas-body">Content</div>
</div>
```

### Toast
```html
<div class="toast-container position-fixed bottom-0 end-0 p-3">
  <div class="toast" role="alert">
    <div class="toast-header">
      <strong class="me-auto">Notification</strong>
      <button class="btn-close" data-bs-dismiss="toast" aria-label="Close"></button>
    </div>
    <div class="toast-body">Message here.</div>
  </div>
</div>
```

---

## CSS Custom Properties (Bootstrap 5.3)

Bootstrap 5.3 exposes theme values as CSS custom properties on `:root`:

```css
:root {
  --bs-primary: #040C53;          /* IMA mapped */
  --bs-secondary: #0296A1;        /* IMA mapped */
  --bs-body-font-family: 'Open Sans', sans-serif;
  --bs-body-font-size: 1rem;
  --bs-body-color: #000;
}
```

Use in custom CSS when SCSS variables aren't available:
```css
.custom-element {
  color: var(--bs-primary);
  font-family: var(--bs-body-font-family);
}
```

---

## JavaScript Integration

### Data Attributes (preferred, no JS needed)
```html
<button data-bs-toggle="modal" data-bs-target="#myModal">Open</button>
<button data-bs-toggle="collapse" data-bs-target="#content">Toggle</button>
<button data-bs-toggle="tooltip" title="Help text">Hover me</button>
```

### Programmatic API
```javascript
// Modal
const modal = new bootstrap.Modal('#myModal');
modal.show();
modal.hide();

// Toast (must be initialized)
const toast = new bootstrap.Toast(document.getElementById('myToast'));
toast.show();

// Tooltip (must be initialized)
const tooltipList = document.querySelectorAll('[data-bs-toggle="tooltip"]');
tooltipList.forEach(el => new bootstrap.Tooltip(el));
```

### Events
```javascript
document.getElementById('myModal').addEventListener('shown.bs.modal', () => {
  // Modal is fully visible
});

document.getElementById('myModal').addEventListener('hidden.bs.modal', () => {
  // Modal is fully hidden
});
```
