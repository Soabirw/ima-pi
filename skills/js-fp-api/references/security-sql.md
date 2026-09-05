# Security-first SQL patterns

Apply the [IMA security baseline](../../ima-security-guardrails/SKILL.md): validation,
authorization, parameterization, and output handling are distinct controls. This reference covers
SQL values and structure only; it does not authorize a request or make an API response safe to
render.

## Parameterize every dynamic value

Never concatenate or interpolate external values into SQL source. Pass a fixed SQL template and a
separate parameter collection to the installed driver's documented API.

```javascript
const selectUserByEmail = async (email, db) => {
  const sql = "SELECT id, email FROM users WHERE email = $1"
  return db.query({ sql, values: [email] })
}
```

The request handler validates `email` and authorizes the operation before calling this adapter. The
adapter receives an already selected query shape and only binds values.

## LIKE values stay values

Build the wildcard pattern in data, then bind it. Do not put a request value inside the SQL string.
If a feature treats `%` or `_` as literal search characters, escape them with the **installed
database's documented** `LIKE ... ESCAPE` convention before binding; the escaping rule is
DB-specific.

```javascript
const buildDomainFilter = (domain) => {
  const validation = validateDomain(domain)
  if (!validation.valid) return { valid: false, error: validation.error }
  if (validation.domain === "all") return { valid: true, sql: "", params: {} }

  return {
    valid: true,
    sql: "AND from_address LIKE @domain_pattern",
    params: { domain_pattern: `%${validation.domain}%` },
  }
}
```

A result object makes invalid input explicit; the route returns a bounded 400 response rather than
executing a partial query.

## Allowlist SQL structure

Placeholders do not bind identifiers, column names, sort direction, or operators. Map a request
choice to a small code-owned set before building the query.

```javascript
const sortColumns = {
  created: "created_at",
  name: "display_name",
}

const sortDirections = {
  ascending: "ASC",
  descending: "DESC",
}

const selectSort = ({ column, direction }) => {
  const selectedColumn = sortColumns[column]
  const selectedDirection = sortDirections[direction]

  if (!selectedColumn || !selectedDirection) {
    return { valid: false, error: "Unsupported sort" }
  }

  return {
    valid: true,
    sql: `ORDER BY ${selectedColumn} ${selectedDirection}`,
  }
}
```

The interpolation is safe only because both fragments come from fixed allowlists, never from the
request. Keep table selection in fixed route configuration whenever possible.

## Compose filters with plain data

Use direct, readable functions rather than custom curry or query-policy utilities. A pure builder
can combine validated filter fragments without executing I/O:

```javascript
const buildEventQuery = ({ domain, startDate, endDate }) => {
  const domainFilter = buildDomainFilter(domain)
  if (!domainFilter.valid) return domainFilter

  return {
    valid: true,
    sql: [
      "SELECT id, from_address, created_at FROM events WHERE created_at BETWEEN @start AND @end",
      domainFilter.sql,
    ].filter(Boolean).join(" "),
    params: {
      start: startDate,
      end: endDate,
      ...domainFilter.params,
    },
  }
}
```

The I/O boundary calls `db.query({ sql, params })` only after the route validates dates and
authorizes access to this data. Do not log raw parameter values when they could contain sensitive
information.

## Review and test checks

- [ ] Every dynamic value uses the driver's parameter API.
- [ ] Every dynamic identifier, operator, table, and sort choice comes from fixed code or an allowlist.
- [ ] `LIKE` patterns are bound values, with documented literal-wildcard behavior.
- [ ] Invalid or unsupported input fails closed before query execution.
- [ ] Tests observe the parameterized or allowlisted query boundary, not only a validator result.
