# Performance Patterns Reference

Evidence-based optimization through pure functions.

## Core Formula

```
Pure Function + Closure + Pre-compilation = Exceptional Performance
```

## The Pre-Compilation Pattern

**Problem**: O(records x fields) - configuration accessed every iteration

```javascript
// SLOW: 100,000 records x 24 fields = 2.4 million iterations
function processRecords(records, schema) {
    return records.map(record => {
        return schema.fields.reduce((obj, field) => {
            obj[field.name] = transformField(record[field.name], field.type)
            return obj
        }, {})
    })
}
```

**Solution**: Pre-compile configuration into closures

```javascript
// FAST: O(records + fields) - configuration extracted once
export const mapRecord = ({prefix, fields}) => {
    const allowedFields = Object.keys(fields)

    // Return optimized mapping function
    return (record) => {
        const map = {}
        allowedFields.forEach((key) => {
            const val = record[prefix + '_' + key]
            map[key] = fields[key].formatter ? fields[key].formatter(val) : val
        })
        return map
    }
}

// Usage
const mapper = mapRecord(meta)  // Configure once
const objects = records.map(mapper)  // Linear performance
```

**Result**: 10-25x improvement on large datasets

## Function Factory Pattern

```javascript
// Create specialized functions - configuration cost paid once
const createValidator = (rules) => (value) => {
  const errors = []
  for (const rule of rules) {
    if (!rule.validator(value)) {
      errors.push(rule.message)
    }
  }
  return errors.length === 0 ? { valid: true } : { valid: false, errors }
}

// Configure once
const validateEmail = createValidator([
  { validator: v => typeof v === 'string', message: 'Must be string' },
  { validator: v => v.includes('@'), message: 'Must contain @' }
])

// Use many times (fast)
emails.map(validateEmail)
```

## Triple-Layer Curry Pattern

```
(Configuration) => (Parameters) => (Context) => Result
```

```javascript
export const selectUserByEmail = (meta) => (user) => async (ctx) => {
    const sql = getSelectStmt(meta)({whereSet: [{field: 'email'}]})
    const results = await ctx.db.query({sql, values: [user.email]})
    return mapRecord(meta)(results[0])
}

// Layer 1: Configuration (compile-time)
const configuredQuery = selectUserByEmail(initMeta(userMeta))

// Layers 2+3: Runtime execution
const user = await configuredQuery({email: 'test@example.com'})(context)
```

## When to Optimize

1. **Measure first** - Profile before optimizing
2. **>10K items** - Pre-compilation matters at scale
3. **Repeated config access** - Look for nested loops accessing setup data
4. **Hot paths** - Focus on frequently called code

## When NOT to Optimize

- Small datasets (<1K items)
- One-time operations
- Code readability suffers significantly
- No measured performance problem

## Quick Optimization Checklist

1. [ ] Identify repeated configuration access in loops
2. [ ] Extract configuration phase outside execution loop
3. [ ] Use closures to cache configuration
4. [ ] Verify linear execution (not quadratic)
5. [ ] Benchmark before/after with real data
