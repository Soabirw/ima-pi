# Testing Patterns Reference

Comprehensive edge-case testing enabled by pure functions.

## Core Principle

Test systematically against ALL data types and edge cases. Pure functions make this practical:
- Same input always produces same output
- No side effects - tests don't interfere
- Fast execution - pure functions run quickly
- Predictable behavior - easy to reason about

## Test Matrix Template

```javascript
describe('FunctionUnderTest', () => {
    describe('valid inputs', () => {
        it('should handle expected use cases', () => {
            expect(validateIntegerGreaterThan(0)(5)).toBe(true)
            expect(validateIntegerGreaterThan(0)('5')).toBe(true)  // String numbers
        })
    })

    describe('invalid types', () => {
        // Test against ALL JavaScript types
        it('should reject null', () => expect(fn(null)).toBe(false))
        it('should reject undefined', () => expect(fn(undefined)).toBe(false))
        it('should reject NaN', () => expect(fn(NaN)).toBe(false))
        it('should reject boolean', () => expect(fn(true)).toBe(false))
        it('should reject array', () => expect(fn([])).toBe(false))
        it('should reject object', () => expect(fn({})).toBe(false))
        it('should reject function', () => expect(fn(() => {})).toBe(false))
    })

    describe('edge cases', () => {
        // Boundary values, empty inputs, extreme values
    })

    describe('composition', () => {
        // Test function combinations
    })
})
```

## Parameterized Test Pattern

```javascript
describe('calculateDiscount', () => {
  describe('valid inputs', () => {
    const testCases = [
      [100, 0.1, 10],
      [50, 0.2, 10],
      [0, 0.1, 0]
    ]

    testCases.forEach(([price, rate, expected]) => {
      it(`${rate*100}% discount on ${price} = ${expected}`, () => {
        expect(calculateDiscount(price, rate)).toBe(expected)
      })
    })
  })

  describe('invalid types', () => {
    const invalidTypes = [null, undefined, NaN, true, [], {}, '100']

    invalidTypes.forEach(input => {
      it(`handles ${typeof input} (${String(input)}) gracefully`, () => {
        expect(() => calculateDiscount(input, 0.1)).not.toThrow()
        expect(calculateDiscount(input, 0.1)).toBe(0)
      })
    })
  })
})
```

## Testing Composed Functions

```javascript
describe('validateCreditCard', () => {
  const validCard = {
    name: 'John Doe',
    number: '4111111111111111',
    expDate: '12/26',
    cvv: '123'
  }

  it('accepts valid complete card', () => {
    expect(validateCreditCard(validCard)).toEqual({ valid: true })
  })

  // Test each field independently
  const fields = ['name', 'number', 'expDate', 'cvv']
  fields.forEach(field => {
    it(`rejects missing ${field}`, () => {
      const invalid = { ...validCard, [field]: '' }
      expect(validateCreditCard(invalid).valid).toBe(false)
    })
  })
})
```

## Testing Pure Functions with Dependencies

```javascript
// Function under test
const saveUser = async (userData, hasher, database) => {
  const hashedPassword = await hasher.hash(userData.password)
  return database.save({ ...userData, password: hashedPassword })
}

// Test with mock dependencies
describe('saveUser', () => {
  const mockHasher = { hash: jest.fn(p => `hashed_${p}`) }
  const mockDb = { save: jest.fn(user => ({ id: 1, ...user })) }

  it('hashes password and saves user', async () => {
    const result = await saveUser(
      { email: 'test@example.com', password: 'secret' },
      mockHasher,
      mockDb
    )
    expect(mockHasher.hash).toHaveBeenCalledWith('secret')
    expect(result.password).toBe('hashed_secret')
  })
})
```

## Quick Checklist

- [ ] Test all JavaScript types (null, undefined, NaN, boolean, array, object, function)
- [ ] Test boundary values (0, -1, MAX_SAFE_INTEGER, empty string, empty array)
- [ ] Test composition of functions together
- [ ] Mock dependencies for isolation
- [ ] Use parameterized tests for data variations
