<?php
declare(strict_types=1);

namespace PhpFp\Examples\Tests;

use PHPUnit\Framework\TestCase;
use function PhpFp\Examples\calculateDiscount;
use function PhpFp\Examples\validateEmail;
use function PhpFp\Examples\formatDisplayName;
use function PhpFp\Examples\createValidator;
use function PhpFp\Examples\createFieldTransformer;
use function PhpFp\Examples\processActiveUsers;
use function PhpFp\Examples\calculateAccountAge;
use function PhpFp\Examples\groupBy;
use function PhpFp\Examples\updateUser;
use function PhpFp\Examples\addItem;
use function PhpFp\Examples\removeItem;
use function PhpFp\Examples\parseUserData;
use function PhpFp\Examples\calculateShipping;
use function PhpFp\Examples\processOrder;
use function PhpFp\Examples\calculateTax;
use function PhpFp\Examples\calculateShippingCost;
use function PhpFp\Examples\applyDiscountCode;

/**
 * Comprehensive test suite for PHP FP patterns
 *
 * Demonstrates:
 * - Data providers for comprehensive edge case testing
 * - Pure function testing (no mocks needed)
 * - Result type validation
 * - Performance pattern validation
 */
class PureFunctionsTest extends TestCase
{
    // ───────────────────────────────────────────────────────
    // Basic Pure Functions Tests
    // ───────────────────────────────────────────────────────

    /**
     * @dataProvider discountProvider
     */
    public function testCalculateDiscount(
        float $price,
        string $tier,
        int $days,
        float $expected
    ): void {
        $result = calculateDiscount($price, $tier, $days);
        $this->assertEquals($expected, $result);
    }

    public function discountProvider(): array
    {
        return [
            'bronze_new_member' => [100.00, 'bronze', 30, 95.00],
            'silver_1year_member' => [100.00, 'silver', 365, 88.00],
            'gold_5year_member' => [100.00, 'gold', 1825, 80.00],
            'platinum_10year_member' => [100.00, 'platinum', 3650, 75.00],
            'invalid_tier' => [100.00, 'invalid', 365, 100.00],
            'zero_days' => [100.00, 'bronze', 0, 95.00],
            'negative_days' => [100.00, 'gold', -100, 85.00],
            'max_loyalty_bronze' => [100.00, 'bronze', 10000, 90.00],
            'zero_price' => [0.00, 'gold', 365, 0.00],
            'high_price' => [9999.99, 'platinum', 3650, 7499.99]
        ];
    }

    /**
     * @dataProvider emailProvider
     */
    public function testValidateEmail(string $email, bool $expectedValid): void
    {
        $result = validateEmail($email);
        $this->assertEquals($expectedValid, $result['valid']);

        if (!$expectedValid) {
            $this->assertNotNull($result['error']);
        } else {
            $this->assertNull($result['error']);
        }
    }

    public function emailProvider(): array
    {
        return [
            'valid_simple' => ['test@example.com', true],
            'valid_subdomain' => ['user@mail.example.com', true],
            'valid_plus' => ['user+tag@example.com', true],
            'invalid_no_at' => ['userexample.com', false],
            'invalid_no_domain' => ['user@', false],
            'invalid_no_tld' => ['user@example', false],
            'invalid_spaces' => ['user @example.com', false],
            'invalid_empty' => ['', false],
            'invalid_double_at' => ['user@@example.com', false]
        ];
    }

    /**
     * @dataProvider displayNameProvider
     */
    public function testFormatDisplayName(array $user, string $expected): void
    {
        $result = formatDisplayName($user);
        $this->assertEquals($expected, $result);
    }

    public function displayNameProvider(): array
    {
        return [
            'full_name' => [
                ['first_name' => 'John', 'last_name' => 'Doe'],
                'John Doe'
            ],
            'first_only' => [
                ['first_name' => 'John'],
                'John'
            ],
            'last_only' => [
                ['last_name' => 'Doe'],
                'Doe'
            ],
            'empty_both' => [
                [],
                'Anonymous'
            ],
            'whitespace_trimmed' => [
                ['first_name' => '  John  ', 'last_name' => '  Doe  '],
                'John Doe'
            ],
            'empty_strings' => [
                ['first_name' => '', 'last_name' => ''],
                'Anonymous'
            ]
        ];
    }

