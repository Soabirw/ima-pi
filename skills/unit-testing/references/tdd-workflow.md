# TDD Workflow

## Red-Green-Refactor Mechanics

### Red: Write a Failing Test

Write the test FIRST. It must fail for the right reason.

```javascript
// 1. Start with the desired behavior
test('filters out inactive users', () => {
  const users = [
    { name: 'Alice', active: true },
    { name: 'Bob', active: false },
    { name: 'Carol', active: true },
  ]
  expect(getActiveUsers(users)).toEqual([
    { name: 'Alice', active: true },
    { name: 'Carol', active: true },
  ])
})
// Fails: getActiveUsers is not defined ✓ (correct failure)
```

**Key:** The test should fail because the feature doesn't exist yet — not because of a typo or setup error.

### Green: Make It Pass (Minimum Code)

Write the simplest code that makes the test pass. Fight the urge to generalize.

```javascript
// 2. Simplest passing implementation
const getActiveUsers = (users) => users.filter(u => u.active)
```

**Key:** Don't optimize. Don't handle edge cases you haven't tested. Just make it green.

### Refactor: Clean Up

With a passing test as your safety net, improve the code.

- Rename for clarity
- Extract shared logic
- Remove duplication
- Improve performance (only if needed)

**Key:** Tests stay green throughout refactoring. If they go red, you broke something.

## TDD with Pure Functions

Pure functions are TDD's sweet spot. No setup, no teardown, no mocking.

```
Input → Function → Output
Test:   Input → Function → Assert Output
```

The cycle is fast:
1. Write test with input/output pair (10 seconds)
2. Write function (10 seconds)
3. Run test (1 second)
4. Refactor if needed (30 seconds)

### Table-Driven TDD

For pure functions, use parameterized tests to cover multiple cases efficiently:

```javascript
test.each([
  [0, 'F'],
  [59, 'F'],
  [60, 'D'],
  [70, 'C'],
  [80, 'B'],
  [90, 'A'],
  [100, 'A'],
])('score %i gets grade %s', (score, expected) => {
  expect(getGrade(score)).toBe(expected)
})
```

Write all cases first (red), then implement until all pass (green).

## TDD for Impure Boundaries

When TDD meets side effects, use the **functional core / imperative shell** pattern:

### 1. Define the Interface

```typescript
// What does the boundary need to provide?
type UserRepository = {
  findById: (id: string) => Promise<User | null>
  save: (user: User) => Promise<void>
}
```

### 2. TDD the Pure Logic

```javascript
// Test the decision logic, not the I/O
test('deactivates user when last login > 90 days ago', () => {
  const user = { lastLogin: daysAgo(91), active: true }
  expect(shouldDeactivate(user)).toBe(true)
})

test('keeps user active when last login < 90 days ago', () => {
  const user = { lastLogin: daysAgo(30), active: true }
  expect(shouldDeactivate(user)).toBe(false)
})
```

### 3. Wire the Shell (Minimal Integration Test)

```javascript
// One integration test to verify wiring
test('deactivation job processes inactive users', async () => {
  const fakeRepo = createFakeUserRepo([
    { id: '1', lastLogin: daysAgo(91), active: true },
  ])
  await runDeactivationJob(fakeRepo)
  expect(fakeRepo.findById('1')).resolves.toMatchObject({ active: false })
})
```

## When TDD Slows You Down

TDD is a tool, not a dogma. Skip it when:

### Exploratory / Prototype Code

You're figuring out what the code should even do. TDD assumes you know the desired behavior.

**Instead:** Spike first, extract and test after.

### Trivial Glue Code

Code that just wires things together with no logic.

```javascript
// No TDD needed for this
app.get('/users', authenticate, userController.list)
```

### UI Layout / Styling

Visual output is better verified by looking at it, not by asserting CSS properties.

**Instead:** Use visual regression tests (screenshot comparison) after the layout stabilizes.

### Rapidly Changing Requirements

If the spec changes daily, tests written today are deleted tomorrow.

**Instead:** Wait for requirements to stabilize, then add tests.

## TDD Anti-Patterns

### Testing Too Much at Once

Write one test, make it pass. Repeat. Don't write 10 failing tests and try to make them all pass simultaneously.

### Gold-Plating in Green Phase

The green phase is about making it work, not making it elegant. Save elegance for refactor.

### Skipping Refactor Phase

Red-green without refactor accumulates technical debt. The refactor step is where design emerges.

### Testing Private Methods

If you feel the need to test a private method, it's a sign that the method should be extracted as a separate pure function.

### Assertion-Free Tests

A test that only checks "it doesn't throw" is not a test. Assert on the output.
