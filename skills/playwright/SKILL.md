---
name: "playwright"
description: "End-to-end testing and QA automation with Playwright + TypeScript. Test strategy, locators, fixtures, POM, assertions, network mocking, visual regression, accessibility, and CI/CD. Use when: writing E2E tests, creating page objects, setting up test fixtures, mocking API responses, visual regression testing, accessibility audits, configuring Playwright projects, debugging flaky tests, or when user mentions Playwright, E2E, end-to-end, browser testing, test automation, QA automation, getByRole, locator, toBeVisible, toHaveScreenshot, or page.route."
---

# Playwright + QA Automation

E2E testing with Playwright and TypeScript.

## QA Strategy

Test critical user journeys (login, checkout, signup). Don't duplicate unit test coverage. Test integration points and real workflows, not implementation details. Each test must be self-contained — set up its own data via API, never depend on another test's state.

```typescript
// GOOD: Real user journey
test('user completes checkout flow', async ({ page }) => {
  await page.goto('/products')
  await page.getByRole('button', { name: 'Add to cart' }).first().click()
  await page.getByRole('link', { name: 'Cart' }).click()
  await page.getByRole('button', { name: 'Checkout' }).click()
  await expect(page.getByText('Order confirmed')).toBeVisible()
})

// BAD: Brittle selectors + hard waits
await page.click('#product-123 > .btn-primary')
await page.waitForTimeout(2000)  // never do this
```

## Locator Strategy

| Priority | Locator | Example |
|----------|---------|---------|
| 1 | Role | `getByRole('button', { name: 'Submit' })` |
| 2 | Label | `getByLabel('Email address')` |
| 3 | Placeholder | `getByPlaceholder('Enter email')` |
| 4 | Text | `getByText('Welcome back')` |
| 5 | Test ID | `getByTestId('submit-btn')` |
| 6 | CSS/XPath | `locator('.btn-primary')` — last resort |

```typescript
// Scoped locators for disambiguation
const dialog = page.getByRole('dialog')
await dialog.getByRole('button', { name: 'Confirm' }).click()

// Filter locators for lists
await page.getByRole('listitem').filter({ hasText: 'Product A' }).click()
```

## Assertions

Always use web-first assertions — they auto-wait and retry.

```typescript
// CORRECT: Web-first (auto-wait + retry)
await expect(page.getByText('Success')).toBeVisible()
await expect(page.getByRole('heading')).toHaveText('Dashboard')
await expect(page).toHaveURL(/\/dashboard/)

// WRONG: Race condition
expect(await page.getByText('Success').isVisible()).toBe(true)
```

Key assertions:
```typescript
await expect(locator).toBeVisible() / toBeHidden()
await expect(locator).toHaveText('exact') / toContainText('partial')
await expect(locator).toHaveValue('val') / toBeChecked() / toBeDisabled()
await expect(page.getByRole('listitem')).toHaveCount(3)
await expect(page).toHaveURL(/dashboard/) / toHaveTitle(/Dashboard/)
```

## Page Object Model

```typescript
// pages/LoginPage.ts
import { type Page, type Locator, expect } from '@playwright/test'

export class LoginPage {
  readonly emailInput: Locator
  readonly passwordInput: Locator
  readonly submitButton: Locator
  readonly errorMessage: Locator

  constructor(private readonly page: Page) {
    this.emailInput = page.getByLabel('Email')
    this.passwordInput = page.getByLabel('Password')
    this.submitButton = page.getByRole('button', { name: 'Sign in' })
    this.errorMessage = page.getByRole('alert')
  }

  async goto() { await this.page.goto('/login') }
  async login(email: string, password: string) {
    await this.emailInput.fill(email)
    await this.passwordInput.fill(password)
    await this.submitButton.click()
  }
  async expectError(message: string) {
    await expect(this.errorMessage).toContainText(message)
  }
}
```

### Fixtures

Register page objects as fixtures instead of beforeEach/afterEach:

```typescript
// fixtures.ts
import { test as base } from '@playwright/test'
import { LoginPage } from './pages/LoginPage'

export const test = base.extend<{ loginPage: LoginPage }>({
  loginPage: async ({ page }, use) => { await use(new LoginPage(page)) },
})
export { expect } from '@playwright/test'
```

