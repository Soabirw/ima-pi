# React Performance Patterns

Performance optimization strategies: measure first, optimize with evidence.

## Table of Contents

1. [When to Optimize](#when-to-optimize)
2. [React.memo Strategies](#reactmemo-strategies)
3. [Virtualization](#virtualization)
4. [Code Splitting](#code-splitting)
5. [Render Optimization](#render-optimization)

## When to Optimize

**Rule**: Optimize only with evidence. Use React DevTools Profiler first.

### Signs You Need Optimization

- Janky scrolling in lists (> 100 items)
- Input lag when typing
- High "Render Duration" in Profiler (> 16ms)

### Signs You Do NOT Need Optimization

- Small component counts (< 50 on screen)
- Simple prop structures
- No user-reported performance issues

## React.memo Strategies

### When memo() Helps

```typescript
// Good: Expensive child with stable parent
const ExpensiveChart = memo(({ data }: { data: DataPoint[] }) => (
  <svg>{/* expensive rendering */}</svg>
))

// Good: Child in frequently-updating parent
const Parent = () => {
  const [count, setCount] = useState(0)
  return (
    <div>
      <button onClick={() => setCount(c => c + 1)}>{count}</button>
      <MemoizedSidebar /> {/* Doesn't need count */}
    </div>
  )
}
```

### When memo() Does NOT Help

```typescript
// Bad: Simple component (overhead > benefit)
const Label = memo(({ text }: { text: string }) => <span>{text}</span>)

// Bad: Props change every render anyway
const BadExample = () => {
  const data = { value: 1 } // New object every render
  return <MemoizedChild data={data} /> // memo is useless
}

// Fix: Stabilize props
const GoodExample = () => {
  const data = useMemo(() => ({ value: 1 }), [])
  return <MemoizedChild data={data} />
}
```

## Virtualization

For lists > 100 items, render only visible items.

```typescript
import { FixedSizeList } from 'react-window'

const Row = memo(({ index, style, data }: RowProps) => (
  <div style={style}>{data[index].name}</div>
))

const VirtualizedList = ({ items }: { items: Item[] }) => (
  <FixedSizeList
    height={400}
    width="100%"
    itemCount={items.length}
    itemSize={50}
    itemData={items}
  >
    {Row}
  </FixedSizeList>
)
```

## Code Splitting

### Route-Based Splitting

```typescript
import { lazy, Suspense } from 'react'

const Dashboard = lazy(() => import('./pages/Dashboard'))
const Settings = lazy(() => import('./pages/Settings'))

const App = () => (
  <Suspense fallback={<LoadingSpinner />}>
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/settings" element={<Settings />} />
    </Routes>
  </Suspense>
)
```

### Preloading

```typescript
const preloadEditor = () => import('./HeavyEditor')

const EditButton = ({ onClick }: { onClick: () => void }) => (
  <button onClick={onClick} onMouseEnter={preloadEditor}>
    Edit
  </button>
)
```

## Render Optimization

### State Colocation

```typescript
// Bad: State too high
const Parent = () => {
  const [inputValue, setInputValue] = useState('')
  return (
    <div>
      <ExpensiveTree /> {/* Re-renders on every keystroke */}
      <input value={inputValue} onChange={e => setInputValue(e.target.value)} />
    </div>
  )
}

// Good: State colocated
const Parent = () => (
  <div>
    <ExpensiveTree />
    <SearchInput /> {/* State lives here */}
  </div>
)
```

### Children as Props Pattern

```typescript
const ScrollContainer = ({ children }: { children: React.ReactNode }) => {
  const [scrollY, setScrollY] = useState(0)
  // children does NOT re-render when scrollY changes
  return (
    <div>
      <ScrollIndicator position={scrollY} />
      {children}
    </div>
  )
}
```

## Quick Reference

| Problem | Solution |
|---------|----------|
| Component re-renders too often | `React.memo()` + stable props |
| Expensive computation | `useMemo()` |
| Callback causes child re-render | `useCallback()` |
| Long list (>100 items) | Virtualization |
| Large bundle size | Code splitting |
| State causes sibling re-render | State colocation |
