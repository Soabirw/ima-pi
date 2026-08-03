# Complete Component Examples

Full working examples demonstrating Vue FP patterns.

## Table of Contents

1. [Product Card Component](#product-card-component)
2. [User Dashboard with Wrapper](#user-dashboard-with-wrapper)
3. [Form with Validation](#form-with-validation)

---

## Product Card Component

Complete example with pure composable, component, and styling.

```vue
<!-- ProductCard.vue -->
<script setup lang="ts">
import type { Ref } from 'vue'
import { computed, readonly, toRef } from 'vue'

interface Product {
  id: string
  name: string
  price: number
  inStock: boolean
}

// ───── Pure composable ─────
const useProductLogic = (product: Readonly<Ref<Product>>) => {
  const displayData = computed(() => ({
    ...product.value,
    formattedPrice: `$${product.value.price.toFixed(2)}`,
    availability: product.value.inStock ? 'In Stock' : 'Out of Stock'
  }))

  const cssClasses = computed(() => ({
    card: `product-card ${product.value.inStock ? 'in-stock' : 'out-of-stock'}`,
    price: `product-price ${product.value.inStock ? 'available' : 'unavailable'}`
  }))

  return { displayData, cssClasses }
}

// ───── Component setup ─────
const props = defineProps<{
  product: Product
}>()

const emit = defineEmits<{
  addToCart: [productId: string]
}>()

const { displayData, cssClasses } = useProductLogic(
  readonly(toRef(props, 'product'))
)

const handleAddToCart = () => {
  if (props.product.inStock) {
    emit('addToCart', props.product.id)
  }
}
</script>

<template>
  <div :class="cssClasses.card">
    <h3>{{ displayData.name }}</h3>
    <p :class="cssClasses.price">{{ displayData.formattedPrice }}</p>
    <p class="availability">{{ displayData.availability }}</p>
    <button
      @click="handleAddToCart"
      :disabled="!product.inStock"
    >
      Add to Cart
    </button>
  </div>
</template>

<style scoped>
.product-card {
  border: 1px solid #ddd;
  padding: 1rem;
  border-radius: 8px;
}

.product-card.in-stock {
  border-color: #28a745;
}

.product-card.out-of-stock {
  opacity: 0.6;
}

.product-price.unavailable {
  text-decoration: line-through;
}
</style>
```

---

## User Dashboard with Wrapper

Pure component + wrapper pattern with API integration.

### Pure Component

```vue
<!-- UserListPure.vue -->
<script setup lang="ts">
interface User {
  id: string
  name: string
  email: string
  role: 'admin' | 'user'
}

defineProps<{
  users: User[]
  selectedId: string | null
}>()

const emit = defineEmits<{
  select: [userId: string]
  delete: [userId: string]
}>()
</script>

<template>
  <ul class="user-list">
    <li
      v-for="user in users"
      :key="user.id"
      :class="{ selected: user.id === selectedId }"
      @click="emit('select', user.id)"
    >
      <span class="name">{{ user.name }}</span>
      <span class="email">{{ user.email }}</span>
      <span :class="['role', user.role]">{{ user.role }}</span>
      <button @click.stop="emit('delete', user.id)">Delete</button>
    </li>
  </ul>
</template>
```

### Wrapper Component

```vue
<!-- UserDashboard.vue -->
<script setup lang="ts">
import { ref, onMounted } from 'vue'
import UserListPure from './UserListPure.vue'

interface User {
  id: string
  name: string
  email: string
  role: 'admin' | 'user'
}

// Injected or imported API
const userApi = {
  getUsers: async (): Promise<User[]> => {
    const response = await fetch('/api/users')
    return response.json()
  },
  deleteUser: async (id: string): Promise<void> => {
    await fetch(`/api/users/${id}`, { method: 'DELETE' })
  }
}

// State
const users = ref<User[]>([])
const selectedId = ref<string | null>(null)
const loading = ref(true)
const error = ref<Error | null>(null)

// Side effects isolated to wrapper
const fetchUsers = async () => {
  loading.value = true
  error.value = null
  try {
    users.value = await userApi.getUsers()
  } catch (e) {
    error.value = e as Error
  } finally {
    loading.value = false
  }
}

const handleSelect = (userId: string) => {
  selectedId.value = userId
}

const handleDelete = async (userId: string) => {
  try {
    await userApi.deleteUser(userId)
    await fetchUsers() // Refresh list
    if (selectedId.value === userId) {
      selectedId.value = null
    }
  } catch (e) {
    error.value = e as Error
  }
}

onMounted(fetchUsers)
</script>

<template>
  <div class="user-dashboard">
    <h2>Users</h2>

    <div v-if="loading" class="loading">Loading users...</div>

    <div v-else-if="error" class="error">
      Error: {{ error.message }}
      <button @click="fetchUsers">Retry</button>
    </div>

    <UserListPure
      v-else
      :users="users"
      :selected-id="selectedId"
      @select="handleSelect"
      @delete="handleDelete"
    />
  </div>
</template>
```

---

## Form with Validation

Pure validation logic with form component.

### Validation Composable

```typescript
// composables/useFormValidation.ts
import type { Ref } from 'vue'
import { computed, ref } from 'vue'

type Validator<T> = (value: T) => string | null

interface FieldConfig<T> {
  value: Ref<T>
  validators: Validator<T>[]
}

export const useFormValidation = <T extends Record<string, unknown>>(
  fields: { [K in keyof T]: FieldConfig<T[K]> }
) => {
  const touched = ref<Record<keyof T, boolean>>(
    Object.keys(fields).reduce((acc, key) => ({ ...acc, [key]: false }), {} as Record<keyof T, boolean>)
  )

  const errors = computed(() => {
    const result: Partial<Record<keyof T, string>> = {}

    for (const [key, config] of Object.entries(fields) as [keyof T, FieldConfig<T[keyof T]>][]) {
      for (const validator of config.validators) {
        const error = validator(config.value.value)
        if (error) {
          result[key] = error
          break
        }
      }
    }

    return result
  })

  const isValid = computed(() => Object.keys(errors.value).length === 0)

  const touch = (field: keyof T) => {
    touched.value[field] = true
  }

  const touchAll = () => {
    for (const key of Object.keys(fields)) {
      touched.value[key as keyof T] = true
    }
  }

  const getError = (field: keyof T) => {
    return touched.value[field] ? errors.value[field] : null
  }

  return { errors, isValid, touched, touch, touchAll, getError }
}

// Common validators
export const required = (msg = 'Required'): Validator<string> =>
  (value) => value.trim() ? null : msg

export const minLength = (min: number, msg?: string): Validator<string> =>
  (value) => value.length >= min ? null : msg ?? `Min ${min} characters`

export const email = (msg = 'Invalid email'): Validator<string> =>
  (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : msg
```

### Form Component

```vue
<!-- UserForm.vue -->
<script setup lang="ts">
import { ref } from 'vue'
import { useFormValidation, required, minLength, email } from '@/composables/useFormValidation'

const emit = defineEmits<{
  submit: [data: { name: string; email: string }]
}>()

// Form state
const name = ref('')
const userEmail = ref('')

// Validation
const { isValid, touch, touchAll, getError } = useFormValidation({
  name: {
    value: name,
    validators: [required(), minLength(2)]
  },
  email: {
    value: userEmail,
    validators: [required(), email()]
  }
})

const handleSubmit = () => {
  touchAll()
  if (isValid.value) {
    emit('submit', { name: name.value, email: userEmail.value })
  }
}
</script>

<template>
  <form @submit.prevent="handleSubmit" class="user-form">
    <div class="field">
      <label for="name">Name</label>
      <input
        id="name"
        v-model="name"
        @blur="touch('name')"
        :class="{ error: getError('name') }"
      />
      <span v-if="getError('name')" class="error-msg">{{ getError('name') }}</span>
    </div>

    <div class="field">
      <label for="email">Email</label>
      <input
        id="email"
        type="email"
        v-model="userEmail"
        @blur="touch('email')"
        :class="{ error: getError('email') }"
      />
      <span v-if="getError('email')" class="error-msg">{{ getError('email') }}</span>
    </div>

    <button type="submit" :disabled="!isValid">Submit</button>
  </form>
</template>

<style scoped>
.user-form .field {
  margin-bottom: 1rem;
}

.user-form input.error {
  border-color: #dc3545;
}

.user-form .error-msg {
  color: #dc3545;
  font-size: 0.875rem;
}
</style>
```

---

## Pattern Summary

| Pattern | Example | Benefit |
|---------|---------|---------|
| Pure Composable | `useProductLogic` | 100% testable logic |
| Wrapper Pattern | `UserDashboard` + `UserListPure` | Isolated side effects |
| Validation Composable | `useFormValidation` | Reusable, pure validation |
| Computed CSS | `cssClasses` | Cached class computation |
| Event Delegation | `emit('select')` | Unidirectional data flow |
