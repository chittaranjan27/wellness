/**
 * Chat Message Component
 * Displays individual chat messages with speech option
 */
'use client'

import { useState, useEffect } from 'react'
import { ChatMessage as ChatMessageType } from '@prisma/client'

interface ProductItem {
  id: string;
  title: string;
  description?: string | null;
  price?: string | null;
  url: string;
  imageUrl?: string | null;
  features?: string[];
}
interface CartItem {
  product: ProductItem;
  quantity: number;
}

export interface ChatSuggestion {
  label: string
  prompt: string
}

interface ChatMessageProps {
  message: ChatMessageType
  onSpeak?: (text: string) => void
  onPauseResume?: () => void
  isSpeaking?: boolean
  isPaused?: boolean
  onAddToCart?: (product: ProductItem, quantity: number) => void
  onUpdateCartQuantity?: (productId: string, delta: number) => void
  cartItems?: CartItem[]
  checkoutLink?: string | null
  onSuggestionClick?: (prompt: string) => void
  onOtherClick?: () => void
  addingProductIds?: Set<string>
}

// Confirmation prompt: "Would you like to get these products?" Yes/No
// Yes = add the displayed products to cart; No = dismiss, products stay visible
function AddToCartPrompt({
  products,
  cartItems,
  onAddToCart,
  isAdding,
}: {
  products: ProductItem[]
  cartItems: CartItem[]
  onAddToCart: (product: ProductItem, quantity: number) => void
  isAdding?: boolean
}) {
  const [responded, setResponded] = useState(false)
  const [yesClicked, setYesClicked] = useState(false)
  const question = products.length === 1
    ? "Would you like to get this product?"
    : "Would you like to get these products?"

  useEffect(() => {
    if (yesClicked && !isAdding) setResponded(true)
  }, [yesClicked, isAdding])

  if (responded) return null

  const handleYes = () => {
    setYesClicked(true)
    products.forEach((product) => {
      const inCart = cartItems.some((item) => item.product.id === product.id)
      if (!inCart) onAddToCart(product, 1)
    })
  }

  const handleNo = () => setResponded(true)

  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <span className="text-sm text-gray-700">{question}</span>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleYes}
          disabled={isAdding}
          className={`px-3 py-1.5 text-xs font-semibold rounded-lg border flex items-center gap-1.5 transition-colors ${isAdding
            ? "border-[#14b8a6] text-[#0f766e] bg-[rgba(20,184,166,0.15)] cursor-wait"
            : "border-[#14b8a6] text-white bg-[#14b8a6] hover:bg-[#0f766e]"
            }`}
        >
          {isAdding ? (
            <>
              <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Adding...
            </>
          ) : (
            "Yes"
          )}
        </button>
        <button
          type="button"
          onClick={handleNo}
          disabled={isAdding}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-300 text-gray-600 bg-white hover:bg-gray-50 transition-colors disabled:opacity-60 disabled:cursor-wait"
        >
          No
        </button>
      </div>
    </div>
  )
}

