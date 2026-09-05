---
name: "php-fp-wordpress"
description: "Security-first WordPress development with PHP FP principles: pure business rules, explicit WordPress boundaries, and cumulative controls."
---

# PHP FP - WordPress

Build pure business rules behind explicit WordPress wrappers. Every request, stored value, file,
URL, and third-party response is boundary data. Use
[ima-security-guardrails](../ima-security-guardrails/SKILL.md) as the shared authority and
[php-fp](../php-fp/SKILL.md) for PHP-specific FP patterns.

## Boundary control matrix

Controls are cumulative. Validation, sanitization, escaping, authentication, capability
authorization, CSRF protection, and prepared database access solve different problems.

| Boundary                 | Verify before the effect                                                                                          | Do not mistake it for                                      |
|--------------------------|-------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------|
| Privileged AJAX          | Request shape, `wp_verify_nonce()` or `check_ajax_referer()`, then `current_user_can()` for the affected resource | A nonce or logged-in session proving authority             |
| Intentional public AJAX  | Explicitly document why it is public; validate and constrain abuse appropriate to the endpoint                    | A missing capability check being safe by default           |
| REST route               | Request validation and a meaningful `permission_callback`                                                         | Route registration or client UI hiding being authorization |
| Database                 | `$wpdb->prepare()` for values; allowlists for identifiers and sort direction                                      | Sanitization replacing parameterization                    |
| Rendered output          | Contextual escaping at the final HTML, attribute, URL, JavaScript, or JSON sink                                   | `wp_kses_post()` making arbitrary data generally safe      |
| Files and paths          | Allowed MIME/type, size, canonical location, and authorization                                                    | Filename cleanup preventing traversal or symlink issues    |
| Redirect / outbound HTTP | Approved scheme and destination; redirects and responses constrained for the use case                             | A syntactically valid URL being safe                       |

**Sanitize ALL user input** at the receiving boundary after validating its shape. **Escape ALL
output by context** at the final sink. Keep raw external input out of pure functions; pass a
validated, normalized value in instead.

### Security function reference

| Need                   | WordPress control                                                                   |
|------------------------|-------------------------------------------------------------------------------------|
| Plain text             | `sanitize_text_field()` then `esc_html()` or `esc_attr()` at output                 |
| Email                  | `sanitize_email()` plus domain/business validation, then contextual output escaping |
| Positive identifier    | `absint()` plus existence and authorization checks                                  |
| Storage URL            | `esc_url_raw()` after scheme/destination validation                                 |
| HTML body text         | `esc_html()`                                                                        |
| Approved rich HTML     | A deliberate `wp_kses()` policy, then appropriate surrounding context               |
| URL in `href` / `src`  | `esc_url()` after destination validation                                            |
| JavaScript data        | `wp_json_encode()`                                                                  |
| Dynamic database value | `$wpdb->prepare()`                                                                  |

## Privileged AJAX: complete boundary example

Register privileged actions only with `wp_ajax_`. Extract the minimal identifier needed to make
the resource authorization decision; do not perform the effect until every check passes.

```php
<?php
declare(strict_types=1);

add_action('wp_ajax_ima_update_post_title', 'ima_update_post_title');

function ima_update_post_title(): void {
    check_ajax_referer('ima_update_post_title', 'nonce');

    $post_id = absint(wp_unslash($_POST['post_id'] ?? ''));
    if ($post_id === 0) {
        wp_send_json_error(['message' => 'Invalid post.'], 400);
    }

    if (!current_user_can('edit_post', $post_id)) {
        wp_send_json_error(['message' => 'Forbidden.'], 403);
    }

    $title = sanitize_text_field(wp_unslash($_POST['title'] ?? ''));
    if ($title === '') {
        wp_send_json_error(['message' => 'Title is required.'], 422);
    }

    $updated = wp_update_post(['ID' => $post_id, 'post_title' => $title], true);
    if (is_wp_error($updated)) {
        wp_send_json_error(['message' => 'Update failed.'], 500);
    }

    wp_send_json_success(['postId' => $post_id, 'title' => $title]);
}
```

The JSON response is a protocol boundary, not pre-escaped HTML. A browser that displays `title`
must use a text sink or context-specific encoding there.

### Intentionally public handlers

A `wp_ajax_nopriv_` handler is an explicit product decision, not a shortcut around authorization.
It may not perform a privileged action. Document why it is public, validate every input, give it a
small response surface, and add rate limits, abuse controls, or challenge mechanisms when exposure
requires them. A public nonce is CSRF-related state, not proof of identity or permission.

