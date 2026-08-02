---
name: "js-fp"
description: "Core FP principles with anti-over-engineering focus - Simple > Complex | Evidence > Assumptions"
---

# JavaScript Functional Programming

## CRITICAL: Anti-Over-Engineering

**"Simple > Complex | Evidence > Assumptions"**

FP is a mindset — pure functions, immutability, composition — not a rigid API signature. Never create custom FP utilities to make JavaScript "feel" like Haskell. Using established libraries (lodash, date-fns, etc.) is fine.

```javascript
// ❌ DON'T CREATE pipe/compose/curry utilities
const pipe = (...fns) => x => fns.reduce((v, f) => f(v), x)

// ✅ Native function calls with early returns
const validateUser = (userData) => {
  const requiredCheck = validateRequired(['email', 'name'])(userData)
  if (!requiredCheck.valid) return requiredCheck
  const emailCheck = validateEmail(userData)
  if (!emailCheck.valid) return emailCheck
  return validateNameLength(userData)
}

// ❌ DON'T CREATE custom monads
class Maybe { /* complex monad implementation */ }

// ✅ Native error handling
const getUser = async (id) => {
  try {
    const user = await fetchUser(id)
    return { success: true, data: user }
  } catch (error) {
    return { success: false, error: error.message }
  }
}
```

**Context-appropriate complexity:**

```javascript
// CLI Script: simple and direct
const processFile = (filePath) => {
  const data = readFileSync(filePath, 'utf8')
  return data.split('\n').filter(line => line.trim()).map(line => line.toUpperCase())
}

// Production Service: appropriate error handling + logging
const processFile = async (filePath, logger) => {
  try {
    const data = await readFile(filePath, 'utf8')
    const lines = data.split('\n').filter(line => line.trim())
    logger.info('File processed', { filePath, lineCount: lines.length })
    return { success: true, data: lines.map(line => line.toUpperCase()) }
  } catch (error) {
    logger.error('File processing failed', { filePath, error })
    return { success: false, error: error.message }
  }
}
```

## Core Patterns

### 1. Purity and Side Effect Isolation

Separate business logic from side effects. Pure core + impure shell.

```javascript
// ❌ Side effects mixed with logic
function calculateTotal(items) {
  console.log('Processing items')
  total += items.reduce((sum, item) => sum + item.price, 0) // mutation
  return total
}

// ✅ Pure logic
const calculateTotal = (items) =>
  items.reduce((sum, item) => sum + item.price, 0)

// ✅ Side effects isolated
const logAndCalculate = (items, logger) => {
  const total = calculateTotal(items)
  logger.log(`Total: ${total}`)
  return total
}
```

### 2. Composition Over Inheritance

```javascript
// ❌ Class hierarchy
class BaseValidator { validate() { throw new Error('Not implemented') } }
class EmailValidator extends BaseValidator { validate(value) { /* email logic */ } }

// ✅ Function composition, no utilities needed
const validateRequired = (value) => value != null && value !== ''
const validateEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
const validateLength = (min, max) => (value) => value.length >= min && value.length <= max

const validateUserEmail = (email) => {
  if (!validateRequired(email)) return { valid: false, error: 'Required' }
  if (!validateEmail(email)) return { valid: false, error: 'Invalid email' }
  if (!validateLength(5, 100)(email)) return { valid: false, error: 'Length' }
  return { valid: true }
}
```

### 3. Dependency Injection via Parameters

Pass dependencies explicitly. No global state, no hidden dependencies.

```javascript
// ❌ Hidden dependencies
function saveUser(userData) {
  const hashedPassword = bcrypt.hash(userData.password)
  return database.save({ ...userData, password: hashedPassword })
}

// ✅ Explicit dependencies
const saveUser = async (userData, hasher, database) => {
  const hashedPassword = await hasher.hash(userData.password)
  return database.save({ ...userData, password: hashedPassword })
}

// ✅ Function factory for repeated use
const createUserService = (hasher, database) => ({
  saveUser: (userData) => saveUser(userData, hasher, database),
  findUser: (id) => database.findById(id)
})
```

### 4. Immutability

```javascript
// ❌ Mutation
function updateUserSettings(user, settings) {
  user.settings = { ...user.settings, ...settings }
  user.updatedAt = new Date()
  return user
}

// ✅ Create new objects
const updateUserSettings = (user, settings) => ({
  ...user,
  settings: { ...user.settings, ...settings },
  updatedAt: new Date()
})

const addItem = (items, newItem) => [...items, newItem]
const removeItem = (items, id) => items.filter(item => item.id !== id)
const updateItem = (items, id, updates) =>
  items.map(item => item.id === id ? { ...item, ...updates } : item)
```

## Testing (Enabled by Purity)

Pure functions enable systematic edge case coverage.

```javascript
describe('calculateDiscount', () => {
  const testCases = [
    [100, 0.1, 10],
    [50, 0.2, 10],
    [0, 0.1, 0]
  ]
  testCases.forEach(([price, rate, expected]) => {
    it(`${rate*100}% on ${price} = ${expected}`, () =>
      expect(calculateDiscount(price, rate)).toBe(expected))
  })

  const invalidTypes = [null, undefined, NaN, true, [], {}, '100']
  invalidTypes.forEach(input => {
    it(`handles ${typeof input} gracefully`, () => {
      expect(() => calculateDiscount(input, 0.1)).not.toThrow()
      expect(calculateDiscount(input, 0.1)).toBe(0)
    })
  })
})
```

## Performance (Evidence-Based Only)

Optimize only when measured. For large datasets (>10K items), pre-compile configuration.

```javascript
// Problem: O(records × fields) — repeated config access per record
function processRecords(records, schema) {
  return records.map(record =>
    schema.fields.reduce((obj, field) => {
      obj[field.name] = transformField(record[field.name], field.type)
      return obj
    }, {}))
}

// Solution: O(records + fields) — pay config cost once
const createRecordProcessor = (schema) => {
  const fieldProcessors = schema.fields.map(field =>
    value => transformField(value, field.type))
  return record => fieldProcessors.reduce((obj, processor, i) => {
    obj[schema.fields[i].name] = processor(record[schema.fields[i].name])
    return obj
  }, {})
}

const processor = createRecordProcessor(schema) // setup once
const results = records.map(processor)           // linear execution
```

## Native JavaScript Idioms

```javascript
// Native array methods over loops
const processUsers = (users) =>
  users
    .filter(user => user.active)
    .map(user => ({ ...user, displayName: `${user.firstName} ${user.lastName}` }))
    .sort((a, b) => a.lastName.localeCompare(b.lastName))

// async/await with result types
const fetchUserData = async (userId, fetcher) => {
  try {
    const [user, preferences] = await Promise.all([
      fetcher.getUser(userId),
      fetcher.getPreferences(userId)
    ])
    return { success: true, data: { ...user, preferences } }
  } catch (error) {
    return { success: false, error: error.message }
  }
}
```

## Pre-Implementation Checklist

1. Can this be pure? — separate business logic from side effects
2. Can this use native patterns? — avoid custom FP utilities
3. Can this be simplified? — prefer simple over clever
4. Is complexity justified? — evidence, not assumptions
5. Is this testable? — pure functions enable comprehensive coverage
6. Is this context-appropriate? — CLI script ≠ production service