```typescript
// tests/login.spec.ts
import { test, expect } from '../fixtures'

test('successful login redirects to dashboard', async ({ loginPage, dashboardPage }) => {
  await loginPage.goto()
  await loginPage.login('user@example.com', 'password123')
  await expect(dashboardPage.heading).toBeVisible()
})
```

### Auth State (Global Setup)

```typescript
// global-setup.ts
import { chromium, type FullConfig } from '@playwright/test'

export default async function globalSetup(config: FullConfig) {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.goto('/login')
  await page.getByLabel('Email').fill(process.env.TEST_USER!)
  await page.getByLabel('Password').fill(process.env.TEST_PASSWORD!)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('/dashboard')
  await page.context().storageState({ path: 'auth/user.json' })
  await browser.close()
}

// fixture usage
authenticatedPage: async ({ browser }, use) => {
  const context = await browser.newContext({ storageState: 'auth/user.json' })
  const page = await context.newPage()
  await use(page)
  await context.close()
}
```

## Project Structure

```
tests/
├── e2e/          # Test specs grouped by feature
├── pages/        # One page object per page/section
├── components/   # Shared: Modal.ts, DataTable.ts, Navigation.ts
├── fixtures.ts   # Extended test object (single export)
├── global-setup.ts
└── playwright.config.ts
```

## Configuration

```typescript
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'blob' : 'html',
  globalSetup: './tests/global-setup.ts',
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 5'] } },
    { name: 'mobile-safari', use: { ...devices['iPhone 13'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
})
```

## Network Mocking

```typescript
// Mock endpoint
await page.route('**/api/users', route => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify([{ id: 1, name: 'Test User' }]),
}))

// Modify real response
await page.route('**/api/products', async route => {
  const response = await route.fetch()
  const json = await response.json()
  json.push({ id: 999, name: 'Test Product' })
  await route.fulfill({ response, json })
})

// Block resources
await page.route('**/*.{png,jpg,gif}', route => route.abort())

// Add auth headers
await page.route('**/api/**', route =>
  route.continue({ headers: { ...route.request().headers(), Authorization: 'Bearer test-token' } })
)
```

See [references/network-mocking.md](references/network-mocking.md) for HAR recording, API-first setup, error simulation.

## Visual Regression

```typescript
await expect(page).toHaveScreenshot()
await expect(page.getByTestId('chart')).toHaveScreenshot('chart.png')
await expect(page).toHaveScreenshot({ maxDiffPixelRatio: 0.01 })
// Update baselines: npx playwright test --update-snapshots
```

See [references/visual-regression.md](references/visual-regression.md) for deterministic screenshots and CI strategies.

## Debugging

```bash
npx playwright test --ui          # Interactive UI mode
npx playwright test --headed      # Headed browser
npx playwright test --trace on    # Step-by-step trace
npx playwright test -g "login" --debug
npx playwright show-report
```

```typescript
await page.pause()  // Pause for manual inspection
// Slow actions: use: { launchOptions: { slowMo: 500 } }
```

## Anti-Patterns

```typescript
await page.waitForTimeout(3000)                          // NEVER: hard wait
await page.click('#app > div:nth-child(2) > button')     // NEVER: brittle CSS
expect(await page.locator('.status').innerText()).toBe('Ready')  // NEVER: race condition
await page.goto('https://external-service.com/verify')   // NEVER: test third-party
let sharedUser  // NEVER: shared mutable state between tests
```

## Linting

```bash
npm install -D eslint-plugin-playwright
```

Catches: missing `await`, `waitForTimeout` usage, manual assertions, forbidden selectors.

## Reference Files

| File | When |
|------|------|
| [references/network-mocking.md](references/network-mocking.md) | HAR recording, intercepting, error simulation |
| [references/visual-regression.md](references/visual-regression.md) | Screenshot CI, animation handling |
| [references/accessibility-testing.md](references/accessibility-testing.md) | WCAG audits, axe-core, a11y fixtures |
| [references/ci-cd.md](references/ci-cd.md) | GitHub Actions, sharding, artifacts, Docker |
