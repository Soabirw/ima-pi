# Anti-Patterns Reference

Common FP anti-patterns to avoid.

## 1. Impure Functions Disguised as Pure

```javascript
// ANTI-PATTERN: Hidden mutation
function processUser(user) {
    user.lastProcessed = new Date() // Mutation!
    return validateUser(user)
}

// CORRECT: Returns new object
function processUser(user) {
    return {
        ...user,
        lastProcessed: new Date()
    }
}
```

## 2. Configuration in Hot Paths

```javascript
// ANTI-PATTERN: O(records x fields) - schema accessed every iteration
function processRecords(records, schema) {
    return records.map(record => {
        return schema.fields.reduce((obj, field) => {
            obj[field.name] = transformField(record[field.name], field.type)
            return obj
        }, {})
    })
}

// CORRECT: Pre-compile the transformation
function createRecordProcessor(schema) {
    const transformers = schema.fields.map(field =>
        value => transformField(value, field.type)
    )
    return record => transformers.reduce((obj, transform, i) => {
        obj[schema.fields[i].name] = transform(record[schema.fields[i].name])
        return obj
    }, {})
}
const processor = createRecordProcessor(schema) // Setup once
const results = records.map(processor) // Fast execution
```

## 3. Over-Engineering Simple Cases

```javascript
// ANTI-PATTERN: Complex machinery for simple validation
const validateEmail = createAdvancedValidator({
    type: 'email',
    rules: [createRule('format', emailRegex), createRule('length', {min: 5, max: 254})],
    transformers: [createTransformer('lowercase'), createTransformer('trim')]
})

// CORRECT: Simple, direct approach
const validateEmail = (email) => {
    const trimmed = email.trim().toLowerCase()
    return trimmed.length >= 5 && trimmed.length <= 254 && emailRegex.test(trimmed)
}
```

## 4. Inline Validation Mixed with Business Logic

```javascript
// ANTI-PATTERN
if (!body || !body.email) {
  return errorResponse(c, 400, 'Email is required')
}
// ... more business logic

// CORRECT: Separate validation function
const validateAuthRequest = (body) => {
  if (!body || !body.email) throw new ValidationError('Email is required')
  return { email: body.email }
}
```

## 5. Per-Request Service Instantiation

```javascript
// ANTI-PATTERN
authRoutes.post('/request', async (c) => {
  const authService = new AuthService(env)  // Created every request!
  // ...
})

// CORRECT: Middleware DI or service container
app.use(ctx => { ctx.authService = authService })  // Created once
```

## 6. Creating Custom FP Utilities

> **Note**: This is about not CREATING your own FP utilities. Using established libraries (lodash, Ramda, etc.) is perfectly fine.

```javascript
// ANTI-PATTERN: Creating your own pipe/compose/curry utilities
const pipe = (...fns) => x => fns.reduce((v, f) => f(v), x)
const compose = (...fns) => x => fns.reduceRight((v, f) => f(v), x)

// CORRECT: Native function calls with early returns
const validateUser = (userData) => {
  const requiredCheck = validateRequired(['email', 'name'])(userData)
  if (!requiredCheck.valid) return requiredCheck
  return validateEmail(userData)
}
```

## Quick Checklist

- [ ] No hidden mutations in function bodies
- [ ] Configuration accessed once, not per-item
- [ ] Complexity matches the problem size
- [ ] Validation separated from business logic
- [ ] Services instantiated once, injected via context
- [ ] No custom FP utility functions (pipe, compose, curry)
