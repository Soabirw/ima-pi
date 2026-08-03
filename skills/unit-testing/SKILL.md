---
name: "unit-testing"
description: "Test workflow orchestration — decision tree routing to domain skills (phpunit-wp, playwright, js-fp, php-fp). TDD, test strategy, mock decisions, quality checklists. Triggers on: unit test, write tests, TDD, test coverage, mock, test strategy."
---

# Unit Testing - Orchestration Skill

Pure functions are trivially testable. Hard-to-test code is a design problem, not a test setup problem.

**Core rules:**
- Extract pure logic — separate decisions from effects
- Test behavior, not implementation
- Bottom-heavy pyramid: many unit, few integration, fewer E2E
- Mock only boundaries (DB, network, filesystem), not your own code

## Decision Tree: Which Skills

```
What are you testing?
├── WordPress PHP plugin/theme?
│   → phpunit-wp (primary) + php-fp + php-fp-wordpress
│
├── General PHP (non-WordPress)?
│   → php-fp (primary)
│
├── JavaScript/TypeScript?
│   ├── React components? → js-fp-react + js-fp
│   ├── Vue components?   → js-fp-vue + js-fp
│   └── General JS/TS?   → js-fp (primary)
│
├── End-to-end / browser? → playwright (primary)
│
└── Unknown / mixed?
    → functional-programmer → route to domain skill once clear
```

## Workflow: Adding Tests

**Step 1 — Analyze:** Read code under test. Identify pure functions vs impure boundaries. Map dependencies (DB, filesystem, network, global state).

**Step 2 — Classify:**

| Code Type | Test Type | Speed | Mocking |
|-----------|-----------|-------|---------|
| Pure function | Unit | Fast (<10ms) | None |
| Injected deps | Unit | Fast | Stub deps |
| WP hook/filter | Unit or integration | Medium | Mock WP functions |
| API endpoint | Integration | Medium | Mock external services |
| Full user workflow | E2E | Slow | None (real browser) |

**Step 3 — Structure:**
- PHP: `tests/Unit/`, `tests/Integration/` (mirror `src/`)
- JS/TS: colocated `*.test.ts` or `__tests__/`
- E2E: `tests/e2e/` or `e2e/`

**Step 4 — Write:** `Arrange → Act → Assert` (one behavior per test)
- Test name = behavior description: `it('returns empty array when no items match filter')`
- One assertion per concept; no logic in tests; minimal test data

**Step 5 — Verify:** Run suite, all green, no unexplained skips, coverage meets floor.

## TDD: Red-Green-Refactor

```
1. RED    — Write failing test for next behavior
2. GREEN  — Minimum code to pass
3. REFACTOR — Clean up, keep green
```

Skip TDD when: exploring/prototyping, trivial/obvious implementation, pure glue code.

## Mock Decision Tree

```
Is the dependency hard to test?
├── No → Don't mock. Test directly.
├── Yes, I own the code
│   ├── Can I extract pure logic? → Extract it. Test the pure part.
│   └── Can I inject the dependency? → Inject it. Pass a stub.
└── Yes, external (DB, API, filesystem, time) → Mock it.
```

| Mock Type | What it does | When |
|-----------|-------------|------|
| Stub | Returns canned data | Default choice |
| Spy | Records calls | When verifying a call was made |
| Fake | Working simplified impl | Complex interfaces (in-memory DB) |
| Full mock | Strict call expectations | Almost never |

## Quality Checklist

- [ ] Tests verify behavior, not implementation
- [ ] Each test name describes the scenario
- [ ] No test depends on another's state
- [ ] No timers, real network, or filesystem in unit tests
- [ ] Pure functions tested without mocking
- [ ] Mocks only at impure boundaries
- [ ] Edge cases: empty input, null/undefined, boundary values
- [ ] Error paths tested (not just happy path)
- [ ] Unit suite runs < 10s

## Anti-Patterns

| Anti-Pattern | Fix |
|-------------|-----|
| Testing implementation details | Test behavior/output instead |
| Mocking everything | Extract pure logic, mock only boundaries |
| Giant test setup | Simplify code under test or use factories |
| Copy-paste test bodies | Use parameterized/table-driven tests |
| Testing framework behavior | Trust the framework |
| 100% coverage target | Set a floor, not a ceiling |
| `sleep()` in tests | Use deterministic waits or fix the design |

## Domain Skill Reference

| Context | Primary Skill | Reference Files |
|---------|--------------|-----------------|
| WordPress PHP | `phpunit-wp` | `php-fp/references/testing-patterns.md`, `php-fp-wordpress/references/testing-strategy.md` |
| General PHP | `php-fp` | `php-fp/references/testing-patterns.md` |
| JavaScript/TypeScript | `js-fp` | `js-fp/references/testing-patterns.md` |
| Vue.js | `js-fp-vue` | `js-fp-vue/references/testing.md` |
| React | `js-fp-react` | `js-fp/references/testing-patterns.md` |
| E2E / Browser | `playwright` | (self-contained skill) |
