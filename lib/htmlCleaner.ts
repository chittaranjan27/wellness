/**
 * HTML Cleaner & Product Extractor
 * Strips scripts/styles, detects product pages, and extracts structured product data
 * for the crawler. Non-product pages are skipped so the knowledge base stays clean.
 */
import { JSDOM } from 'jsdom'

/* ─────────────────────────────────────────────────────────────────────────────
 * URL-level product page detection
 * ──────────────────────────────────────────────────────────────────────────── */

/** Path segments that strongly indicate a product detail page */
const PRODUCT_URL_PATTERNS = [
  /\/product\//i,
  /\/products\//i,
  /\/item\//i,
  /\/shop\//i,
  /\/store\//i,
  /\/pd\//i,
  /\/p\//i,
  /\/catalogue\//i,
  /\/catalog\//i,
  /[?&]product_id=/i,
  /[?&]pid=/i,
  /[?&]sku=/i,
]

/** Path segments that strongly indicate NON-product pages to skip */
const NON_PRODUCT_URL_PATTERNS = [
  /\/blog\//i,
  /\/news\//i,
  /\/article\//i,
  /\/post\//i,
  /\/about/i,
  /\/contact/i,
  /\/faq/i,
  /\/help/i,
  /\/terms/i,
  /\/privacy/i,
  /\/policy/i,
  /\/login/i,
  /\/register/i,
  /\/account/i,
  /\/cart/i,
  /\/checkout/i,
  /\/wishlist/i,
  /\/search/i,
  /\/sitemap/i,
  /\/tag\//i,
  /\/category\//i,
  /\/collection\//i,
]

/**
 * Return true when a URL looks like a product detail page.
 * Falls back to `true` (crawl it) when neither pattern matches,
 * so collection/unknown pages are included as possible sources.
 */
export function isProductUrl(url: string): boolean {
  for (const re of NON_PRODUCT_URL_PATTERNS) {
    if (re.test(url)) return false
  }
  // If it explicitly looks like a product URL, always include
  for (const re of PRODUCT_URL_PATTERNS) {
    if (re.test(url)) return true
  }
  // Neither known product nor known non-product — include by default
  return true
}

/* ─────────────────────────────────────────────────────────────────────────────
 * HTML-level product page detection (post-fetch)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Detect whether the fetched HTML is a product detail page.
 * Looks for structured-data signals, CSS classes, and price elements.
 */
