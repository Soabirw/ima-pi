# Test Strategy for FP Codebases

## The Test Pyramid (FP Edition)

FP codebases are bottom-heavy by nature. Pure functions are trivially testable — lean into this.

```
        /  E2E  \          Few: critical user journeys only
       /----------\
      / Integration \      Some: boundary wiring, API contracts
     /----------------\
    /    Unit Tests     \   Many: pure functions, transformations, validators
   /____________________\
```

### Why FP Pyramids Are Bottom-Heavy

- Pure functions need zero setup → unit tests are cheap
- Side effects are isolated at boundaries → integration tests are focused
- Business logic is testable without infrastructure → fast feedback

## Coverage Strategy

**Coverage is a floor, not a ceiling.**

### Setting the Floor

- New projects: 80% line coverage as a starting point
- Legacy projects: measure current coverage, set floor 5% below, ratchet up
- Never chase 100% — the last 20% costs more than the first 80%

### What to Cover

| Priority | What | Why |
|----------|------|-----|
| High | Pure business logic | Core value, easy to test |
| High | Data transformations | Bugs here corrupt everything downstream |
| High | Validation functions | Security and correctness boundary |
| Medium | Integration wiring | Verify components connect correctly |
| Medium | Error handling paths | Prevent silent failures |
| Low | Glue code / configuration | Low logic density |
| Skip | Framework boilerplate | Trust the framework |

### What NOT to Cover

- Trivial getters/setters with no logic
- Framework-generated code (migrations, stubs)
- Configuration files
- Type definitions (TypeScript interfaces, PHP type hints)

## When to Write Each Test Type

### Unit Tests

Write when:
- Function takes input, returns output (pure)
- Logic has branches (if/else, switch, pattern matching)
- Data transformation or validation
- Algorithm implementation

Skip when:
- Code is pure glue (just wires things together)
- Logic is trivially obvious (`return this.name`)

### Integration Tests

Write when:
- Verifying database queries return correct data
- API endpoint contracts (request → response shape)
- Multiple components must work together
- Third-party service integration points

Skip when:
- You can test the logic as a pure function instead
- The integration is trivial and well-typed

### E2E Tests

Write when:
- Critical user journeys (login, checkout, signup)
- Complex multi-step workflows
- Regression tests for bugs that slipped through unit/integration

Skip when:
- The behavior is fully covered by unit + integration tests
- The UI is rapidly changing (tests will be constantly rewritten)
- The test would be flaky by nature (animations, timing)

## Retrofitting Tests onto Legacy Code

Legacy code without tests is the norm. Don't try to add 100% coverage at once.

### The Characterization Test Approach

1. **Identify the change point** — what code are you about to modify?
2. **Write characterization tests** — tests that document current behavior (even if buggy)
3. **Extract pure logic** — pull testable functions out of the tangled code
4. **Test the extracted logic** — proper unit tests for the new pure functions
5. **Make your change** — now you have a safety net
6. **Update tests** — adjust characterization tests if behavior intentionally changed

### Priority Order for Legacy Code

1. Code you're about to change (safety net)
2. Code with known bugs (prevent regression)
3. Business-critical paths (high impact if broken)
4. Frequently modified code (high churn = high risk)
5. Everything else (only if you have time)

### The Strangler Pattern for Tests

Don't rewrite all tests at once. Instead:
- Every time you touch legacy code, add tests for what you changed
- Over time, coverage grows organically where it matters most
- Old untested code stays untested until it needs to change

## When NOT to Test

Testing has diminishing returns. Don't test:

- **Prototype/spike code** — it's throwaway by definition
- **One-off scripts** — run it, verify manually, done
- **Configuration** — JSON/YAML files don't need unit tests
- **Type system guarantees** — if TypeScript/PHP types prevent it, don't test it
- **Third-party library internals** — test your usage, not their code
- **Obvious glue code** — `app.use(cors())` doesn't need a test