## REST, database, files, URLs, and dependencies

### REST permission callbacks

Every protected REST route supplies a resource-aware `permission_callback`:

```php
register_rest_route('ima/v1', '/posts/(?P<id>\d+)', [
    'methods' => 'POST',
    'callback' => 'ima_update_post_rest',
    'permission_callback' => static function (WP_REST_Request $request): bool {
        return current_user_can('edit_post', absint($request['id']));
    },
]);
```

Validate request arguments in the callback or registered argument schema as well. Authentication
alone does not authorize the update.

### Prepared values and allowlisted structure

```php
<?php
declare(strict_types=1);

function ima_find_records(string $status, string $sort): array {
    global $wpdb;

    $allowed_sorts = ['created_at', 'title'];
    if (!in_array($sort, $allowed_sorts, true)) {
        return [];
    }

    $table = $wpdb->prefix . 'ima_records'; // Plugin-controlled identifier.
    $sql = $wpdb->prepare(
        "SELECT id, title FROM {$table} WHERE status = %s ORDER BY {$sort}",
        $status,
    );

    return $wpdb->get_results($sql, ARRAY_A);
}
```

`$wpdb->prepare()` binds values, not table names or `ORDER BY` expressions. Keep those structural
choices in fixed code or a narrow allowlist.

### Files, paths, redirects, and outbound HTTP

- Use `wp_handle_upload()` with an explicit MIME policy after a capability check; store uploads
  only in an approved location and never trust a client filename as an authorization decision.
- Canonicalize or otherwise constrain paths under an approved base before file effects. Account for
  traversal and symlinks in sensitive operations.
- Use `wp_safe_redirect()` or `wp_validate_redirect()` with an approved fallback. Validate URL
  schemes and destinations before rendering or redirecting.
- For outbound HTTP, allowlist intended hosts and schemes where appropriate, set timeouts, restrict
  redirects when they change the threat model, validate the response before use, and do not forward
  credentials to an unverified destination.
- Keep secrets out of options exposed to untrusted users, browser data, errors, and logs. Review
  Composer dependencies and lockfile changes as a supply-chain boundary.

## Pure logic + WordPress wrapper

```php
<?php
declare(strict_types=1);

namespace MyPlugin\Pure;

function calculate_discount(float $price, string $tier): float {
    $rates = ['bronze' => 0.05, 'silver' => 0.10, 'gold' => 0.15];
    return round($price * (1 - ($rates[$tier] ?? 0)), 2);
}
```

The wrapper owns WordPress I/O, authorization, and output context; the pure function receives only
validated values and returns data. Do not add custom `pipe`, `compose`, or security-wrapper
abstractions.

## Inter-plugin communication: hooks only

Use WordPress hooks for cross-plugin extension points, not `function_exists()` probes:

```php
<?php
do_action('ima_discourse_refresh_user_meta', $user_id);
$result = apply_filters('ima_membership_cancel_subscription', ['success' => true], $user_id, $sub_id);
```

`function_exists()` is acceptable only for internal guards within one plugin or PHP extension checks.
A hook does not grant permission; authorize the originating operation before firing sensitive effects.

## Quality gates

- [ ] Every privileged operation checks a resource-appropriate capability.
- [ ] AJAX state changes have nonce/CSRF protection; public handlers are intentional and constrained.
- [ ] REST routes use a meaningful `permission_callback`.
- [ ] Inputs are validated, then sanitized; output is encoded for its actual sink.
- [ ] Dynamic values use `$wpdb->prepare()`; identifiers and sort direction are allowlisted.
- [ ] Uploads, paths, URLs, redirects, outbound HTTP, secrets, and dependencies receive their own boundary controls.
- [ ] PHP source declares `strict_types=1`; pure rules remain separate from WordPress effects.

## Reference files

| File                                                        | Load when                                                                                        |
|-------------------------------------------------------------|--------------------------------------------------------------------------------------------------|
| [security-examples.md](references/security-examples.md)     | Cumulative privileged/public AJAX, REST, files, redirects, HTTP, data, and supply-chain examples |
| [testing-strategy.md](references/testing-strategy.md)       | Enforcement-point and sink-aware security tests                                                  |
| [fp-patterns.md](references/fp-patterns.md)                 | Pure logic and wrapper patterns                                                                  |
| [plugin-architecture.md](references/plugin-architecture.md) | Plugin structure decisions                                                                       |
