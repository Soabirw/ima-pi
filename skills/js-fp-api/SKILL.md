---
name: "js-fp-api"
description: "FP API patterns for Node.js with security-first SQL and middleware DI - references js-fp core"
---

# JavaScript FP - Node.js API

## CRITICAL: Security-First SQL (MANDATORY)

Never use string concatenation for SQL. Always use parameterized queries returning `{sql, params}`.

```javascript
// NEVER
const sql = `SELECT * FROM events WHERE domain LIKE '%${domain}%'` // SQL injection!

// ALWAYS
const buildDomainFilter = (domain) => {
  const validation = validateDomain(domain)
  if (!validation.valid) throw new Error(validation.error)
  if (validation.domain === 'all') return { sql: '', params: {} }
  return {
    sql: 'AND from_address LIKE @domain_pattern',
    params: { domain_pattern: `%${validation.domain}%` }
  }
}
```

See `references/security-sql.md` for advanced SQL patterns, triple-layer curry, domain whitelisting.

## Architecture

```
/api/
├── middleware/          # DI only (database.js, auth.js)
├── shared/             # ONLY if 3+ routes use it
│   ├── validators.js
│   ├── filters.js      # SQL builders returning {sql, params}
│   └── constants.js
├── business/           # Pure functions only (calculations, transformations)
└── routes/
    ├── [domain]/
    │   ├── index.js    # Route orchestrator
    │   └── [endpoint].js # 300-500 lines MAX
    └── [simple].js
```

## Self-Contained Route Pattern

```javascript
import { Hono } from 'hono'
import { validateDomain } from '../../shared/validators.js'
import { buildDomainFilter } from '../../shared/filters.js'

const route = new Hono()

const validateRequest = (ctx) => {
  const validation = validateDomain(ctx.req.query('domain'))
  if (!validation.valid) {
    const error = new Error(validation.error)
    error.status = 400
    throw error
  }
  return { domain: validation.domain }
}

const buildQuery = (env, { domain }) => {
  const table = getTableReference(env)('events')
  const filters = buildDomainFilter(domain)
  return { sql: `SELECT * FROM ${table} WHERE 1=1 ${filters.sql}`, params: filters.params }
}

const processData = (raw) => raw.map(r => ({ ...r, timestamp: r.timestamp + 'Z' }))

route.get('/', async (c) => {
  try {
    const params = validateRequest(c)
    const { sql, params: qp } = buildQuery(c.env, params)
    const raw = await c.db.queryWithParams(sql, qp)
    return c.json({ success: true, data: processData(raw) })
  } catch (error) {
    return c.json({ success: false, error: error.message }, error.status || 500)
  }
})

export default route
```

## Middleware Dependency Injection

Inject via middleware context, not per-request instantiation.

```javascript
// middleware/database.js
export const databaseMiddleware = async (c, next) => {
  const db = createDatabaseClient(c.env.DATABASE_URL)
  c.db = {
    query: (sql) => db.query(sql),
    queryWithParams: (sql, params) => db.query(sql, params),
    transaction: (fn) => db.transaction(fn)
  }
  await next()
}
```

See `references/middleware-patterns.md` for function factories, auth middleware, testing.

## Extract to business/ Only If

- Used by 3+ routes
- Pure calculation/transformation, no side effects
- 100% testable

```javascript
// business/calculations.js
export const calculateTotalRevenue = (orders) =>
  orders.reduce((sum, order) => sum + order.total, 0)

export const calculateAverageOrderValue = (orders) =>
  orders.length === 0 ? 0 : calculateTotalRevenue(orders) / orders.length
```

## Anti-Patterns

- Routes >500 lines → split to business/
- Service layer files → keep in-route or business/
- String concatenation SQL → use `{sql, params}`
- Manual client init → use middleware DI
- Shared validation used by <3 routes → keep in-route
- Abstraction layers, complex error frameworks, over-engineered logging

## Testing

```javascript
// Pure logic
describe('calculateTotalRevenue', () => {
  it('sums order totals', () => {
    expect(calculateTotalRevenue([{ total: 100 }, { total: 200 }])).toBe(300)
  })
})

// Route integration
describe('GET /orders', () => {
  const mockDb = { queryWithParams: jest.fn().mockResolvedValue([{ id: 1, total: 100 }]) }

  it('returns orders', async () => {
    const res = await app.request('/orders', { method: 'GET' }, { db: mockDb })
    expect(res.status).toBe(200)
  })
})
```

See `references/middleware-patterns.md` for comprehensive testing patterns.

## Quality Gates

1. SQL uses `{sql, params}` pattern?
2. Route <500 lines?
3. Validation route-scoped or shared (3+ routes)?
4. Using middleware DI (`c.db`, `c.bq`, `c.logger`)?
5. Business logic extracted only if reusable (3+)?
6. All dependencies injectable for testing?

## Reference Files

| File | Load When |
|------|-----------|
| `references/security-sql.md` | Complex multi-filter queries, triple-layer curry, SQL security training |
| `references/middleware-patterns.md` | Custom middleware, function factories, auth, integration tests |
| `references/validation-patterns.md` | Complex validation, composable validators, error accumulation |
| `../js-fp/SKILL.md` | Core FP: purity, composition, DI, immutability, testing |
