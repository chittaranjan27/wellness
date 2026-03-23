/**
 * Shopify API integration
 *
 * Supports BOTH token types:
 * - Admin API tokens (shpat_*)  → uses Admin GraphQL endpoint + X-Shopify-Access-Token header
 * - Storefront API tokens       → uses Storefront GraphQL endpoint + X-Shopify-Storefront-Access-Token header
 *
 * Auto-detects which type based on the token prefix.
 *
 * Environment variables required:
 *   SHOPIFY_STORE_DOMAIN              e.g. "your-store.myshopify.com"
 *   SHOPIFY_STOREFRONT_ACCESS_TOKEN   Admin or Storefront API access token
 */

import { env } from './env'

// ─── Config ───────────────────────────────────────────────────────────────────
const SHOPIFY_DOMAIN = env.SHOPIFY_STORE_DOMAIN
const SHOPIFY_TOKEN = env.SHOPIFY_STOREFRONT_ACCESS_TOKEN
const API_VERSION = '2024-01'

/** Detect if the token is an Admin API token (shpat_*) vs Storefront token */
const isAdminToken = SHOPIFY_TOKEN.startsWith('shpat_')

/** Admin API and Storefront API have different endpoints and headers */
const endpoint = isAdminToken
  ? `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`
  : `https://${SHOPIFY_DOMAIN}/api/${API_VERSION}/graphql.json`

const authHeader: Record<string, string> = isAdminToken
  ? { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
  : { 'X-Shopify-Storefront-Access-Token': SHOPIFY_TOKEN }

// ─── Types ────────────────────────────────────────────────────────────────────
export interface ShopifyProduct {
  id: string
  title: string
  handle: string
  description: string
  productType: string
  tags: string[]
  imageUrl: string | null
  imageAlt: string | null
  variants: ShopifyVariant[]
  /** URL to the product on the Shopify storefront */
  url: string
}

export interface ShopifyVariant {
  id: string
  title: string
  price: string
  currencyCode: string
  available: boolean
}

// ─── GraphQL helper ───────────────────────────────────────────────────────────
export async function shopifyFetch<T = any>({
  query,
  variables = {},
}: {
  query: string
  variables?: Record<string, unknown>
}): Promise<T> {
  if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN) {
    throw new Error(
      'Shopify integration is not configured. Set SHOPIFY_STORE_DOMAIN and SHOPIFY_STOREFRONT_ACCESS_TOKEN in .env'
    )
  }

  console.log(`[Shopify] Fetching from: ${endpoint} (${isAdminToken ? 'Admin API' : 'Storefront API'})`)

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader,
    },
    body: JSON.stringify({ query, variables }),
    cache: 'no-store', // Don't cache during development
  })

  const text = await res.text()

  // Log non-200 responses
  if (!res.ok) {
    console.error(`[Shopify] HTTP ${res.status}: ${text.substring(0, 500)}`)
    throw new Error(`Shopify API returned HTTP ${res.status}`)
  }

  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    console.error(`[Shopify] Invalid JSON response: ${text.substring(0, 500)}`)
    throw new Error('Shopify returned invalid JSON')
  }

  if (json.errors) {
    console.error('[Shopify] GraphQL errors:', JSON.stringify(json.errors, null, 2))
    throw new Error(json.errors[0]?.message || 'Shopify GraphQL error')
  }

  return json.data as T
}

// ─── GraphQL Queries ──────────────────────────────────────────────────────────

/**
 * Admin API query — uses `price` and `compareAtPrice` (not priceV2).
 * This works with shpat_ tokens.
 */
const ADMIN_PRODUCTS_QUERY = `
  query getProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          handle
          description
          productType
          tags
          images(first: 1) {
            edges {
              node {
                url
                altText
              }
            }
          }
          variants(first: 10) {
            edges {
              node {
                id
                title
                price
                availableForSale
              }
            }
          }
        }
      }
    }
  }
`

/**
 * Storefront API query — uses priceV2 (for non-admin tokens).
 */
const STOREFRONT_PRODUCTS_QUERY = `
  query getProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          handle
          description
          productType
          tags
          images(first: 1) {
            edges {
              node {
                url
                altText
              }
            }
          }
          variants(first: 10) {
            edges {
              node {
                id
                title
                priceV2 {
                  amount
                  currencyCode
                }
                availableForSale
              }
            }
          }
        }
      }
    }
  }
`

