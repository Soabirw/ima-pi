/**
 * Pure Functions Examples
 *
 * Demonstrating core FP concepts with practical examples
 */

// ============================================================================
// 1. BASIC PURITY
// ============================================================================

// ❌ Impure: Depends on external state
let taxRate = 0.1
const calculateTotalImpure = (price) => price * (1 + taxRate)

// ✅ Pure: All dependencies explicit
const calculateTotal = (price, taxRate) => price * (1 + taxRate)

// ✅ Pure with pre-configuration
const createTaxCalculator = (taxRate) => (price) => price * (1 + taxRate)
const calculateWithTax = createTaxCalculator(0.1)

// ============================================================================
// 2. COMPOSITION WITHOUT UTILITIES
// ============================================================================

// Data validation example
const validateRequired = (value) => value != null && value !== ''
const validateEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
const validateLength = (min, max) => (value) =>
  value.length >= min && value.length <= max

// Compose with early returns (no pipe utility needed)
const validateUserEmail = (email) => {
  if (!validateRequired(email)) {
    return { valid: false, error: 'Email is required' }
  }

  if (!validateEmail(email)) {
    return { valid: false, error: 'Invalid email format' }
  }

  if (!validateLength(5, 100)(email)) {
    return { valid: false, error: 'Email must be 5-100 characters' }
  }

  return { valid: true, value: email }
}

// ============================================================================
// 3. DEPENDENCY INJECTION
// ============================================================================

// Pure business logic
const hashPassword = (password, hasher) => hasher.hash(password)
const saveToDatabase = (data, database) => database.save(data)

// Compose with explicit dependencies
const saveUser = async (userData, hasher, database) => {
  const hashedPassword = await hashPassword(userData.password, hasher)
  const userToSave = { ...userData, password: hashedPassword }
  return saveToDatabase(userToSave, database)
}

// Function factory for convenience
const createUserService = (hasher, database) => ({
  save: (userData) => saveUser(userData, hasher, database),
  find: (id) => database.findById(id)
})

// ============================================================================
// 4. IMMUTABILITY
// ============================================================================

// Pure array operations
const users = [
  { id: 1, name: 'Alice', active: true },
  { id: 2, name: 'Bob', active: false },
  { id: 3, name: 'Charlie', active: true }
]

// Add user (immutable)
const addUser = (users, newUser) => [...users, newUser]

// Remove user (immutable)
const removeUser = (users, userId) =>
  users.filter(user => user.id !== userId)

// Update user (immutable)
const updateUser = (users, userId, updates) =>
  users.map(user =>
    user.id === userId ? { ...user, ...updates } : user
  )

// Filter active users
const getActiveUsers = (users) => users.filter(user => user.active)

// ============================================================================
// 5. DATA TRANSFORMATION PIPELINE
// ============================================================================

// Transform user data without utilities
const processUserData = (rawData) => {
  // Normalize
  const normalized = {
    id: rawData.id,
    name: rawData.name?.trim() || '',
    email: rawData.email?.toLowerCase() || ''
  }

  // Validate
  const emailValidation = validateUserEmail(normalized.email)
  if (!emailValidation.valid) {
    return { valid: false, error: emailValidation.error }
  }

  // Enhance
  const enhanced = {
    ...normalized,
    displayName: normalized.name || 'Anonymous',
    createdAt: new Date().toISOString()
  }

  return { valid: true, data: enhanced }
}

// ============================================================================
// 6. ERROR HANDLING
// ============================================================================

// Result type pattern
const divide = (a, b) =>
  b === 0
    ? { success: false, error: 'Division by zero' }
    : { success: true, data: a / b }

// Chain operations with early returns
const calculate = (a, b, c) => {
  const step1 = divide(a, b)
  if (!step1.success) return step1

  const step2 = divide(step1.data, c)
  return step2
}

// Try-catch wrapper for async
const tryCatch = (fn) => async (...args) => {
  try {
    const data = await fn(...args)
    return { success: true, data }
  } catch (error) {
    return { success: false, error: error.message }
  }
}

// ============================================================================
// 7. CONFIGURATION PRE-COMPILATION (Performance)
// ============================================================================

// Problem: O(items × validators) - repeated config access
const validateItemsSlow = (items, validators) => {
  return items.map(item => {
    const errors = []
    for (const validator of validators) {
      if (!validator.validate(item[validator.field])) {
        errors.push(validator.message)
      }
    }
    return { item, valid: errors.length === 0, errors }
  })
}

// Solution: O(validators + items) - pre-compiled
const createItemValidator = (validators) => {
  // Pre-compile validator functions
  const compiledValidators = validators.map(v => ({
    field: v.field,
    validate: v.validate,
    message: v.message
  }))

  return (item) => {
    const errors = []
    for (const validator of compiledValidators) {
      if (!validator.validate(item[validator.field])) {
        errors.push(validator.message)
      }
    }
    return { item, valid: errors.length === 0, errors }
  }
}

const validateItemsFast = (items, validators) => {
  const validator = createItemValidator(validators)
  return items.map(validator)
}

// ============================================================================
// 8. MEMOIZATION (Pure Functions Only)
// ============================================================================

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

// Expensive calculation (pure)
const fibonacci = (n) => {
  if (n <= 1) return n
  return fibonacci(n - 1) + fibonacci(n - 2)
}

const fibonacciMemoized = memoize(fibonacci)

// ============================================================================
// EXPORTS FOR TESTING
// ============================================================================

module.exports = {
  // Basic purity
  calculateTotal,
  createTaxCalculator,

  // Composition
  validateRequired,
  validateEmail,
  validateLength,
  validateUserEmail,

  // Dependency injection
  saveUser,
  createUserService,

  // Immutability
  addUser,
  removeUser,
  updateUser,
  getActiveUsers,

  // Data transformation
  processUserData,

  // Error handling
  divide,
  calculate,
  tryCatch,

  // Performance
  createItemValidator,
  validateItemsFast,

  // Memoization
  memoize,
  fibonacciMemoized
}
