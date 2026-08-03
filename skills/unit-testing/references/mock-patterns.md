# Mock Patterns for FP Codebases

## The FP Alternative to Mocking

Before reaching for a mock, ask: **can I extract the pure logic instead?**

### Before (Hard to Test — Needs Mocks)

```javascript
// Impure: mixed logic + side effects
function processOrder(orderId) {
  const order = db.getOrder(orderId)         // side effect
  const total = order.items.reduce((s, i) => s + i.price * i.qty, 0)
  const tax = total * 0.08
  const discount = total > 100 ? total * 0.1 : 0
  db.updateOrder(orderId, { total, tax, discount })  // side effect
  return { total, tax, discount }
}
```

### After (Easy to Test — No Mocks Needed)

```javascript
// Pure: extract the logic
const calculateOrderTotals = (items, taxRate = 0.08, discountThreshold = 100) => {
  const total = items.reduce((s, i) => s + i.price * i.qty, 0)
  const tax = total * taxRate
  const discount = total > discountThreshold ? total * 0.1 : 0
  return { total, tax, discount }
}

// Impure shell: thin wrapper
function processOrder(orderId) {
  const order = db.getOrder(orderId)
  const totals = calculateOrderTotals(order.items)
  db.updateOrder(orderId, totals)
  return totals
}
```

Now `calculateOrderTotals` is tested with zero mocks. The impure shell is thin enough to verify by inspection or a single integration test.

## When Mocking IS Appropriate

Mock when the dependency is:

| Dependency | Mock? | Why |
|-----------|-------|-----|
| External API (Stripe, Twilio) | Yes | Unreliable, slow, costs money |
| Database | Yes (for unit tests) | Slow, requires setup/teardown |
| Filesystem | Yes | Non-deterministic, platform-specific |
| Time/Date | Yes | Non-deterministic |
| Random/UUID | Yes | Non-deterministic |
| Your own pure functions | **No** | Use the real thing |
| Your own classes | **Rarely** | Extract the logic instead |

## Mock Types: When to Use Each

### Stub (Default Choice)

Returns canned data. Use for most cases.

```javascript
// JS: Simple stub
const getUser = vi.fn().mockReturnValue({ id: 1, name: 'Alice' })

// PHP: PHPUnit stub
$repo = $this->createStub(UserRepository::class);
$repo->method('find')->willReturn(new User(1, 'Alice'));
```

### Spy (Verify Calls)

Records calls for later assertion. Use when you need to verify a side effect happened.

```javascript
// JS: Spy on a method
const sendEmail = vi.fn()
processSignup(user, { sendEmail })
expect(sendEmail).toHaveBeenCalledWith(user.email, expect.any(String))

// PHP: PHPUnit expects
$mailer = $this->createMock(Mailer::class);
$mailer->expects($this->once())
       ->method('send')
       ->with($this->equalTo('alice@example.com'));
```

### Fake (Simplified Implementation)

A working but simplified version. Use for complex interfaces.

```javascript
// JS: In-memory store as a fake
const createFakeStore = () => {
  const data = new Map()
  return {
    get: (key) => data.get(key),
    set: (key, value) => data.set(key, value),
    delete: (key) => data.delete(key),
  }
}
```

### Full Mock (Almost Never)

Strict expectations on exact call sequences. Couples tests tightly to implementation.

**Use only when:** the exact call sequence IS the behavior (e.g., protocol compliance, ordered operations).

## Language-Specific Tooling

### JavaScript/TypeScript

| Tool | Best For |
|------|----------|
| `vi.fn()` / `jest.fn()` | Stubs and spies |
| `vi.mock()` / `jest.mock()` | Module-level mocking |
| `msw` (Mock Service Worker) | HTTP API mocking (integration/E2E) |
| `@testing-library/*` | Component testing without implementation details |

### PHP

| Tool | Best For |
|------|----------|
| PHPUnit `createStub()` | Simple return values |
| PHPUnit `createMock()` | Stubs with expectations |
| `Brain\Monkey` | WordPress function mocking |
| `WP_Mock` | WordPress hook/filter mocking |
| `Mockery` | Complex mocking (use sparingly) |

## Anti-Patterns

### Mocking What You Own

```javascript
// BAD: Mocking your own utility
const calculateTax = vi.fn().mockReturnValue(8.0)
const result = processOrder(items, { calculateTax })
expect(result.tax).toBe(8.0)  // This proves nothing!
```

You're testing that your test setup works, not that the code works. Use the real function.

### Deep Mock Chains

```javascript
// BAD: Mock chain hell
const mockDb = {
  getConnection: vi.fn().mockReturnValue({
    query: vi.fn().mockReturnValue({
      rows: vi.fn().mockReturnValue([{ id: 1 }])
    })
  })
}
```

If you need this, the code needs refactoring, not more mocks. Extract the pure logic.

### Mocking to Achieve Coverage

```javascript
// BAD: Mocking just to hit a coverage number
const fs = vi.mock('fs')
fs.readFileSync.mockReturnValue('data')
// ... test that proves readFileSync was called with the right path
```

This tests that you called `readFileSync`, not that your logic is correct. Extract the logic that processes the data and test that instead.

### Over-Specified Mocks

```javascript
// BAD: Testing implementation, not behavior
expect(mockDb.query).toHaveBeenCalledWith(
  'SELECT * FROM users WHERE id = ? AND active = ?',
  [1, true]
)
```

This breaks if you rename a column or change the query. Test the behavior: "given user ID 1, returns the user's data."