    // ───────────────────────────────────────────────────────
    // Configuration Pre-Compilation Tests
    // ───────────────────────────────────────────────────────

    public function testCreateValidator(): void
    {
        $validator = createValidator([
            'email' => 'email',
            'age' => 'numeric',
            'name' => 'required'
        ]);

        // Valid data
        $result = $validator([
            'email' => 'test@example.com',
            'age' => '25',
            'name' => 'John'
        ]);
        $this->assertTrue($result['valid']);
        $this->assertEmpty($result['errors']);

        // Invalid email
        $result = $validator([
            'email' => 'invalid',
            'age' => '25',
            'name' => 'John'
        ]);
        $this->assertFalse($result['valid']);
        $this->assertArrayHasKey('email', $result['errors']);

        // Missing required
        $result = $validator([
            'email' => 'test@example.com',
            'age' => '25'
        ]);
        $this->assertFalse($result['valid']);
        $this->assertArrayHasKey('name', $result['errors']);

        // Invalid numeric
        $result = $validator([
            'email' => 'test@example.com',
            'age' => 'not-a-number',
            'name' => 'John'
        ]);
        $this->assertFalse($result['valid']);
        $this->assertArrayHasKey('age', $result['errors']);
    }

    public function testCreateValidatorPerformance(): void
    {
        // Pre-compile validator once
        $validator = createValidator([
            'email' => 'email',
            'age' => 'numeric'
        ]);

        $data = array_fill(0, 1000, [
            'email' => 'test@example.com',
            'age' => '25'
        ]);

        $start = microtime(true);
        foreach ($data as $item) {
            $validator($item);
        }
        $preCompiledTime = microtime(true) - $start;

        // This should be significantly faster than creating validator N times
        $this->assertLessThan(0.1, $preCompiledTime, 'Pre-compiled validator should be fast');
    }

    public function testCreateFieldTransformer(): void
    {
        $transformer = createFieldTransformer([
            'name' => 'capitalize',
            'email' => 'lowercase',
            'code' => 'uppercase'
        ]);

        $result = $transformer([
            'name' => 'john doe',
            'email' => 'USER@EXAMPLE.COM',
            'code' => 'abc123'
        ]);

        $this->assertEquals('John doe', $result['name']);
        $this->assertEquals('user@example.com', $result['email']);
        $this->assertEquals('ABC123', $result['code']);
    }

    // ───────────────────────────────────────────────────────
    // Composition Tests
    // ───────────────────────────────────────────────────────

    public function testProcessActiveUsers(): void
    {
        $users = [
            ['id' => 1, 'first_name' => 'John', 'last_name' => 'Doe', 'active' => true, 'created_at' => '2020-01-01'],
            ['id' => 2, 'first_name' => 'Jane', 'last_name' => 'Smith', 'active' => false, 'created_at' => '2021-01-01'],
            ['id' => 3, 'first_name' => 'Bob', 'last_name' => 'Johnson', 'active' => true, 'created_at' => '2019-01-01']
        ];

        $result = processActiveUsers($users, 10);

        // Only active users
        $this->assertCount(2, $result);

        // Check display names added
        $this->assertEquals('John Doe', $result[0]['display_name']);
        $this->assertEquals('Bob Johnson', $result[1]['display_name']);

        // Check account age added
        $this->assertArrayHasKey('account_age', $result[0]);
        $this->assertIsInt($result[0]['account_age']);
    }

    public function testProcessActiveUsersLimit(): void
    {
        $users = array_map(
            fn($i) => [
                'id' => $i,
                'first_name' => "User{$i}",
                'last_name' => 'Test',
                'active' => true,
                'created_at' => '2020-01-01'
            ],
            range(1, 20)
        );

        $result = processActiveUsers($users, 5);
        $this->assertCount(5, $result);
    }

