# Plugin Complexity Patterns

## Table of Contents
1. [Complexity Decision Guide](#complexity-decision-guide)
2. [Simple Plugin (<500 lines)](#simple-plugin-500-lines)
3. [Medium Plugin (500-2000 lines)](#medium-plugin-500-2000-lines)
4. [Complex Plugin (2000+ lines)](#complex-plugin-2000-lines)
5. [File Organization](#file-organization)

---

## Complexity Decision Guide

| Plugin Size | Lines | Pattern | When to Use |
|-------------|-------|---------|-------------|
| Simple | <500 | Namespaced functions | Single feature, few hooks |
| Medium | 500-2000 | Classes + pure functions | Multiple features, some state |
| Complex | 2000+ | DI Container + Services | Many features, shared dependencies |

**Rule**: Start simple, add complexity only when needed.

---

## Simple Plugin (<500 lines)

**Use**: Namespaced functions with direct hook usage.

```php
<?php
/**
 * Plugin Name: Simple Analytics Tracker
 */

namespace SimpleAnalytics;

// Pure function - testable without WordPress
function calculate_page_views(array $logs): int {
    return count(array_filter($logs, fn($log) => $log['type'] === 'page_view'));
}

function format_analytics_data(array $logs): array {
    return [
        'page_views' => calculate_page_views($logs),
        'unique_visitors' => count(array_unique(array_column($logs, 'visitor_id'))),
        'last_updated' => date('Y-m-d H:i:s')
    ];
}

// WordPress integration with security
add_action('wp_footer', function() {
    if (!current_user_can('edit_posts')) return;

    $logs = get_option('analytics_logs', []);
    $data = format_analytics_data($logs);

    echo '<div id="analytics">' . esc_html($data['page_views']) . ' page views</div>';
});

add_action('wp_ajax_get_analytics', function() {
    if (!current_user_can('manage_options')) {
        wp_send_json_error('Unauthorized', 403);
    }
    check_ajax_referer('analytics_nonce');

    $logs = get_option('analytics_logs', []);
    wp_send_json_success(format_analytics_data($logs));
});
```

---

## Medium Plugin (500-2000 lines)

**Use**: Classes for features + pure functions for logic.

```php
<?php
namespace MediumPlugin;

// Pure functions in separate file (includes/functions.php)
function calculate_shipping_cost(float $weight, string $zone): float {
    $rates = ['domestic' => 5.00, 'international' => 15.00];
    $base = $rates[$zone] ?? 10.00;
    return $base + ($weight * 0.50);
}

function validate_shipping_address(array $address): array {
    $errors = [];
    if (empty($address['street'])) $errors[] = 'Street required';
    if (empty($address['city'])) $errors[] = 'City required';
    if (empty($address['zip'])) $errors[] = 'ZIP required';

    return empty($errors)
        ? ['valid' => true]
        : ['valid' => false, 'errors' => $errors];
}

// Class for WordPress integration
class ShippingCalculator {
    public function __construct() {
        add_filter('woocommerce_shipping_cost', [$this, 'apply_calculation'], 10, 2);
        add_action('wp_ajax_validate_address', [$this, 'handle_validation']);
    }

    public function apply_calculation($cost, $package) {
        $weight = $package['contents_weight'];
        $zone = $package['destination']['country'] === 'US' ? 'domestic' : 'international';

        return calculate_shipping_cost($weight, $zone);
    }

    public function handle_validation() {
        if (!current_user_can('edit_shop_orders')) {
            wp_send_json_error('Unauthorized', 403);
        }
        check_ajax_referer('shipping_nonce');

        $address = array_map('sanitize_text_field', $_POST['address']);
        $result = validate_shipping_address($address);

        if ($result['valid']) {
            wp_send_json_success('Address valid');
        } else {
            wp_send_json_error($result['errors']);
        }
    }
}

// Initialize
new ShippingCalculator();
```

---

## Complex Plugin (2000+ lines)

**Use**: Dependency Injection Container + Service Architecture.

### DI Container

```php
<?php
namespace ComplexPlugin;

class Container {
    private array $services = [];
    private array $resolved = [];

    public function register(string $name, callable $resolver): void {
        $this->services[$name] = $resolver;
    }

    public function get(string $name) {
        if (!isset($this->resolved[$name])) {
            $this->resolved[$name] = ($this->services[$name])($this);
        }
        return $this->resolved[$name];
    }
}
```

### Service Classes

```php
<?php
namespace ComplexPlugin\Services;

class OrderService {
    private PaymentService $payment;

    public function __construct(PaymentService $payment) {
        $this->payment = $payment;
    }

    public function process(array $order_data): array {
        // Use pure function for calculation
        $total = \ComplexPlugin\BusinessLogic\calculate_order_total(
            $order_data['items'],
            $order_data['discounts']
        );

        // Side effect: process payment
        $payment_result = $this->payment->charge($total);

        return [
            'order_id' => uniqid('order_'),
            'total' => $total,
            'payment' => $payment_result
        ];
    }
}

class PaymentService {
    public function charge(float $amount): array {
        // Payment gateway integration
        return ['success' => true, 'transaction_id' => uniqid('txn_')];
    }
}
```

### Main Plugin Class

```php
<?php
namespace ComplexPlugin;

class Plugin {
    private Container $container;

    public function __construct() {
        $this->container = new Container();
        $this->setup_services();
        $this->init_hooks();
    }

    private function setup_services(): void {
        $this->container->register('payment', fn($c) =>
            new Services\PaymentService()
        );
        $this->container->register('order', fn($c) =>
            new Services\OrderService($c->get('payment'))
        );
    }

    private function init_hooks(): void {
        add_action('wp_ajax_process_order', [$this, 'handle_order']);
    }

    public function handle_order(): void {
        // Security
        if (!current_user_can('edit_shop_orders')) {
            wp_send_json_error('Unauthorized', 403);
        }
        check_ajax_referer('process_order');

        // Sanitize
        $order_data = [
            'items' => array_map(function($item) {
                return [
                    'id' => absint($item['id']),
                    'price' => floatval($item['price']),
                    'quantity' => absint($item['quantity'])
                ];
            }, $_POST['items']),
            'discounts' => []
        ];

        // Process via service
        $result = $this->container->get('order')->process($order_data);

        wp_send_json_success($result);
    }
}
```

---

## File Organization

### Simple Plugin
```
simple-plugin/
├── simple-plugin.php     # Everything in one file
└── readme.txt
```

### Medium Plugin
```
medium-plugin/
├── medium-plugin.php     # Bootstrap, hooks
├── includes/
│   ├── functions.php     # Pure business logic
│   └── class-feature.php # WordPress integration
└── tests/
    └── test-functions.php
```

### Complex Plugin
```
complex-plugin/
├── complex-plugin.php
├── includes/
│   ├── class-container.php
│   ├── class-plugin.php
│   └── functions.php          # Pure business logic
├── services/
│   ├── class-order-service.php
│   └── class-payment-service.php
├── admin/
│   ├── settings.php
│   └── ajax-handlers.php
└── tests/
    ├── unit/                  # Pure function tests
    └── integration/           # WordPress tests
```
