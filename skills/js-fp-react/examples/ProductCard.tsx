// ProductCard.tsx
// Complete FP React component example demonstrating:
// - Custom hook for business logic
// - Pure component with memo
// - Appropriate memoization
// - TypeScript interfaces

import { memo, useMemo, useCallback } from 'react'

// ───── Types ─────
interface Product {
  id: string
  name: string
  price: number
  inStock: boolean
}

interface ProductCardProps {
  product: Product
  onAddToCart: (productId: string) => void
}

// ───── Custom Hook (Business Logic) ─────
// Pure computations separated from presentation
const useProductLogic = (product: Product) => {
  const displayData = useMemo(() => ({
    ...product,
    formattedPrice: `$${product.price.toFixed(2)}`,
    availability: product.inStock ? 'In Stock' : 'Out of Stock'
  }), [product])

  const cssClasses = useMemo(() => ({
    card: `product-card ${product.inStock ? 'in-stock' : 'out-of-stock'}`,
    price: `product-price ${product.inStock ? 'available' : 'unavailable'}`
  }), [product.inStock])

  return { displayData, cssClasses }
}

// ───── Pure Component ─────
const ProductCard = memo<ProductCardProps>(({ product, onAddToCart }) => {
  const { displayData, cssClasses } = useProductLogic(product)

  const handleAddToCart = useCallback(() => {
    if (product.inStock) {
      onAddToCart(product.id)
    }
  }, [product.inStock, product.id, onAddToCart])

  return (
    <div className={cssClasses.card}>
      <h3>{displayData.name}</h3>
      <p className={cssClasses.price}>{displayData.formattedPrice}</p>
      <p className="availability">{displayData.availability}</p>
      <button onClick={handleAddToCart} disabled={!product.inStock}>
        Add to Cart
      </button>
    </div>
  )
})

ProductCard.displayName = 'ProductCard'

export { ProductCard, useProductLogic }
export type { Product, ProductCardProps }
