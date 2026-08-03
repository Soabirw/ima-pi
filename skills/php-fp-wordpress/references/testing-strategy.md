# WordPress Testing Strategy

## Table of Contents
1. [Testing Philosophy](#testing-philosophy)
2. [Unit Tests (Pure Functions)](#unit-tests-pure-functions)
3. [Integration Tests (WordPress)](#integration-tests-wordpress)
4. [Minimal Mock Strategy](#minimal-mock-strategy)
5. [Security Testing](#security-testing)
6. [Test Organization](#test-organization)

---

## Testing Philosophy

**Pure functions enable fast, comprehensive testing without WordPress.**

| Test Type | Target | Speed | WordPress Needed |
|-----------|--------|-------|------------------|
| Unit | Pure functions | <1ms each | No |
| Integration | WordPress wrappers | ~10ms each | Mocked |
| End-to-end | Full plugin | ~100ms each | Yes |

**Goal**: 95%+ coverage via unit tests, minimal integration tests.

---

## Unit Tests (Pure Functions)

**Zero WordPress dependencies = instant execution.**

```php
<?php
use PHPUnit\Framework\TestCase;
use MyPlugin\BusinessLogic;

class DiscountCalculatorTest extends TestCase {
    /**
     * @dataProvider discountProvider
     */
    public function test_calculate_discount($price, $tier, $days, $expected) {
        $result = BusinessLogic\calculate_discount($price, $tier, $days);
        $this->assertEquals($expected, $result);
    }

    public function discountProvider(): array {
        return [
            'bronze_new_member' => [100.00, 'bronze', 30, 95.00],
            'gold_5year_member' => [100.00, 'gold', 1825, 80.00],
            'invalid_tier' => [100.00, 'invalid', 365, 100.00],
            'platinum_max_discount' => [100.00, 'platinum', 3650, 75.00],
        ];
    }

    public function test_validate_tier_upgrade_valid() {
        $result = BusinessLogic\validate_tier_upgrade('bronze', 'gold');

        $this->assertTrue($result['valid']);
        $this->assertEquals(2, $result['upgrade_levels']);
    }

    public function test_validate_tier_upgrade_invalid_downgrade() {
        $result = BusinessLogic\validate_tier_upgrade('gold', 'bronze');

        $this->assertFalse($result['valid']);
        $this->assertStringContainsString('Cannot downgrade', $result['error']);
    }
}
```

---

## Integration Tests (WordPress)

**Use Brain\Monkey for minimal WordPress mocking.**

```php
<?php
use PHPUnit\Framework\TestCase;
use Brain\Monkey;
use Brain\Monkey\Functions;

class MembershipIntegrationTest extends TestCase {
    protected function setUp(): void {
        parent::setUp();
        Monkey\setUp();
    }

    protected function tearDown(): void {
        Monkey\tearDown();
        parent::tearDown();
    }

    public function test_upgrade_membership_with_permission() {
        // Mock WordPress functions
        Functions\when('current_user_can')->justReturn(true);
        Functions\when('check_ajax_referer')->justReturn(true);
        Functions\when('get_user_meta')->justReturn('silver');
        Functions\expect('update_user_meta')->twice();
        Functions\expect('wp_send_json_success')->once();

        $_POST = [
            'user_id' => '1',
            'new_tier' => 'gold',
            'nonce' => 'valid_nonce'
        ];

        // Call the handler
        do_action('wp_ajax_upgrade_membership');
    }

    public function test_upgrade_membership_without_permission() {
        Functions\when('current_user_can')->justReturn(false);
        Functions\expect('wp_send_json_error')->once()->with('Insufficient permissions', 403);

        do_action('wp_ajax_upgrade_membership');
    }
}
```

---

## Minimal Mock Strategy

**Bootstrap file with minimal WordPress function definitions.**

```php
<?php
// tests/bootstrap.php

// Autoload pure functions (no WordPress)
require_once __DIR__ . '/../includes/functions.php';

// Minimal WordPress mocks (only when needed)
if (!function_exists('sanitize_email')) {
    function sanitize_email(string $email): string {
        return strtolower(trim($email));
    }
}

if (!function_exists('sanitize_text_field')) {
    function sanitize_text_field(string $str): string {
        return trim(strip_tags($str));
    }
}

if (!function_exists('absint')) {
    function absint($val): int {
        return abs((int) $val);
    }
}

if (!function_exists('apply_filters')) {
    function apply_filters(string $hook, $value) {
        return $value; // No filters in tests
    }
}

if (!defined('WP_DEBUG')) {
    define('WP_DEBUG', false);
}
```

---

## Security Testing

**Dedicated tests for security edge cases.**

```php
<?php
class SecurityTest extends TestCase {
    /**
     * @dataProvider xss_vectors
     */
    public function test_xss_safety(string $malicious_input) {
        $result = validate_email_domain(
            $malicious_input,
            ['<script>alert(1)</script>.com'],
            []
        );

        $this->assertIsArray($result);
        $this->assertFalse($result['valid']);
    }

    public function xss_vectors(): array {
        return [
            'script_in_user' => ['<script>alert(1)</script>@example.com'],
            'script_in_domain' => ['user@<script>alert(1)</script>.com'],
            'javascript_protocol' => ['javascript:alert(1)@example.com'],
            'data_protocol' => ['data:text/html,<script>alert(1)</script>@example.com'],
        ];
    }

    /**
     * @dataProvider sql_injection_vectors
     */
    public function test_sql_injection_safety(string $malicious_input) {
        // Pure functions should handle malicious input safely
        $result = format_user_data(['name' => $malicious_input]);

        // Should not throw, should sanitize
        $this->assertIsArray($result);
    }

    public function sql_injection_vectors(): array {
        return [
            'basic_injection' => ["'; DROP TABLE users; --"],
            'union_select' => ["' UNION SELECT * FROM users --"],
            'boolean_based' => ["' OR '1'='1"],
        ];
    }
}
```

---

## Test Organization

```
tests/
├── bootstrap.php                    # Minimal WordPress mocks
├── phpunit.xml                      # Configuration
├── unit/                            # Pure function tests (FAST)
│   ├── DiscountCalculatorTest.php
│   ├── TierValidationTest.php
│   └── FormattingTest.php
├── integration/                     # WordPress wrapper tests
│   ├── MembershipHandlerTest.php
│   └── ShortcodeTest.php
└── security/                        # Security-focused tests
    ├── XSSTest.php
    └── SQLInjectionTest.php
```

### phpunit.xml

```xml
<?xml version="1.0"?>
<phpunit bootstrap="bootstrap.php">
    <testsuites>
        <testsuite name="unit">
            <directory>unit</directory>
        </testsuite>
        <testsuite name="integration">
            <directory>integration</directory>
        </testsuite>
        <testsuite name="security">
            <directory>security</directory>
        </testsuite>
    </testsuites>
</phpunit>
```

### Production Results (ima-espo plugin)
- **130 tests, 236 assertions**
- **<30ms total execution**
- **100% pure function coverage**
- **Zero WordPress test database needed**
