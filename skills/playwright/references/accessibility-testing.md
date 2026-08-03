# Accessibility Testing

Automated WCAG compliance checks using Playwright with axe-core.

## Table of Contents

- [Setup](#setup)
- [Basic Scanning](#basic-scanning)
- [Fixtures for Reusable Config](#fixtures-for-reusable-config)
- [Targeted Scanning](#targeted-scanning)
- [Common Violations](#common-violations)
- [Integration with E2E Tests](#integration-with-e2e-tests)

## Setup

```bash
npm install -D @axe-core/playwright
```

## Basic Scanning

```typescript
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('homepage has no a11y violations', async ({ page }) => {
  await page.goto('/')

  const results = await new AxeBuilder({ page }).analyze()

  expect(results.violations).toEqual([])
})
```

## Fixtures for Reusable Config

Create a shared axe fixture with consistent WCAG rules across all tests.

```typescript
// fixtures.ts
import { test as base } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

type A11yFixtures = {
  makeAxeBuilder: () => AxeBuilder
}

export const test = base.extend<A11yFixtures>({
  makeAxeBuilder: async ({ page }, use) => {
    await use(() =>
      new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    )
  },
})

export { expect } from '@playwright/test'
```

```typescript
// tests/a11y/pages.spec.ts
import { test, expect } from '../../fixtures'

test('login page is accessible', async ({ page, makeAxeBuilder }) => {
  await page.goto('/login')
  const results = await makeAxeBuilder().analyze()
  expect(results.violations).toEqual([])
})

test('dashboard is accessible', async ({ page, makeAxeBuilder }) => {
  await page.goto('/dashboard')
  const results = await makeAxeBuilder().analyze()
  expect(results.violations).toEqual([])
})
```

## Targeted Scanning

### Scan Specific Sections

```typescript
// Only scan the main content area
const results = await new AxeBuilder({ page })
  .include('#main-content')
  .analyze()

// Scan everything except a known-broken third-party widget
const results = await new AxeBuilder({ page })
  .exclude('.third-party-chat-widget')
  .analyze()
```

### Specific Rule Sets

```typescript
// Only check color contrast
const results = await new AxeBuilder({ page })
  .withRules(['color-contrast'])
  .analyze()

// Disable specific rules (with justification)
const results = await new AxeBuilder({ page })
  .disableRules(['color-contrast'])  // Third-party component, tracked in JIRA-123
  .analyze()
```

## Common Violations

| Violation | Fix | Impact |
|-----------|-----|--------|
| Missing alt text | Add `alt` attribute to `<img>` tags | Critical |
| Missing form labels | Associate `<label>` with inputs via `for`/`id` | Critical |
| Insufficient contrast | Adjust foreground/background colors to meet 4.5:1 ratio | Serious |
| Missing landmark regions | Wrap content in `<main>`, `<nav>`, `<header>` | Moderate |
| Missing page title | Add descriptive `<title>` element | Serious |
| Duplicate IDs | Ensure all `id` attributes are unique | Moderate |
| Missing language attribute | Add `lang` attribute to `<html>` | Serious |

## Integration with E2E Tests

Run accessibility checks as part of existing E2E flows, not just standalone audits.

```typescript
test('checkout flow is accessible at each step', async ({ page, makeAxeBuilder }) => {
  // Step 1: Cart page
  await page.goto('/cart')
  let a11y = await makeAxeBuilder().analyze()
  expect(a11y.violations).toEqual([])

  // Step 2: Shipping form
  await page.getByRole('button', { name: 'Proceed to shipping' }).click()
  a11y = await makeAxeBuilder().analyze()
  expect(a11y.violations).toEqual([])

  // Step 3: Payment form
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  a11y = await makeAxeBuilder().analyze()
  expect(a11y.violations).toEqual([])
})
```

### Dedicated A11y Project

```typescript
// playwright.config.ts — separate project for a11y tests
projects: [
  {
    name: 'accessibility',
    testDir: './tests/a11y',
    use: { ...devices['Desktop Chrome'] },
  },
],
```
