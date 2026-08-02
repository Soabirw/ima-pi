# PHP FP Core Principles

Deep-dive into functional programming philosophy adapted for PHP 8.1+.

## The Three Laws

### 1. Purity: Same Input, Same Output

```php
<?php
declare(strict_types=1);

// PURE: Deterministic, no side effects
function calculateTax(float $amount, float $rate): float {
    return $amount * $rate;
}

// IMPURE: Uses external state
function calculateTax(float $amount): float {
    global $taxRate; // Hidden dependency
    file_put_contents('/tmp/log', $amount); // Side effect
    return $amount * $taxRate;
}
```

**Test**: Can you call this function 1000 times with the same input and always get the same result without affecting anything else?

### 2. Immutability: Never Mutate, Always Return New

```php
<?php
declare(strict_types=1);

// MUTATES: Modifies input
function addTimestamp(array &$record): void {
    $record['created_at'] = time();
}

// IMMUTABLE: Returns new array
function addTimestamp(array $record): array {
    return [...$record, 'created_at' => time()];
}

// IMMUTABLE: Collection operations
function removeInactive(array $users): array {
    return array_values(array_filter($users, fn($u) => $u['active']));
}

function updateById(array $items, int $id, array $updates): array {
    return array_map(
        fn($item) => $item['id'] === $id ? [...$item, ...$updates] : $item,
        $items
    );
}
```

### 3. Composition: Small Functions, Combined Simply

```php
<?php
declare(strict_types=1);

// Build complex from simple - NO pipe() utility needed
function processOrder(array $order): array {
    $validated = validateOrder($order);
    if (!$validated['success']) return $validated;

    $calculated = calculateTotals($validated['data']);
    if (!$calculated['success']) return $calculated;

    return applyDiscounts($calculated['data']);
}

// Each function is small, pure, testable
function validateOrder(array $order): array {
    if (empty($order['items'])) {
        return ['success' => false, 'error' => 'No items'];
    }
    return ['success' => true, 'data' => $order];
}
```

## PHP-Native Patterns

### Closures as First-Class Functions

```php
<?php
declare(strict_types=1);

// Factory returns configured closure
function createValidator(int $minLength): Closure {
    return fn(string $value): bool => strlen($value) >= $minLength;
}

$validateName = createValidator(2);
$validateName('Jo'); // true

// Compose validators
function validateAll(array $validators): Closure {
    return fn($value): bool => array_reduce(
        $validators,
        fn(bool $valid, callable $v) => $valid && $v($value),
        true
    );
}

$validateUsername = validateAll([
    fn($v) => is_string($v),
    fn($v) => strlen($v) >= 3,
    fn($v) => strlen($v) <= 20,
    fn($v) => preg_match('/^[a-z0-9_]+$/', $v) === 1,
]);
```

### Match Expressions for Branching

```php
<?php
declare(strict_types=1);

// Pure branching with match
function getStatusMessage(string $status): string {
    return match($status) {
        'pending' => 'Awaiting review',
        'approved' => 'Ready to proceed',
        'rejected' => 'Request denied',
        'cancelled' => 'User cancelled',
        default => 'Unknown status',
    };
}

// Type-safe dispatch
function processEvent(array $event): array {
    return match($event['type']) {
        'user.created' => handleUserCreated($event['data']),
        'user.updated' => handleUserUpdated($event['data']),
        'user.deleted' => handleUserDeleted($event['data']),
        default => ['handled' => false, 'reason' => 'Unknown event'],
    };
}
```

### Readonly Properties for Immutable Objects

```php
<?php
declare(strict_types=1);

// Value objects with readonly (PHP 8.1+)
readonly class Money {
    public function __construct(
        public int $amount,
        public string $currency
    ) {}

    public function add(Money $other): Money {
        if ($this->currency !== $other->currency) {
            throw new InvalidArgumentException('Currency mismatch');
        }
        return new Money($this->amount + $other->amount, $this->currency);
    }
}

// Usage - immutable by design
$price = new Money(1000, 'USD');
$tax = new Money(100, 'USD');
$total = $price->add($tax); // New Money object
```

## Anti-Pattern Recognition

### Hidden Mutation

```php
<?php
// ANTI-PATTERN: Mutation disguised as transformation
function processUser(array $user): array {
    $user['processed_at'] = time(); // Mutates if passed by reference
    return validateUser($user);
}

// CORRECT: Explicit new array
function processUser(array $user): array {
    return validateUser([
        ...$user,
        'processed_at' => time()
    ]);
}
```

### Configuration in Hot Paths

```php
<?php
// ANTI-PATTERN: O(records x fields) - schema accessed every iteration
function mapRecords(array $records, array $schema): array {
    return array_map(function($record) use ($schema) {
        return array_combine(
            array_column($schema['fields'], 'name'),
            array_map(fn($f) => $record[$f['key']], $schema['fields'])
        );
    }, $records);
}

// CORRECT: Pre-compile, then execute - O(records + fields)
function createRecordMapper(array $schema): Closure {
    $fields = $schema['fields'];
    $names = array_column($fields, 'name');
    $keys = array_column($fields, 'key');

    return fn(array $record): array => array_combine(
        $names,
        array_map(fn($key) => $record[$key], $keys)
    );
}

$mapper = createRecordMapper($schema); // Setup once
$results = array_map($mapper, $records); // Linear execution
```

### Over-Engineering Validation

```php
<?php
// ANTI-PATTERN: Complex machinery for simple check
$emailValidator = (new ValidatorBuilder())
    ->addRule(new FormatRule(new EmailPattern()))
    ->addRule(new LengthRule(new Range(5, 254)))
    ->addTransformer(new LowercaseTransformer())
    ->build();

// CORRECT: Simple, direct, readable
function validateEmail(string $email): bool {
    $normalized = strtolower(trim($email));
    return strlen($normalized) >= 5
        && strlen($normalized) <= 254
        && filter_var($normalized, FILTER_VALIDATE_EMAIL) !== false;
}
```

## Result Type Pattern

Consistent error handling without exceptions for expected failures.

```php
<?php
declare(strict_types=1);

// Standard result shape
function success(mixed $data): array {
    return ['success' => true, 'data' => $data];
}

function failure(string $error, array $context = []): array {
    return ['success' => false, 'error' => $error, 'context' => $context];
}

// Usage in pure functions
function parseJson(string $json): array {
    $data = json_decode($json, true);
    return json_last_error() === JSON_ERROR_NONE
        ? success($data)
        : failure('Invalid JSON', ['error' => json_last_error_msg()]);
}

// Chain results
function processInput(string $json): array {
    $parsed = parseJson($json);
    if (!$parsed['success']) return $parsed;

    $validated = validateData($parsed['data']);
    if (!$validated['success']) return $validated;

    return transformData($validated['data']);
}
```
