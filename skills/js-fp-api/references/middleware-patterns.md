# Middleware Dependency Injection Patterns

## Core Principle

**Inject dependencies via middleware context, not per-request instantiation.**

## Basic Middleware DI

```javascript
// Clean middleware-based injection
app
  .use(StageVariableConnector)    // Injects config onto ctx.stage
  .use(MySQLConnector)            // Injects db onto ctx.db
  .use(routeware)                 // Routes use injected dependencies

// Pure connector function
export default async function MySQLConnector(ctx, next) {
    ctx.db = await createConnection({...})
    await next()
}
```

## Context-Based DI Pattern

```javascript
// Database dependency injected through context
const selectUser = (params) => async (ctx) => {
    const user = await selectUserByEmail(initMeta(meta))({email: params.email})(ctx)
    if (!user.active) ctx.throw(401, 'User account disabled')
    return user
}
```

## Function Factory for O(1) Performance

```javascript
// middleware/bigquery.js
const createBigQueryAPI = (client, projectId) => ({
  query: (q) => client.query(projectId, q),
  queryWithParams: (q, p) => client.queryWithParams(projectId, q, p)
})

export const bigQueryMiddleware = async (c, next) => {
  const client = new BigQueryRestClient(c.env)
  await client.init()
  c.bq = createBigQueryAPI(client, c.env.BIGQUERY_PROJECT_ID)
  await next()
}

// Usage in routes: await c.bq.queryWithParams(sql, params)
```

## Standard Middleware Patterns

### Database Middleware

```javascript
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

### Auth Middleware

```javascript
export const authMiddleware = async (c, next) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')

  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  try {
    c.user = await verifyToken(token, c.env.JWT_SECRET)
    await next()
  } catch (error) {
    return c.json({ error: 'Invalid token' }, 401)
  }
}
```

## Anti-Pattern: Per-Request Instantiation

```javascript
// ANTI-PATTERN: Created every request!
authRoutes.post('/request', async (c) => {
  const authService = new AuthService(env)
  // ...
})

// CORRECT: Middleware DI or service container
app.use(ctx => { ctx.authService = authService })  // Created once
```

## Benefits of Middleware DI

- **Testability**: Easy to mock `ctx` for testing
- **Purity**: Functions are pure relative to their injected dependencies
- **Flexibility**: Different contexts for different environments
- **No Global State**: All dependencies explicitly passed
- **Performance**: Services instantiated once, not per-request

## Testing with Middleware DI

```javascript
describe('GET /orders', () => {
  let mockDb

  beforeEach(() => {
    mockDb = {
      queryWithParams: jest.fn().mockResolvedValue([
        { id: 1, total: 100 },
        { id: 2, total: 200 }
      ])
    }
  })

  it('returns orders successfully', async () => {
    const res = await app.request('/orders', {
      method: 'GET'
    }, {
      db: mockDb  // Inject mock via context
    })

    expect(res.status).toBe(200)
  })
})
```
