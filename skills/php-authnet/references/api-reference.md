# Authorize.Net PHP SDK — API Reference

Complete SDK class and method reference for `authorizenet/authorizenet` ^2.0.

## Table of Contents

- [SDK Namespaces](#sdk-namespaces)
- [Payment Transactions](#payment-transactions)
- [Customer Profiles (CIM)](#customer-profiles-cim)
- [Recurring Billing (ARB)](#recurring-billing-arb)
- [Accept.js Token Handling](#acceptjs-token-handling)
- [Webhooks](#webhooks)
- [Transaction Reporting](#transaction-reporting)
- [Response Codes](#response-codes)
- [Field Constraints](#field-constraints)

---

## SDK Namespaces

```php
use net\authorize\api\contract\v1 as AnetAPI;       // Data contracts
use net\authorize\api\controller as AnetController;  // Request controllers
use net\authorize\api\constants\ANetEnvironment;     // SANDBOX / PRODUCTION
```

## Payment Transactions

### CreateTransactionRequest

The universal transaction endpoint. Behavior varies by `transactionType`.

**Controller**: `AnetController\CreateTransactionController`

```php
$request = new AnetAPI\CreateTransactionRequest();
$request->setMerchantAuthentication($merchant_auth);
$request->setTransactionRequest($transaction_request);

$controller = new AnetController\CreateTransactionController($request);
$response = $controller->executeWithApiResponse($api_url);
```

### TransactionRequestType — Key Setters

| Method | Type | Required | Notes |
|--------|------|----------|-------|
| `setTransactionType()` | string | Yes | See transaction types table |
| `setAmount()` | float | Yes | Decimal (e.g., 29.99) |
| `setPayment()` | PaymentType | Conditional | Required for new charges; not for profile charges |
| `setProfile()` | CustomerProfilePaymentType | Conditional | For charging stored profiles |
| `setRefTransId()` | string | Conditional | Required for refunds, voids, prior auth capture |
| `setBillTo()` | CustomerAddressType | No | Billing address |
| `setShipTo()` | CustomerAddressType | No | Shipping address |
| `setOrder()` | OrderType | No | Order description, invoice number |
| `setCustomer()` | CustomerDataType | No | Customer email, ID |
| `setLineItems()` | LineItemType[] | No | Array of line items |
| `setTax()` | ExtendedAmountType | No | Tax info |
| `setPoNumber()` | string | No | Purchase order number |

### Transaction Types

| Value | Description |
|-------|-------------|
| `authCaptureTransaction` | Authorize and capture in one step |
| `authOnlyTransaction` | Authorize only (capture later) |
| `priorAuthCaptureTransaction` | Capture a prior auth (requires `refTransId`) |
| `refundTransaction` | Refund settled transaction (requires `refTransId` + last 4 of card) |
| `voidTransaction` | Void unsettled transaction (requires `refTransId`) |

### Refund Requirements

Refunds require the original transaction ID AND payment info (last 4 digits):

```php
$credit_card = new AnetAPI\CreditCardType();
$credit_card->setCardNumber('XXXX1234'); // last 4 digits
$credit_card->setExpirationDate('XXXX');  // literal 'XXXX'

$payment = new AnetAPI\PaymentType();
$payment->setCreditCard($credit_card);

$tx = new AnetAPI\TransactionRequestType();
$tx->setTransactionType('refundTransaction');
$tx->setAmount($refund_amount);
$tx->setRefTransId($original_transaction_id);
$tx->setPayment($payment);
```

Refund constraints:
- Transaction must be settled (usually within 24h of capture)
- Refund amount ≤ original captured amount
- Partial refunds allowed (multiple refunds up to original amount)
- Default refund window: 180 days from settlement

### Void Requirements

Voids only work on **unsettled** transactions:

```php
$tx = new AnetAPI\TransactionRequestType();
$tx->setTransactionType('voidTransaction');
$tx->setRefTransId($transaction_id);
```

### Response Parsing

```php
$response = $controller->executeWithApiResponse($api_url);

// Top-level result
$result_code = $response->getMessages()->getResultCode(); // 'Ok' or 'Error'
$messages = $response->getMessages()->getMessage();        // AnetAPI\MessagesType\MessageAType[]
$messages[0]->getCode();   // e.g., 'I00001'
$messages[0]->getText();   // e.g., 'Successful.'

// Transaction response (may be null)
$tresponse = $response->getTransactionResponse();
$tresponse->getTransId();       // Transaction ID
$tresponse->getAuthCode();      // Authorization code
$tresponse->getResponseCode();  // '1'=Approved, '2'=Declined, '3'=Error, '4'=Held
$tresponse->getAccountNumber(); // Masked card (e.g., 'XXXX1234')
$tresponse->getAccountType();   // 'Visa', 'Mastercard', etc.

// Transaction-level messages (success details)
$tresponse->getMessages();      // array of message objects (null if failed)
$tresponse->getMessages()[0]->getCode();
$tresponse->getMessages()[0]->getDescription();

// Transaction-level errors (decline/error details)
$tresponse->getErrors();        // array of error objects (null if success)
$tresponse->getErrors()[0]->getErrorCode();
$tresponse->getErrors()[0]->getErrorText();
```

### Response Code Values

| Code | Meaning |
|------|---------|
| `1` | Approved |
| `2` | Declined |
| `3` | Error |
| `4` | Held for review |

---

## Customer Profiles (CIM)

CIM stores customer payment data securely on Authorize.Net's servers.

### Hierarchy

```
CustomerProfile
├── description, email, merchantCustomerId
├── PaymentProfile[] (credit cards, bank accounts)
│   ├── billTo (CustomerAddressType)
│   └── payment (PaymentType)
└── ShippingAddress[] (CustomerAddressType)
```

### Create Customer Profile

**Controller**: `AnetController\CreateCustomerProfileController`

```php
$payment_profile = new AnetAPI\CustomerPaymentProfileType();
$payment_profile->setCustomerType('individual'); // or 'business'
$payment_profile->setBillTo($bill_to);
$payment_profile->setPayment($payment_type);

$customer_profile = new AnetAPI\CustomerProfileType();
$customer_profile->setDescription('Profile description');
$customer_profile->setEmail($email);
$customer_profile->setPaymentProfiles([$payment_profile]);

$request = new AnetAPI\CreateCustomerProfileRequest();
$request->setMerchantAuthentication($merchant_auth);
$request->setProfile($customer_profile);
$request->setValidationMode('liveMode'); // or 'testMode' for sandbox

$controller = new AnetController\CreateCustomerProfileController($request);
$response = $controller->executeWithApiResponse($api_url);

$customer_profile_id = $response->getCustomerProfileId();
$payment_profile_ids = $response->getCustomerPaymentProfileIdList(); // array
```

### Validation Modes

| Mode | Behavior |
|------|----------|
| `liveMode` | Runs $0.00 or $0.01 auth to validate card (production) |
| `testMode` | Validates format only, no auth (sandbox-safe) |
| `none` | No validation |

**Sandbox gotcha**: `liveMode` validation may fail with Accept.js opaque data in sandbox. Use `testMode` for sandbox environments.

### Create Customer Profile from Transaction

More reliable than direct creation, especially in sandbox:

```php
$request = new AnetAPI\CreateCustomerProfileFromTransactionRequest();
$request->setMerchantAuthentication($merchant_auth);
$request->setTransId($transaction_id);

// Optional: attach email
$customer = new AnetAPI\CustomerProfileBaseType();
$customer->setEmail($email);
$request->setCustomer($customer);

$controller = new AnetController\CreateCustomerProfileFromTransactionController($request);
$response = $controller->executeWithApiResponse($api_url);
```

### Add Payment Profile to Existing Customer

```php
$request = new AnetAPI\CreateCustomerPaymentProfileRequest();
$request->setMerchantAuthentication($merchant_auth);
$request->setCustomerProfileId($customer_profile_id);
$request->setPaymentProfile($payment_profile);
$request->setValidationMode($validation_mode);

$controller = new AnetController\CreateCustomerPaymentProfileController($request);
$response = $controller->executeWithApiResponse($api_url);

$new_payment_profile_id = $response->getCustomerPaymentProfileId();
```

### Get Customer Profile

```php
$request = new AnetAPI\GetCustomerProfileRequest();
$request->setMerchantAuthentication($merchant_auth);
$request->setCustomerProfileId($customer_profile_id);

$controller = new AnetController\GetCustomerProfileController($request);
$response = $controller->executeWithApiResponse($api_url);

$profile = $response->getProfile();
$payment_profiles = $profile->getPaymentProfiles(); // array
```

### Update Customer Payment Profile

```php
$request = new AnetAPI\UpdateCustomerPaymentProfileRequest();
$request->setMerchantAuthentication($merchant_auth);
$request->setCustomerProfileId($customer_profile_id);
$request->setPaymentProfile($updated_payment_profile);

$controller = new AnetController\UpdateCustomerPaymentProfileController($request);
```

### Delete Customer Profile

Deletes the profile AND all associated payment profiles and shipping addresses:

```php
$request = new AnetAPI\DeleteCustomerProfileRequest();
$request->setMerchantAuthentication($merchant_auth);
$request->setCustomerProfileId($customer_profile_id);

$controller = new AnetController\DeleteCustomerProfileController($request);
$response = $controller->executeWithApiResponse($api_url);
```

### Delete Payment Profile

```php
$request = new AnetAPI\DeleteCustomerPaymentProfileRequest();
$request->setMerchantAuthentication($merchant_auth);
$request->setCustomerProfileId($customer_profile_id);
$request->setCustomerPaymentProfileId($payment_profile_id);

$controller = new AnetController\DeleteCustomerPaymentProfileController($request);
```

### Charge Stored Profile

```php
$profile_to_charge = new AnetAPI\CustomerProfilePaymentType();
$profile_to_charge->setCustomerProfileId($customer_profile_id);

$payment_profile = new AnetAPI\PaymentProfileType();
$payment_profile->setPaymentProfileId($payment_profile_id);
$profile_to_charge->setPaymentProfile($payment_profile);

$tx = new AnetAPI\TransactionRequestType();
$tx->setTransactionType('authCaptureTransaction');
$tx->setAmount($amount);
$tx->setProfile($profile_to_charge);
```

---

## Recurring Billing (ARB)

### Create Subscription

**Controller**: `AnetController\ARBCreateSubscriptionController`

```php
$interval = new AnetAPI\PaymentScheduleType\IntervalAType();
$interval->setLength(1);       // billing interval length
$interval->setUnit('months');  // 'months' or 'days'

$schedule = new AnetAPI\PaymentScheduleType();
$schedule->setInterval($interval);
$schedule->setStartDate(new \DateTime($start_date)); // Y-m-d
$schedule->setTotalOccurrences(9999); // 9999 = unlimited

// Optional trial period
$schedule->setTrialOccurrences(1);

// Using CIM profile (recommended)
$profile = new AnetAPI\CustomerProfileIdType();
$profile->setCustomerProfileId($customer_profile_id);
$profile->setCustomerPaymentProfileId($payment_profile_id);

$subscription = new AnetAPI\ARBSubscriptionType();
$subscription->setName('Monthly Membership'); // max 50 chars
$subscription->setPaymentSchedule($schedule);
$subscription->setAmount($amount);
$subscription->setProfile($profile);
$subscription->setTrialAmount(0.00); // if trial

$request = new AnetAPI\ARBCreateSubscriptionRequest();
$request->setMerchantAuthentication($merchant_auth);
$request->setSubscription($subscription);

$controller = new AnetController\ARBCreateSubscriptionController($request);
$response = $controller->executeWithApiResponse($api_url);

$subscription_id = $response->getSubscriptionId();
```

### Interval Constraints

| Unit | Min Length | Max Length |
|------|-----------|-----------|
| `days` | 7 | 365 |
| `months` | 1 | 12 |

### Cancel Subscription

```php
$request = new AnetAPI\ARBCancelSubscriptionRequest();
$request->setMerchantAuthentication($merchant_auth);
$request->setSubscriptionId($subscription_id);

$controller = new AnetController\ARBCancelSubscriptionController($request);
$response = $controller->executeWithApiResponse($api_url);
```

### Get Subscription Status

```php
$request = new AnetAPI\ARBGetSubscriptionStatusRequest();
$request->setMerchantAuthentication($merchant_auth);
$request->setSubscriptionId($subscription_id);

$controller = new AnetController\ARBGetSubscriptionStatusController($request);
$response = $controller->executeWithApiResponse($api_url);

$status = $response->getStatus(); // active, expired, suspended, canceled, terminated
```

### Subscription Statuses

| Status | Meaning |
|--------|---------|
| `active` | Billing normally |
| `expired` | All occurrences completed |
| `suspended` | Payment failed (auto-retry pending) |
| `canceled` | Merchant canceled via API or UI |
| `terminated` | System terminated (too many failures) |

### Update Subscription

Once created, you CANNOT change: start date, interval length/unit, trial period. Create a new subscription for those changes.

You CAN update: amount, payment profile, name, billing address.

```php
$subscription = new AnetAPI\ARBSubscriptionType();
$subscription->setAmount($new_amount);

$request = new AnetAPI\ARBUpdateSubscriptionRequest();
$request->setMerchantAuthentication($merchant_auth);
$request->setSubscriptionId($subscription_id);
$request->setSubscription($subscription);

$controller = new AnetController\ARBUpdateSubscriptionController($request);
```

---

## Accept.js Token Handling

Accept.js sends card data directly to Authorize.Net from the browser, returning a one-time payment nonce.

### Payment Nonce → OpaqueDataType

```php
$opaque_data = new AnetAPI\OpaqueDataType();
$opaque_data->setDataDescriptor('COMMON.ACCEPT.INAPP.PAYMENT');
$opaque_data->setDataValue($nonce_from_acceptjs);

$payment = new AnetAPI\PaymentType();
$payment->setOpaqueData($opaque_data);
```

### Token Lifecycle

- Valid for **15 minutes** after creation
- Single-use — consumed on first API call
- Contains no readable card data (opaque)

### Accept.js vs Accept Hosted vs Accept.UI

| Method | PCI Level | Control | Description |
|--------|-----------|---------|-------------|
| Accept.js (custom form) | SAQ A-EP | Full | Your form, JS tokenizes before submit |
| Accept.js (hosted form) | SAQ A | Medium | Authorize.Net renders fields in modal |
| Accept Hosted | SAQ A | Low | Full redirect/iframe to Authorize.Net page |

---

## Webhooks

### Event Types

**Payment events** (triggered by transactions):

| Event | Description |
|-------|-------------|
| `net.authorize.payment.authcapture.created` | Auth+capture completed |
| `net.authorize.payment.authorization.created` | Auth-only completed |
| `net.authorize.payment.capture.created` | Prior auth captured |
| `net.authorize.payment.refund.created` | Refund processed |
| `net.authorize.payment.void.created` | Transaction voided |
| `net.authorize.payment.priorAuthCapture.created` | Prior auth captured |

**Subscription events**:

| Event | Description |
|-------|-------------|
| `net.authorize.customer.subscription.created` | Subscription created |
| `net.authorize.customer.subscription.updated` | Subscription modified |
| `net.authorize.customer.subscription.suspended` | Payment failed |
| `net.authorize.customer.subscription.terminated` | System terminated |
| `net.authorize.customer.subscription.cancelled` | Merchant cancelled |
| `net.authorize.customer.subscription.expiring` | Approaching end date |

**Customer profile events**:

| Event | Description |
|-------|-------------|
| `net.authorize.customer.created` | Customer profile created |
| `net.authorize.customer.updated` | Customer profile updated |
| `net.authorize.customer.deleted` | Customer profile deleted |
| `net.authorize.customer.paymentProfile.created` | Payment profile added |
| `net.authorize.customer.paymentProfile.updated` | Payment profile updated |
| `net.authorize.customer.paymentProfile.deleted` | Payment profile deleted |

**Fraud events**:

| Event | Description |
|-------|-------------|
| `net.authorize.payment.fraud.approved` | Held transaction approved |
| `net.authorize.payment.fraud.declined` | Held transaction declined |
| `net.authorize.payment.fraud.held` | Transaction held for review |

### Subscription Billing: Which Event Fires?

When a subscription charges the next billing cycle, it fires a **payment event** (`net.authorize.payment.authcapture.created`), NOT a subscription event. Subscription events only fire for lifecycle changes (create, cancel, suspend, terminate).

### HMAC-SHA512 Signature Validation

Authorize.Net signs webhook payloads with the Signature Key using HMAC-SHA512. The signature is in the `X-ANET-Signature` header as `sha512=<HEXDIGEST>`.

```php
function validate_webhook_signature(
    string $raw_body,
    ?string $signature_header,
    string $signature_key
): bool {
    if (empty($raw_body) || empty($signature_header) || empty($signature_key)) {
        return false;
    }

    $prefix = 'sha512=';
    if (stripos($signature_header, $prefix) !== 0) {
        return false;
    }

    $received = strtoupper(substr($signature_header, strlen($prefix)));
    $computed = strtoupper(hash_hmac('sha512', $raw_body, $signature_key));

    return hash_equals($computed, $received);
}
```

### Webhook Payload Structure

```json
{
    "notificationId": "unique-notification-id",
    "eventType": "net.authorize.payment.authcapture.created",
    "eventDate": "2025-01-15T12:00:00Z",
    "webhookId": "webhook-config-id",
    "payload": {
        "responseCode": 1,
        "authCode": "ABC123",
        "avsResponse": "Y",
        "authAmount": 29.99,
        "entityName": "transaction",
        "id": "123456789"
    }
}
```

### Idempotency

Authorize.Net may deliver webhooks multiple times. Use `notificationId` for deduplication:

```php
$idempotency_key = 'ima_wh_' . md5($notification_id);
if (get_transient($idempotency_key)) {
    return; // already processed
}
set_transient($idempotency_key, true, 3 * DAY_IN_SECONDS);
```

---

## Transaction Reporting

### Get Transaction Details

```php
$request = new AnetAPI\GetTransactionDetailsRequest();
$request->setMerchantAuthentication($merchant_auth);
$request->setTransId($transaction_id);

$controller = new AnetController\GetTransactionDetailsController($request);
$response = $controller->executeWithApiResponse($api_url);

$tx = $response->getTransaction();
$tx->getTransId();
$tx->getTransactionStatus(); // settledSuccessfully, authorizedPendingCapture, etc.
$tx->getSettleAmount();
$tx->getSubmitTimeUTC();
```

### Get Merchant Details (Connection Test)

```php
$request = new AnetAPI\GetMerchantDetailsRequest();
$request->setMerchantAuthentication($merchant_auth);

$controller = new AnetController\GetMerchantDetailsController($request);
$response = $controller->executeWithApiResponse($api_url);
// result_code 'Ok' = credentials valid
```

---

## Response Codes

### API-Level Result Codes

| Result | Meaning |
|--------|---------|
| `Ok` | Request processed (check transaction-level for actual result) |
| `Error` | API-level failure (auth, format, etc.) |

### Common Error Codes

| Code | Description | Recovery |
|------|-------------|----------|
| `E00001` | Internal error | Retry after delay |
| `E00003` | Invalid credentials | Verify api_login_id and transaction_key |
| `E00007` | Permission denied | Check account permissions |
| `E00012` | Duplicate subscription | Check existing subscriptions |
| `E00027` | Transaction declined | User should try different payment method |
| `E00039` | Duplicate record | Extract existing ID from error text with regex `/ID\s+(\d+)/` |
| `E00040` | Record not found | Profile was deleted or ID is wrong |
| `E00042` | Max payment profiles reached | Delete an old profile first (max 10 per customer) |
| `E00043` | Max shipping addresses reached | Delete an old address first |

### Transaction Response Codes

| Code | Meaning | Action |
|------|---------|--------|
| `1` | Approved | Process success |
| `2` | Declined | Show decline message to user |
| `3` | Error | Log and show generic error |
| `4` | Held for review | Wait for webhook notification |

---

## Field Constraints

| Field | Max Length | Notes |
|-------|-----------|-------|
| Subscription name | 50 chars | Truncate, don't reject |
| Order description | 255 chars | Truncate, don't reject |
| Invoice number | 20 chars | Alphanumeric |
| First/Last name | 50 chars each | |
| Company | 50 chars | |
| Address | 60 chars | |
| City | 40 chars | |
| State | 40 chars | |
| Zip | 20 chars | |
| Country | 60 chars | |
| Phone | 25 chars | |
| Email | 255 chars | |
| Customer ID | 20 chars | merchantCustomerId |
| Payment profiles per customer | 10 max | Error E00042 if exceeded |
| Shipping addresses per customer | 100 max | |
