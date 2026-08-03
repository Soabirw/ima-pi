# Visual Regression Testing

Catch unintended UI changes with screenshot comparisons.

## Table of Contents

- [Basic Usage](#basic-usage)
- [Deterministic Screenshots](#deterministic-screenshots)
- [Configuration](#configuration)
- [Element-Level Comparisons](#element-level-comparisons)
- [CI Considerations](#ci-considerations)
- [Workflow](#workflow)

## Basic Usage

```typescript
import { test, expect } from '@playwright/test'

test('homepage visual check', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveScreenshot()
})

// Named screenshots for clarity
test('dashboard layout', async ({ page }) => {
  await page.goto('/dashboard')
  await expect(page).toHaveScreenshot('dashboard-default.png')
})
```

**First run** generates baseline snapshots in a `__snapshots__` directory. Subsequent runs compare against baselines.

Update baselines when UI changes are intentional:

```bash
npx playwright test --update-snapshots
```

## Deterministic Screenshots

Dynamic content causes false positives. Remove variability before taking screenshots.

### Disable Animations

```typescript
// In playwright.config.ts — recommended for all visual tests
export default defineConfig({
  use: {
    // Disable CSS animations, transitions, and smooth scroll
    launchOptions: {
      args: ['--force-prefers-reduced-motion'],
    },
  },
})

// Or per-test with a stylesheet
await page.addStyleTag({
  content: `
    *, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
    }
  `,
})
```

### Mask Dynamic Content

```typescript
// Mask elements that change between runs
await expect(page).toHaveScreenshot({
  mask: [
    page.getByTestId('timestamp'),
    page.getByTestId('ad-banner'),
    page.locator('.random-avatar'),
  ],
})
```

### Mock Time-Dependent Data

```typescript
// Fix the clock for consistent date rendering
await page.clock.setFixedTime(new Date('2025-01-15T10:00:00Z'))
await page.goto('/dashboard')
await expect(page).toHaveScreenshot()
```

### Wait for Stable State

```typescript
// Ensure all data is loaded before screenshotting
await page.goto('/dashboard')
await page.waitForLoadState('networkidle')
await expect(page.getByTestId('chart')).toBeVisible()
await expect(page).toHaveScreenshot()
```

## Configuration

### Global Thresholds

```typescript
// playwright.config.ts
export default defineConfig({
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,   // Allow 1% pixel difference
      threshold: 0.2,            // Per-pixel color threshold (0-1)
      animations: 'disabled',    // Disable CSS animations
    },
  },
})
```

### Per-Test Thresholds

```typescript
// Stricter for pixel-perfect components
await expect(page.getByTestId('logo')).toHaveScreenshot({
  maxDiffPixels: 0,
})

// Looser for content-heavy pages
await expect(page).toHaveScreenshot({
  maxDiffPixelRatio: 0.05,
})
```

### Consistent Viewport

```typescript
// playwright.config.ts — dedicated visual regression project
projects: [
  {
    name: 'visual',
    use: {
      ...devices['Desktop Chrome'],
      viewport: { width: 1280, height: 720 },
      colorScheme: 'light',
      locale: 'en-US',
      timezoneId: 'America/New_York',
    },
  },
],
```

## Element-Level Comparisons

Test specific components instead of full pages for more focused checks.

```typescript
// Component screenshot
await expect(page.getByTestId('pricing-table')).toHaveScreenshot('pricing.png')

// Header section only
await expect(page.getByRole('banner')).toHaveScreenshot('header.png')

// Form in a specific state
await page.getByLabel('Email').fill('invalid')
await page.getByRole('button', { name: 'Submit' }).click()
await expect(page.getByRole('form')).toHaveScreenshot('form-validation-errors.png')
```

## CI Considerations

### Consistent Rendering Across Environments

Screenshots taken on macOS will differ from Linux (font rendering, antialiasing). Solutions:

1. **Generate baselines in CI** (recommended) — ensures baselines match the CI environment
2. **Use Docker** — `mcr.microsoft.com/playwright:latest` for identical rendering
3. **Increase thresholds** — if cross-platform baselines are unavoidable

```yaml
# GitHub Actions — generate baselines in CI
- name: Update snapshots
  run: npx playwright test --update-snapshots
  env:
    CI: true
```

### Snapshot Storage

- Commit baselines to version control (`__snapshots__/` directories)
- Use `.gitattributes` to mark snapshots as binary:

```
**/__snapshots__/** binary
```

### Diff Review

Playwright generates diff images on failure. Upload test results as CI artifacts for review.

```yaml
- uses: actions/upload-artifact@v4
  if: ${{ !cancelled() }}
  with:
    name: playwright-report
    path: playwright-report/
    retention-days: 30
```

## Workflow

1. **Write test** with `toHaveScreenshot()`
2. **First run** generates baselines (will fail — this is expected)
3. **Review baselines** — ensure they look correct
4. **Commit baselines** to version control
5. **CI runs** compare against committed baselines
6. **On intentional UI changes**: run `--update-snapshots`, review diffs, commit new baselines
7. **On unintentional failures**: investigate and fix the regression