// Product Card Component - Add to Cart only (quantity 1 per click)
function ProductCard({
  product,
  cartItem,
  onAddToCart,
  isAdding
}: {
  product: ProductItem
  cartItem?: CartItem
  onAddToCart?: (product: ProductItem, quantity: number) => void
  isAdding?: boolean
}) {
  const inCart = !!cartItem

  return (
    <div className="flex w-[190px] flex-shrink-0 flex-col rounded-xl border border-gray-200 bg-white p-3 shadow-sm hover:shadow-md transition-shadow duration-200">
      {product.imageUrl ? (
        <img
          src={product.imageUrl}
          alt={product.title}
          className="mb-2.5 h-24 w-full rounded-lg object-cover"
        />
      ) : (
        <div className="mb-2.5 flex h-24 w-full items-center justify-center rounded-lg bg-gradient-to-br from-gray-100 to-gray-200 text-xs text-gray-500">
          No image
        </div>
      )}
      <div className="flex-1">
        <p className="text-xs font-semibold text-gray-900 leading-snug line-clamp-2">{product.title}</p>
        {product.price && (
          <p className="mt-1 text-sm font-bold text-[#14b8a6]">{product.price}</p>
        )}
        {product.description && (
          <p className="mt-1.5 text-[11px] text-gray-600 line-clamp-2 leading-relaxed">{product.description}</p>
        )}
        <a
          href={product.url}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center text-[11px] font-medium text-[#14b8a6] hover:text-[#0f766e] transition-colors"
        >
          View product →
        </a>
      </div>
      {onAddToCart && (
        <div className="mt-3 border-t border-gray-100 pt-2.5">
          <button
            type="button"
            onClick={() => onAddToCart(product, 1)}
            disabled={inCart || isAdding}
            className={`w-full rounded-md border px-3 py-2 text-xs font-semibold transition-all duration-200 flex items-center justify-center gap-1.5 ${inCart
              ? "border-gray-200 text-gray-400 bg-gray-50 cursor-not-allowed"
              : isAdding
                ? "border-[#14b8a6] text-[#0f766e] bg-[rgba(20,184,166,0.15)] cursor-wait"
                : "border-[#14b8a6] text-white bg-[#14b8a6] hover:bg-[#0f766e] shadow-sm hover:shadow-md transform hover:scale-[1.02]"
              }`}
          >
            {inCart ? "Added" : isAdding ? (
              <>
                <span className="inline-block w-3.5 h-3.5 border-2 border-[#0f766e] border-t-transparent rounded-full animate-spin" />
                Adding...
              </>
            ) : (
              "Add to Cart"
            )}
          </button>
        </div>
      )}
    </div>
  )
}

// Simple formatter to strip common markdown symbols like *, **, and # from the text
function formatMessageContent(text: string): string {
  if (!text) return text

  return text
    // Remove leading markdown heading markers (e.g., "## Title" -> "Title")
    .replace(/^#{1,6}\s+/gm, '')
    // Remove common list/bullet prefixes (*, -, +, >) at the start of lines
    .replace(/^[\s>*+-]+\s+/gm, '')
    // Remove bold/italic markers (**text**, *text*, __text__, _text_)
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    // Strip inline code backticks (`code`)
    .replace(/`([^`]+)`/g, '$1')
}

export default function ChatMessage({
  message,
  onSpeak,
  onPauseResume,
  isSpeaking = false,
  isPaused = false,
  onAddToCart,
  cartItems = [],
  checkoutLink,
  onSuggestionClick,
  onOtherClick,
  addingProductIds = new Set()
}: ChatMessageProps) {
  const isUser = message.role === 'user'
  const displayName = isUser ? 'You' : 'CARE'
  const metadata = message.metadata as any
  // Check for products in metadata
  const products = metadata?.products as ProductItem[] | undefined
  const isProductMessage = metadata?.type === 'products' && products && Array.isArray(products) && products.length > 0
  // Check for suggestions (example cases / recommendations as clickable buttons)
  const suggestions = metadata?.suggestions as ChatSuggestion[] | undefined
  const hasSuggestions = !isUser && onSuggestionClick && suggestions && Array.isArray(suggestions) && suggestions.length > 0
  const showOtherButton = hasSuggestions && onOtherClick

  // Debug: Log product detection
  if (!isUser && metadata) {
    console.log('[ChatMessage] Checking products:', {
      messageId: message.id,
      hasMetadata: !!metadata,
      metadataType: metadata?.type,
      hasProducts: !!metadata?.products,
      productsIsArray: Array.isArray(metadata?.products),
      productsLength: Array.isArray(metadata?.products) ? metadata?.products.length : 0,
      isProductMessage
    });
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4 animate-in fade-in`}>
      <div
        className={`${isProductMessage ? 'max-w-2xl lg:max-w-4xl' : 'max-w-xs lg:max-w-md'} overflow-hidden px-4 py-3 rounded-2xl shadow-sm transition-all duration-200 ${isUser
          ? 'bg-[#14b8a6] text-white shadow-[0_8px_24px_rgba(20,184,166,0.25)]'
          : 'bg-white text-gray-900 shadow-gray-100 border border-gray-100'
          }`}
      >
        <p className={`text-xs font-semibold uppercase tracking-wide mb-1 ${isUser ? 'text-white/80' : 'text-gray-500'
          }`}>
          {displayName}
        </p>
        <p className={`text-sm leading-relaxed whitespace-pre-wrap ${isProductMessage ? 'line-clamp-5' : ''}`}>
          {formatMessageContent(message.content)}
        </p>

        {/* Clickable options: shown during consultation, hidden once product recommendations begin */}
        {hasSuggestions && (
          <div className="mt-3 flex flex-wrap gap-2">
            {suggestions!.map((s, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => onSuggestionClick!(s.prompt)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-[#14b8a6] text-[#0f766e] bg-white hover:bg-[rgba(20,184,166,0.12)] hover:border-[#0d9488] transition-all duration-150 shadow-sm"
              >
                {s.label}
              </button>
            ))}
            {showOtherButton && (
              <button
                type="button"
                onClick={() => onOtherClick!()}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 text-gray-600 bg-white hover:bg-gray-50 hover:border-gray-400 transition-all duration-150 shadow-sm"
              >
                Other
              </button>
            )}
          </div>
        )}

        {/* Render products if this is a product message - presented as solutions for the user's concern */}
        {!isUser && isProductMessage && products && Array.isArray(products) && products.length > 0 && (
          <div className="mt-4 space-y-3">
            <p className="text-xs font-medium text-[#0f766e]">Recommended for your concern</p>
            <div className="flex gap-3 overflow-x-auto overscroll-x-contain touch-pan-x pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {products.map((product) => {
                const cartItem = cartItems.find((item) => item.product.id === product.id);
                return (
                  <ProductCard
                    key={product.id}
                    product={product}
                    cartItem={cartItem}
                    onAddToCart={onAddToCart}
                    isAdding={addingProductIds.has(product.id)}
                  />
                );
              })}
            </div>
            {/* "Would you like me to add this to your cart?" - Yes/No */}
            {onAddToCart && (
              <AddToCartPrompt
                products={products}
                cartItems={cartItems}
                onAddToCart={onAddToCart}
                isAdding={addingProductIds.size > 0}
              />
            )}
            {cartItems.length > 0 && (
              <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-[rgba(20,184,166,0.35)] bg-[rgba(20,184,166,0.12)] p-3 shadow-sm">
                <span className="text-xs font-medium text-[#134e4a]">
                  {cartItems.reduce((sum, item) => sum + item.quantity, 0)} item{cartItems.reduce((sum, item) => sum + item.quantity, 0) > 1 ? "s" : ""} in cart
                </span>
                {/* View Cart - use shop's full URL (/cart is on the shop domain, not chat app) */}
                {(() => {
                  const firstProduct = cartItems[0]?.product;
                  const cartUrl = firstProduct ? (() => { try { return new URL(firstProduct.url).origin + '/cart'; } catch { return '/cart'; } })() : '/cart';
                  return (
                    <a
                      href={cartUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-[#14b8a6] text-[#134e4a] bg-white hover:bg-[rgba(20,184,166,0.12)] hover:border-[#0f766e] transition-all duration-150 shadow-sm"
                    >
                      View Cart
                    </a>
                  );
                })()}
                {/* Checkout - direct link when cart has items */}
                {checkoutLink && (
                  <a
                    href={checkoutLink}
                    target="_blank"
                    rel="noreferrer"
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-[#14b8a6] text-[#134e4a] bg-white hover:bg-[rgba(20,184,166,0.12)] hover:border-[#0f766e] transition-all duration-150 shadow-sm"
                  >
                    Checkout
                  </a>
                )}
              </div>
            )}
          </div>
        )}

        {!isUser && onSpeak && (
          <div className="mt-3 flex items-center space-x-2 pt-2 border-t border-gray-200/50">
            {isSpeaking ? (
              <>
                {onPauseResume && (
                  <button
                    onClick={onPauseResume}
                    className="text-xs font-medium text-[#14b8a6] hover:text-[#0f766e] transition-colors px-2 py-1 rounded hover:bg-[rgba(20,184,166,0.12)]"
                    title={isPaused ? "Resume" : "Pause"}
                  >
                    <span>{isPaused ? "▶ Resume" : "⏸ Pause"}</span>
                  </button>
                )}
                <span className="text-xs text-[#0f766e] font-medium">
                  {isPaused ? "⏸ Paused" : "🔊 Speaking..."}
                </span>
              </>
            ) : (
              <button
                onClick={() => onSpeak(formatMessageContent(message.content))}
                className="text-xs font-medium text-[#14b8a6] hover:text-[#0f766e] transition-colors px-2 py-1 rounded hover:bg-[rgba(20,184,166,0.12)] flex items-center gap-1"
              >
                <span>🔊</span>
                <span>Speak</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
