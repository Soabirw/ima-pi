---
name: "js-fp-react"
description: "FP patterns for React with hooks, HOCs, and pure components - references js-fp core"
---

# JavaScript FP - React

FP patterns for React 16.8+ (hooks era): business logic in custom hooks, HOCs for DI, appropriate memoization.

**Foundation**: Builds on `js-fp` core. See `../js-fp/SKILL.md` for purity, composition, DI, and testing patterns.

## Pure Component + Custom Hook Pattern

Separate business logic (hooks) from presentation (components).

```typescript
import { memo, useMemo, useCallback } from 'react'

// ───── Custom hook with pure business logic ─────
const useUserLogic = (userData: UserData, config: UserConfig) => {
  const displayData = useMemo(() => ({
    ...userData,
    displayName: userData.name.trim(),
    shouldShowEmail: config.showEmail && userData.email
  }), [userData, config])

  const handleAction = useCallback((action: string) => ({
    type: 'USER_ACTION',
    payload: { userId: userData.id, action }
  }), [userData.id])

  return { displayData, handleAction }
}

// ───── Pure component with memo ─────
const UserCard = memo<UserCardProps>(({ userData, config, onAction }) => {
  const { displayData, handleAction } = useUserLogic(userData, config)

  const handleClick = useCallback(() => {
    const action = handleAction('view')
    onAction?.(action)
  }, [handleAction, onAction])

  return (
    <div className={`user-card user-card--${config.variant}`}>
      <h3>{displayData.displayName}</h3>
      {displayData.shouldShowEmail && <p>{displayData.email}</p>}
      <button onClick={handleClick}>View</button>
    </div>
  )
})

UserCard.displayName = 'UserCard'
```

## HOC for Dependency Injection

Inject dependencies via HOCs for testability.

```typescript
interface ServiceDependencies {
  userService: { getUser: (id: string) => Promise<UserData>; updateUser: (id: string, data: Partial<UserData>) => Promise<UserData> }
  logger: { info: (message: string, meta?: any) => void; error: (message: string, meta?: any) => void }
}

export const withUserService = <P extends object>(
  WrappedComponent: React.ComponentType<P & ServiceDependencies>
) => {
  const WithUserServiceComponent = (props: P) => {
    const services: ServiceDependencies = {
      userService: useUserService(),
      logger: useLogger()
    }
    return <WrappedComponent {...props} {...services} />
  }

  WithUserServiceComponent.displayName =
    `withUserService(${WrappedComponent.displayName || WrappedComponent.name})`

  return WithUserServiceComponent
}

const UserProfile = ({ userId, userService, logger }: { userId: string } & ServiceDependencies) => {
  const [user, setUser] = useState<UserData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadUser = async () => {
      try {
        const userData = await userService.getUser(userId)
        setUser(userData)
        logger.info('User loaded', { userId })
      } catch (error) {
        logger.error('Failed to load user', { userId, error })
      } finally {
        setLoading(false)
      }
    }
    loadUser()
  }, [userId, userService, logger])

  if (loading) return <div>Loading...</div>
  if (!user) return <div>User not found</div>
  return <UserCard userData={user} config={{ showEmail: true, variant: 'detailed' }} />
}

export const UserProfileWithServices = withUserService(UserProfile)
```

## Compound Component Pattern

Composition for flexible, reusable component APIs.

```typescript
const ModalContext = createContext<{ isOpen: boolean; onClose: () => void } | null>(null)

const useModalContext = () => {
  const context = useContext(ModalContext)
  if (!context) throw new Error('Modal components must be used within Modal')
  return context
}

const Modal = ({ isOpen, onClose, children }: ModalProps) => {
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    if (isOpen) {
      document.addEventListener('keydown', handleEscape)
      return () => document.removeEventListener('keydown', handleEscape)
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <ModalContext.Provider value={{ isOpen, onClose }}>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-content" onClick={e => e.stopPropagation()}>
          {children}
        </div>
      </div>
    </ModalContext.Provider>
  )
}

Modal.Header = ({ children }: { children: React.ReactNode }) => {
  const { onClose } = useModalContext()
  return <div className="modal-header">{children}<button onClick={onClose} aria-label="Close">×</button></div>
}
Modal.Body = ({ children }: { children: React.ReactNode }) => <div className="modal-body">{children}</div>
Modal.Footer = ({ children }: { children: React.ReactNode }) => <div className="modal-footer">{children}</div>
```

## Performance (Evidence-Based Only)

```typescript
// ✅ memo for genuinely expensive renders
const ExpensiveComponent = memo(({ data }: { data: LargeDataSet }) => <ComplexVisualization data={data} />)

// ✅ useMemo for expensive computations
const result = useMemo(() => performExpensiveCalculation(largeDataSet), [largeDataSet])

// ✅ useCallback to stabilize props to memoized children
const handleClick = useCallback(() => setCount(c => c + 1), [])

// ❌ memo on trivial components — not needed
// ❌ useMemo for simple expressions: `${first} ${last}` — just write it inline
// ❌ useCallback when child isn't memoized — no benefit
```

## Testing

```typescript
// Hook tests
import { renderHook } from '@testing-library/react-hooks'

describe('useUserLogic', () => {
  it('processes user data correctly', () => {
    const { result } = renderHook(() =>
      useUserLogic({ id: '1', name: '  John  ', email: 'john@test.com' }, { showEmail: true, variant: 'compact' })
    )
    expect(result.current.displayData.displayName).toBe('John')
    expect(result.current.displayData.shouldShowEmail).toBe(true)
  })
})

// Component tests
describe('UserCard', () => {
  it('calls onAction when button clicked', async () => {
    const onAction = jest.fn()
    render(
      <UserCard
        userData={{ id: '1', name: 'John', email: 'john@test.com' }}
        config={{ showEmail: true, variant: 'compact' }}
        onAction={onAction}
      />
    )
    await userEvent.click(screen.getByRole('button'))
    expect(onAction).toHaveBeenCalled()
  })
})
```

## Anti-Patterns

| Pattern | Avoid | Use Instead |
|---------|-------|-------------|
| Context for local state | `createContext` + provider for 2-component data | Props |
| Premature memoization | `useMemo(() => 1 + 1, [])` | Direct computation |
| `useCallback` on non-memoized children | Adds overhead, no benefit | Plain function |

## Quality Gates

1. Business logic in custom hook, not component body?
2. Dependencies injected via HOC (not imported directly)?
3. `memo`/`useMemo`/`useCallback` only where evidence of need?
4. Compound components for flexible APIs?
5. All hooks testable without rendering full component tree?
6. Immutable state updates throughout?

## References

- `references/hooks-advanced.md` — complex hooks, state machines, async patterns
- `references/performance-patterns.md` — React.memo strategies, virtualization, code splitting
- `examples/ProductCard.tsx` — complete working component with custom hook
