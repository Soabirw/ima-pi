---
name: "php-fp"
description: "Core FP principles with anti-over-engineering focus - Simple > Complex | Evidence > Assumptions"
---

# PHP Functional Programming

## Anti-Over-Engineering (PRIMARY)

"Simple > Complex | Evidence > Assumptions"

Don't CREATE custom FP utilities (pipe, compose, curry) to make PHP feel like Haskell. Using established libraries (Carbon, Collections) is fine. FP is a mindset — pure functions, immutability, composition — not an API signature.

```php
<?php
// DON'T: pipe() utility
function pipe(...$functions) {
    return fn($value) => array_reduce($functions, fn($carry, $fn) => $fn($carry), $value);
}

// DO: native early returns
function validateUser(array $userData): array {
    $requiredCheck = validateRequired(['email', 'name'], $userData);
    if (!$requiredCheck['valid']) return $requiredCheck;
    return validateEmail($userData);
}

// DON'T: curry() utility
// DO: native closures
function createValidator(array $rules): callable {
    return fn($value): array => ['valid' => empty(array_filter($rules, fn($r) => !$r['validator']($value)))];
}

// DON'T: complex monad implementations
// DO: simple result arrays
function divide(float $a, float $b): array {
    return $b === 0.0 ? ['success' => false, 'error' => 'Division by zero'] : ['success' => true, 'data' => $a / $b];
}
```

### 4-Question Quality Framework

Before extracting or abstracting:

1. **"Can this be pure?"** — separate business logic from side effects
2. **"Can this use native patterns?"** — avoid custom FP utilities
3. **"Can this be simplified?"** — simple > complex
4. **"Is this complexity justified?"** — evidence required

### Context-Appropriate Complexity

```php
<?php
// CLI Script: direct
function processFile(string $filePath): array {
    $data = file_get_contents($filePath);
    return array_map('strtoupper', array_filter(explode("\n", $data), fn($l) => trim($l) !== ''));
}

// Production Service: appropriate error handling + logging
function processFile(string $filePath, LoggerInterface $logger): array {
    try {
        if (!file_exists($filePath)) throw new InvalidArgumentException("File not found: {$filePath}");
        $lines = array_filter(explode("\n", file_get_contents($filePath)), fn($l) => trim($l) !== '');
        $logger->info('File processed', ['path' => $filePath, 'lines' => count($lines)]);
        return ['success' => true, 'data' => array_map('strtoupper', $lines)];
    } catch (Exception $e) {
        $logger->error('File processing failed', ['path' => $filePath, 'error' => $e->getMessage()]);
        return ['success' => false, 'error' => $e->getMessage()];
    }
}
```

## Core Patterns

### Purity + Side Effect Isolation

```php
<?php
declare(strict_types=1);

function calculateTotal(array $items): float {
    return array_reduce($items, fn($sum, $item) => $sum + $item['price'], 0.0);
}

function logAndCalculate(array $items, LoggerInterface $logger): float {
    $total = calculateTotal($items);
    $logger->info("Total: {$total}");
    return $total;
}
```

### Composition Over Inheritance

```php
<?php
function validateRequired($value): bool { return $value !== null && $value !== ''; }
function validateEmail(string $value): bool { return filter_var($value, FILTER_VALIDATE_EMAIL) !== false; }
function validateLength(int $min, int $max): callable {
    return fn(string $value): bool => strlen($value) >= $min && strlen($value) <= $max;
}

function validateUserEmail(string $email): array {
    if (!validateRequired($email)) return ['valid' => false, 'error' => 'Required'];
    if (!validateEmail($email)) return ['valid' => false, 'error' => 'Invalid email'];
    if (!validateLength(5, 100)($email)) return ['valid' => false, 'error' => 'Length'];
    return ['valid' => true];
}
```

### Dependency Injection

```php
<?php
function saveUser(array $userData, PasswordHasherInterface $hasher, DatabaseInterface $db): array {
    return $db->save(['name' => $userData['name'], 'password' => $hasher->hash($userData['password'])]);
}

class UserService {
    public function __construct(
        private readonly PasswordHasherInterface $hasher,
        private readonly DatabaseInterface $db
    ) {}

    public function saveUser(array $userData): array {
        return saveUser($userData, $this->hasher, $this->db);
    }
}
```

