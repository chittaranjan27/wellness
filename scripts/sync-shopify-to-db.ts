/**
 * One-off script: Clears the products table and re-populates it
 * with data fetched from the /api/shopify/products endpoint.
 *
 * Usage: npx tsx scripts/sync-shopify-to-db.ts
 */

const API_URL = 'http://localhost:3000/api/shopify/products'

// We use the Prisma client directly so we don't depend on the web server
// for the DB operations.
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('=== Shopify → DB Sync ===\n')

  // 1. Fetch products from the Shopify API endpoint
  console.log(`Fetching products from ${API_URL} ...`)
  const res = await fetch(API_URL)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to fetch products: HTTP ${res.status} — ${text}`)
  }

  const json = await res.json()
  const shopifyProducts: any[] = json.products || []
  console.log(`  ✓ Received ${shopifyProducts.length} products from Shopify\n`)

  if (shopifyProducts.length === 0) {
    console.log('No products found — aborting (existing data NOT deleted).')
    process.exit(0)
  }

  // 2. Delete ALL existing rows from the products table
  console.log('Deleting all existing products from the database ...')
  const deleted = await prisma.$executeRawUnsafe(`DELETE FROM products`)
  console.log(`  ✓ Deleted ${deleted} existing rows\n`)

  // 3. Insert each Shopify product
  console.log('Inserting Shopify products ...')
  let synced = 0
  let failed = 0

  for (const p of shopifyProducts) {
    // Parse prices
    const priceStr = p.price || ''
    const priceNum = parseFloat(priceStr.replace(/[^0-9.]/g, '')) || 0
    const minPrice = priceNum.toFixed(2)
    const maxPrice = priceNum.toFixed(2)

    // If there are multiple variants with different prices, find min/max
    let variantMin = priceNum
    let variantMax = priceNum
    if (p.variants && Array.isArray(p.variants)) {
      for (const v of p.variants) {
        const vp = parseFloat(String(v.price || '0').replace(/[^0-9.]/g, '')) || 0
        if (vp > 0) {
          variantMin = Math.min(variantMin, vp)
          variantMax = Math.max(variantMax, vp)
        }
      }
    }

    const currency = priceStr.replace(/[0-9.,\s]/g, '').trim() || 'INR'
    const symbol = currency === 'INR' ? '₹' : currency + ' '
    const priceDisplay =
      variantMin === variantMax
        ? `${symbol}${variantMin.toFixed(2)}`
        : `${symbol}${variantMin.toFixed(2)} – ${symbol}${variantMax.toFixed(2)}`

    // Variant titles for format/pack_size
    const variantTitles = (p.variants || [])
      .map((v: any) => v.title)
      .filter((t: any) => t && t !== 'Default Title')
    const format = variantTitles.length > 0 ? variantTitles.join(' / ') : null
    const packSize = variantTitles[0] || null

    // Tags → health_issues
    const healthIssues =
      p.tags && Array.isArray(p.tags) && p.tags.length > 0
        ? p.tags.join(', ')
        : null

    // Truncate to fit DB column varchar limits
    // If handle > 50 chars, use first 42 chars + 8-char hash to keep unique
    const rawHandle = p.handle || p.id || ''
    let productId: string
    if (rawHandle.length > 50) {
      const hash = rawHandle.split('').reduce((a: number, c: string) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0)
      const hashStr = Math.abs(hash).toString(36).substring(0, 8)
      productId = rawHandle.substring(0, 41) + '-' + hashStr
    } else {
      productId = rawHandle
    }
    const productName = (p.title || '').substring(0, 200)
    const subtitle = (p.type || '').substring(0, 200) || null
    const formatTrunc = format ? format.substring(0, 50) : null
    const funnelRole = (p.type || 'general').substring(0, 50)

    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO products (
          product_id, product_name, subtitle, format,
          capsule_count, pack_size,
          price_inr_min, price_inr_max, price_display,
          market, daily_dose_caps, supply_days, funnel_role,
          discount_eligible, discount_pct,
          target_age_group, health_issues, dosage_instructions,
          results_timeline, compatibility, recommended_plan,
          image_url, shopify_url
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6,
          $7::numeric, $8::numeric, $9,
          $10, $11, $12, $13,
          $14, $15,
          $16, $17, $18,
          $19, $20, $21,
          $22, $23
        )`,
        productId,                                  // product_id (varchar 50)
        productName,                                // product_name (varchar 200)
        subtitle,                                   // subtitle (varchar 200)
        formatTrunc,                                // format (varchar 50)
        0,                                          // capsule_count
        packSize,                                   // pack_size (varchar 200)
        variantMin,                                 // price_inr_min (numeric)
        variantMax,                                 // price_inr_max (numeric)
        priceDisplay,                               // price_display (text)
        (currency === 'INR' ? 'IN' : currency).substring(0, 100), // market (varchar 100)
        0,                                          // daily_dose_caps
        0,                                          // supply_days
        funnelRole,                                 // funnel_role (varchar 50)
        false,                                      // discount_eligible
        null,                                       // discount_pct
        null,                                       // target_age_group
        healthIssues,                               // health_issues (text)
        null,                                       // dosage_instructions (text)
        null,                                       // results_timeline (text)
        null,                                       // compatibility (text)
        null,                                       // recommended_plan (text)
        p.imageUrl || null,                         // image_url (text)
        p.url || null                               // shopify_url (text)
      )
      synced++
      console.log(`  ✓ [${synced}] ${p.title}  →  ${priceDisplay}`)
    } catch (err: any) {
      failed++
      console.error(`  ✗ Failed: "${p.title}" — ${err.message}`)
    }
  }

  console.log(`\n=== Done ===`)
  console.log(`  Fetched:  ${shopifyProducts.length}`)
  console.log(`  Synced:   ${synced}`)
  console.log(`  Failed:   ${failed}`)
  console.log(`  Deleted:  ${deleted} (old rows)`)

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('\nFatal error:', err)
  process.exit(1)
})
