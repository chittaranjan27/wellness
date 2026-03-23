/**
 * POST /api/shopify/sync
 *
 * Replaces ALL products in the local `products` table with data fetched
 * from the Shopify Storefront/Admin API.
 *
 * Strategy:
 * 1. Fetch all products from Shopify
 * 2. DELETE all existing rows from the `products` table (removes dummy data)
 * 3. INSERT each Shopify product into the table
 *
 * After this runs the chatbot (`/api/db-consultation`) and the product
 * listing (`/api/products`) will serve real Shopify data automatically.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  getAllShopifyProducts,
  isShopifyConfigured,
  ShopifyProduct,
} from '@/lib/shopify'

export const runtime = 'nodejs'

// ─── CORS ─────────────────────────────────────────────────────────────────────
function corsHeaders(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 200,
    headers: corsHeaders(req.headers.get('origin')),
  })
}

/**
 * Map a Shopify product into the shape of the existing `products` table.
 *
 * Full column list (from consultation-flow.service.ts Product interface):
 *   product_id, product_name, subtitle, format, capsule_count, pack_size,
 *   price_inr_min, price_inr_max, price_display, market,
 *   daily_dose_caps, supply_days, funnel_role,
 *   discount_eligible, discount_pct,
 *   target_age_group, health_issues, dosage_instructions,
 *   results_timeline, compatibility, recommended_plan
 */
function mapToLocalProduct(sp: ShopifyProduct) {
  const prices = sp.variants
    .map((v) => parseFloat(v.price))
    .filter((n) => !isNaN(n))
  const minPrice = prices.length > 0 ? Math.min(...prices).toFixed(2) : '0.00'
  const maxPrice = prices.length > 0 ? Math.max(...prices).toFixed(2) : '0.00'
  const currency = sp.variants[0]?.currencyCode || 'INR'

  // Build a readable price display string
  const symbol = currency === 'INR' ? '₹' : currency + ' '
  const priceDisplay =
    minPrice === maxPrice
      ? `${symbol}${minPrice}`
      : `${symbol}${minPrice} – ${symbol}${maxPrice}`

  // Use variant title as format (e.g. "30-day pack", "Default Title")
  const variantTitles = sp.variants
    .map((v) => v.title)
    .filter((t) => t && t !== 'Default Title')
  const format = variantTitles.length > 0 ? variantTitles.join(' / ') : null

  return {
    product_id: sp.handle,
    product_name: sp.title,
    subtitle: sp.productType || null,
    format: format,
    capsule_count: 0,
    pack_size: variantTitles[0] || null,
    price_inr_min: minPrice,
    price_inr_max: maxPrice,
    price_display: priceDisplay,
    market: currency === 'INR' ? 'IN' : currency,
    daily_dose_caps: 0,
    supply_days: 0,
    funnel_role: sp.productType || 'general',
    discount_eligible: false,
    discount_pct: null as string | null,
    target_age_group: null as string | null,
    health_issues: sp.tags.length > 0 ? sp.tags.join(', ') : null,
    dosage_instructions: null as string | null,
    results_timeline: null as string | null,
    compatibility: null as string | null,
    recommended_plan: null as string | null,
  }
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin')
  const cors = corsHeaders(origin)

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
    // 1. Fetch all products from Shopify
    const shopifyProducts = await getAllShopifyProducts()
    console.log(`[shopify/sync] Fetched ${shopifyProducts.length} products from Shopify`)

    if (shopifyProducts.length === 0) {
      return NextResponse.json(
        {
          error: 'No products found in Shopify store',
          hint: 'Make sure your Shopify store has published products',
        },
        { status: 404, headers: cors }
      )
    }

    // 2. DELETE all existing (dummy) products
    const deleted = await prisma.$executeRawUnsafe(`DELETE FROM products`)
    console.log(`[shopify/sync] Deleted ${deleted} existing products from local DB`)

    // 3. INSERT each Shopify product
    let synced = 0
    let failed = 0

    for (const sp of shopifyProducts) {
      const p = mapToLocalProduct(sp)
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO products (
            product_id, product_name, subtitle, format,
            capsule_count, pack_size,
            price_inr_min, price_inr_max, price_display,
            market, daily_dose_caps, supply_days, funnel_role,
            discount_eligible, discount_pct,
            target_age_group, health_issues, dosage_instructions,
            results_timeline, compatibility, recommended_plan
          ) VALUES (
            $1, $2, $3, $4,
            $5, $6,
            $7, $8, $9,
            $10, $11, $12, $13,
            $14, $15,
            $16, $17, $18,
            $19, $20, $21
          )`,
          p.product_id,
          p.product_name,
          p.subtitle,
          p.format,
          p.capsule_count,
          p.pack_size,
          p.price_inr_min,
          p.price_inr_max,
          p.price_display,
          p.market,
          p.daily_dose_caps,
          p.supply_days,
          p.funnel_role,
          p.discount_eligible,
          p.discount_pct,
          p.target_age_group,
          p.health_issues,
          p.dosage_instructions,
          p.results_timeline,
          p.compatibility,
          p.recommended_plan
        )
        synced++
      } catch (insertErr) {
        console.error(
          `[shopify/sync] Failed to insert "${sp.title}":`,
          insertErr instanceof Error ? insertErr.message : insertErr
        )
        failed++
      }
    }

    return NextResponse.json(
      {
        message: 'Shopify sync complete — dummy data replaced with real Shopify products',
        deletedOldProducts: deleted,
        totalFetched: shopifyProducts.length,
        synced,
        failed,
      },
      { headers: cors }
    )
  } catch (error) {
    console.error('[/api/shopify/sync] Error:', error)
    return NextResponse.json(
      {
        error: 'Shopify sync failed',
        details: error instanceof Error ? error.message : 'Unknown',
      },
      { status: 500, headers: cors }
    )
  }
}
