/**
 * Complete CRUD Endpoint Example
 *
 * Demonstrating FP patterns for REST APIs with:
 * - Security-first SQL
 * - Middleware DI
 * - Pure business logic
 * - Comprehensive error handling
 */

import { Hono } from 'hono'

// ============================================================================
// SHARED VALIDATORS (Would be in shared/validators.js if used by 3+ routes)
// ============================================================================

const validateRequired = (value) => value != null && value !== ''

const validateEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)

const validateLength = (min, max) => (value) =>
  value.length >= min && value.length <= max

// ============================================================================
// ROUTE-SCOPED VALIDATION
// ============================================================================

const validateProductInput = (data) => {
  const errors = []

  if (!validateRequired(data.name)) {
    errors.push({ field: 'name', message: 'Name is required' })
  } else if (!validateLength(3, 100)(data.name)) {
    errors.push({ field: 'name', message: 'Name must be 3-100 characters' })
  }

  if (!validateRequired(data.price)) {
    errors.push({ field: 'price', message: 'Price is required' })
  } else if (typeof data.price !== 'number' || data.price < 0) {
    errors.push({ field: 'price', message: 'Price must be a positive number' })
  }

  if (data.description && !validateLength(0, 500)(data.description)) {
    errors.push({ field: 'description', message: 'Description max 500 characters' })
  }

  return errors.length > 0
    ? { valid: false, errors }
    : {
        valid: true,
        data: {
          name: data.name.trim(),
          price: data.price,
          description: data.description?.trim() || ''
        }
      }
}

// ============================================================================
// PURE BUSINESS LOGIC
// ============================================================================

const prepareProductForStorage = (productData) => ({
  ...productData,
  createdAt: new Date().toISOString()
})

const prepareProductForUpdate = (productData) => ({
  ...productData,
  updatedAt: new Date().toISOString()
})

const calculateDiscountedPrice = (price, discountPercent) =>
  price * (1 - discountPercent / 100)

// ============================================================================
// SECURITY-FIRST SQL BUILDERS
// ============================================================================

const buildProductListQuery = (filters = {}) => {
  const conditions = []
  const params = {}

  if (filters.minPrice) {
    conditions.push('price >= @min_price')
    params.min_price = filters.minPrice
  }

  if (filters.maxPrice) {
    conditions.push('price <= @max_price')
    params.max_price = filters.maxPrice
  }

  if (filters.search) {
    conditions.push('name LIKE @search')
    params.search = `%${filters.search}%`
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(' AND ')}`
    : ''

  return {
    sql: `SELECT id, name, price, description, created_at, updated_at FROM products ${whereClause} ORDER BY created_at DESC`,
    params
  }
}

const buildProductInsertQuery = (product) => ({
  sql: 'INSERT INTO products (name, price, description, created_at) VALUES (@name, @price, @description, @created_at) RETURNING id, name, price, description, created_at',
  params: product
})

const buildProductUpdateQuery = (id, product) => ({
  sql: 'UPDATE products SET name = @name, price = @price, description = @description, updated_at = @updated_at WHERE id = @id RETURNING id, name, price, description, updated_at',
  params: { ...product, id }
})

const buildProductDeleteQuery = (id) => ({
  sql: 'DELETE FROM products WHERE id = @id RETURNING id',
  params: { id }
})

// ============================================================================
// CRUD ROUTES
// ============================================================================

const route = new Hono()

// ───── LIST products (GET /products) ─────
route.get('/', async (c) => {
  try {
    const filters = {
      minPrice: c.req.query('minPrice') ? parseFloat(c.req.query('minPrice')) : undefined,
      maxPrice: c.req.query('maxPrice') ? parseFloat(c.req.query('maxPrice')) : undefined,
      search: c.req.query('search')
    }

    const { sql, params } = buildProductListQuery(filters)
    const products = await c.db.queryWithParams(sql, params)

    c.logger.info('Products listed', { count: products.length, filters })
    return c.json({ success: true, data: products })
  } catch (error) {
    c.logger.error('Failed to list products', error)
    return c.json({ success: false, error: 'Internal error' }, 500)
  }
})

// ───── GET single product (GET /products/:id) ─────
route.get('/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'))

    if (isNaN(id)) {
      return c.json({ success: false, error: 'Invalid product ID' }, 400)
    }

    const { sql, params } = {
      sql: 'SELECT id, name, price, description, created_at, updated_at FROM products WHERE id = @id',
      params: { id }
    }

    const [product] = await c.db.queryWithParams(sql, params)

    if (!product) {
      return c.json({ success: false, error: 'Product not found' }, 404)
    }

    c.logger.info('Product retrieved', { productId: id })
    return c.json({ success: true, data: product })
  } catch (error) {
    c.logger.error('Failed to retrieve product', error)
    return c.json({ success: false, error: 'Internal error' }, 500)
  }
})

// ───── CREATE product (POST /products) ─────
route.post('/', async (c) => {
  try {
    const body = await c.req.json()
    const validation = validateProductInput(body)

    if (!validation.valid) {
      return c.json({ success: false, errors: validation.errors }, 400)
    }

    const productToSave = prepareProductForStorage(validation.data)
    const { sql, params } = buildProductInsertQuery(productToSave)

    const [product] = await c.db.queryWithParams(sql, params)

    c.logger.info('Product created', { productId: product.id })
    return c.json({ success: true, data: product }, 201)
  } catch (error) {
    c.logger.error('Failed to create product', error)
    return c.json({ success: false, error: 'Internal error' }, 500)
  }
})

// ───── UPDATE product (PUT /products/:id) ─────
route.put('/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'))

    if (isNaN(id)) {
      return c.json({ success: false, error: 'Invalid product ID' }, 400)
    }

    const body = await c.req.json()
    const validation = validateProductInput(body)

    if (!validation.valid) {
      return c.json({ success: false, errors: validation.errors }, 400)
    }

    const productToUpdate = prepareProductForUpdate(validation.data)
    const { sql, params } = buildProductUpdateQuery(id, productToUpdate)

    const [product] = await c.db.queryWithParams(sql, params)

    if (!product) {
      return c.json({ success: false, error: 'Product not found' }, 404)
    }

    c.logger.info('Product updated', { productId: id })
    return c.json({ success: true, data: product })
  } catch (error) {
    c.logger.error('Failed to update product', error)
    return c.json({ success: false, error: 'Internal error' }, 500)
  }
})

// ───── DELETE product (DELETE /products/:id) ─────
route.delete('/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'))

    if (isNaN(id)) {
      return c.json({ success: false, error: 'Invalid product ID' }, 400)
    }

    const { sql, params } = buildProductDeleteQuery(id)
    const [deleted] = await c.db.queryWithParams(sql, params)

    if (!deleted) {
      return c.json({ success: false, error: 'Product not found' }, 404)
    }

    c.logger.info('Product deleted', { productId: id })
    return c.json({ success: true, data: { id: deleted.id } })
  } catch (error) {
    c.logger.error('Failed to delete product', error)
    return c.json({ success: false, error: 'Internal error' }, 500)
  }
})

export default route
