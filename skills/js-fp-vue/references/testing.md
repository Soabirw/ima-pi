# Testing Vue FP Components

Testing patterns for Vue.js functional programming architecture.

## Table of Contents

1. [Testing Pure Composables](#testing-pure-composables)
2. [Testing Components](#testing-components)
3. [Testing Wrapper Components](#testing-wrapper-components)
4. [Mocking Dependencies](#mocking-dependencies)

---

## Testing Pure Composables

Composables with pure logic are trivially testable.

```typescript
// composables/__tests__/useUserLogic.test.ts
import { ref } from 'vue'
import { useUserLogic } from '../useUserLogic'

describe('useUserLogic', () => {
  it('computes display data correctly', () => {
    const userData = ref({
      id: '1',
      name: ' John ',
      email: 'john@test.com'
    })
    const config = ref({
      showEmail: true,
      variant: 'compact' as const
    })

    const { displayData } = useUserLogic(userData, config)

    expect(displayData.value).toEqual({
      id: '1',
      name: ' John ',
      email: 'john@test.com',
      displayName: 'John' // Trimmed
    })
  })

  it('hides email when config.showEmail is false', () => {
    const userData = ref({
      id: '1',
      name: 'John',
      email: 'john@test.com'
    })
    const config = ref({
      showEmail: false,
      variant: 'compact' as const
    })

    const { displayData } = useUserLogic(userData, config)

    expect(displayData.value.email).toBeUndefined()
  })

  it('generates correct CSS classes for variant', () => {
    const userData = ref({ id: '1', name: 'John', email: 'john@test.com' })
    const config = ref({ showEmail: true, variant: 'detailed' as const })

    const { cssClasses } = useUserLogic(userData, config)

    expect(cssClasses.value.card).toContain('detailed')
  })

  it('reacts to config changes', () => {
    const userData = ref({ id: '1', name: 'John', email: 'john@test.com' })
    const config = ref({ showEmail: true, variant: 'compact' as const })

    const { displayData } = useUserLogic(userData, config)
    expect(displayData.value.email).toBe('john@test.com')

    config.value = { showEmail: false, variant: 'compact' }
    expect(displayData.value.email).toBeUndefined()
  })
})
```

---

## Testing Components

Use Vue Test Utils for component testing.

```typescript
// components/__tests__/UserCard.test.ts
import { mount } from '@vue/test-utils'
import UserCard from '../UserCard.vue'

describe('UserCard', () => {
  const defaultProps = {
    userData: { id: '1', name: 'John', email: 'john@test.com' },
    config: { showEmail: true, variant: 'compact' as const }
  }

  it('renders user data correctly', () => {
    const wrapper = mount(UserCard, { props: defaultProps })

    expect(wrapper.find('.user-card__name').text()).toBe('John')
    expect(wrapper.find('p').text()).toBe('john@test.com')
  })

  it('hides email when config.showEmail is false', () => {
    const wrapper = mount(UserCard, {
      props: {
        ...defaultProps,
        config: { showEmail: false, variant: 'compact' }
      }
    })

    expect(wrapper.find('p').exists()).toBe(false)
  })

  it('applies correct variant class', () => {
    const wrapper = mount(UserCard, {
      props: {
        ...defaultProps,
        config: { showEmail: true, variant: 'detailed' }
      }
    })

    expect(wrapper.find('.user-card').classes()).toContain('user-card--detailed')
  })

  it('emits update event with new data', async () => {
    const wrapper = mount(UserCard, { props: defaultProps })

    await wrapper.find('button').trigger('click')

    expect(wrapper.emitted('update')).toBeTruthy()
    expect(wrapper.emitted('update')![0]).toEqual([
      expect.objectContaining({ id: '1' })
    ])
  })
})
```

---

## Testing Wrapper Components

Test wrappers separately from pure components.

```typescript
// components/__tests__/UserDisplayWrapper.test.ts
import { mount, flushPromises } from '@vue/test-utils'
import UserDisplayWrapper from '../UserDisplayWrapper.vue'

// Mock the API module
vi.mock('@/api/userApi', () => ({
  userApi: {
    getUser: vi.fn(),
    updateUser: vi.fn()
  }
}))

import { userApi } from '@/api/userApi'

describe('UserDisplayWrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows loading state initially', () => {
    (userApi.getUser as Mock).mockImplementation(() => new Promise(() => {}))

    const wrapper = mount(UserDisplayWrapper, {
      props: { userId: '1' }
    })

    expect(wrapper.text()).toContain('Loading')
  })

  it('renders user data after fetch', async () => {
    (userApi.getUser as Mock).mockResolvedValue({
      id: '1',
      name: 'John',
      email: 'john@test.com'
    })

    const wrapper = mount(UserDisplayWrapper, {
      props: { userId: '1' }
    })

    await flushPromises()

    expect(wrapper.text()).toContain('John')
  })

  it('shows error state on fetch failure', async () => {
    (userApi.getUser as Mock).mockRejectedValue(new Error('Network error'))

    const wrapper = mount(UserDisplayWrapper, {
      props: { userId: '1' }
    })

    await flushPromises()

    expect(wrapper.text()).toContain('Error')
  })

  it('calls updateUser on update event', async () => {
    const mockUser = { id: '1', name: 'John', email: 'john@test.com' }
    ;(userApi.getUser as Mock).mockResolvedValue(mockUser)
    ;(userApi.updateUser as Mock).mockResolvedValue(undefined)

    const wrapper = mount(UserDisplayWrapper, {
      props: { userId: '1' }
    })

    await flushPromises()

    // Trigger update from child component
    await wrapper.findComponent({ name: 'UserDisplayPure' }).vm.$emit('update', {
      ...mockUser,
      name: 'Updated'
    })

    expect(userApi.updateUser).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Updated' })
    )
  })
})
```

---

## Mocking Dependencies

### Using Provide/Inject for DI

```typescript
// Component that uses injected API
// UserFeature.vue uses `const api = inject('api')`

describe('UserFeature with injected API', () => {
  const mockApi = {
    getUser: vi.fn().mockResolvedValue({ id: '1', name: 'Test' }),
    updateUser: vi.fn().mockResolvedValue(undefined)
  }

  it('uses injected API', async () => {
    const wrapper = mount(UserFeature, {
      global: {
        provide: {
          api: mockApi
        }
      },
      props: { userId: '1' }
    })

    await flushPromises()

    expect(mockApi.getUser).toHaveBeenCalledWith('1')
  })
})
```

### Testing Composables with Mocked Dependencies

```typescript
// composables/__tests__/useUserData.test.ts
import { ref } from 'vue'
import { useUserData } from '../useUserData'

describe('useUserData', () => {
  it('fetches user with provided API', async () => {
    const mockApi = {
      getUser: vi.fn().mockResolvedValue({ id: '1', name: 'Test' })
    }

    // Composable accepts API as dependency
    const { user, loading, fetchUser } = useUserData(mockApi)

    expect(loading.value).toBe(false)
    expect(user.value).toBeNull()

    await fetchUser('1')

    expect(mockApi.getUser).toHaveBeenCalledWith('1')
    expect(user.value).toEqual({ id: '1', name: 'Test' })
  })

  it('handles fetch errors', async () => {
    const mockApi = {
      getUser: vi.fn().mockRejectedValue(new Error('Not found'))
    }

    const { error, fetchUser } = useUserData(mockApi)

    await fetchUser('1')

    expect(error.value).toBeInstanceOf(Error)
    expect(error.value?.message).toBe('Not found')
  })
})
```

---

## Testing Best Practices

| Practice | Reason |
|----------|--------|
| Test composables in isolation | Faster, focused tests |
| Test components with minimal mocking | Verify integration |
| Test wrappers with API mocks | Isolate side effects |
| Use provide/inject for DI | Easy mock injection |
| Test reactive updates | Verify computed reactivity |
| Avoid snapshot tests for logic | Fragile, hard to review |