    public function testGroupBy(): void
    {
        $items = [
            ['id' => 1, 'category' => 'A', 'name' => 'Item 1'],
            ['id' => 2, 'category' => 'B', 'name' => 'Item 2'],
            ['id' => 3, 'category' => 'A', 'name' => 'Item 3'],
            ['id' => 4, 'category' => 'C', 'name' => 'Item 4']
        ];

        $grouped = groupBy($items, 'category');

        $this->assertArrayHasKey('A', $grouped);
        $this->assertArrayHasKey('B', $grouped);
        $this->assertArrayHasKey('C', $grouped);
        $this->assertCount(2, $grouped['A']);
        $this->assertCount(1, $grouped['B']);
        $this->assertCount(1, $grouped['C']);
    }

    // ───────────────────────────────────────────────────────
    // Immutability Tests
    // ───────────────────────────────────────────────────────

    public function testUpdateUserImmutability(): void
    {
        $original = ['id' => 1, 'name' => 'John', 'email' => 'john@example.com'];
        $updated = updateUser($original, ['email' => 'newemail@example.com']);

        // Original unchanged
        $this->assertEquals('john@example.com', $original['email']);

        // New array created
        $this->assertEquals('newemail@example.com', $updated['email']);
        $this->assertArrayHasKey('updated_at', $updated);
    }

    public function testAddItemImmutability(): void
    {
        $original = [
            ['id' => 1, 'name' => 'Item 1'],
            ['id' => 2, 'name' => 'Item 2']
        ];

        $newCollection = addItem($original, ['id' => 3, 'name' => 'Item 3']);

        // Original unchanged
        $this->assertCount(2, $original);

        // New collection created
        $this->assertCount(3, $newCollection);
        $this->assertEquals('Item 3', $newCollection[2]['name']);
    }

    public function testRemoveItemImmutability(): void
    {
        $original = [
            ['id' => '1', 'name' => 'Item 1'],
            ['id' => '2', 'name' => 'Item 2'],
            ['id' => '3', 'name' => 'Item 3']
        ];

        $newCollection = removeItem($original, '2');

        // Original unchanged
        $this->assertCount(3, $original);

        // New collection created with item removed
        $this->assertCount(2, $newCollection);
        $this->assertEquals('1', $newCollection[0]['id']);
        $this->assertEquals('3', $newCollection[1]['id']);
    }

    // ───────────────────────────────────────────────────────
    // Result Type Pattern Tests
    // ───────────────────────────────────────────────────────

    public function testParseUserDataSuccess(): void
    {
        $result = parseUserData([
            'email' => 'test@example.com',
            'name' => 'John Doe',
            'age' => '25'
        ]);

        $this->assertTrue($result['success']);
        $this->assertNull($result['error']);
        $this->assertIsArray($result['data']);
        $this->assertEquals('test@example.com', $result['data']['email']);
        $this->assertEquals('John Doe', $result['data']['name']);
        $this->assertEquals(25, $result['data']['age']);
    }

    public function testParseUserDataMissingFields(): void
    {
        $result = parseUserData(['email' => 'test@example.com']);

        $this->assertFalse($result['success']);
        $this->assertNotNull($result['error']);
        $this->assertStringContainsString('Missing required fields', $result['error']);
        $this->assertNull($result['data']);
    }

    public function testParseUserDataInvalidEmail(): void
    {
        $result = parseUserData([
            'email' => 'invalid-email',
            'name' => 'John Doe'
        ]);

        $this->assertFalse($result['success']);
        $this->assertNotNull($result['error']);
        $this->assertStringContainsString('email', $result['error']);
        $this->assertNull($result['data']);
    }

    /**
     * @dataProvider shippingProvider
     */
    public function testCalculateShipping(
        float $weight,
        string $zone,
        bool $expectedSuccess,
        ?float $expectedCost
    ): void {
        $result = calculateShipping($weight, $zone);

        $this->assertEquals($expectedSuccess, $result['success']);

        if ($expectedSuccess) {
            $this->assertNull($result['error']);
            $this->assertEquals($expectedCost, $result['data']);
        } else {
            $this->assertNotNull($result['error']);
            $this->assertNull($result['data']);
        }
    }

