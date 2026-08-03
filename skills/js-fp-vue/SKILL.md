---
name: "js-fp-vue"
description: "FP patterns for Vue.js with composables, wrappers, and pure components - references js-fp core"
---

# JavaScript FP - Vue.js

Pure components with business logic in composables, wrapper pattern for side effects, composables over stores (95% of cases). Builds on `../js-fp/SKILL.md`.

## Pure Component + Composable Pattern

Separate business logic (composables) from presentation (components).

```vue
<script setup lang="ts">
import type { Ref } from 'vue'
import { computed, readonly, toRef } from 'vue'

interface UserData { id: string; name: string; email: string }
interface UserConfig { showEmail: boolean; variant: 'compact' | 'detailed' }

const useUserLogic = (userData: Readonly<Ref<UserData>>, config: Readonly<Ref<UserConfig>>) => {
  const displayData = computed(() => ({
    ...userData.value,
    displayName: userData.value.name.trim(),
    ...(config.value.showEmail ? {} : { email: undefined })
  }))

  const cssClasses = computed(() => ({
    card: `user-card user-card--${config.value.variant}`,
    name: `user-card__name user-card__name--${config.value.variant}`
  }))

  return { displayData, cssClasses }
}

const props = defineProps<{ userData: UserData; config: UserConfig }>()
const { displayData, cssClasses } = useUserLogic(
  readonly(toRef(props, 'userData')),
  readonly(toRef(props, 'config'))
)
</script>

<template>
  <div :class="cssClasses.card">
    <h3 :class="cssClasses.name">{{ displayData.displayName }}</h3>
    <p v-if="config.showEmail && displayData.email">{{ displayData.email }}</p>
  </div>
</template>
```

## Wrapper Pattern for Side Effects

Pure inner component receives data via props, emits events. Wrapper handles all I/O.

```vue
<!-- UserDisplayPure.vue -->
<script setup lang="ts">
const props = defineProps<{ user: UserData }>()
const emit = defineEmits<{ update: [user: UserData] }>()
const handleUpdate = (updates: Partial<UserData>) => emit('update', { ...props.user, ...updates })
</script>

<!-- UserDisplayWrapper.vue -->
<script setup lang="ts">
import { ref } from 'vue'
import UserDisplayPure from './UserDisplayPure.vue'

const props = defineProps<{ userId: string }>()
const user = ref<UserData | null>(null)
const loading = ref(true)
const error = ref<Error | null>(null)

const fetchUser = async () => {
  try {
    loading.value = true
    user.value = await userApi.getUser(props.userId)
  } catch (e) {
    error.value = e as Error
  } finally {
    loading.value = false
  }
}

const handleUpdate = async (updatedUser: UserData) => {
  await userApi.updateUser(updatedUser)
  await fetchUser()
}

fetchUser()
</script>

<template>
  <UserDisplayPure v-if="user && !loading" :user="user" @update="handleUpdate" />
  <div v-else-if="loading">Loading...</div>
  <div v-else-if="error">Error: {{ error.message }}</div>
</template>
```

## Reactive vs. Ref

```typescript
// ref for primitives and simple objects (default choice)
const count = ref(0)
const user = ref<UserData>({ id: '1', name: 'Alice', email: 'alice@test.com' })

// reactive sparingly — only for complex nested objects
const state = reactive({ users: [], filters: { search: '', minAge: 0 } })

// computed over watch for derived state
const filteredUsers = computed(() =>
  state.users.filter(u => u.name.includes(state.filters.search))
)
```

## Anti-Patterns

```typescript
// BAD: Pinia store for simple state
const useUserStore = defineStore('users', {
  state: () => ({ users: [], loading: false }),
  actions: { async fetchUsers() { /* ... */ } }
})

// GOOD: Composable (covers 95% of cases)
const useUsers = () => {
  const users = ref<UserData[]>([])
  const loading = ref(false)
  const fetchUsers = async () => {
    loading.value = true
    users.value = await userApi.getUsers()
    loading.value = false
  }
  return { users: readonly(users), loading: readonly(loading), fetchUsers }
}

// BAD: watch for derived state
watch([firstName, lastName], () => { fullName.value = `${firstName.value} ${lastName.value}` })

// GOOD: computed
const fullName = computed(() => `${firstName.value} ${lastName.value}`)

// BAD: Nested reactive
const user = reactive({ profile: reactive({ settings: reactive({ theme: 'dark' }) }) })

// GOOD: ref with computed
const userSettings = ref({ theme: 'dark', notifications: true })
const isDarkTheme = computed(() => userSettings.value.theme === 'dark')
```

## Quality Gates

1. Business logic in composable, not component?
2. Side effects isolated to wrapper component?
3. computed over watch for derived state?
4. Composable instead of store (unless truly global state)?
5. All dependencies injectable for testing?
6. Immutable updates, pure functions?

## Reference Files

| File | Load When |
|------|-----------|
| `references/composables-advanced.md` | Factory patterns, provide/inject DI, lifecycle integration |
| `references/reactivity-patterns.md` | Performance, shallowRef, computed optimization, cleanup |
| `references/testing.md` | Testing composables, component tests, wrapper tests, mocking |
| `references/complete-examples.md` | Full working examples (product card, user dashboard, form) |
| `../js-fp/SKILL.md` | Core FP: purity, composition, DI, immutability, testing |
