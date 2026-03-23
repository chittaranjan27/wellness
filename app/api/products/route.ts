/**
 * GET /api/products
 *
 * Returns all products stored in the `products` table.
 * Public endpoint — no auth required (used by the embed widget).
 * Accepts optional ?agentId= query param (reserved for future per-agent filtering).
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

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

  try {
    const products = await prisma.$queryRawUnsafe<
      Array<{
        product_id: string
        product_name: string
        capsule_count: number
        price_inr_min: string
        price_inr_max: string
        market: string
        daily_dose_caps: number
        supply_days: number
        funnel_role: string
        discount_eligible: boolean
        discount_pct: string | null
        image_url: string | null
        shopify_url: string | null
      }>
    >(`SELECT * FROM products ORDER BY product_id`)

    const formatted = products.map((p) => {
      const priceDisplay =
        p.price_inr_min === p.price_inr_max
          ? `₹${p.price_inr_min}`
          : `₹${p.price_inr_min} – ₹${p.price_inr_max}`

      const discountNote =
        p.discount_eligible && p.discount_pct
          ? ` · Save ${p.discount_pct}% on bundle`
          : ''

      return {
        id: p.product_id,
        title: p.product_name,
        price: `${priceDisplay}${discountNote}`,
        priceMin: p.price_inr_min,
        priceMax: p.price_inr_max,
        supplyDays: p.supply_days,
        capsuleCount: p.capsule_count,
        dailyDose: p.daily_dose_caps,
        market: p.market,
        funnelRole: p.funnel_role,
        discountEligible: p.discount_eligible,
        discountPct: p.discount_pct,
        imageUrl: p.image_url || null,
        url: p.shopify_url || null,
      }
    })

    return NextResponse.json({ products: formatted }, { headers: cors })
  } catch (error) {
    console.error('[/api/products] Error:', error)
    return NextResponse.json(
      {
        error: 'Failed to fetch products',
        details: error instanceof Error ? error.message : 'Unknown',
      },
      { status: 500, headers: cors }
    )
  }
}
