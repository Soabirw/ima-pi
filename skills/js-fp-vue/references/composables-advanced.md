# Composables Advanced Patterns

Advanced composable patterns for Vue.js FP architecture.

## Table of Contents

1. [Composable Factory Pattern](#composable-factory-pattern)
2. [State Management with Composables](#state-management-with-composables)
3. [Provide/Inject for Dependency Injection](#provideinject-for-dependency-injection)
4. [Lifecycle Integration](#lifecycle-integration)
5. [Composable Composition](#composable-composition)

---

## Composable Factory Pattern

Pre-compile expensive configurations for performance.

```typescript
// composables/useUserFactory.ts
import type { Ref } from 'vue'
import { computed } from 'vue'

interface UserData {
  id: string
  name: string
  email: string
}

interface UserConfig {
  showEmail: boolean
  variant: 'compact' | 'detailed'
}

// Factory creates optimized composable
const createUserComposable = (defaultConfig: UserConfig) => {
  // Pre-compile static configuration (hot path optimization)
  const compiledClasses = {
    compact: {
      card: 'user-card user-card--compact',
      name: 'user-card__name user-card__name--compact'
    },
    detailed: {
      card: 'user-card user-card--detailed',
      name: 'user-card__name user-card__name--detailed'
    }
  }

  return (userData: Readonly<Ref<UserData>>, config?: Partial<UserConfig>) => {
    const mergedConfig = { ...defaultConfig, ...config }

    const displayData = computed(() => ({
      ...userData.value,
      displayName: userData.value.name.trim()
    }))

    // O(1) lookup instead of string concatenation
    const cssClasses = computed(() => compiledClasses[mergedConfig.variant])

    return { displayData, cssClasses }
  }
}

// Usage: Pre-compile for different contexts
export const useCompactUser = createUserComposable({
  showEmail: false,
  variant: 'compact'
})

export const useDetailedUser = createUserComposable({
  showEmail: true,
  variant: 'detailed'
})
```

---

## State Management with Composables

Use composables for 95% of state management. Only use Pinia/Vuex for truly global state.

```typescript
// composables/useUserState.ts
import { ref, readonly } from 'vue'

interface UserData {
  id: string
  name: string
  email: string
}

export const useUserState = () => {
  const users = ref<UserData[]>([])
  const loading = ref(false)

  // Pure functions for state transitions
  const addUser = (user: UserData) => {
    users.value = [...users.value, user] // Immutable
  }

  const updateUser = (userId: string, updates: Partial<UserData>) => {
    users.value = users.value.map(user =>
      user.id === userId ? { ...user, ...updates } : user
    ) // Immutable
  }

  const removeUser = (userId: string) => {
    users.value = users.value.filter(user => user.id !== userId) // Immutable
  }

  // Side effect isolated
  const fetchUsers = async (userApi: { getUsers: () => Promise<UserData[]> }) => {
    loading.value = true
    try {
      users.value = await userApi.getUsers()
    } finally {
      loading.value = false
    }
  }

  return {
    users: readonly(users),
    loading: readonly(loading),
    addUser,
    updateUser,
    removeUser,
    fetchUsers
  }
}
```

---

## Provide/Inject for Dependency Injection

Use Vue's provide/inject for cross-component dependency injection.

```typescript
// composables/useApiProvider.ts
import { provide, inject, type InjectionKey } from 'vue'

interface ApiClient {
  getUser: (id: string) => Promise<UserData>
  updateUser: (user: UserData) => Promise<void>
}

// Type-safe injection key
const API_KEY: InjectionKey<ApiClient> = Symbol('api')

// Provider composable (use in root component)
export const useApiProvider = (client: ApiClient) => {
  provide(API_KEY, client)
}

// Consumer composable (use in child components)
export const useApi = (): ApiClient => {
  const api = inject(API_KEY)
  if (!api) {
    throw new Error('useApi must be used within ApiProvider')
  }
  return api
}

// Mock provider for testing
export const useMockApiProvider = () => {
  const mockClient: ApiClient = {
    getUser: async (id) => ({ id, name: 'Mock User', email: 'mock@test.com' }),
    updateUser: async () => {}
  }
  provide(API_KEY, mockClient)
}
```

---

## Lifecycle Integration

Integrate composables with Vue lifecycle hooks.

```typescript
// composables/usePolling.ts
import { ref, readonly, onMounted, onUnmounted } from 'vue'

export const usePolling = <T>(
  fetcher: () => Promise<T>,
  intervalMs: number = 60000
) => {
  const data = ref<T | null>(null)
  const error = ref<Error | null>(null)
  const loading = ref(false)

  let intervalId: ReturnType<typeof setInterval> | null = null

  const fetch = async () => {
    loading.value = true
    try {
      data.value = await fetcher()
      error.value = null
    } catch (e) {
      error.value = e as Error
    } finally {
      loading.value = false
    }
  }

  const start = () => {
    fetch() // Initial fetch
    intervalId = setInterval(fetch, intervalMs)
  }

  const stop = () => {
    if (intervalId) {
      clearInterval(intervalId)
      intervalId = null
    }
  }

  // Lifecycle integration
  onMounted(start)
  onUnmounted(stop)

  return {
    data: readonly(data),
    error: readonly(error),
    loading: readonly(loading),
    refetch: fetch,
    stop
  }
}
```

---

## Composable Composition

Compose multiple composables together.

```typescript
// composables/useUserDashboard.ts
import { computed } from 'vue'
import { useUserState } from './useUserState'
import { usePolling } from './usePolling'

export const useUserDashboard = (userApi: { getUsers: () => Promise<UserData[]> }) => {
  // Compose state management
  const { users, loading: stateLoading, addUser, updateUser, removeUser } = useUserState()

  // Compose polling
  const { data: freshUsers, loading: pollLoading, refetch } = usePolling(
    userApi.getUsers,
    30000
  )

  // Derived state from composed composables
  const isLoading = computed(() => stateLoading.value || pollLoading.value)
  const userCount = computed(() => users.value.length)
  const hasUsers = computed(() => userCount.value > 0)

  return {
    users,
    isLoading,
    userCount,
    hasUsers,
    addUser,
    updateUser,
    removeUser,
    refetch
  }
}
```

---

## When to Use These Patterns

| Pattern | Use When |
|---------|----------|
| Factory | Multiple similar composables with different configs |
| State Management | Local/feature state (95% of cases) |
| Provide/Inject | Cross-component dependencies, testing |
| Lifecycle Integration | Timers, subscriptions, cleanup needed |
| Composition | Building complex features from simple parts |
