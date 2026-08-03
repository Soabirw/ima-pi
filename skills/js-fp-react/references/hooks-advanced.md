# Advanced React Hooks Patterns

Advanced patterns for custom hooks following FP principles.

## Table of Contents

1. [Composition Patterns](#composition-patterns)
2. [State Machine Hooks](#state-machine-hooks)
3. [Async Data Hooks](#async-data-hooks)
4. [Effect Isolation](#effect-isolation)

## Composition Patterns

### Hook Composition

Compose smaller hooks into larger ones:

```typescript
// Small, focused hooks
const useToggle = (initial = false) => {
  const [value, setValue] = useState(initial)
  const toggle = useCallback(() => setValue(v => !v), [])
  return { value, toggle }
}

const useAsync = <T>(asyncFn: () => Promise<T>, deps: any[]) => {
  const [state, setState] = useState<{
    data: T | null; loading: boolean; error: Error | null
  }>({ data: null, loading: true, error: null })

  useEffect(() => {
    setState(s => ({ ...s, loading: true }))
    asyncFn()
      .then(data => setState({ data, loading: false, error: null }))
      .catch(error => setState({ data: null, loading: false, error }))
  }, deps)

  return state
}
```

### Reducer Pattern for Complex State

```typescript
type Action =
  | { type: 'FETCH_START' }
  | { type: 'FETCH_SUCCESS'; payload: User[] }
  | { type: 'FETCH_ERROR'; error: Error }

// Pure reducer function
const userReducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'FETCH_START': return { ...state, loading: true, error: null }
    case 'FETCH_SUCCESS': return { ...state, users: action.payload, loading: false }
    case 'FETCH_ERROR': return { ...state, error: action.error, loading: false }
    default: return state
  }
}
```

## State Machine Hooks

```typescript
type FormState = 'idle' | 'validating' | 'submitting' | 'success' | 'error'

const useFormMachine = () => {
  const [state, setState] = useState<FormState>('idle')

  const transition = useCallback((event: string) => {
    setState(current => {
      const transitions: Record<FormState, Record<string, FormState>> = {
        idle: { SUBMIT: 'submitting' },
        submitting: { SUCCESS: 'success', FAILURE: 'error' },
        error: { RETRY: 'idle' },
        success: { RESET: 'idle' }
      }
      return transitions[current]?.[event] ?? current
    })
  }, [])

  return { state, canSubmit: state === 'idle', transition }
}
```

## Async Data Hooks

### Debounced Search

```typescript
const useDebouncedSearch = <T>(searchFn: (q: string) => Promise<T[]>, delay = 300) => {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<T[]>([])

  useEffect(() => {
    if (!query.trim()) { setResults([]); return }
    const timer = setTimeout(async () => {
      setResults(await searchFn(query))
    }, delay)
    return () => clearTimeout(timer)
  }, [query, searchFn, delay])

  return { query, setQuery, results }
}
```

## Effect Isolation

```typescript
// Pure computation hook
const useCartCalculations = (items: CartItem[]) => {
  return useMemo(() => ({
    subtotal: items.reduce((sum, item) => sum + item.price * item.qty, 0),
    itemCount: items.reduce((sum, item) => sum + item.qty, 0)
  }), [items])
}

// Side effect hook (separated)
const useCartPersistence = (items: CartItem[]) => {
  useEffect(() => {
    localStorage.setItem('cart', JSON.stringify(items))
  }, [items])
}
```

## Testing

```typescript
// Test reducer in isolation (pure function)
describe('userReducer', () => {
  it('handles FETCH_SUCCESS', () => {
    const state = { users: [], loading: true, error: null }
    const result = userReducer(state, { type: 'FETCH_SUCCESS', payload: [mockUser] })
    expect(result.users).toEqual([mockUser])
  })
})
```
