# PHP FP Testing Patterns

Comprehensive testing philosophy for pure functions using PHPUnit.

## Why Pure Functions Enable Better Testing

Pure functions guarantee:
- **Deterministic**: Same input always produces same output
- **Isolated**: No side effects means tests never interfere
- **Fast**: No I/O, network, or database needed
- **Complete**: All edge cases can be systematically tested

## The Test Matrix Approach

### Systematic Type Coverage

```php
<?php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;

class ValidatorTest extends TestCase
{
    // Test expected use cases
    #[DataProvider('validInputProvider')]
    public function testAcceptsValidInput(mixed $input, bool $expected): void
    {
        $this->assertSame($expected, validatePositiveInteger($input));
    }

    public static function validInputProvider(): array
    {
        return [
            'positive integer' => [5, true],
            'large number' => [1000000, true],
            'boundary: 1' => [1, true],
            'zero' => [0, false],
            'negative' => [-5, false],
        ];
    }

    // Test ALL PHP types systematically
    #[DataProvider('invalidTypeProvider')]
    public function testRejectsInvalidTypes(mixed $input): void
    {
        $this->expectException(TypeError::class);
        validatePositiveInteger($input);
    }

    public static function invalidTypeProvider(): array
    {
        return [
            'null' => [null],
            'string' => ['5'],
            'float' => [5.0],
            'bool true' => [true],
            'bool false' => [false],
            'empty array' => [[]],
            'array with values' => [[1, 2, 3]],
            'object' => [new stdClass()],
            'closure' => [fn() => 5],
        ];
    }
}
```

### Boundary Value Testing

```php
<?php
declare(strict_types=1);

class RangeValidatorTest extends TestCase
{
    private Closure $validator;

    protected function setUp(): void
    {
        $this->validator = createRangeValidator(min: 0, max: 100);
    }

    #[DataProvider('boundaryProvider')]
    public function testBoundaryValues(int $value, bool $expected): void
    {
        $this->assertSame($expected, ($this->validator)($value));
    }

    public static function boundaryProvider(): array
    {
        return [
            'below min' => [-1, false],
            'at min' => [0, true],
            'above min' => [1, true],
            'middle' => [50, true],
            'below max' => [99, true],
            'at max' => [100, true],
            'above max' => [101, false],
        ];
    }
}
```

## Testing Composed Functions

### Test Components Independently

```php
<?php
declare(strict_types=1);

// Functions under test
function normalizeEmail(string $email): string {
    return strtolower(trim($email));
}

function validateEmailFormat(string $email): bool {
    return filter_var($email, FILTER_VALIDATE_EMAIL) !== false;
}

function validateEmailDomain(string $email, array $blocked): bool {
    $domain = substr($email, strpos($email, '@') + 1);
    return !in_array($domain, $blocked, true);
}

// Test each component
class EmailValidationTest extends TestCase
{
    public function testNormalizeEmail(): void
    {
        $this->assertSame('test@example.com', normalizeEmail('  TEST@EXAMPLE.COM  '));
    }

    #[DataProvider('formatProvider')]
    public function testValidateEmailFormat(string $email, bool $valid): void
    {
        $this->assertSame($valid, validateEmailFormat($email));
    }

    public static function formatProvider(): array
    {
        return [
            'valid' => ['test@example.com', true],
            'no @' => ['testexample.com', false],
            'no domain' => ['test@', false],
            'no local' => ['@example.com', false],
            'double @' => ['test@@example.com', false],
        ];
    }

    public function testValidateEmailDomain(): void
    {
        $blocked = ['spam.com', 'temp.net'];

        $this->assertTrue(validateEmailDomain('user@example.com', $blocked));
        $this->assertFalse(validateEmailDomain('user@spam.com', $blocked));
    }
}
```

### Test the Composition

```php
<?php
declare(strict_types=1);

class EmailValidationIntegrationTest extends TestCase
{
    private Closure $validateEmail;

    protected function setUp(): void
    {
        $blocked = ['spam.com'];
        $this->validateEmail = createEmailValidator($blocked);
    }

    #[DataProvider('integrationProvider')]
    public function testFullValidation(string $input, array $expected): void
    {
        $result = ($this->validateEmail)($input);
        $this->assertSame($expected['success'], $result['success']);
        if (!$expected['success']) {
            $this->assertStringContainsString($expected['error'], $result['error']);
        }
    }

    public static function integrationProvider(): array
    {
        return [
            'valid email' => [
                'USER@EXAMPLE.COM',
                ['success' => true]
            ],
            'invalid format' => [
                'not-an-email',
                ['success' => false, 'error' => 'format']
            ],
            'blocked domain' => [
                'user@spam.com',
                ['success' => false, 'error' => 'blocked']
            ],
        ];
    }
}
```

