<?php
declare(strict_types=1);

namespace PhpFp\Examples;

/**
 * Pure function examples demonstrating PHP FP patterns
 *
 * Key principles:
 * - Strict types enabled
 * - Pure functions (no side effects, deterministic)
 * - Native PHP array functions over loops
 * - Explicit dependencies via parameters
 * - Immutable data handling
 */

// ───────────────────────────────────────────────────────
// Basic Pure Functions
// ───────────────────────────────────────────────────────

/**
 * Calculate user discount based on tier and loyalty
 * @pure - No side effects, deterministic
 */
function calculateDiscount(float $price, string $tier, int $daysAsMember): float
{
    $tierMultipliers = [
        'bronze' => 0.05,
        'silver' => 0.10,
        'gold' => 0.15,
        'platinum' => 0.20
    ];

    $baseDiscount = $tierMultipliers[$tier] ?? 0.0;
    $loyaltyBonus = min($daysAsMember / 365 * 0.02, 0.05); // Max 5%
    $totalDiscount = min($baseDiscount + $loyaltyBonus, 0.25); // Max 25%

    return round($price * (1 - $totalDiscount), 2);
}

/**
 * Validate email format
 * @pure - Returns validation result without side effects
 */
function validateEmail(string $email): array
{
    $isValid = filter_var($email, FILTER_VALIDATE_EMAIL) !== false;

    return [
        'valid' => $isValid,
        'error' => $isValid ? null : 'Invalid email format'
    ];
}

/**
 * Format user display name
 * @pure - String transformation only
 */
function formatDisplayName(array $user): string
{
    $firstName = trim($user['first_name'] ?? '');
    $lastName = trim($user['last_name'] ?? '');

    if ($firstName && $lastName) {
        return "{$firstName} {$lastName}";
    }

    return $firstName ?: $lastName ?: 'Anonymous';
}

// ───────────────────────────────────────────────────────
// Configuration Pre-Compilation (Performance Pattern)
// ───────────────────────────────────────────────────────

/**
 * Pre-compile validation rules to avoid O(n²) complexity
 *
 * ❌ BAD: Configuration inside loop
 * foreach ($users as $user) {
 *     $rules = ['email' => 'required', 'age' => 'numeric'];  // Created N times!
 *     validate($user, $rules);
 * }
 *
 * ✅ GOOD: Pre-compile configuration
 * $validator = createValidator(['email' => 'required', 'age' => 'numeric']);
 * foreach ($users as $user) {
 *     $validator($user);  // Uses pre-compiled rules
 * }
 */
function createValidator(array $rules): callable
{
    // Pre-compile rules once (expensive operation)
    $compiledRules = array_map(function($rule) {
        return match($rule) {
            'required' => fn($value) => !empty($value),
            'numeric' => fn($value) => is_numeric($value),
            'email' => fn($value) => filter_var($value, FILTER_VALIDATE_EMAIL) !== false,
            default => fn($value) => true
        };
    }, $rules);

    // Return validator function that uses pre-compiled rules
    return function(array $data) use ($compiledRules): array {
        $errors = [];

        foreach ($compiledRules as $field => $validator) {
            $value = $data[$field] ?? null;
            if (!$validator($value)) {
                $errors[$field] = "Validation failed for {$field}";
            }
        }

        return [
            'valid' => empty($errors),
            'errors' => $errors
        ];
    };
}

/**
 * Pre-compile field transformer configuration
 */
function createFieldTransformer(array $fieldConfig): callable
{
    // Pre-compile transformation functions
    $transformers = array_map(function($transform) {
        return match($transform) {
            'trim' => fn($v) => trim($v),
            'lowercase' => fn($v) => strtolower($v),
            'uppercase' => fn($v) => strtoupper($v),
            'capitalize' => fn($v) => ucfirst($v),
            default => fn($v) => $v
        };
    }, $fieldConfig);

    return function(array $data) use ($transformers): array {
        $transformed = $data;

        foreach ($transformers as $field => $transform) {
            if (isset($transformed[$field])) {
                $transformed[$field] = $transform($transformed[$field]);
            }
        }

        return $transformed;
    };
}

// ───────────────────────────────────────────────────────
// Composition with Native PHP Functions
// ───────────────────────────────────────────────────────

/**
 * Process users with native array functions
 * Demonstrates composition without pipe/compose utilities
 */
function processActiveUsers(array $users, int $limit = 10): array
{
    return array_slice(
        array_map(
            fn($user) => [
                ...$user,
                'display_name' => formatDisplayName($user),
                'account_age' => calculateAccountAge($user['created_at'])
            ],
            array_filter(
                $users,
                fn($user) => $user['active'] ?? false
            )
        ),
        0,
        $limit
    );
}

/**
 * Calculate account age in days
 * @pure - Date calculation only
 */
function calculateAccountAge(string $createdAt): int
{
    $created = strtotime($createdAt);
    $now = time();

    return (int) (($now - $created) / (60 * 60 * 24));
}