/**
 * Admin API search query.
 */
const ADMIN_SEARCH_QUERY = `
  query searchProducts($query: String!, $first: Int!) {
    products(first: $first, query: $query) {
      edges {
        node {
          id
          title
          handle
          description
          productType
          tags
          images(first: 1) {
            edges {
              node {
                url
                altText
              }
            }
          }
          variants(first: 10) {
            edges {
              node {
                id
                title
                price
                availableForSale
              }
            }
          }
        }
      }
    }
  }
`

/**
 * Storefront API search query.
 */
const STOREFRONT_SEARCH_QUERY = `
  query searchProducts($query: String!, $first: Int!) {
    products(first: $first, query: $query) {
      edges {
        node {
          id
          title
          handle
          description
          productType
          tags
          images(first: 1) {
            edges {
              node {
                url
                altText
              }
            }
          }
          variants(first: 10) {
            edges {
              node {
                id
                title
                priceV2 {
                  amount
                  currencyCode
                }
                availableForSale
              }
            }
          }
        }
      }
    }
  }
`

// Select the right query based on token type
const PRODUCTS_QUERY = isAdminToken ? ADMIN_PRODUCTS_QUERY : STOREFRONT_PRODUCTS_QUERY
const SEARCH_QUERY = isAdminToken ? ADMIN_SEARCH_QUERY : STOREFRONT_SEARCH_QUERY

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Map a raw GraphQL product node to our clean ShopifyProduct type. */
function mapProductNode(node: any): ShopifyProduct {
  const firstImage = node.images?.edges?.[0]?.node
  return {
    id: node.id,
    title: node.title,
    handle: node.handle,
    description: node.description || '',
    productType: node.productType || '',
    tags: node.tags || [],
    imageUrl: firstImage?.url || null,
    imageAlt: firstImage?.altText || null,
    variants: (node.variants?.edges || []).map((ve: any) => {
      const v = ve.node
      // Admin API returns `price` as a string, Storefront returns `priceV2` as an object
      const priceAmount = typeof v.price === 'string' ? v.price : (v.priceV2?.amount || '0')
      const currency = v.priceV2?.currencyCode || 'INR'
      return {
        id: v.id,
        title: v.title,
        price: priceAmount,
        currencyCode: currency,
        available: v.availableForSale ?? true,
      }
    }),
    url: `https://${SHOPIFY_DOMAIN}/products/${node.handle}`,
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch ALL products from the Shopify store.
 * Handles pagination automatically (250 products per page).
 * @param maxPages – Safety limit on the number of pages to fetch (default 10 = 2500 products max).
 */
export async function getAllShopifyProducts(maxPages = 10): Promise<ShopifyProduct[]> {
  const allProducts: ShopifyProduct[] = []
  let cursor: string | null = null
  let page = 0

  while (page < maxPages) {
    const data: any = await shopifyFetch<any>({
      query: PRODUCTS_QUERY,
      variables: { first: 250, after: cursor },
    })

    const edges: any[] = data.products?.edges || []
    for (const edge of edges) {
      allProducts.push(mapProductNode(edge.node))
    }

    const pageInfo: any = data.products?.pageInfo
    if (!pageInfo?.hasNextPage) break

    cursor = pageInfo.endCursor
    page++
  }

  console.log(`[Shopify] Fetched ${allProducts.length} products (${page + 1} pages)`)
  return allProducts
}

/**
 * Search products in Shopify by a keyword query.
 * @param searchQuery – Free-text search string (title, type, tag, etc.)
 * @param limit – Maximum results to return (default 20).
 */
export async function searchShopifyProducts(
  searchQuery: string,
  limit = 20
): Promise<ShopifyProduct[]> {
  const data: any = await shopifyFetch<any>({
    query: SEARCH_QUERY,
    variables: { query: searchQuery, first: limit },
  })

  const edges: any[] = data.products?.edges || []
  return edges.map((edge: any) => mapProductNode(edge.node))
}

/**
 * Check whether Shopify integration is configured.
 */
export function isShopifyConfigured(): boolean {
  return Boolean(SHOPIFY_DOMAIN && SHOPIFY_TOKEN)
}
