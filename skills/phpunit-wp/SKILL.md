---
name: "phpunit-wp"
description: "PHPUnit testing for WordPress plugins with FP principles - fast unit tests, minimal mocks, environment-aware setup. Triggers on: phpunit, unit test, test wordpress, composer test, test bootstrap, mock wordpress."
---

# PHPUnit for WordPress Plugins

## Core Philosophy

Test pure functions, not WordPress integration.

| Layer | Approach | Speed |
|-------|----------|-------|
| Pure business logic | Unit tests, no WordPress | <100ms |
| WordPress wrappers | Integration tests, full WP env | Seconds |
| Mocks | Only what pure functions actually use | Minimal |

References: `../php-fp/SKILL.md`, `../php-fp-wordpress/SKILL.md`

---

## THE TWO CRITICAL SETUP BUGS

### Bug #1: Silent PHPUnit Execution

**Symptom**: `composer test` produces zero output

**Cause**: PHPUnit 9.x requires `--testdox` for visible output

```json
{
    "scripts": {
        "test": "phpunit --colors=always --testdox",
        "test:coverage": "phpunit --coverage-html coverage"
    }
}
```

### Bug #2: Autoload Files Kill Tests

**Symptom**: Tests hang or exit silently

**Cause**: Composer autoload runs BEFORE bootstrap defines `ABSPATH`

```
1. bootstrap.php requires vendor/autoload.php
2. Composer loads autoload "files" immediately
3. helpers.php: if (!defined('ABSPATH')) { exit; }
4. ABSPATH not yet defined → silent exit → PHPUnit never starts
```

Fix: Remove `autoload.files`, load helpers manually in bootstrap AFTER defining `ABSPATH`.

```json
{
    "autoload-dev": {
        "psr-4": { "MyPlugin\\Tests\\": "tests/" }
    }
}
```

---

## Environment Setup

Use pure PHPUnit for deterministic business logic. When WordPress integration is necessary, use the supported DDEV project environment; Git commands work in a normal terminal. Never point test configuration at a production database.

```bash
# Run pure PHPUnit tests
composer test

# Run WordPress-aware commands only from a checked DDEV project
 ddev status
ddev wp plugin list
```

Check `.ddev/config.yaml` and `ddev describe` before environment-dependent work. See `../wp-ddev/SKILL.md` for the supported local WordPress path.

### Quick Diagnosis

```bash
php tests/bootstrap.php          # Should print "Bootstrap Loaded"
ls -la vendor/bin/phpunit        # Verify phpunit installed
cat composer.json | grep -A 3 scripts
cat composer.json | grep -A 5 autoload
```

---

## Working Templates

### composer.json

```json
{
    "name": "ima-network/my-plugin",
    "type": "wordpress-plugin",
    "license": "GPL-2.0-or-later",
    "require": { "php": ">=7.4" },
    "require-dev": { "phpunit/phpunit": "^9.5" },
    "autoload-dev": {
        "psr-4": { "MyPlugin\\Tests\\": "tests/" }
    },
    "scripts": {
        "test": "phpunit --colors=always --testdox",
        "test:coverage": "phpunit --coverage-html coverage"
    }
}
```

### phpunit.xml

```xml
<?xml version="1.0" encoding="UTF-8"?>
<phpunit xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:noNamespaceSchemaLocation="https://schema.phpunit.de/9.5/phpunit.xsd"
         bootstrap="tests/bootstrap.php"
         colors="true"
         verbose="true"
         stopOnFailure="false">
    <testsuites>
        <testsuite name="Unit">
            <directory>tests/Unit</directory>
        </testsuite>
    </testsuites>
    <coverage>
        <include>
            <directory suffix=".php">includes</directory>
        </include>
        <exclude>
            <directory>tests</directory>
            <directory>templates</directory>
        </exclude>
    </coverage>
    <php>
        <ini name="error_reporting" value="E_ALL"/>
        <ini name="display_errors" value="true"/>
    </php>
</phpunit>
```

### tests/bootstrap.php

```php
<?php
declare(strict_types=1);

// 1. Autoloader first (no autoload.files — removed!)
require_once dirname(__DIR__) . '/vendor/autoload.php';

// 2. Define ABSPATH before loading any plugin files
if (!defined('ABSPATH')) {
    define('ABSPATH', '/tmp/wordpress/');
}

// 3. Plugin constants
if (!defined('MY_PLUGIN_PATH')) {
    define('MY_PLUGIN_PATH', dirname(__DIR__) . '/');
}

// 4. Load helpers manually (AFTER ABSPATH)
require_once MY_PLUGIN_PATH . 'includes/helpers/url-validation.php';
require_once MY_PLUGIN_PATH . 'includes/helpers/share-urls.php';

// 5. Minimal WP function mocks
if (!function_exists('home_url')) {
    function home_url(string $path = ''): string {
        return 'https://example.com' . $path;
    }
}
if (!function_exists('sanitize_text_field')) {
    function sanitize_text_field(string $str): string {
        return trim(str_replace(["\r", "\n"], '', strip_tags($str)));
    }
}
if (!function_exists('esc_html')) {
    function esc_html(string $text): string {
        return htmlspecialchars($text, ENT_QUOTES, 'UTF-8');
    }
}

echo "My Plugin Test Bootstrap Loaded\n";
```