    public function shippingProvider(): array
    {
        return [
            'domestic_1kg' => [1.0, 'domestic', true, 5.50],
            'international_2kg' => [2.0, 'international', true, 16.00],
            'express_3kg' => [3.0, 'express', true, 26.50],
            'invalid_zone' => [1.0, 'invalid', false, null],
            'zero_weight' => [0.0, 'domestic', false, null],
            'negative_weight' => [-1.0, 'domestic', false, null]
        ];
    }

    // ───────────────────────────────────────────────────────
    // Dependency Injection Tests
    // ───────────────────────────────────────────────────────

    public function testProcessOrder(): void
    {
        $order = [
            'items' => [
                ['name' => 'Product 1', 'price' => 50.00],
                ['name' => 'Product 2', 'price' => 30.00]
            ],
            'weight' => 2.0,
            'tax_zone' => 'CA',
            'shipping_zone' => 'domestic',
            'discount_code' => 'SAVE10'
        ];

        $result = processOrder(
            $order,
            'PhpFp\Examples\calculateTax',
            'PhpFp\Examples\calculateShippingCost',
            'PhpFp\Examples\applyDiscountCode'
        );

        $this->assertEquals(80.00, $result['subtotal']);
        $this->assertEquals(5.80, $result['tax']); // CA tax 7.25%
        $this->assertEquals(6.00, $result['shipping']); // 5 + 2*0.5
        $this->assertEquals(8.00, $result['discount']); // 10% of 80
        $this->assertEquals(83.80, $result['total']); // 80 + 5.80 + 6 - 8
    }

    public function testProcessOrderWithMockedDependencies(): void
    {
        $order = [
            'items' => [['price' => 100.00]],
            'weight' => 1.0,
            'tax_zone' => 'CA',
            'shipping_zone' => 'domestic',
            'discount_code' => null
        ];

        // Mock dependencies for testing
        $mockTax = fn($amount, $zone) => 10.00;
        $mockShipping = fn($weight, $zone) => 5.00;
        $mockDiscount = fn($amount, $code) => 0.00;

        $result = processOrder($order, $mockTax, $mockShipping, $mockDiscount);

        $this->assertEquals(100.00, $result['subtotal']);
        $this->assertEquals(10.00, $result['tax']);
        $this->assertEquals(5.00, $result['shipping']);
        $this->assertEquals(0.00, $result['discount']);
        $this->assertEquals(115.00, $result['total']);
    }

    /**
     * @dataProvider taxProvider
     */
    public function testCalculateTax(float $amount, string $zone, float $expected): void
    {
        $result = calculateTax($amount, $zone);
        $this->assertEquals($expected, $result);
    }

    public function taxProvider(): array
    {
        return [
            'CA_100' => [100.00, 'CA', 7.25],
            'NY_100' => [100.00, 'NY', 8.88],
            'TX_100' => [100.00, 'TX', 6.25],
            'unknown_zone' => [100.00, 'XX', 0.00],
            'zero_amount' => [0.00, 'CA', 0.00]
        ];
    }

    /**
     * @dataProvider discountCodeProvider
     */
    public function testApplyDiscountCode(float $amount, ?string $code, float $expected): void
    {
        $result = applyDiscountCode($amount, $code);
        $this->assertEquals($expected, $result);
    }

    public function discountCodeProvider(): array
    {
        return [
            'SAVE10' => [100.00, 'SAVE10', 10.00],
            'SAVE20' => [100.00, 'SAVE20', 20.00],
            'SAVE30' => [100.00, 'SAVE30', 30.00],
            'invalid_code' => [100.00, 'INVALID', 0.00],
            'null_code' => [100.00, null, 0.00],
            'zero_amount' => [0.00, 'SAVE10', 0.00]
        ];
    }
}
