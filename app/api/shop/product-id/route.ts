/**
 * API route to extract WooCommerce product ID from a product page URL.
 * Server-side fetch avoids CORS - used when frontend can't fetch the shop directly.
 */
import { NextRequest, NextResponse } from 'next/server'

const ID_PATTERNS = [
  /data-product-id=["'](\d+)["']/i,
  /data-product_id=["'](\d+)["']/i,
  /product[_-]?id["']?\s*[:=]\s*["']?(\d+)/i,
  /<input[^>]*name=["']product_id["'][^>]*value=["'](\d+)["']/i,
  /<input[^>]*name=["']add-to-cart["'][^>]*value=["'](\d+)["']/i,
  /add-to-cart["']?\s*[:=]\s*["']?(\d+)/i,
  /"add_to_cart":"(\d+)"/i,
]

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { url } = body
    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'Missing url' }, { status: 400 })
    }

    const productUrl = new URL(url)
    if (!['http:', 'https:'].includes(productUrl.protocol)) {
      return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
    }

    const response = await fetch(productUrl.href, {
      method: 'GET',
      headers: {
        'Accept': 'text/html',
        'User-Agent': 'Mozilla/5.0 (compatible; AgentChat/1.0)',
      },
      redirect: 'follow',
    })

    if (!response.ok) {
      return NextResponse.json(
        { error: `Failed to fetch product page: ${response.status}` },
        { status: 502 }
      )
    }

    const html = await response.text()
    let productId: string | null = null

    for (const pattern of ID_PATTERNS) {
      const match = html.match(pattern)
      if (match?.[1]) {
        productId = match[1]
        break
      }
    }

    if (!productId) {
      return NextResponse.json(
        { error: 'Could not extract product ID from page' },
        { status: 404 }
      )
    }

    return NextResponse.json({ productId })
  } catch (error) {
    console.error('[product-id] Error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