---

## What to Test

### DO: Pure Business Logic

```php
<?php
// Pure function — zero WordPress dependencies, perfect for unit testing
function my_plugin_validate_email_pure(string $email): array {
    if (empty($email)) return ['valid' => false, 'error' => 'Email required'];
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) return ['valid' => false, 'error' => 'Invalid email format'];

    $disposable = ['tempmail.com', 'throwaway.email'];
    $domain = substr(strrchr($email, '@'), 1);
    if (in_array($domain, $disposable)) return ['valid' => false, 'error' => 'Disposable email not allowed'];

    return ['valid' => true];
}
```

```php
<?php
class ValidationTest extends TestCase {
    public function test_empty_email_returns_error() {
        $result = my_plugin_validate_email_pure('');
        $this->assertFalse($result['valid']);
        $this->assertEquals('Email required', $result['error']);
    }

    public function test_valid_email_passes() {
        $result = my_plugin_validate_email_pure('user@example.com');
        $this->assertTrue($result['valid']);
    }

    public function test_function_is_deterministic() {
        $this->assertEquals(
            my_plugin_validate_email_pure('test@example.com'),
            my_plugin_validate_email_pure('test@example.com')
        );
    }
}
```

### DON'T: WordPress Integration Wrappers

```php
<?php
// Skip unit testing this — it's 100% WordPress integration
function my_plugin_ajax_validate_email() {
    check_ajax_referer('validate_email_nonce', 'nonce');
    if (!current_user_can('read')) wp_send_json_error('Unauthorized', 403);
    wp_send_json_success(my_plugin_validate_email_pure(sanitize_email($_POST['email'])));
}
```

Unit test the pure function. Integration test the AJAX handler with a real WP environment.

---

## Mocking Rules

Mock only what pure functions actually call. Common mocks for pure functions:

```php
<?php
if (!function_exists('wp_parse_args')) {
    function wp_parse_args($args, $defaults = []): array {
        if (is_string($args)) { parse_str($args, $args); }
        return array_merge($defaults, (array) $args);
    }
}
if (!function_exists('sanitize_email')) {
    function sanitize_email(string $email): string { return strtolower(trim($email)); }
}
if (!function_exists('esc_url_raw')) {
    function esc_url_raw(string $url): string { return filter_var($url, FILTER_SANITIZE_URL) ?: ''; }
}
if (!function_exists('wp_parse_url')) {
    function wp_parse_url(string $url, int $component = -1) {
        return $component === -1 ? parse_url($url) : parse_url($url, $component);
    }
}
```

---

## Test Organization

```
tests/
├── Unit/               # Pure functions — no WP, <100ms, run every commit
│   ├── ValidationTest.php
│   ├── CalculationTest.php
│   └── FormatterTest.php
└── Integration/        # Full WP env — run before releases
    ├── AjaxHandlerTest.php
    └── DatabaseTest.php
```

---

## Patterns by Function Type

```php
// Calculations — assert exact values
$this->assertEquals(90.0, calculate_discount_pure(100.0, 0.10));

// Validation — assert result structure
$result = validate_age_pure(15);
$this->assertFalse($result['valid']);
$this->assertArrayHasKey('error', $result);

// Transformations — assert output shape
$this->assertEquals('(555) 123-4567', format_phone_pure('5551234567'));
$this->assertEquals('(555) 123-4567', format_phone_pure('555-123-4567'));

// Performance — pure functions enable this for free
$start = microtime(true);
for ($i = 0; $i < 10000; $i++) { my_plugin_validate_email_pure('user@example.com'); }
$this->assertLessThan(0.1, microtime(true) - $start);
```

---

## Anti-Patterns

| Avoid | Do Instead |
|-------|-----------|
| Reflection to test private methods | Extract as testable pure function |
| Test internal variable values | Test public behavior/output |
| Mock 20+ WordPress functions | Redesign so pure function needs <5 mocks |

---

## Quality Gates

- [ ] `composer test` produces visible output
- [ ] Bootstrap prints confirmation message
- [ ] Pure function tests run in <100ms
- [ ] No `autoload.files` in composer.json
- [ ] Pure business logic separated from WP wrappers
- [ ] Mock count <10 functions
- [ ] No flaky assertions

---

## Reference Plugins

```bash
cd wp-content/plugins/ima-forms && composer test       # Gold standard
cd wp-content/plugins/ima-shortcodes && composer test  # Recently fixed
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| No output from `composer test` | Missing `--testdox` | Add `--testdox` to scripts |
| Hang/silent exit | `autoload.files` loads before ABSPATH | Remove files array, load manually in bootstrap |
| "Class not found" | Bad PSR-4 mapping | Check `autoload-dev` in composer.json, run `composer dump-autoload` |

---

## References

- `../php-fp/SKILL.md` - Core FP principles
- `../php-fp-wordpress/SKILL.md` - WordPress security + FP
- `../wp-ddev/SKILL.md` - Supported DDEV WordPress environment
- https://phpunit.de/documentation.html
