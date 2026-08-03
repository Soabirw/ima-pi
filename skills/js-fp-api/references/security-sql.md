# Security-First SQL Patterns

## Core Principle

**NEVER use string concatenation for SQL. ALWAYS use parameterized queries.**

## Parameterized Query Pattern

```javascript
// NEVER: String concatenation (SQL INJECTION!)
const sql = `SELECT * FROM users WHERE email = '${email}'`

// ALWAYS: Parameterized queries
export const selectUserByEmail = (meta) => (user) => async (ctx) => {
    const sql = getSelectStmt(meta)({whereSet: [{field: 'email'}]})
    const results = await ctx.db.query({sql, values: [user.email]})  // Safe!
    return mapRecord(meta)(results[0])
}
```

## Prepared Statement Pattern

```javascript
// Build SQL with placeholders, pass values separately
const findUserQuery = createQueryBuilder(userSchema, ['email', 'active'])
const { sql, values } = findUserQuery(criteria)
const result = await ctx.db.query({ sql, values })
```

## SQL Builder Pattern

All SQL builders return `{sql, params}`:

```javascript
// Filter builder - returns safe {sql, params} object
export const buildDomainFilter = (domain) => {
  const validation = validateDomain(domain)
  if (!validation.valid) throw new Error(validation.error)

  if (validation.domain === 'all') return { sql: '', params: {} }

  // Zero string concatenation - placeholder only
  return {
    sql: 'AND from_address LIKE @domain_pattern',
    params: { domain_pattern: `%${validation.domain}%` }
  }
}

export const buildTimeFilter = (startDate, endDate) => {
  return {
    sql: 'AND created_at BETWEEN @start_date AND @end_date',
    params: { start_date: startDate, end_date: endDate }
  }
}

// Combine filters safely
const domain = buildDomainFilter(req.query.domain)
const time = buildTimeFilter(req.query.start, req.query.end)

const query = {
  sql: `SELECT * FROM events WHERE 1=1 ${domain.sql} ${time.sql}`,
  params: { ...domain.params, ...time.params }
}
```

## Triple-Layer Curry for Database Operations

```
(Configuration) => (Parameters) => (Context) => Result
```

```javascript
export const selectUserByEmail = (meta) => (user) => async (ctx) => {
    const sql = getSelectStmt(meta)({whereSet: [{field: 'email'}]})
    const results = await ctx.db.query({sql, values: [user.email]})
    return mapRecord(meta)(results[0])
}

// Usage
const configuredQuery = selectUserByEmail(initMeta(userMeta))  // Layer 1: Config
const user = await configuredQuery({email: 'test@example.com'})(context)  // Layers 2+3
```

## Domain Whitelisting (Input Validation)

```javascript
const ALLOWED_DOMAINS = ['example.com', 'test.com', 'all']

export const validateDomain = (domain) => {
  if (!domain) {
    return { valid: false, error: 'Domain is required' }
  }

  const normalized = domain.toLowerCase().trim()

  if (!ALLOWED_DOMAINS.includes(normalized)) {
    return { valid: false, error: 'Domain not allowed' }
  }

  return { valid: true, domain: normalized }
}
```

## Security Checklist

- [ ] All SQL uses parameterized queries
- [ ] User input validated before use in queries
- [ ] Domain/value whitelisting where applicable
- [ ] No string concatenation in SQL statements
- [ ] Query builders return `{sql, params}` objects
