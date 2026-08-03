# Network Mocking Patterns

Advanced patterns for intercepting and mocking network requests in Playwright.

## Table of Contents

- [Basic Mocking](#basic-mocking)
- [Modify Real Responses](#modify-real-responses)
- [HAR Recording and Playback](#har-recording-and-playback)
- [Error Simulation](#error-simulation)
- [API-First Test Setup](#api-first-test-setup)
- [Route Management](#route-management)
- [Fixtures for Common Mocks](#fixtures-for-common-mocks)

## Basic Mocking

### Fulfill with JSON

```typescript
await page.route('**/api/v1/users', route => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ users: [{ id: 1, name: 'Test User' }] }),
}))
```

### Fulfill with File

```typescript
await page.route('**/api/v1/config', route => route.fulfill({
  status: 200,
  path: './tests/fixtures/config-response.json',
}))
```

### Match by Method

```typescript
await page.route('**/api/v1/users', async route => {
  if (route.request().method() === 'POST') {
    await route.fulfill({
      status: 201,
      json: { id: 99, name: 'New User' },
    })
  } else {
    await route.continue()
  }
})
```

### URL Pattern Matching

```typescript
// Exact path
await page.route('**/api/users', handler)

// Wildcard segments
await page.route('**/api/users/*/profile', handler)

// Regex for complex patterns
await page.route(/\/api\/v[12]\/users/, handler)

// Query parameters (use regex)
await page.route(/\/api\/search\?q=/, handler)
```

## Modify Real Responses

Intercept the real API response and modify it before the page sees it.

```typescript
await page.route('**/api/products', async route => {
  const response = await route.fetch()
  const json = await response.json()

  // Add a test product to the real data
  json.products.push({
    id: 'test-product',
    name: 'Test Product',
    price: 9.99,
  })

  await route.fulfill({ response, json })
})
```

### Add/Modify Headers

```typescript
await page.route('**/api/**', async route => {
  const response = await route.fetch()
  await route.fulfill({
    response,
    headers: {
      ...response.headers(),
      'x-test-header': 'injected',
    },
  })
})
```

## HAR Recording and Playback

Record real API responses and replay them in tests for consistency.

### Record HAR

```typescript
// In a setup script or dedicated test
const context = await browser.newContext({
  recordHar: {
    path: './tests/fixtures/api.har',
    urlFilter: '**/api/**',
  },
})
const page = await context.newPage()
await page.goto('/dashboard')
// ... perform actions that trigger API calls
await context.close()  // HAR file is written on close
```

### Playback HAR

```typescript
// Route from a saved HAR file
await page.routeFromHAR('./tests/fixtures/api.har', {
  url: '**/api/**',
  update: false,  // Set true to re-record if requests change
})
await page.goto('/dashboard')
```

### HAR Best Practices

- Store HAR files in `tests/fixtures/` and commit to version control
- Use `urlFilter` to keep HAR files focused (don't record everything)
- Set `update: true` temporarily when APIs change, then switch back
- Scrub sensitive data (tokens, passwords) from HAR files before committing

## Error Simulation

Test how the UI handles failures.

```typescript
// Server error
await page.route('**/api/save', route => route.fulfill({
  status: 500,
  json: { error: 'Internal server error' },
}))

// Network failure
await page.route('**/api/save', route => route.abort('failed'))

// Timeout simulation
await page.route('**/api/slow', async route => {
  await new Promise(r => setTimeout(r, 30000))
  await route.fulfill({ status: 200, json: {} })
})

// Rate limiting
await page.route('**/api/**', route => route.fulfill({
  status: 429,
  json: { error: 'Too many requests', retryAfter: 60 },
}))

// Empty responses
await page.route('**/api/search', route => route.fulfill({
  status: 200,
  json: { results: [], total: 0 },
}))
```

## API-First Test Setup

Use the API directly to set up test data instead of clicking through the UI.

```typescript
// Create test data via API before testing UI
test('displays user profile', async ({ page, request }) => {
  // Setup: create user via API (fast)
  const response = await request.post('/api/users', {
    data: { name: 'Test User', email: 'test@example.com' },
  })
  const user = await response.json()

  // Test: verify UI renders correctly
  await page.goto(`/users/${user.id}`)
  await expect(page.getByRole('heading')).toHaveText('Test User')
  await expect(page.getByText('test@example.com')).toBeVisible()
})
```

### API Context Fixture

```typescript
import { test as base } from '@playwright/test'

export const test = base.extend<{ apiSetup: APIRequestContext }>({
  apiSetup: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({
      baseURL: process.env.API_BASE_URL ?? 'http://localhost:3000',
      extraHTTPHeaders: { Authorization: `Bearer ${process.env.API_TOKEN}` },
    })
    await use(context)
    await context.dispose()
  },
})
```

## Route Management

### Route Registration Order

Playwright uses the **last matching route**. Register broad routes first, specific routes second.

```typescript
// Broad pass-through first
await page.route('**/api/**', route => route.continue())

// Specific mock second (takes priority)
await page.route('**/api/users', route => route.fulfill({
  json: [{ id: 1, name: 'Mocked User' }],
}))
```

### Remove Routes

```typescript
const handler = route => route.fulfill({ json: [] })
await page.route('**/api/search', handler)

// Later, remove the mock
await page.unroute('**/api/search', handler)
```

### Context-Level Routes

Apply routes to all pages in a context (useful for popups and new tabs).

```typescript
const context = await browser.newContext()
await context.route('**/api/**', route => route.continue({
  headers: { ...route.request().headers(), 'X-Test': 'true' },
}))
const page = await context.newPage()
```

## Fixtures for Common Mocks

```typescript
// fixtures.ts
export const test = base.extend<{
  mockApi: void
  mockAuth: void
}>({
  mockApi: [async ({ page }, use) => {
    // Block analytics and tracking
    await page.route('**/analytics/**', route => route.abort())
    await page.route('**/tracking/**', route => route.abort())
    await use()
  }, { auto: true }],  // auto: true means it runs for every test

  mockAuth: async ({ page }, use) => {
    await page.route('**/api/auth/me', route => route.fulfill({
      json: { id: 1, name: 'Test User', role: 'admin' },
    }))
    await use()
  },
})
```
