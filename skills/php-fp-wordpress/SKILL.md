---
name: "php-fp-wordpress"
description: "Security-first WordPress development with PHP FP principles - pure business logic + WordPress integration"
---

# PHP FP - WordPress

Security-first WordPress development: pure functions for business logic, WordPress wrappers with mandatory security.

**Foundation**: `../php-fp/SKILL.md` for PHP FP core.

## The 5 Non-Negotiable Security Practices

Evidence: 7,966 vulnerabilities (2024) — these prevent 95%+ of WordPress plugin vulnerabilities.

| Practice | Prevents | Rule |
|----------|----------|------|
| **Capability Checks** | 53% of XSS | `current_user_can()` before ANY privileged operation |
| **Nonce Verification** | 15-17% CSRF | `wp_verify_nonce()` on ALL form/AJAX submissions |
| **Input Sanitization** | Injection | Sanitize ALL user input by type |
| **Output Escaping** | XSS | Escape ALL output by context |
| **Prepared Statements** | SQL injection | `$wpdb->prepare()` for ALL queries |

### Security Function Reference

**Sanitization (Input)**:

| Function | Use For |
|----------|---------|
| `sanitize_text_field()` | Plain text |
| `sanitize_email()` | Email addresses |
| `absint()` | Positive integers |
| `wp_kses_post()` | HTML content |
| `esc_url_raw()` | URLs (storage) |

**Escaping (Output)**:

| Function | Context |
|----------|---------|
| `esc_html()` | HTML body |
| `esc_attr()` | HTML attributes |
| `esc_url()` | URLs in href/src |
| `wp_json_encode()` | JavaScript data |

### Minimal Security Pattern

```php
<?php
add_action('wp_ajax_my_action', function() {
    if (!current_user_can('edit_posts')) {
        wp_send_json_error('Unauthorized', 403);
    }

    check_ajax_referer('my_action_nonce', 'nonce');

    $id   = absint($_POST['id']);
    $name = sanitize_text_field($_POST['name']);

    global $wpdb;
    $result = $wpdb->get_row($wpdb->prepare(
        "SELECT * FROM {$wpdb->prefix}my_table WHERE id = %d",
        $id
    ));

    wp_send_json_success(['name' => esc_html($result->name)]);
});
```

## Pure Logic + WordPress Wrapper Pattern

```php
<?php
// PURE: zero WordPress dependencies, fully testable
namespace MyPlugin\Pure;

function calculate_discount(float $price, string $tier): float {
    $rates = ['bronze' => 0.05, 'silver' => 0.10, 'gold' => 0.15];
    return round($price * (1 - ($rates[$tier] ?? 0)), 2);
}

// WRAPPER: WordPress integration with security
namespace MyPlugin;

add_filter('product_price', function($price) {
    if (!is_user_logged_in()) return $price;
    $tier = get_user_meta(get_current_user_id(), 'tier', true);
    return Pure\calculate_discount($price, $tier);
});
```

## Inter-Plugin Communication: Hooks Only

ALL cross-plugin calls use WordPress hooks. NEVER `function_exists()`.

Hooks are safe no-ops — if nobody listens, nothing happens. `function_exists()` is tight coupling disguised as loose coupling.

```php
<?php
// BAD — tight coupling, breaks silently on rename
if (function_exists('ima_discourse_refresh_user_meta')) {
    ima_discourse_refresh_user_meta($user_id);
}

// GOOD — fire-and-forget side effect
do_action('ima_discourse_refresh_user_meta', $user_id);

// GOOD — transform with safe default
$result = apply_filters('ima_membership_cancel_subscription', ['success' => true], $user_id, $sub_id);
```

- **Actions** (`do_action`): side effects — "something happened, react if you care"
- **Filters** (`apply_filters`): data transformation — chained composition with default return

```php
<?php
// Handler registers itself — callers never crash if plugin is absent
add_action('ima_discourse_refresh_user_meta', 'ima_discourse_refresh_user_meta', 10, 1);
```

`function_exists()` is acceptable only for internal guards within a single plugin, or checking PHP extensions (`function_exists('sodium_crypto_secretbox')`).

## Plugin Complexity Guide

| Size | Lines | Pattern |
|------|-------|---------|
| Simple | <500 | Namespaced functions |
| Medium | 500-2000 | Classes + pure functions |
| Complex | 2000+ | DI Container + Services |

Start simple, add complexity only when needed.

## File Organization

```
my-plugin/
├── my-plugin.php              # Bootstrap
├── includes/
│   └── functions.php          # Pure business logic
├── admin/
│   └── ajax-handlers.php      # WordPress integration
└── tests/
    ├── unit/                  # Pure function tests (fast)
    └── integration/           # WordPress tests
```

## Quality Gates

- [ ] Capability checks on all privileged operations
- [ ] Nonces on all form/AJAX submissions
- [ ] Input sanitized by type
- [ ] Output escaped by context
- [ ] SQL uses `$wpdb->prepare()`
- [ ] File uploads use `wp_handle_upload()`
- [ ] No hardcoded credentials
- [ ] Cross-plugin calls use hooks, not `function_exists()`

## Reference Files

| File | Load When |
|------|-----------|
| `references/security-examples.md` | Detailed security patterns, vulnerable vs. safe comparisons |
| `references/fp-patterns.md` | Pure logic + wrapper pattern, function factories, production examples |
| `references/plugin-architecture.md` | Plugin structure decisions, DI container implementation |
| `references/testing-strategy.md` | Unit/integration tests, security tests, minimal mock bootstrap |

---

Evidence: 7,966 WordPress vulnerabilities (2024), WordPress Core Team standards, Wordfence/Patchstack research.