/**
 * Group items by field value
 * @pure - Array transformation
 */
function groupBy(array $items, string $field): array
{
    return array_reduce(
        $items,
        function($groups, $item) use ($field) {
            $key = $item[$field] ?? 'unknown';
            $groups[$key][] = $item;
            return $groups;
        },
        []
    );
}

// ───────────────────────────────────────────────────────
// Immutability Patterns (PHP-Specific)
// ───────────────────────────────────────────────────────

/**
 * Update user without mutation
 * PHP arrays are copy-on-write, but we make it explicit
 */
function updateUser(array $user, array $updates): array
{
    // Create new array instead of mutating
    return array_merge($user, $updates, [
        'updated_at' => date('Y-m-d H:i:s')
    ]);
}

/**
 * Add item to collection immutably
 */
function addItem(array $collection, array $item): array
{
    // array_merge creates new array
    return array_merge($collection, [$item]);
}

/**
 * Remove item from collection immutably
 */
function removeItem(array $collection, string $id): array
{
    // array_filter creates new array
    return array_values(
        array_filter(
            $collection,
            fn($item) => $item['id'] !== $id
        )
    );
}

// ───────────────────────────────────────────────────────
// Result Type Pattern (Error Handling)
// ───────────────────────────────────────────────────────

/**
 * Parse and validate user data
 * @pure - Returns result, throws no exceptions
 */
function parseUserData(array $data): array
{
    // Validate required fields
    $requiredFields = ['email', 'name'];
    $missingFields = array_filter(
        $requiredFields,
        fn($field) => empty($data[$field])
    );

    if (!empty($missingFields)) {
        return [
            'success' => false,
            'error' => 'Missing required fields: ' . implode(', ', $missingFields),
            'data' => null
        ];
    }

    // Validate email
    $emailValidation = validateEmail($data['email']);
    if (!$emailValidation['valid']) {
        return [
            'success' => false,
            'error' => $emailValidation['error'],
            'data' => null
        ];
    }

    // Success - return parsed data
    return [
        'success' => true,
        'error' => null,
        'data' => [
            'email' => strtolower(trim($data['email'])),
            'name' => trim($data['name']),
            'age' => isset($data['age']) ? (int) $data['age'] : null
        ]
    ];
}

/**
 * Calculate shipping cost with error handling
 * @pure - Returns result type
 */
function calculateShipping(float $weight, string $zone): array
{
    $validZones = ['domestic', 'international', 'express'];

    if (!in_array($zone, $validZones)) {
        return [
            'success' => false,
            'error' => "Invalid zone: {$zone}",
            'data' => null
        ];
    }

    if ($weight <= 0) {
        return [
            'success' => false,
            'error' => 'Weight must be positive',
            'data' => null
        ];
    }

    $rates = [
        'domestic' => 5.00,
        'international' => 15.00,
        'express' => 25.00
    ];

    $cost = $rates[$zone] + ($weight * 0.50);

    return [
        'success' => true,
        'error' => null,
        'data' => round($cost, 2)
    ];
}

// ───────────────────────────────────────────────────────
// Dependency Injection Examples
// ───────────────────────────────────────────────────────

/**
 * Process order with injected dependencies
 * @pure - All dependencies passed as parameters
 */
function processOrder(
    array $order,
    callable $calculateTax,
    callable $calculateShipping,
    callable $applyDiscount
): array {
    $subtotal = array_sum(array_column($order['items'], 'price'));
    $tax = $calculateTax($subtotal, $order['tax_zone']);
    $shipping = $calculateShipping($order['weight'], $order['shipping_zone']);
    $discount = $applyDiscount($subtotal, $order['discount_code'] ?? null);

    return [
        'subtotal' => $subtotal,
        'tax' => $tax,
        'shipping' => $shipping,
        'discount' => $discount,
        'total' => $subtotal + $tax + $shipping - $discount
    ];
}

/**
 * Calculate tax based on zone
 * @pure - Tax calculation only
 */
function calculateTax(float $amount, string $zone): float
{
    $rates = [
        'CA' => 0.0725,
        'NY' => 0.08875,
        'TX' => 0.0625
    ];

    $rate = $rates[$zone] ?? 0.0;
    return round($amount * $rate, 2);
}

/**
 * Calculate shipping cost
 * @pure - Shipping calculation only
 */
function calculateShippingCost(float $weight, string $zone): float
{
    $baseRates = [
        'domestic' => 5.00,
        'international' => 15.00
    ];

    $base = $baseRates[$zone] ?? 10.00;
    return round($base + ($weight * 0.50), 2);
}

/**
 * Apply discount code
 * @pure - Discount calculation only
 */
function applyDiscountCode(float $amount, ?string $code): float
{
    $discounts = [
        'SAVE10' => 0.10,
        'SAVE20' => 0.20,
        'SAVE30' => 0.30
    ];

    $rate = $discounts[$code ?? ''] ?? 0.0;
    return round($amount * $rate, 2);
}
