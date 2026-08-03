# EspoCRM Email Template Compatibility

## What EspoCRM Strips

| Tag / Attribute | Notes |
|---|---|
| `<html>`, `<head>`, `<body>` | Document-level structure removed |
| `<style>` blocks | Stripped by prep script; inline CSS only is the guarantee |
| `<script>`, `<iframe>`, `<embed>`, `<object>` | Security-stripped |
| Event handlers (`onclick`, `onload`, etc.) | Stripped |
| `data-*` attributes | May be stripped |

Responsive `@media` queries in `<style>` blocks are lost after EspoCRM prep. This is expected — EspoCRM renders in its own container.

## What Survives

- Table-based layouts with inline `style=""` attributes
- `<img>` with inline styles and HTML attributes (`width`, `height`, `alt`)
- `<a>` links
- Standard block/inline elements: `div`, `span`, `p`, `h1–h6`, `ul`, `ol`, `li`, `br`, `hr`

## The Body→Div Transform

The key transform is simple: `espocrm-prep.py` extracts `<body>` content and wraps it in a `<div>`. The `<head>` style block, Google Fonts import, and MSO conditionals are all stripped.

```bash
python3 skills/ima-email-creator/scripts/espocrm-prep.py input.html --out output.html
```

## Source View Paste Workflow

1. Generate email HTML (or receive from BeeFree/external tool)
2. Run `espocrm-prep.py` — this extracts `<body>` content and wraps in `<div>`. The `<head>` style block, Google Fonts import, and MSO conditionals are all stripped.
3. In EspoCRM: Email Template → Edit → switch to Source View (`< >` icon)
4. Paste the prepared HTML
5. **NEVER switch back to WYSIWYG** — it will corrupt the HTML
6. Save directly from source view

## EspoCRM Template Variables

EspoCRM uses **single-brace** syntax (NOT Handlebars double-brace):

| Variable | Usage | Email Types |
|----------|-------|-------------|
| `{Person.firstName}` | First name greeting | Newsletters |
| `{Person.name}` | Full name greeting | Campaigns, fundraising |
| `{optOutLink}` | Unsubscribe link | ALL emails (footer) |

The `{optOutLink}` renders as a clickable link. Style the container:
```html
<div style="text-align: center; color: #00B8B8;">{optOutLink}</div>
```

## Tips

- Build HTML externally, paste into source view as a single operation
- Test by sending a test email to yourself before mass send
- If HTML looks broken after saving, it was round-tripped through WYSIWYG — rebuild from source
