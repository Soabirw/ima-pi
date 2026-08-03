# CI/CD Integration

Run Playwright tests reliably in CI pipelines.

## Table of Contents

- [GitHub Actions](#github-actions)
- [Sharding](#sharding)
- [Docker](#docker)
- [Browser Optimization](#browser-optimization)
- [Reporting](#reporting)
- [Environment Management](#environment-management)

## GitHub Actions

### Basic Setup

```yaml
# .github/workflows/playwright.yml
name: Playwright Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium

      - name: Run tests
        run: npx playwright test
        env:
          BASE_URL: ${{ vars.STAGING_URL }}

      - uses: actions/upload-artifact@v4
        if: ${{ !cancelled() }}
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 30
```

### Key Points

- **Use `ubuntu-latest`** — cheaper and faster than macOS/Windows runners
- **Install only needed browsers** — `chromium` instead of all three saves ~2 minutes
- **Always upload artifacts** — even on failure, for debugging

## Sharding

Split tests across multiple CI machines for faster execution.

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shardIndex: [1, 2, 3, 4]
        shardTotal: [4]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npx playwright install --with-deps chromium

      - name: Run tests (shard ${{ matrix.shardIndex }}/${{ matrix.shardTotal }})
        run: npx playwright test --shard=${{ matrix.shardIndex }}/${{ matrix.shardTotal }}

      - uses: actions/upload-artifact@v4
        if: ${{ !cancelled() }}
        with:
          name: blob-report-${{ matrix.shardIndex }}
          path: blob-report/
          retention-days: 1

  merge-reports:
    if: ${{ !cancelled() }}
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci

      - uses: actions/download-artifact@v4
        with:
          path: all-blob-reports
          pattern: blob-report-*
          merge-multiple: true

      - name: Merge reports
        run: npx playwright merge-reports --reporter html ./all-blob-reports

      - uses: actions/upload-artifact@v4
        with:
          name: html-report
          path: playwright-report/
          retention-days: 14
```

### Config for Sharding

```typescript
// playwright.config.ts
export default defineConfig({
  reporter: process.env.CI ? 'blob' : 'html',
  // Use blob reporter in CI for merge-reports support
})
```

## Docker

Use the official Playwright Docker image for consistent rendering.

```dockerfile
# Dockerfile.playwright
FROM mcr.microsoft.com/playwright:v1.50.0-noble

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

CMD ["npx", "playwright", "test"]
```

```yaml
# docker-compose.test.yml
services:
  tests:
    build:
      dockerfile: Dockerfile.playwright
    environment:
      - BASE_URL=http://app:3000
    depends_on:
      - app
  app:
    build: .
    ports:
      - "3000:3000"
```

## Browser Optimization

### Install Only What You Need

```bash
# CI: install just Chromium (fastest)
npx playwright install --with-deps chromium

# Local: install all browsers
npx playwright install --with-deps
```

### Parallel Workers

```typescript
// playwright.config.ts
export default defineConfig({
  workers: process.env.CI ? 1 : undefined,
  // CI: 1 worker to avoid resource contention on small runners
  // Local: auto-detect based on CPU cores
})
```

Increase CI workers if your runner has enough resources:

```typescript
workers: process.env.CI ? 2 : undefined,
```

## Reporting

### Reporter Options

```typescript
// playwright.config.ts
export default defineConfig({
  // CI: blob for sharding, html for single machine
  reporter: process.env.CI
    ? [['blob'], ['github']]  // GitHub Actions annotations + blob for merging
    : [['html', { open: 'never' }]],
})
```

### Available Reporters

| Reporter | Use Case |
|----------|----------|
| `html` | Local development, detailed interactive report |
| `blob` | CI with sharding, merge later with `merge-reports` |
| `github` | GitHub Actions, adds annotations to PRs |
| `json` | Programmatic analysis of results |
| `junit` | Integration with CI tools that consume JUnit XML |
| `list` | Terminal output, good for CI logs |

## Environment Management

### Secrets

```yaml
# GitHub Actions — use secrets for credentials
env:
  BASE_URL: ${{ vars.STAGING_URL }}
  TEST_USER: ${{ secrets.TEST_USER }}
  TEST_PASSWORD: ${{ secrets.TEST_PASSWORD }}
```

```typescript
// Access in config or tests via process.env
use: {
  baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
},
```

### Per-Environment Projects

```typescript
// playwright.config.ts
projects: [
  {
    name: 'staging',
    use: {
      baseURL: 'https://staging.example.com',
      ...devices['Desktop Chrome'],
    },
  },
  {
    name: 'production-smoke',
    use: {
      baseURL: 'https://example.com',
      ...devices['Desktop Chrome'],
    },
    testMatch: '**/smoke/**',  // Only run smoke tests in production
  },
],
```

### Retries in CI

```typescript
// playwright.config.ts
export default defineConfig({
  retries: process.env.CI ? 2 : 0,
  // Retries help with transient CI failures
  // But investigate persistent flakes — don't just retry forever
})
```
