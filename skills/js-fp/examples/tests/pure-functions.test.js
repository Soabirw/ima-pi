/**
 * Pure Functions Test Suite
 *
 * Demonstrating comprehensive testing enabled by purity
 */

const {
  calculateTotal,
  createTaxCalculator,
  validateRequired,
  validateEmail,
  validateUserEmail,
  addUser,
  removeUser,
  updateUser,
  divide,
  calculate,
  memoize
} = require('../pure-functions')

describe('Pure Functions - Comprehensive Testing', () => {
  // ============================================================================
  // BASIC PURITY TESTS
  // ============================================================================

  describe('calculateTotal', () => {
    it('calculates total with tax', () => {
      expect(calculateTotal(100, 0.1)).toBe(110)
      expect(calculateTotal(50, 0.2)).toBe(60)
    })

    it('handles zero price', () => {
      expect(calculateTotal(0, 0.1)).toBe(0)
    })

    it('handles zero tax rate', () => {
      expect(calculateTotal(100, 0)).toBe(100)
    })
  })

  describe('createTaxCalculator', () => {
    it('creates specialized calculator', () => {
      const calc = createTaxCalculator(0.1)
      expect(calc(100)).toBe(110)
      expect(calc(50)).toBe(55)
    })
  })

  // ============================================================================
  // VALIDATION TESTS (All Edge Cases)
  // ============================================================================

  describe('validateRequired', () => {
    it('validates non-empty values', () => {
      expect(validateRequired('test')).toBe(true)
      expect(validateRequired(0)).toBe(true)
      expect(validateRequired(false)).toBe(true)
    })

    it('rejects empty values', () => {
      expect(validateRequired('')).toBe(false)
      expect(validateRequired(null)).toBe(false)
      expect(validateRequired(undefined)).toBe(false)
    })
  })

  describe('validateEmail', () => {
    it('validates correct emails', () => {
      expect(validateEmail('test@example.com')).toBe(true)
      expect(validateEmail('user.name@domain.co.uk')).toBe(true)
    })

    it('rejects invalid emails', () => {
      expect(validateEmail('invalid')).toBe(false)
      expect(validateEmail('missing@domain')).toBe(false)
      expect(validateEmail('@example.com')).toBe(false)
    })
  })

  describe('validateUserEmail - Composition', () => {
    it('validates complete email', () => {
      const result = validateUserEmail('test@example.com')
      expect(result.valid).toBe(true)
      expect(result.value).toBe('test@example.com')
    })

    it('rejects missing email', () => {
      const result = validateUserEmail('')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Email is required')
    })

    it('rejects invalid format', () => {
      const result = validateUserEmail('invalid')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Invalid email format')
    })

    it('rejects too short', () => {
      const result = validateUserEmail('a@b')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Email must be 5-100 characters')
    })

    it('rejects too long', () => {
      const longEmail = 'a'.repeat(100) + '@example.com'
      const result = validateUserEmail(longEmail)
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Email must be 5-100 characters')
    })
  })

  // ============================================================================
  // IMMUTABILITY TESTS
  // ============================================================================

  describe('Immutable Array Operations', () => {
    const users = [
      { id: 1, name: 'Alice', active: true },
      { id: 2, name: 'Bob', active: false }
    ]

    describe('addUser', () => {
      it('adds user without mutation', () => {
        const newUser = { id: 3, name: 'Charlie', active: true }
        const result = addUser(users, newUser)

        expect(result).toHaveLength(3)
        expect(result[2]).toEqual(newUser)
        expect(users).toHaveLength(2) // Original unchanged
      })
    })

    describe('removeUser', () => {
      it('removes user without mutation', () => {
        const result = removeUser(users, 1)

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe(2)
        expect(users).toHaveLength(2) // Original unchanged
      })
    })

    describe('updateUser', () => {
      it('updates user without mutation', () => {
        const result = updateUser(users, 1, { name: 'Alice Updated' })

        expect(result[0].name).toBe('Alice Updated')
        expect(users[0].name).toBe('Alice') // Original unchanged
      })

      it('returns same array if user not found', () => {
        const result = updateUser(users, 999, { name: 'Not Found' })

        expect(result).toHaveLength(2)
        expect(result).toEqual(users)
      })
    })
  })

  // ============================================================================
  // ERROR HANDLING TESTS
  // ============================================================================

  describe('divide', () => {
    it('divides numbers successfully', () => {
      const result = divide(10, 2)
      expect(result.success).toBe(true)
      expect(result.data).toBe(5)
    })

    it('handles division by zero', () => {
      const result = divide(10, 0)
      expect(result.success).toBe(false)
      expect(result.error).toBe('Division by zero')
    })
  })

  describe('calculate - Chained Operations', () => {
    it('calculates successfully', () => {
      const result = calculate(20, 2, 5)
      expect(result.success).toBe(true)
      expect(result.data).toBe(2) // (20 / 2) / 5 = 2
    })

    it('short-circuits on first error', () => {
      const result = calculate(20, 0, 5)
      expect(result.success).toBe(false)
      expect(result.error).toBe('Division by zero')
    })

    it('short-circuits on second error', () => {
      const result = calculate(20, 2, 0)
      expect(result.success).toBe(false)
      expect(result.error).toBe('Division by zero')
    })
  })

  // ============================================================================
  // SYSTEMATIC EDGE CASE TESTING
  // ============================================================================

  describe('Edge Cases - All JavaScript Types', () => {
    const allTypes = [
      null,
      undefined,
      true,
      false,
      0,
      1,
      -1,
      '',
      'string',
      [],
      [1, 2],
      {},
      { key: 'value' },
      NaN,
      Infinity,
      -Infinity
    ]

    describe('validateRequired - handles all types', () => {
      allTypes.forEach(input => {
        it(`handles ${typeof input}: ${JSON.stringify(input)}`, () => {
          expect(() => validateRequired(input)).not.toThrow()
        })
      })
    })
  })

  // ============================================================================
  // MEMOIZATION TESTS
  // ============================================================================

  describe('memoize', () => {
    it('caches results', () => {
      const expensive = jest.fn((n) => n * 2)
      const memoized = memoize(expensive)

      expect(memoized(5)).toBe(10)
      expect(expensive).toHaveBeenCalledTimes(1)

      expect(memoized(5)).toBe(10)
      expect(expensive).toHaveBeenCalledTimes(1) // Still 1, cached

      expect(memoized(10)).toBe(20)
      expect(expensive).toHaveBeenCalledTimes(2) // New input
    })

    it('works with multiple arguments', () => {
      const add = jest.fn((a, b) => a + b)
      const memoized = memoize(add)

      expect(memoized(2, 3)).toBe(5)
      expect(add).toHaveBeenCalledTimes(1)

      expect(memoized(2, 3)).toBe(5)
      expect(add).toHaveBeenCalledTimes(1) // Cached
    })
  })
})
