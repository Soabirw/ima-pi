# Validation Composition Patterns

## Core Principle

**Build complex validators from simple, composable functions.**

## Function Factory Pattern

```javascript
// Factory creates customized validators
export const validateIntegerGreaterThan = (min) => (val) => validateAll([
    () => validateInteger(min),
    validateInteger,
    (val) => parseInt(val) > min
])(val)

// Usage: Create reusable, configured functions
const validatePositiveInteger = validateIntegerGreaterThan(0)
const validateAdultAge = validateIntegerGreaterThan(17)
```

## The validateAll Utility

```javascript
// Short-circuit evaluation - stops on first failure
export const validateAll = (validators = []) => (val) =>
  !validators.find((validator) => !validator(val))
```

## Composition Pattern

```javascript
// Build complex validators from simple functions
export const validateLatitude = (val) => validateAll([
    validateNumber,
    validateNumberGreaterThanEq(-90),
    validateNumberLessThanEq(90)
])(val)

// Object validation with destructuring
export const validateCreditCard = ({name, number, expDate, cvv}) => validateAll([
    ({name}) => validateCreditCardHolderName(name),
    ({number}) => validateCreditCardNumber(number),
    ({expDate}) => validateCreditCardExpiration(expDate),
    ({cvv}) => validateCreditCardCvv(cvv)
])({name, number, expDate, cvv})
```

## Route-Scoped Validation

```javascript
// Keep validation in-route if used by <3 routes
const validateRequest = (ctx) => {
  const domain = ctx.req.query('domain')
  const validation = validateDomain(domain)
  if (!validation.valid) {
    const error = new Error(validation.error)
    error.status = 400
    throw error
  }
  return { domain: validation.domain }
}
```

## Result Object Pattern

```javascript
// Return validation result objects, not throw
export const validateTimeRange = (start, end) => {
  const startDate = new Date(start)
  const endDate = new Date(end)

  if (isNaN(startDate.getTime())) {
    return { valid: false, error: 'Invalid start date' }
  }

  if (isNaN(endDate.getTime())) {
    return { valid: false, error: 'Invalid end date' }
  }

  if (startDate > endDate) {
    return { valid: false, error: 'Start date must be before end date' }
  }

  return { valid: true, start: startDate.toISOString(), end: endDate.toISOString() }
}
```

## Error Accumulation Pattern

```javascript
const validateUserInput = (data) => {
  const errors = []

  if (!validateRequired(data.email)) {
    errors.push('Email is required')
  } else if (!validateEmail(data.email)) {
    errors.push('Invalid email format')
  }

  if (!validateRequired(data.name)) {
    errors.push('Name is required')
  }

  return errors.length > 0
    ? { valid: false, errors }
    : { valid: true, data }
}
```

## Anti-Pattern: Inline Validation

```javascript
// ANTI-PATTERN: Mixed with business logic
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

## Anti-Pattern: Over-Engineering

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

## Pure Error Factory

```javascript
export function createValidationError(errors, status = 400) {
    const error = new Error()
    error.errors = errors
    error.status = status
    return error
}
```

## When to Extract Validators

**Extract to shared/ ONLY if**:
- 3+ routes use the same validation
- Validation is genuinely reusable
- Pure function with no side effects

**Keep in-route if**:
- Route-specific validation
- Used by <3 routes
- Simple enough to inline