export function isProductPage(html: string): boolean {
  try {
    // JSON-LD schema.org Product — the most reliable signal
    if (/"@type"\s*:\s*"Product"/i.test(html)) return true

    const dom = new JSDOM(html)
    const doc = dom.window.document

    // Open Graph product type
    const ogType = doc.querySelector('meta[property="og:type"]')?.getAttribute('content') ?? ''
    if (/product/i.test(ogType)) return true

    // Common WooCommerce / Shopify / Magento CSS classes
    const productClassSelectors = [
      '.product-summary',
      '.product-details',
      '.product-info',
      '.woocommerce-product-details__short-description',
      '.product-single',
      '.product-page',
      '#product-description',
      '[itemtype*="schema.org/Product"]',
      '[data-product-id]',
      '[data-product_id]',
    ]
    for (const sel of productClassSelectors) {
      if (doc.querySelector(sel)) return true
    }

    // Price element combined with an add-to-cart button
    const hasPrice = !!doc.querySelector(
      '.price, .product-price, .woocommerce-Price-amount, [class*="price"], [data-price]'
    )
    const hasAddToCart = !!doc.querySelector(
      'button[name="add-to-cart"], .add_to_cart_button, [class*="add-to-cart"], [class*="addtocart"]'
    )
    if (hasPrice && hasAddToCart) return true

    return false
  } catch {
    return false
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Structured product data extraction
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ProductData {
  name: string
  description: string
  price: string
  imageUrl: string
  categories: string[]
  sku: string
  brand: string
  availability: string
  variants: string[]
  features: string[]
  rating: string
  reviews: string
  /** Normalized structured block ready for embedding */
  structuredText: string
}

/**
 * Extract all product fields from a page and return a structured text block
 * optimised for RAG retrieval.
 */
export function extractProductData(html: string, pageUrl: string): ProductData {
  const dom = new JSDOM(html, { url: pageUrl })
  const doc = dom.window.document
  const result: Partial<ProductData> = {}

  /* ── 1. JSON-LD schema.org/Product (most complete source) ──────────────── */
  const jsonLdBlocks = doc.querySelectorAll('script[type="application/ld+json"]')
  for (const block of Array.from(jsonLdBlocks)) {
    try {
      const data = JSON.parse(block.textContent ?? '{}')
      const productNode =
        data['@type'] === 'Product' ? data
          : Array.isArray(data['@graph'])
            ? data['@graph'].find((n: any) => n['@type'] === 'Product')
            : null

      if (productNode) {
        result.name = result.name || productNode.name
        result.description = result.description || productNode.description
        result.brand = result.brand || productNode.brand?.name || productNode.brand
        result.sku = result.sku || productNode.sku || productNode.gtin || productNode.mpn

        // Image
        const img = productNode.image
        if (!result.imageUrl) {
          if (typeof img === 'string') result.imageUrl = img
          else if (Array.isArray(img)) result.imageUrl = img[0]
          else if (img?.url) result.imageUrl = img.url
        }

        // Price
        const offer = Array.isArray(productNode.offers) ? productNode.offers[0] : productNode.offers
        if (offer) {
          result.price = result.price || (offer.price ? `${offer.priceCurrency ?? ''} ${offer.price}`.trim() : '')
          result.availability = result.availability || (offer.availability ?? '').replace(/https?:\/\/schema\.org\//i, '')
        }

        // Rating
        const rating = productNode.aggregateRating
        if (rating) {
          result.rating = `${rating.ratingValue ?? ''} / ${rating.bestRating ?? 5} (${rating.reviewCount ?? 0} reviews)`
        }
      }
    } catch {
      // malformed JSON — skip this block
    }
  }

  /* ── 2. Open Graph fallbacks ──────────────────────────────────────────── */
  result.name = result.name
    || doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim()
    || doc.querySelector('h1.product_title, h1.product-title, h1')?.textContent?.trim()
    || ''

  result.description = result.description
    || doc.querySelector('meta[property="og:description"]')?.getAttribute('content')?.trim()
    || doc.querySelector('meta[name="description"]')?.getAttribute('content')?.trim()
    || ''

  if (!result.imageUrl) {
    const ogImg = doc.querySelector('meta[property="og:image"]')?.getAttribute('content')?.trim()
    if (ogImg) result.imageUrl = ogImg
  }

  /* ── 3. WooCommerce / Shopify / generic DOM selectors ───────────────────── */
  if (!result.price) {
    const priceEl = doc.querySelector(
      '.woocommerce-Price-amount, .price ins .amount, .price .amount, [class*="price"]:not(del), [data-price]'
    )
    result.price = priceEl?.textContent?.trim() ?? ''

    // Also try regex on page text as final fallback
    if (!result.price) {
      const match = doc.body?.textContent?.match(/(?:AED|SAR|USD|EUR|£|\$|€)\s?[\d,]+(?:\.\d{1,2})?/)
      if (match) result.price = match[0]
    }
  }

  if (!result.sku) {
    result.sku =
      doc.querySelector('[class*="sku"]')?.textContent?.replace(/sku[:\s]*/i, '').trim()
      || doc.querySelector('[data-sku]')?.getAttribute('data-sku')
      || ''
  }

  if (!result.brand) {
    result.brand =
      doc.querySelector('[class*="brand"] a, [class*="brand"] span')?.textContent?.trim()
      || doc.querySelector('meta[property="product:brand"]')?.getAttribute('content')?.trim()
      || ''
  }

  if (!result.availability) {
    const stockEl = doc.querySelector('.stock, [class*="availability"], [class*="in-stock"], [class*="out-of-stock"]')
    result.availability = stockEl?.textContent?.trim() ?? ''
  }

  /* ── 4. Categories ──────────────────────────────────────────────────────── */
  const categories: string[] = []
  // Breadcrumbs (WooCommerce / most stores)
  const breadcrumbs = doc.querySelectorAll('.breadcrumb a, .woocommerce-breadcrumb a, nav[aria-label="breadcrumb"] a')
  for (const bc of Array.from(breadcrumbs).slice(0, 5)) {
    const text = bc.textContent?.trim()
    if (text && !/home|shop|all/i.test(text)) categories.push(text)
  }
  // category meta tags
  const catMeta = doc.querySelectorAll('meta[property="product:category"]')
  for (const m of Array.from(catMeta)) {
    const v = m.getAttribute('content')?.trim()
    if (v && !categories.includes(v)) categories.push(v)
  }
  result.categories = [...new Set(categories)]

  /* ── 5. Product variants (size, colour, etc.) ───────────────────────────── */
  const variants: string[] = []
  const variantSelectors = doc.querySelectorAll(
    'select[name*="attribute"], .variation select, .product-options select, [class*="variant"] select'
  )
  for (const sel of Array.from(variantSelectors)) {
    const label = (sel as HTMLSelectElement).closest('.form-row, .variation, [class*="option"]')
      ?.querySelector('label, th')?.textContent?.trim() ?? ''
    const options = Array.from((sel as HTMLSelectElement).options)
      .map((o) => o.text.trim())
      .filter((t) => t && !/choose|select/i.test(t))
    if (options.length > 0) {
      variants.push(`${label}: ${options.join(', ')}`)
    }
  }
  // Swatches / button variants
  const swatches = doc.querySelectorAll('[class*="swatch"] span, [class*="variant"] button, [class*="option"] button')
  const swatchTexts = [...new Set(Array.from(swatches).map((s) => s.textContent?.trim()).filter(Boolean) as string[])].slice(0, 10)
  if (swatchTexts.length > 0 && variants.length === 0) {
    variants.push(`Options: ${swatchTexts.join(', ')}`)
  }
  result.variants = variants

  /* ── 6. Features / key benefit points ──────────────────────────────────── */
  const features: string[] = []
  // Prefer product-specific description lists / feature blocks
  const featureBlock = doc.querySelector(
    '.product-features, .product-highlights, .product-benefits, .woocommerce-product-details__short-description, #product-description, .product-description'
  )
  if (featureBlock) {
    const listItems = featureBlock.querySelectorAll('li')
    for (const li of Array.from(listItems).slice(0, 12)) {
      const t = li.textContent?.trim()
      if (t && t.length > 5 && t.length < 300) features.push(t)
    }
    // Plain paragraphs in short description
    if (features.length === 0) {
      const paras = featureBlock.querySelectorAll('p')
      for (const p of Array.from(paras).slice(0, 4)) {
        const t = p.textContent?.trim()
        if (t && t.length > 10) features.push(t)
      }
    }
  }
  // Fallback: any visible list items on the page (capped)
  if (features.length === 0) {
    const allLis = doc.querySelectorAll('ul li, ol li')
    for (const li of Array.from(allLis).slice(0, 8)) {
      const t = li.textContent?.trim()
      if (t && t.length > 8 && t.length < 250) features.push(t)
    }
  }
  result.features = features

  /* ── 7. Rating / reviews from DOM ──────────────────────────────────────── */
  if (!result.rating) {
    const ratingEl = doc.querySelector('[class*="rating"], [class*="stars"], .star-rating')
    if (ratingEl) result.rating = ratingEl.textContent?.trim() ?? ''
  }
  const reviewCountEl = doc.querySelector('[class*="review-count"], [class*="num-reviews"]')
  result.reviews = reviewCountEl?.textContent?.trim() ?? ''

  /* ── 8. Product image from DOM fallback ─────────────────────────────────── */
  if (!result.imageUrl) {
    const imgSelectors = [
      'img.product-image', 'img[class*="product"]', 'img[class*="main"]',
      '.product-image img', '.product-gallery img', '.product-photo img',
      'picture source', 'picture img', 'img[src*="product"]',
    ]
    for (const sel of imgSelectors) {
      const el = doc.querySelector(sel) as HTMLImageElement | HTMLSourceElement | null
      const src = el?.getAttribute('src') || el?.getAttribute('srcset')?.split(' ')[0]
      if (src && !src.startsWith('data:') && !/icon|logo|avatar/i.test(src)) {
        try { result.imageUrl = new URL(src, pageUrl).href } catch { result.imageUrl = src }
        break
      }
    }
  }

  /* ── 9. Build structured text block ───────────────────────────────────── */
  const lines: string[] = []

  if (result.name) lines.push(`Product Name: ${result.name}`)
  if (result.brand) lines.push(`Brand: ${result.brand}`)
  if (result.sku) lines.push(`SKU: ${result.sku}`)
  if (result.categories?.length) lines.push(`Categories: ${result.categories.join(' > ')}`)
  if (result.price) lines.push(`Price: ${result.price}`)
  if (result.availability) lines.push(`Availability: ${result.availability}`)
  if (result.variants?.length) {
    lines.push('')
    lines.push('Variants:')
    result.variants.forEach((v) => lines.push(`  - ${v}`))
  }
  if (result.description) {
    lines.push('')
    lines.push(`Description: ${result.description}`)
  }
  if (result.features?.length) {
    lines.push('')
    lines.push('Key Features / Benefits:')
    result.features.forEach((f) => lines.push(`  - ${f}`))
  }
  if (result.imageUrl) lines.push('')
  if (result.imageUrl) lines.push(`Product Image: ${result.imageUrl}`)
  if (result.rating) lines.push(`Rating: ${result.rating}`)
  if (result.reviews) lines.push(`Reviews: ${result.reviews}`)
  lines.push(`Source URL: ${pageUrl}`)

  result.structuredText = lines.join('\n').trim()

  return {
    name: result.name ?? '',
    description: result.description ?? '',
    price: result.price ?? '',
    imageUrl: result.imageUrl ?? '',
    categories: result.categories ?? [],
    sku: result.sku ?? '',
    brand: result.brand ?? '',
    availability: result.availability ?? '',
    variants: result.variants ?? [],
    features: result.features ?? [],
    rating: result.rating ?? '',
    reviews: result.reviews ?? '',
    structuredText: result.structuredText ?? '',
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Legacy helpers (kept for backwards compatibility)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Clean HTML and extract readable text (used outside product context).
 */
export function cleanHtml(html: string): string {
  try {
    const dom = new JSDOM(html)
    const document = dom.window.document

    // Remove non-content elements
    document.querySelectorAll('script, style, noscript, iframe, embed, object').forEach((el) => el.remove())

    // Remove HTML comments
    const walker = document.createTreeWalker(document, dom.window.NodeFilter.SHOW_COMMENT, null)
    const comments: Comment[] = []
    let node
    while ((node = walker.nextNode())) comments.push(node as Comment)
    comments.forEach((c) => c.remove())

    const body = document.body || document.documentElement
    if (!body) return ''

    let text = extractTextContent(body)
    text = text.replace(/\s+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
    return text
  } catch (error) {
    console.error('[HTMLCleaner] Error cleaning HTML:', error)
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
}

function extractTextContent(element: Element): string {
  const textParts: string[] = []
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === 3) {
      const text = node.textContent?.trim()
      if (text) textParts.push(text)
    } else if (node.nodeType === 1) {
      const el = node as Element
      const tagName = el.tagName.toLowerCase()
      if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'br'].includes(tagName)) {
        if (textParts.length > 0 && !textParts[textParts.length - 1].endsWith('\n')) {
          textParts.push('\n')
        }
      }
      const childText = extractTextContent(el)
      if (childText) textParts.push(childText)
      if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li'].includes(tagName)) {
        textParts.push('\n')
      }
    }
  }
  return textParts.join(' ')
}

/**
 * Legacy: detectProductFields — preserved for any code that still imports it.
 * @deprecated Use extractProductData instead.
 */
export function detectProductFields(html: string, text: string, baseUrl?: string): {
  title?: string
  description?: string
  price?: string
  features?: string[]
  imageUrl?: string
} {
  const data = extractProductData(html, baseUrl ?? '')
  return {
    title: data.name || undefined,
    description: data.description || undefined,
    price: data.price || undefined,
    features: data.features.length > 0 ? data.features : undefined,
    imageUrl: data.imageUrl || undefined,
  }
}
