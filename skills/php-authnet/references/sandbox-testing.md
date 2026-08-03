# Authorize.Net Sandbox & Testing Guide

Testing patterns, sandbox configuration, test card numbers, and PHPUnit strategies for Authorize.Net PHP SDK.

## Table of Contents

- [Sandbox Setup](#sandbox-setup)
- [Test Card Numbers](#test-card-numbers)
- [Sandbox Gotchas](#sandbox-gotchas)
- [PHPUnit Testing Patterns](#phpunit-testing-patterns)
- [Test Data Reference](#test-data-reference)

---

## Sandbox Setup

### Sandbox Credentials

1. Create sandbox account at https://developer.authorize.net/hello_world/sandbox.html
2. Get API Login ID + Transaction Key from Account → Settings → API Credentials & Keys
3. Get Public Client Key for Accept.js from Account → Settings → Manage Public Client Key
4. Get Signature Key for webhooks from Account → Settings → API Credentials & Keys → New Signature Key

### Environment URLs

```php
use net\authorize\api\constants\ANetEnvironment;

// Sandbox
$api_url = ANetEnvironment::SANDBOX;
// https://apitest.authorize.net/xml/v1/request.api

// Production
$api_url = ANetEnvironment::PRODUCTION;
// https://api.authorize.net/xml/v1/request.api
```

### Accept.js Script URLs

```html
<!-- Sandbox -->
<script src="https://jstest.authorize.net/v1/Accept.js"></script>

<!-- Production -->
<script src="https://js.authorize.net/v1/Accept.js"></script>
```

---

## Test Card Numbers

### Credit Cards

| Card Type | Number | CVV | Result |
|-----------|--------|-----|--------|
| Visa | `4111111111111111` | Any 3-digit | Approved |
| Visa | `4222222222222` | Any 3-digit | Approved |
| Mastercard | `5424000000000015` | Any 3-digit | Approved |
| Amex | `370000000000002` | Any 4-digit | Approved |
| Discover | `6011000000000012` | Any 3-digit | Approved |
| JCB | `3088000000000017` | Any 3-digit | Approved |
| Diners Club | `38000000000006` | Any 3-digit | Approved |

### Triggering Declines

Use specific amounts to trigger decline responses:

| Amount ending in | Response |
|-----------------|----------|
| `.00` | Approved (default) |
| `.01` | Approved |
| `.02` | Declined |
| `.03` | Error |
| `.04` | Held for review |

Example: `$50.02` triggers a decline.

### Expiration Dates

Any future date works in sandbox. Use `12/2030` or similar.

### eCheck (ACH)

| Field | Test Value |
|-------|-----------|
| Routing Number | `121042882` |
| Account Number | Any 6-17 digit number |
| Account Type | `checking` or `savings` |
| Name on Account | Any name |
| eCheck Type | `WEB` (internet) or `PPD` (prearranged) |

---

## Sandbox Gotchas

### CIM → ARB Propagation Delay

**Problem**: Creating a CIM profile then immediately creating an ARB subscription with that profile fails with "The record cannot be found."

**Cause**: Sandbox takes ~15 seconds to propagate CIM profiles to the ARB subsystem.

**Solution**: Retry with delay (sandbox only):

```php
function create_subscription_with_retry(
    string $customer_profile_id,
    string $payment_profile_id,
    array $plan,
    array $credentials,
    string $environment
): array {
    $max_attempts = ($environment === 'sandbox') ? 3 : 1;

    for ($attempt = 1; $attempt <= $max_attempts; $attempt++) {
        $result = create_subscription_via_sdk(
            $customer_profile_id, $payment_profile_id, $plan, $credentials
        );

        if ($result['success']) return $result;
        if ($attempt === $max_attempts) return $result;
        if (!str_contains($result['error'] ?? '', 'record cannot be found')) return $result;

        sleep(15); // wait for propagation
    }

    return ['success' => false, 'error' => 'Failed after retries'];
}
```

### Validation Mode with Accept.js Tokens

**Problem**: `liveMode` validation fails with Accept.js opaque data in sandbox.

**Solution**: Use `testMode` in sandbox, `liveMode` in production:

```php
$validation_mode = ($environment === 'sandbox') ? 'testMode' : 'liveMode';
```

### Settlement Timing

Sandbox settles transactions daily at a specific time (not real-time). This affects:
- Refunds: Can only refund settled transactions
- Voids: Can only void unsettled transactions
- You cannot test both refund and void on the same transaction in the same test run

### Webhook Delivery in Sandbox

- Webhooks work in sandbox but may have higher latency
- Webhook URL must be publicly accessible (use ngrok or similar for local dev)
- Sandbox webhook signature key is different from production

---

## PHPUnit Testing Patterns

### Testing the Three-Layer Architecture

The FP architecture makes testing straightforward — pure functions need no mocks.

#### Testing Pure Builders (No Mocks Needed)

```php
<?php declare(strict_types=1);

use PHPUnit\Framework\TestCase;

class RequestBuilderTest extends TestCase
{
    public function test_build_charge_request_normalizes_billing(): void
    {
        $result = build_charge_request([
            'amount' => 29.99,
            'payment_token' => 'token123',
            'billing' => ['first_name' => 'Jane', 'last_name' => 'Doe'],
        ]);

        $this->assertSame(29.99, $result['amount']);
        $this->assertSame('token123', $result['payment_token']);
        $this->assertSame('Jane', $result['billing']['first_name']);
    }

    public function test_build_charge_request_handles_empty_billing(): void
    {
        $result = build_charge_request([
            'amount' => 10.00,
            'payment_token' => 'token456',
            'billing' => [],
        ]);

        $this->assertNull($result['billing']);
    }

    public function test_build_subscription_request_truncates_name(): void
    {
        $long_name = str_repeat('A', 60);
        $result = build_subscription_request('cp1', 'pp1', [
            'amount' => 9.99,
            'name' => $long_name,
        ], '2025-01-01');

        $this->assertSame(50, strlen($result['name']));
    }
}
```

#### Testing Pure Parsers (No Mocks Needed)

```php
class ResponseParserTest extends TestCase
{
    public function test_parse_charge_success(): void
    {
        $result = parse_charge_response([
            'result_code' => 'Ok',
            'transaction_id' => 'TX123',
            'has_transaction_messages' => true,
            'auth_code' => 'AUTH1',
            'message' => 'Approved',
            'response_code' => '1',
            'account_number' => 'XXXX1234',
            'error_text' => null,
            'error_code' => null,
        ]);

        $this->assertTrue($result['success']);
        $this->assertSame('TX123', $result['transaction_id']);
    }

    public function test_parse_charge_null_response(): void
    {
        $result = parse_charge_response([
            'result_code' => null,
            'transaction_id' => null,
            'has_transaction_messages' => false,
            'error_text' => null,
            'error_code' => null,
        ]);

        $this->assertFalse($result['success']);
        $this->assertSame('No response from payment gateway', $result['error']);
    }

    public function test_parse_create_profile_duplicate_recovery(): void
    {
        $result = parse_create_profile_response([
            'result_code' => 'Error',
            'customer_profile_id' => null,
            'payment_profile_id' => null,
            'error_code' => 'E00039',
            'error_text' => 'A duplicate record with ID 12345 already exists.',
        ]);

        $this->assertFalse($result['success']);
        $this->assertSame('E00039', $result['error_code']);
        $this->assertSame('12345', $result['existing_profile_id']);
    }
}
```

#### Testing Pure Webhook Functions (No Mocks Needed)

```php
class WebhookPureFunctionsTest extends TestCase
{
    public function test_validate_signature_valid(): void
    {
        $body = '{"eventType":"net.authorize.payment.authcapture.created"}';
        $key = 'test-signature-key';
        $hash = strtoupper(hash_hmac('sha512', $body, $key));

        $this->assertTrue(
            validate_webhook_signature($body, "sha512={$hash}", $key)
        );
    }

    public function test_validate_signature_invalid(): void
    {
        $this->assertFalse(
            validate_webhook_signature('body', 'sha512=WRONG', 'key')
        );
    }

    /**
     * @dataProvider eventCategoryProvider
     */
    public function test_get_event_category(string $event, string|false $expected): void
    {
        $this->assertSame($expected, get_event_category($event));
    }

    public static function eventCategoryProvider(): array
    {
        return [
            ['net.authorize.payment.authcapture.created', 'payment'],
            ['net.authorize.customer.subscription.created', 'subscription'],
            ['net.authorize.payment.fraud.held', 'fraud'],
            ['net.authorize.unknown.something', false],
        ];
    }
}
```

#### Testing Validation Functions (No Mocks Needed)

```php
class ValidationTest extends TestCase
{
    /**
     * @dataProvider amountProvider
     */
    public function test_validate_amount(mixed $amount, bool $expected_valid): void
    {
        $result = validate_amount($amount);
        $this->assertSame($expected_valid, $result['valid']);
    }

    public static function amountProvider(): array
    {
        return [
            'valid'    => [29.99, true],
            'minimum'  => [1.00, true],
            'below'    => [0.50, false],
            'zero'     => [0, false],
            'negative' => [-10, false],
            'string'   => ['abc', false],
            'max'      => [25000.00, true],
            'over_max' => [25001.00, false],
        ];
    }

    public function test_validate_payment_token_too_short(): void
    {
        $result = validate_payment_token('short');
        $this->assertFalse($result['valid']);
        $this->assertSame('Payment token format is invalid', $result['message']);
    }
}
```

### Testing SDK Adapters (Integration Tests)

SDK adapter functions require the actual SDK. Test these as integration tests against the sandbox:

```php
/**
 * @group integration
 * @group requires-sandbox
 */
class SdkAdapterIntegrationTest extends TestCase
{
    private array $credentials;

    protected function setUp(): void
    {
        $this->credentials = [
            'api_login_id'   => getenv('AUTHNET_API_LOGIN_ID'),
            'transaction_key' => getenv('AUTHNET_TRANSACTION_KEY'),
            'api_url'        => ANetEnvironment::SANDBOX,
        ];

        if (empty($this->credentials['api_login_id'])) {
            $this->markTestSkipped('Sandbox credentials not configured');
        }
    }

    public function test_connection(): void
    {
        $result = sdk_test_connection($this->credentials);
        $this->assertSame('Ok', $result['result_code']);
    }
}
```

Run integration tests separately:

```bash
# Unit tests only (fast, no network)
phpunit --exclude-group=integration

# Integration tests (requires sandbox credentials)
AUTHNET_API_LOGIN_ID=xxx AUTHNET_TRANSACTION_KEY=yyy phpunit --group=integration
```

---

## Test Data Reference

### Billing Address (Test)

```php
$test_billing = [
    'first_name' => 'Test',
    'last_name'  => 'User',
    'email'      => 'test@example.com',
    'company'    => 'Test Company',
    'address'    => '123 Test St',
    'city'       => 'Testville',
    'state'      => 'CA',
    'zip'        => '90210',
    'country'    => 'US',
];
```

### Subscription Plan (Test)

```php
$test_plan = [
    'amount'           => 9.99,
    'name'             => 'Test Monthly',
    'interval_length'  => 1,
    'interval_unit'    => 'months',
    'total_occurrences' => 12,
    'start_date'       => date('Y-m-d', strtotime('+1 day')),
];
```

### Accept.js Token (Test - Sandbox Only)

In sandbox, you can generate test tokens using the Accept.js test page or by calling Accept.js with test card data. For unit tests that need a token format but won't hit the API, use a placeholder:

```php
$test_token = str_repeat('A', 100); // meets length validation
```