### Immutability

```php
<?php
function updateUserSettings(array $user, array $settings): array {
    return [...$user, 'settings' => array_merge($user['settings'] ?? [], $settings), 'updated_at' => time()];
}

function addItem(array $items, array $newItem): array { return [...$items, $newItem]; }
function removeItem(array $items, int $id): array { return array_values(array_filter($items, fn($i) => $i['id'] !== $id)); }
function updateItem(array $items, int $id, array $updates): array {
    return array_map(fn($i) => $i['id'] === $id ? [...$i, ...$updates] : $i, $items);
}
```

## PHP-Specific: Native Array Functions + Strict Types (MANDATORY)

```php
<?php
declare(strict_types=1);

function processUsers(array $users): array {
    return array_slice(
        array_map(fn($u) => [...$u, 'display_name' => "{$u['first_name']} {$u['last_name']}"],
            array_filter($users, fn($u) => $u['active'])),
        0, 10
    );
}

// match over switch (PHP 8.0+)
function getTierDiscount(string $tier): float {
    return match($tier) {
        'bronze' => 0.05, 'silver' => 0.10, 'gold' => 0.15, 'platinum' => 0.20, default => 0.0
    };
}

// Union types (PHP 8.0+)
function processResult(array|false $result): array {
    return $result === false ? ['success' => false, 'error' => 'Not found'] : ['success' => true, 'data' => $result];
}
```

## Result Type Pattern

```php
<?php
function createResult($data = null, ?string $error = null): array {
    return $error !== null ? ['success' => false, 'error' => $error] : ['success' => true, 'data' => $data];
}

// Chain with early return
function calculate(float $a, float $b, float $c): array {
    $r1 = divide($a, $b);
    if (!$r1['success']) return $r1;
    return divide($r1['data'], $c);
}
```

## Testing

Pure functions enable systematic edge-case coverage.

```php
<?php
use PHPUnit\Framework\TestCase;

class CalculatorTest extends TestCase {
    /** @dataProvider discountProvider */
    public function testCalculateDiscount(float $price, float $rate, float $expected): void {
        $this->assertEquals($expected, calculateDiscount($price, $rate));
    }

    public function discountProvider(): array {
        return [
            'standard' => [100.0, 0.1, 90.0],
            'zero'     => [100.0, 0.0, 100.0],
            'full'     => [100.0, 1.0, 0.0],
        ];
    }
}
```

## Performance: Configuration Pre-Compilation (Evidence-Based)

Optimize only with evidence. Key pattern: pre-compile config once, execute linearly.

```php
<?php
// Problem: O(records × config) — config accessed every iteration
// Solution: pre-compile once
function createRecordProcessor(array $schema): callable {
    $fieldProcessors = array_map(fn($f) => fn($v) => transformField($v, $f['type']), $schema['fields']);

    return function(array $record) use ($schema, $fieldProcessors): array {
        $result = [];
        foreach ($schema['fields'] as $i => $field) {
            $result[$field['name']] = $fieldProcessors[$i]($record[$field['name']]);
        }
        return $result;
    };
}

$processor = createRecordProcessor($schema); // setup once
$results = array_map($processor, $records);  // linear execution
```

Real result: ima-espo email validation — 2-5x speedup, 130 tests, 236 assertions, <30ms total.

## Quality Gates

1. Pure? — business logic separated from side effects
2. Native? — no custom FP utilities
3. Simple? — simple > complex
4. Justified? — evidence for complexity
5. Testable? — pure functions have tests
6. Strict types? — `declare(strict_types=1)` at file top

## Reference Files

| File | Load When |
|------|-----------|
| `references/core-principles.md` | Architectural decisions, full Result Type patterns, anti-pattern recognition |
| `references/testing-patterns.md` | Comprehensive test suites, edge cases, mocking, performance testing |
| `examples/` | Complete working code, integration examples |
