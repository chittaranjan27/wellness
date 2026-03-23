/**
 * GET /api/shopify/products
 *
 * Returns products fetched directly from the Shopify Storefront API.
 * Accepts optional `?q=<search>` query parameter for keyword search.
 * Public endpoint — no auth required (used by the embed widget).
 *
 * Response shape:
 *   { products: ShopifyProduct[], source: "shopify" }
 */
import { NextRequest, NextResponse } from 'next/server'
import {
  getAllShopifyProducts,
  searchShopifyProducts,
  isShopifyConfigured,
} from '@/lib/shopify'

export const runtime = 'nodejs'

// ─── CORS ─────────────────────────────────────────────────────────────────────
function corsHeaders(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 200,
    headers: corsHeaders(req.headers.get('origin')),
  })
}

export async function GET(req: NextRequest) {
  const origin = req.headers.get('origin')
  const cors = corsHeaders(origin)

  // Guard: is Shopify configured?
  if (!isShopifyConfigured()) {
    return NextResponse.json(
      {
        error: 'Shopify integration not configured',
        hint: 'Set SHOPIFY_STORE_DOMAIN and SHOPIFY_STOREFRONT_ACCESS_TOKEN in .env',
      },
      { status: 503, headers: cors }
    )
  }

  try {
    const searchQuery = req.nextUrl.searchParams.get('q')?.trim()

    const products = searchQuery
      ? await searchShopifyProducts(searchQuery)
      : await getAllShopifyProducts()

    // Map to a shape compatible with the existing widget product card format
    const formatted = products.map((p) => {
      const mainVariant = p.variants[0]
      const price = mainVariant
        ? `${mainVariant.currencyCode} ${mainVariant.price}`
        : null

      return {
        id: p.id,
        title: p.title,
        handle: p.handle,
        description: p.description,
        type: p.productType,
        tags: p.tags,
        price,
        imageUrl: p.imageUrl,
        url: p.url,
        variants: p.variants.map((v) => ({
          id: v.id,
          title: v.title,
          price: `${v.currencyCode} ${v.price}`,
          available: v.available,
        })),
      }
    })

    return NextResponse.json(
      { products: formatted, source: 'shopify', count: formatted.length },
      { headers: cors }
    )
  } catch (error) {
    console.error('[/api/shopify/products] Error:', error)
    return NextResponse.json(
      {
        error: 'Failed to fetch Shopify products',
        details: error instanceof Error ? error.message : 'Unknown',
      },
      { status: 500, headers: cors }
    )
  }
}
