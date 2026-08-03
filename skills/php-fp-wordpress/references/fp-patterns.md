# Pure Logic + WordPress Wrapper Patterns

## Table of Contents
1. [Core Pattern](#core-pattern)
2. [Complete Example: Membership System](#complete-example-membership-system)
3. [Function Factory Pattern](#function-factory-pattern)
4. [Production Example: Email Validator](#production-example-email-validator)

---

## Core Pattern

**Separate pure business logic from WordPress integration.**

```
┌─────────────────────────────────────────┐
│     PURE BUSINESS LOGIC                 │
│  • Zero WordPress dependencies          │
│  • Deterministic, testable              │
│  • Returns data, no side effects        │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│     WORDPRESS WRAPPER                   │
│  • Security checks (capability, nonce)  │
│  • Input sanitization                   │
│  • Database operations                  │
│  • Output escaping                      │
└─────────────────────────────────────────┘
```

---

## Complete Example: Membership System

### Pure Business Logic (Zero WordPress Dependencies)

```php
<?php
namespace MyPlugin\BusinessLogic;

/**
 * Calculate membership discount
 * @pure - No side effects, deterministic, easily testable
 */
function calculate_discount(float $price, string $tier, int $days_member): float {
    $tier_multipliers = [
        'bronze' => 0.05,
        'silver' => 0.10,
        'gold' => 0.15,
        'platinum' => 0.20
    ];

    $base_discount = $tier_multipliers[$tier] ?? 0;
    $loyalty_bonus = min($days_member / 365 * 0.02, 0.05); // Max 5% loyalty
    $total_discount = min($base_discount + $loyalty_bonus, 0.25); // Max 25%

    return round($price * (1 - $total_discount), 2);
}

/**
 * Validate membership tier upgrade
 * @pure - Returns validation result, no database queries
 */
function validate_tier_upgrade(string $current_tier, string $new_tier): array {
    $tier_hierarchy = ['bronze', 'silver', 'gold', 'platinum'];
    $current_level = array_search($current_tier, $tier_hierarchy);
    $new_level = array_search($new_tier, $tier_hierarchy);

    if ($current_level === false || $new_level === false) {
        return ['valid' => false, 'error' => 'Invalid tier specified'];
    }

    if ($new_level <= $current_level) {
        return ['valid' => false, 'error' => 'Cannot downgrade or stay at same tier'];
    }

    return ['valid' => true, 'upgrade_levels' => $new_level - $current_level];
}

/**
 * Format membership data for display
 * @pure - Data transformation only
 */
function format_membership_display(array $membership): array {
    return [
        'tier' => ucfirst($membership['tier']),
        'expires' => date('F j, Y', strtotime($membership['expires'])),
        'days_remaining' => max(0, (strtotime($membership['expires']) - time()) / DAY_IN_SECONDS),
        'status' => strtotime($membership['expires']) > time() ? 'Active' : 'Expired'
    ];
}
```

### WordPress Integration Layer

```php
<?php
namespace MyPlugin;

use MyPlugin\BusinessLogic;

/**
 * WordPress filter hook - uses pure function
 */
add_filter('woocommerce_product_price', function($price, $product) {
    if (!is_user_logged_in()) {
        return $price;
    }

    $user_id = get_current_user_id();
    $tier = get_user_meta($user_id, 'membership_tier', true);
    $member_since = get_user_meta($user_id, 'member_since', true);
    $days_member = (time() - strtotime($member_since)) / DAY_IN_SECONDS;

    // Pure function call - easily testable
    return BusinessLogic\calculate_discount($price, $tier, $days_member);
}, 10, 2);

/**
 * WordPress action hook - handles side effects with security
 */
add_action('wp_ajax_upgrade_membership', function() {
    // 1. Security first - capability check
    if (!current_user_can('edit_user')) {
        wp_send_json_error('Insufficient permissions', 403);
    }

    // 2. Security first - nonce verification
    check_ajax_referer('upgrade_membership', 'nonce');

    // 3. Sanitize inputs
    $user_id = absint($_POST['user_id']);
    $new_tier = sanitize_text_field($_POST['new_tier']);

    // 4. Get current data (side effect)
    $current_tier = get_user_meta($user_id, 'membership_tier', true);

    // 5. Use pure function for validation
    $validation = BusinessLogic\validate_tier_upgrade($current_tier, $new_tier);

    if (!$validation['valid']) {
        wp_send_json_error($validation['error']);
    }

    // 6. Update database (side effect)
    update_user_meta($user_id, 'membership_tier', $new_tier);
    update_user_meta($user_id, 'tier_upgraded_at', current_time('mysql'));

    // 7. Send response (escaped)
    wp_send_json_success([
        'message' => 'Membership upgraded successfully',
        'new_tier' => esc_html($new_tier)
    ]);
});
```

---

## Function Factory Pattern

**Pre-compile configuration for performance.**

```php
<?php
namespace MyPlugin\Pure;

/**
 * Function factory: Pre-compile email validator
 * @pure - Configuration captured in closure
 */
function create_email_validator(
    array $bad_domains,
    array $typo_corrections
): callable {
    // Configuration pre-compiled once during factory creation
    return function (string $email) use ($bad_domains, $typo_corrections): array {
        return validate_email_domain($email, $bad_domains, $typo_corrections);
    };
}

/**
 * Validate email domain
 * @pure - Deterministic, no WordPress dependencies
 */
function validate_email_domain(
    string $email,
    array $bad_domains,
    array $typo_domains
): array {
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        return ['valid' => false, 'error' => 'Invalid email format'];
    }

    $domain = strtolower(substr($email, strpos($email, '@') + 1));

    if (in_array($domain, $bad_domains, true)) {
        return ['valid' => false, 'error' => 'Disposable email domain'];
    }

    if (isset($typo_domains[$domain])) {
        return [
            'valid' => false,
            'error' => 'Possible typo',
            'suggestion' => $typo_domains[$domain]
        ];
    }

    return ['valid' => true];
}
```

---

## Production Example: Email Validator

**From ima-espo plugin - 130 tests, <30ms execution.**

```php
<?php
use function MyPlugin\Pure\create_email_validator;

/**
 * WordPress wrapper class using function factory pattern
 */
class EmailValidatorCore {
    protected $validator = null;
    protected $bad_domains = [];
    protected $typo_domains = [];

    /**
     * Constructor: Pre-compile validator function once
     */
    public function __construct(array $bad_domains = [], array $typo_domains = []) {
        $this->bad_domains = $bad_domains;
        $this->typo_domains = $typo_domains;

        // Function factory: Configuration pre-compiled once
        // Performance: 2-5x speedup when validating multiple emails
        $this->validator = create_email_validator($bad_domains, $typo_domains);
    }

    /**
     * WordPress integration method
     */
    public function validate_email_domain(string $email) {
        // Security: Sanitize input
        $email = sanitize_email($email);

        // Use pre-compiled validator
        $result = ($this->validator)($email);

        // WordPress integration: Log failures in debug mode
        if (!$result['valid'] && defined('WP_DEBUG') && WP_DEBUG) {
            error_log(sprintf('[Plugin] Email validation failed: %s - %s', $email, $result['error']));
        }

        return $result;
    }

    /**
     * Allow customization via WordPress filters
     */
    public function get_bad_domains(): array {
        return apply_filters('my_plugin_bad_email_domains', $this->bad_domains);
    }
}
```

### Benefits
- **Performance**: 2-5x faster (configuration pre-compiled once)
- **Testability**: Pure functions fully testable without WordPress
- **Security**: Sanitization at wrapper boundary
- **Extensibility**: WordPress filters allow customization