## Testing Function Factories

```php
<?php
declare(strict_types=1);

class FunctionFactoryTest extends TestCase
{
    public function testCreateValidatorReturnsCallable(): void
    {
        $validator = createValidator(minLength: 5);
        $this->assertIsCallable($validator);
    }

    public function testFactoryConfigurationIsCaptured(): void
    {
        $validator5 = createValidator(minLength: 5);
        $validator10 = createValidator(minLength: 10);

        // Same input, different results based on configuration
        $this->assertTrue($validator5('hello'));    // 5 >= 5
        $this->assertFalse($validator10('hello'));  // 5 < 10
    }

    public function testFactoryProducesIndependentInstances(): void
    {
        $v1 = createValidator(minLength: 3);
        $v2 = createValidator(minLength: 3);

        // Different instances, same behavior
        $this->assertNotSame($v1, $v2);
        $this->assertSame($v1('abc'), $v2('abc'));
    }
}
```

## Result Type Testing

```php
<?php
declare(strict_types=1);

class ResultTypeTest extends TestCase
{
    public function testSuccessResultStructure(): void
    {
        $result = divide(10.0, 2.0);

        $this->assertArrayHasKey('success', $result);
        $this->assertTrue($result['success']);
        $this->assertArrayHasKey('data', $result);
        $this->assertSame(5.0, $result['data']);
    }

    public function testFailureResultStructure(): void
    {
        $result = divide(10.0, 0.0);

        $this->assertArrayHasKey('success', $result);
        $this->assertFalse($result['success']);
        $this->assertArrayHasKey('error', $result);
        $this->assertIsString($result['error']);
    }

    public function testResultChaining(): void
    {
        // Test that failures short-circuit
        $result = processCalculation(10.0, 0.0, 5.0);

        $this->assertFalse($result['success']);
        $this->assertStringContainsString('zero', $result['error']);
    }
}
```

## Mocking Dependencies

```php
<?php
declare(strict_types=1);

class ServiceWithDependenciesTest extends TestCase
{
    public function testUserServiceWithMocks(): void
    {
        // Create mock implementations
        $mockHasher = $this->createMock(PasswordHasherInterface::class);
        $mockHasher->method('hash')->willReturn('hashed_password');

        $mockDb = $this->createMock(DatabaseInterface::class);
        $mockDb->method('save')->willReturn(['id' => 1, 'name' => 'Test']);

        // Inject mocks - DI makes this trivial
        $result = saveUser(
            ['name' => 'Test', 'password' => 'secret'],
            $mockHasher,
            $mockDb
        );

        $this->assertSame(1, $result['id']);
    }

    public function testPureFunctionNeedsNoMocks(): void
    {
        // Pure functions are trivially testable
        $result = calculateDiscount(100.0, 0.1);
        $this->assertSame(90.0, $result);
        // No setup, no mocks, no cleanup
    }
}
```

## Performance Testing Pure Functions

```php
<?php
declare(strict_types=1);

class PerformanceTest extends TestCase
{
    public function testFactoryPerformanceGain(): void
    {
        $data = range(1, 10000);
        $config = ['multiplier' => 2];

        // Without factory: config accessed each iteration
        $start = microtime(true);
        $results1 = array_map(
            fn($n) => $n * $config['multiplier'],
            $data
        );
        $withoutFactory = microtime(true) - $start;

        // With factory: config captured once
        $processor = fn($n) => $n * 2; // Config pre-compiled
        $start = microtime(true);
        $results2 = array_map($processor, $data);
        $withFactory = microtime(true) - $start;

        $this->assertSame($results1, $results2);
        // Factory should be faster (config not re-accessed)
    }
}
```

## Test Organization

```
tests/
  Unit/
    Validators/
      EmailValidatorTest.php
      RangeValidatorTest.php
    Transformers/
      DataMapperTest.php
    Utils/
      ResultTypeTest.php
  Integration/
    ValidationPipelineTest.php
```

**Key Principles**:
1. One test class per function/factory
2. Data providers for systematic coverage
3. Test components independently, then composition
4. Pure functions need no mocks
5. Edge cases are cheap to test - test them all
