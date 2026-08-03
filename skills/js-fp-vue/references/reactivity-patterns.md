# Reactivity Patterns

Deep reactivity patterns, performance optimization, and memory management for Vue.js.

## Table of Contents

1. [Reactive vs Ref](#reactive-vs-ref)
2. [Computed Optimization](#computed-optimization)
3. [Watch Anti-Patterns](#watch-anti-patterns)
4. [ShallowRef for Performance](#shallowref-for-performance)
5. [Memory Management](#memory-management)
6. [Common Anti-Patterns](#common-anti-patterns)

---

## Reactive vs Ref

### When to Use ref()

```typescript
import { ref, computed } from 'vue'

// Primitives - always ref
const count = ref(0)
const name = ref('')
const isActive = ref(false)

// Simple objects - prefer ref for consistency
const user = ref<UserData>({ id: '1', name: 'Alice', email: 'alice@test.com' })

// Access with .value in script
console.log(user.value.name)

// Template auto-unwraps
// <p>{{ user.name }}</p>
```

### When to Use reactive()

```typescript
import { reactive } from 'vue'

// Complex nested objects with many properties
const state = reactive({
  users: [] as UserData[],
  filters: {
    search: '',
    minAge: 0,
    status: 'active' as 'active' | 'inactive'
  },
  pagination: {
    page: 1,
    perPage: 20,
    total: 0
  }
})

// No .value needed
console.log(state.filters.search)
```

### Decision Guide

| Scenario | Use |
|----------|-----|
| Primitive values | `ref()` |
| Single object | `ref()` |
| Form state with many fields | `reactive()` |
| Complex nested state | `reactive()` |
| Needs to be replaced entirely | `ref()` |
| Need to pass by reference | `ref()` |

---

## Computed Optimization

### Always Computed for Derived State

```typescript
import { ref, computed } from 'vue'

const users = ref<UserData[]>([])
const searchTerm = ref('')

// Good: computed automatically caches
const filteredUsers = computed(() =>
  users.value.filter(u =>
    u.name.toLowerCase().includes(searchTerm.value.toLowerCase())
  )
)

// Good: computed chain
const activeFilteredUsers = computed(() =>
  filteredUsers.value.filter(u => u.isActive)
)

const userCount = computed(() => activeFilteredUsers.value.length)
```

### Avoid Expensive Recomputation

```typescript
// Bad: recomputes on every access
const getExpensiveData = () => {
  return users.value.map(u => ({
    ...u,
    computed: expensiveCalculation(u)
  }))
}

// Good: computed caches until dependencies change
const expensiveData = computed(() =>
  users.value.map(u => ({
    ...u,
    computed: expensiveCalculation(u)
  }))
)
```

### Computed with Getters and Setters

```typescript
const firstName = ref('John')
const lastName = ref('Doe')

const fullName = computed({
  get: () => `${firstName.value} ${lastName.value}`,
  set: (value: string) => {
    const [first, ...rest] = value.split(' ')
    firstName.value = first
    lastName.value = rest.join(' ')
  }
})

// Usage
fullName.value = 'Jane Smith' // Sets firstName and lastName
```

---

## Watch Anti-Patterns

### Bad: Watch for Derived State

```typescript
// Bad: watch to update derived state
const fullName = ref('')
watch([firstName, lastName], () => {
  fullName.value = `${firstName.value} ${lastName.value}`
})

// Good: computed for derived state
const fullName = computed(() => `${firstName.value} ${lastName.value}`)
```

### Good: Watch for Side Effects Only

```typescript
import { watch, watchEffect } from 'vue'

// Good: watch for API calls
watch(userId, async (newId) => {
  if (newId) {
    user.value = await fetchUser(newId)
  }
})

// Good: watchEffect for multiple dependencies
watchEffect(() => {
  if (user.value && isActive.value) {
    analytics.track('user_active', { userId: user.value.id })
  }
})

// Good: watch with cleanup
watch(source, (newValue, oldValue, onCleanup) => {
  const controller = new AbortController()
  fetchData(newValue, { signal: controller.signal })

  onCleanup(() => controller.abort())
})
```

---

## ShallowRef for Performance

Use shallowRef when you have large objects that are replaced, not mutated.

```typescript
import { shallowRef, triggerRef } from 'vue'

// Large dataset that gets replaced entirely
const largeDataset = shallowRef<DataItem[]>([])

// Replacing works fine
const refreshData = async () => {
  largeDataset.value = await fetchLargeDataset()
}

// Mutation requires manual trigger
const updateItem = (index: number, updates: Partial<DataItem>) => {
  largeDataset.value[index] = { ...largeDataset.value[index], ...updates }
  triggerRef(largeDataset) // Manual trigger needed
}
```

### When to Use shallowRef

| Scenario | Use |
|----------|-----|
| Large arrays (1000+ items) | `shallowRef()` |
| Data replaced, not mutated | `shallowRef()` |
| Deeply nested objects | `shallowRef()` or `shallowReactive()` |
| Small objects with mutations | `ref()` |

---

## Memory Management

### Cleanup Subscriptions

```typescript
import { onUnmounted } from 'vue'

export const useEventListener = (
  target: EventTarget,
  event: string,
  handler: EventListener
) => {
  target.addEventListener(event, handler)

  onUnmounted(() => {
    target.removeEventListener(event, handler)
  })
}
```

### Avoid Memory Leaks with watchEffect

```typescript
import { watchEffect } from 'vue'

// watchEffect auto-stops when component unmounts
// But manual stop is available if needed
const stop = watchEffect(() => {
  // Side effect
})

// Manual stop if needed
// stop()
```

### Cleanup in Async Operations

```typescript
import { ref, onUnmounted } from 'vue'

export const useAsyncData = <T>(fetcher: () => Promise<T>) => {
  const data = ref<T | null>(null)
  const loading = ref(false)
  let cancelled = false

  const fetch = async () => {
    cancelled = false
    loading.value = true
    try {
      const result = await fetcher()
      if (!cancelled) {
        data.value = result
      }
    } finally {
      if (!cancelled) {
        loading.value = false
      }
    }
  }

  onUnmounted(() => {
    cancelled = true
  })

  return { data, loading, fetch }
}
```

---

## Common Anti-Patterns

### Reactive Over-Engineering

```typescript
// Bad: Unnecessary nesting
const user = reactive({
  profile: reactive({
    settings: reactive({
      theme: 'dark'
    })
  })
})

// Good: Simple structure
const userSettings = ref({ theme: 'dark', notifications: true })
const isDarkTheme = computed(() => userSettings.value.theme === 'dark')
```

### Ref Unwrapping Confusion

```typescript
// Bad: Inconsistent access
const count = ref(0)
console.log(count) // Ref object, not value

// Good: Always use .value in script
console.log(count.value)

// Template auto-unwraps, no .value needed
// <p>{{ count }}</p>
```

### Mutating Props

```typescript
// Bad: Mutating prop
const props = defineProps<{ user: UserData }>()
props.user.name = 'New Name' // Mutation!

// Good: Emit update
const emit = defineEmits<{ update: [user: UserData] }>()
const updateName = (name: string) => {
  emit('update', { ...props.user, name })
}
```

---

## Performance Checklist

Before optimizing, always measure first. Then:

1. Use `computed()` for derived state (caching)
2. Avoid `watch()` for derived values
3. Use `shallowRef()` for large datasets
4. Clean up subscriptions in `onUnmounted()`
5. Use `v-once` for static content in templates
6. Use `v-memo` for expensive list renders
7. Avoid reactive objects when plain objects suffice
