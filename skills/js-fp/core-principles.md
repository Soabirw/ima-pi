# Core FP Principles - Deep Dive

Complete functional programming philosophy with detailed pattern explanations and cross-pattern comparisons.

## Table of Contents

1. [Philosophy and Mindset](#philosophy-and-mindset)
2. [Purity Deep Dive](#purity-deep-dive)
3. [Composition Strategies](#composition-strategies)
4. [Dependency Injection Patterns](#dependency-injection-patterns)
5. [Immutability Strategies](#immutability-strategies)
6. [Error Handling Patterns](#error-handling-patterns)
7. [State Management](#state-management)
8. [Cross-Pattern Comparisons](#cross-pattern-comparisons)

## Philosophy and Mindset

### The FP Mental Model

Functional programming is about:
- **Functions as building blocks**: Small, composable, testable units
- **Data transformation**: Input → Processing → Output (no hidden state)
- **Explicit over implicit**: Dependencies and effects are visible
- **Simplicity over cleverness**: Native patterns over utilities

### Why FP in JavaScript?

**JavaScript's FP strengths**:
- First-class functions (functions as values)
- Closures (lexical scoping for data encapsulation)
- Array methods (map, filter, reduce are FP primitives)
- Async/await (functional async composition)

**NOT about**:
- Creating Haskell in JavaScript
- Complex category theory
- Academic purity for its own sake
- FP utility libraries

## Purity Deep Dive

### What Makes a Function Pure?

```javascript
// Pure: Same inputs → Same outputs, no side effects
const add = (a, b) => a + b
const multiply = (x) => (y) => x * y

// Impure: Depends on external state
let discount = 0.1
const calculatePrice = (price) => price * (1 - discount) // ❌

// Pure version: Explicit dependency
const calculatePrice = (price, discount) => price * (1 - discount) // ✅
```

### Benefits of Purity

**1. Testability**: 100% of logic is testable
```javascript
// Pure function - test every data type easily
const safeDivide = (a, b) => b === 0 ? 0 : a / b

describe('safeDivide', () => {
  const testCases = [
    [10, 2, 5],
    [10, 0, 0],
    [0, 5, 0],
    [-10, 2, -5]
  ]

  testCases.forEach(([a, b, expected]) => {
    it(`${a} / ${b} = ${expected}`, () => {
      expect(safeDivide(a, b)).toBe(expected)
    })
  })
})
```

**2. Predictability**: No surprises from hidden state
```javascript
// Impure: Can fail randomly based on network
const getUser = (id) => fetch(`/users/${id}`).then(r => r.json()) // ❌

// Pure: Explicit dependency injection
const getUser = (id, fetcher) => fetcher.get(`/users/${id}`) // ✅

// Test with mock
const mockFetcher = { get: jest.fn().mockResolvedValue({ id: 1, name: 'Test' }) }
await getUser(1, mockFetcher) // Fully controllable
```

**3. Memoization**: Pure functions can be cached safely
```javascript
const memoize = (fn) => {
  const cache = new Map()
  return (...args) => {
    const key = JSON.stringify(args)
    if (cache.has(key)) return cache.get(key)
    const result = fn(...args)
    cache.set(key, result)
    return result
  }
}

// Only works with pure functions
const expensiveCalculation = memoize((n) => {
  // Complex computation
  return n * n * n
})
```

### Side Effect Isolation

**Pattern**: Push effects to the edges
```javascript
// ❌ Mixed concerns
const processAndSaveUser = async (userData) => {
  const validated = validateUser(userData) // Pure
  console.log('Validated:', validated) // Side effect
  const enhanced = enhanceUser(validated) // Pure
  await database.save(enhanced) // Side effect
  console.log('Saved:', enhanced.id) // Side effect
  return enhanced
}

// ✅ Separated concerns
// Pure business logic
const processUser = (userData) => {
  const validated = validateUser(userData)
  if (!validated.valid) return validated
  return { valid: true, data: enhanceUser(validated.data) }
}

// Side effects at the edge
const saveUser = async (userData, logger, database) => {
  const result = processUser(userData) // Pure

  if (!result.valid) {
    logger.error('Validation failed', result.errors)
    return result
  }

  logger.info('Validated', result.data)
  const saved = await database.save(result.data)
  logger.info('Saved', saved.id)
  return { valid: true, data: saved }
}
```

## Composition Strategies

### Why Composition Over Inheritance?

**Problems with inheritance**:
- Tight coupling between parent and child
- Fragile base class problem
- Deep hierarchies are hard to understand
- Can't mix behaviors from multiple parents easily

**Composition benefits**:
- Loosely coupled functions
- Easy to understand each piece
- Mix and match behaviors freely
- Easy to test each function

### Composition Patterns

**1. Sequential Composition (early returns)**
```javascript
// Each step can short-circuit
const processOrder = (order) => {
  const validated = validateOrder(order)
  if (!validated.valid) return validated

  const priced = calculatePrice(validated.data)
  if (!priced.valid) return priced

  const inventoryCheck = checkInventory(priced.data)
  if (!inventoryCheck.valid) return inventoryCheck

  return { valid: true, data: prepareShipment(inventoryCheck.data) }
}
```

**2. Array Methods Composition**
```javascript
// Native JavaScript composition
const processUsers = (users) =>
  users
    .filter(user => user.active)
    .map(user => ({ ...user, displayName: `${user.firstName} ${user.lastName}` }))
    .sort((a, b) => a.lastName.localeCompare(b.lastName))
    .slice(0, 10)
```

**3. Function Factories**
```javascript
// Create specialized functions
const createTransformer = (config) => {
  // Pre-compile configuration
  const rules = compileRules(config.rules)
  const filters = compileFilters(config.filters)

  return (data) => {
    const filtered = filters.reduce((d, filter) => filter(d), data)
    return rules.reduce((d, rule) => rule(d), filtered)
  }
}

// Use specialized function
const userTransformer = createTransformer(userConfig)
const results = users.map(userTransformer)
```

## Dependency Injection Patterns

### Why DI in FP?

- Makes dependencies explicit
- Enables complete testing
- Reduces coupling
- Makes side effects visible

### DI Pattern Levels

**Level 1: Direct Parameter Injection**
```javascript
const saveUser = (user, hasher, database) => {
  const hashed = hasher.hash(user.password)
  return database.save({ ...user, password: hashed })
}

// Test with mocks
const mockHasher = { hash: (p) => `hashed_${p}` }
const mockDb = { save: jest.fn() }
saveUser(testUser, mockHasher, mockDb)
```

**Level 2: Function Factory**
```javascript
const createUserService = (hasher, database) => ({
  save: (user) => saveUser(user, hasher, database),
  find: (id) => database.findById(id),
  update: (id, updates) => updateUser(id, updates, hasher, database)
})

// Create once with real deps
const userService = createUserService(bcrypt, postgresDb)

// Use without passing deps every time
await userService.save(userData)

// Test with mock deps
const testService = createUserService(mockHasher, mockDb)
```

**Level 3: Higher-Order Functions**
```javascript
const withLogging = (fn, logger) => async (...args) => {
  logger.info('Starting', { fn: fn.name, args })
  try {
    const result = await fn(...args)
    logger.info('Success', { fn: fn.name, result })
    return result
  } catch (error) {
    logger.error('Failed', { fn: fn.name, error })
    throw error
  }
}

// Wrap any function with logging
const saveUserWithLogging = withLogging(saveUser, console)
```

## Immutability Strategies

### Why Immutability?

- Prevents unexpected mutations
- Makes state changes explicit
- Enables time-travel debugging
- Safer concurrent operations

### Immutable Operations

**Objects**:
```javascript
// Add property
const addProp = (obj, key, value) => ({ ...obj, [key]: value })

// Remove property
const removeProp = (obj, key) => {
  const { [key]: removed, ...rest } = obj
  return rest
}

// Update nested property
const updateNested = (obj, path, value) => {
  const [key, ...rest] = path
  if (rest.length === 0) return { ...obj, [key]: value }
  return { ...obj, [key]: updateNested(obj[key], rest, value) }
}
```

**Arrays**:
```javascript
// Add
const add = (arr, item) => [...arr, item]
const addAt = (arr, index, item) => [...arr.slice(0, index), item, ...arr.slice(index)]

// Remove
const remove = (arr, index) => [...arr.slice(0, index), ...arr.slice(index + 1)]
const removeBy = (arr, predicate) => arr.filter(item => !predicate(item))

// Update
const update = (arr, index, updater) =>
  arr.map((item, i) => i === index ? updater(item) : item)
```

## Error Handling Patterns

### Result Type Pattern

```javascript
// Standard result shape
const createResult = (data, error = null) =>
  error ? { success: false, error } : { success: true, data }

// Use in functions
const divide = (a, b) =>
  b === 0
    ? createResult(null, 'Division by zero')
    : createResult(a / b)

// Chain results
const calculate = (a, b, c) => {
  const result1 = divide(a, b)
  if (!result1.success) return result1

  const result2 = divide(result1.data, c)
  return result2
}
```

### Try-Catch Wrapper

```javascript
const tryCatch = (fn) => async (...args) => {
  try {
    const data = await fn(...args)
    return { success: true, data }
  } catch (error) {
    return { success: false, error: error.message }
  }
}

// Wrap async functions
const safeFetchUser = tryCatch(fetchUser)
const result = await safeFetchUser(userId)
```

## State Management

### Local State with Closures

```javascript
const createCounter = (initial = 0) => {
  let count = initial

  return {
    get: () => count,
    increment: () => ++count,
    decrement: () => --count,
    reset: () => count = initial
  }
}

const counter = createCounter(10)
counter.increment() // 11
counter.get() // 11
```

### Immutable State Updates

```javascript
const createStore = (initialState) => {
  let state = initialState
  const listeners = []

  return {
    getState: () => state,
    setState: (updater) => {
      state = updater(state)
      listeners.forEach(listener => listener(state))
    },
    subscribe: (listener) => {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index > -1) listeners.splice(index, 1)
      }
    }
  }
}
```

## Cross-Pattern Comparisons

### OOP vs FP Comparison

**OOP Approach**:
```javascript
class UserService {
  constructor(database, hasher) {
    this.database = database
    this.hasher = hasher
  }

  async saveUser(userData) {
    const hashed = await this.hasher.hash(userData.password)
    return this.database.save({ ...userData, password: hashed })
  }
}
```

**FP Approach**:
```javascript
const createUserService = (database, hasher) => ({
  saveUser: async (userData) => {
    const hashed = await hasher.hash(userData.password)
    return database.save({ ...userData, password: hashed })
  }
})
```

**Trade-offs**:
- FP: Simpler, more explicit, easier to test
- OOP: More familiar to some developers, encapsulation through privacy

### Procedural vs FP

**Procedural**:
```javascript
function processUsers(users) {
  const result = []
  for (let i = 0; i < users.length; i++) {
    if (users[i].active) {
      result.push({
        ...users[i],
        displayName: users[i].firstName + ' ' + users[i].lastName
      })
    }
  }
  return result
}
```

**FP**:
```javascript
const processUsers = (users) =>
  users
    .filter(user => user.active)
    .map(user => ({
      ...user,
      displayName: `${user.firstName} ${user.lastName}`
    }))
```

**Trade-offs**:
- FP: More declarative, easier to understand intent
- Procedural: More control, potentially more performant for very large datasets

## When to Break the Rules

FP is a tool, not a religion. Break rules when:

1. **Performance**: Mutation is faster for large datasets (measure first!)
2. **Simplicity**: Sometimes procedural code is clearer
3. **Library Integration**: Some libraries require mutation
4. **Team Familiarity**: Don't force FP on a team that hates it

Always prioritize:
1. Correctness
2. Simplicity
3. Maintainability
4. Performance (when needed with evidence)
