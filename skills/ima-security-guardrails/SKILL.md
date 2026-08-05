---
name: ima-security-guardrails
description: Apply IMA security guardrails to WordPress/PHP, JavaScript/TypeScript, and Bootstrap changes. Use when implementing, testing, or reviewing code that handles user input, database access, authorization, or UI styling.
---

# IMA security guardrails

Apply the sections that match the code being changed. State any inapplicable section rather than silently assuming it passed.

## WordPress PHP

After every PHP file edit, verify all five checks:

1. AJAX handlers verify a nonce with `wp_verify_nonce()` or `check_ajax_referer()` before processing. Privileged operations additionally authorize the caller with `current_user_can()`; intentional public handlers do not require an authenticated capability check.
2. Every `$wpdb` query with dynamic data uses `->prepare()`; never interpolate values into SQL.
3. User input is sanitized at the boundary with the appropriate function, such as `sanitize_text_field()`, `absint()`, `sanitize_email()`, or `wp_kses()`.
4. Output is escaped for its context with `esc_html()`, `esc_attr()`, `esc_url()`, or `wp_kses()` for approved rich HTML.
5. Each PHP file declares `declare(strict_types=1);` immediately after its opening `<?php` tag.

Use `do_action()` or `apply_filters()` for cross-plugin extension points rather than probing other plugins with `function_exists()`. In WordPress, jQuery is already available for DOM work; do not add a duplicate dependency.

## JavaScript and TypeScript

Never construct SQL by interpolating values into a query string. Use the driver’s parameterized-query API, for example a SQL string with placeholders and a separate `params` array. Treat request data, credentials, authorization state, and external responses as explicit boundaries that require validation and error handling.

## Functional boundaries

Keep business rules pure where practical and isolate I/O at explicit boundaries. Do not create custom `pipe()`, `compose()`, `curry()`, or monad utilities; use native language control flow and collection methods.

## Bootstrap styling

When Bootstrap 5 is available, prefer its utility classes over inline styles. Use the existing Bootstrap and IMA styling guidance for values that need a design-system decision.
