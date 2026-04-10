/**
 * POST /api/sales-agent
 *
 * Sales-focused endpoint that:
 * 1. Receives user concern + conversation history
 * 2. Fetches the LIVE Shopify product catalog (real prices, real variant IDs)
 * 3. Enriches with DB metadata (dosage, results_timeline, health_issues, supply_days) when available
 * 4. Calls GPT-4o-mini with a sales system prompt + enriched catalog
 * 5. GPT returns structured combo plans with real product IDs, quantities, and roles
 * 6. Returns validated bundles with actual Shopify prices + variant IDs ready for cart
 *
 * KEY DESIGN: Products come from Shopify (source of truth for price/availability),
 * enriched with DB metadata. Plans are built by GPT based on the user's condition.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { OpenAI } from 'openai'
import { env } from '@/lib/env'
import { getAllShopifyProducts, isShopifyConfigured, type ShopifyProduct } from '@/lib/shopify'

export const runtime = 'nodejs'

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY })

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

// ─── Types ────────────────────────────────────────────────────────────────────

/** Enriched product combining Shopify live data + DB metadata */
interface EnrichedProduct {
  // From Shopify (source of truth)
  shopifyId: string
  handle: string
  title: string
  description: string
  productType: string
  tags: string[]
  imageUrl: string | null
  shopifyUrl: string
  variants: Array<{
    id: string
    title: string
    price: number
    currencyCode: string
    available: boolean
  }>
  // Best price (cheapest available variant)
  price: number
  // From DB enrichment (may be null if not in DB)
  supplyDays: number
  healthIssues: string | null
  dosageInstructions: string | null
  resultsTimeline: string | null
  funnelRole: string
}

/** What GPT returns for each product in a plan */
interface GPTPlanProduct {
  handle: string          // Shopify product handle
  variantIndex: number    // which variant to use (0-based index)
  quantity: number        // how many to add
  role: 'primary' | 'supporting'
  reason: string          // why this product is included
}

/** What GPT returns for each plan */
interface GPTPlan {
  name: string
  tagline: string
  durationLabel: string
  durationDays: number
  products: GPTPlanProduct[]
  expectedResults: string
  recommended: boolean
}

/** Final bundle product for frontend */
interface BundleProduct {
  productId: string
  productName: string
  role: 'primary' | 'supporting'
  imageUrl: string | null
  shopifyUrl: string | null
  shopifyVariantId: string | null
  price: number        // price PER UNIT
  quantity: number     // how many to add
  supplyDays: number
  totalDays: number
  dosageInstructions: string | null
  resultsTimeline: string | null
}

interface Bundle {
  name: string
  tagline: string
  duration: number
  durationLabel: string
  products: BundleProduct[]
  totalPrice: number
  perDayPrice: number
  savingsLabel: string | null
  expectedResults: string
  recommended: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const VARIANT_RE = /\b(\d+)\s*[-–]?\s*(day|days|month|months|week|weeks|capsule|capsules|tablet|tablets|sachet|sachets|ml|gm|gram|grams|kg|pack|packs|bottle|bottles|strips?)\b/gi

function getProductBaseName(title: string): string {
  return (title || '')
    .toLowerCase()
    .replace(VARIANT_RE, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Fetch live Shopify products and enrich with DB metadata.
 * Shopify is the source of truth for: price, availability, variant IDs, images.
 * DB enriches with: supply_days, dosage_instructions, results_timeline, health_issues.
 */
async function getEnrichedProducts(): Promise<EnrichedProduct[]> {
  // 1. Fetch live Shopify catalog
  let shopifyProducts: ShopifyProduct[] = []
  if (isShopifyConfigured()) {
    shopifyProducts = await getAllShopifyProducts()
  }

  if (shopifyProducts.length === 0) {
    console.warn('[sales-agent] No Shopify products found, cannot build plans')
    return []
  }

  // 2. Fetch DB metadata for enrichment
  interface DBRow {
    product_id: string
    product_name: string
    supply_days: number
    health_issues: string | null
    dosage_instructions: string | null
    results_timeline: string | null
    funnel_role: string
    image_url: string | null
    shopify_url: string | null
    shopify_variant_id: string | null
  }

  let dbProducts: DBRow[] = []
  try {
    dbProducts = await prisma.$queryRawUnsafe<DBRow[]>(
      `SELECT product_id, product_name, supply_days, health_issues,
              dosage_instructions, results_timeline, funnel_role,
              image_url, shopify_url, shopify_variant_id
       FROM products`
    )
  } catch (e) {
    console.warn('[sales-agent] DB products query failed, using Shopify-only data:', e)
  }

  // 3. Build a lookup map: base_name → DB rows
  const dbByBase = new Map<string, DBRow[]>()
  for (const row of dbProducts) {
    const base = getProductBaseName(row.product_name)
    if (!dbByBase.has(base)) dbByBase.set(base, [])
    dbByBase.get(base)!.push(row)
  }

  // Also create a handle → DB row map for direct matching
  const dbByHandle = new Map<string, DBRow>()
  for (const row of dbProducts) {
    dbByHandle.set(row.product_id, row)
  }

  // 4. Enrich each Shopify product
  const enriched: EnrichedProduct[] = []

  for (const sp of shopifyProducts) {
    // Parse variant prices
    const variants = sp.variants.map(v => ({
      id: v.id,
      title: v.title,
      price: parseFloat(v.price) || 0,
      currencyCode: v.currencyCode || 'INR',
      available: v.available !== false,
    }))

    // Skip products with no available variants or zero price
    const availableVariants = variants.filter(v => v.available && v.price > 0)
    if (availableVariants.length === 0 && variants.every(v => v.price === 0)) continue

    const cheapest = availableVariants.length > 0
      ? Math.min(...availableVariants.map(v => v.price))
      : (variants[0]?.price || 0)

    // Find DB enrichment via handle match or base-name match
    const dbRow = dbByHandle.get(sp.handle)
    let dbMatch: DBRow | undefined = dbRow
    if (!dbMatch) {
      const spBase = getProductBaseName(sp.title)
      const candidates = dbByBase.get(spBase)
      if (candidates && candidates.length > 0) {
        dbMatch = candidates[0]
      }
    }

    enriched.push({
      shopifyId: sp.id,
      handle: sp.handle,
      title: sp.title,
      description: sp.description,
      productType: sp.productType,
      tags: sp.tags,
      imageUrl: sp.imageUrl,
      shopifyUrl: sp.url,
      variants,
      price: cheapest,
      supplyDays: dbMatch?.supply_days || 0,
      healthIssues: dbMatch?.health_issues || (sp.tags.length > 0 ? sp.tags.join(', ') : null),
      dosageInstructions: dbMatch?.dosage_instructions || null,
      resultsTimeline: dbMatch?.results_timeline || null,
      funnelRole: dbMatch?.funnel_role || sp.productType || 'general',
    })
  }

  console.log(`[sales-agent] Enriched ${enriched.length} products from Shopify (${dbProducts.length} DB rows for metadata)`)
  return enriched
}

/**
 * Build the product catalog string for the AI prompt.
 * Includes ALL real products with their actual Shopify prices and variant details.
 */
function buildCatalogPrompt(products: EnrichedProduct[]): string {
  return products.map((p, idx) => {
    const variantDetails = p.variants
      .filter(v => v.available && v.price > 0)
      .map((v, vi) => `    variant[${vi}]: "${v.title}" @ ₹${v.price}${v.available ? '' : ' (out of stock)'}`)
      .join('\n')

    return [
      `[${idx}] ${p.title} (handle: "${p.handle}")`,
      `  Price: ₹${p.price} | Type: ${p.productType || 'General'} | Tags: ${p.tags.join(', ') || 'none'}`,
      `  Health issues: ${p.healthIssues || 'general wellness'}`,
      `  Supply days: ${p.supplyDays || 'not specified'}`,
      `  Dosage: ${p.dosageInstructions || 'As per label'}`,
      `  Results: ${p.resultsTimeline || 'Varies'}`,
      `  Variants:\n${variantDetails || '    (single variant)'}`,
    ].join('\n')
  }).join('\n\n')
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin')
  const cors = corsHeaders(origin)

  try {
    const body = await req.json()
    const {
      agentId,
      concern,
      language = 'en',
      conversationHistory = [],
      mode = 'recommend', // 'recommend' | 'ask'
      question,
    } = body

    if (!agentId) {
      return NextResponse.json({ error: 'Missing agentId' }, { status: 400, headers: cors })
    }

    // ── Fetch enriched product catalog ──────────────────────────────────────
    const enrichedProducts = await getEnrichedProducts()

    if (enrichedProducts.length === 0) {
      return NextResponse.json({
        error: 'No products available',
        details: 'Could not fetch products from Shopify. Please ensure Shopify integration is configured.',
      }, { status: 503, headers: cors })
    }

    // ── "Ask" mode: answer dosage/safety/results questions ──────────────────
    if (mode === 'ask' && question) {
      const catalog = enrichedProducts.map(p =>
        `• ${p.title} — ₹${p.price}. Dosage: ${p.dosageInstructions || 'Follow label'}. Results: ${p.resultsTimeline || '2-4 weeks'}.`
      ).join('\n')

      const askPrompt = [
        {
          role: 'system' as const,
          content:
            `You are a friendly, knowledgeable wellness sales advisor for StayOn Wellness.\n` +
            `Answer the user's question about dosage, safety, or expected results accurately and warmly.\n` +
            `Use the product catalog below.\n\n` +
            `PRODUCT CATALOG:\n${catalog}\n\n` +
            `Respond in ${language === 'hi' ? 'Hindi (Devanagari)' : 'English'}.\n` +
            `Keep answers concise (2-4 sentences). Be reassuring and professional.\n` +
            `Return a JSON object: { "response": "your answer", "chips": ["chip1", "chip2"] }`
        },
        ...conversationHistory.slice(-10),
        { role: 'user' as const, content: question },
      ]

      const askCompletion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: askPrompt as any,
        temperature: 0.6,
        max_tokens: 400,
        response_format: { type: 'json_object' },
      })

      let askParsed: any = { response: '', chips: [] }
      try {
        askParsed = JSON.parse(askCompletion.choices[0]?.message?.content?.trim() || '{}')
      } catch { /* fallback */ }

      return NextResponse.json({
        response: askParsed.response || 'I can help with that! Please describe your question in more detail.',
        chips: Array.isArray(askParsed.chips) ? askParsed.chips : [],
      }, { headers: cors })
    }

    // ── "Recommend" mode: build combo plans from real products ──────────────
    if (!concern) {
      return NextResponse.json({ error: 'Missing concern' }, { status: 400, headers: cors })
    }

    const catalogPrompt = buildCatalogPrompt(enrichedProducts)

    const systemMsg =
      `You are a wellness sales specialist for StayOn Wellness (Ayurvedic/natural supplements).\n\n` +
      `The user's main concern is: "${concern}"\n\n` +
      `CONVERSATION CONTEXT:\n${conversationHistory.slice(-8).map((m: any) => `${m.role}: ${m.content}`).join('\n')}\n\n` +
      `REAL PRODUCT CATALOG (from Shopify — use ONLY these products):\n${catalogPrompt}\n\n` +
      `YOUR TASK:\n` +
      `Create 2-4 personalized combo plans using ONLY products from the catalog above.\n` +
      `Each plan should be a meaningful combination of products that work together for the user's condition.\n\n` +
      `RULES:\n` +
      `1. Use ONLY products listed above — reference them by their exact "handle" value.\n` +
      `2. Each plan should have 2-4 products that complement each other.\n` +
      `3. Mark 1 product per plan as "primary" (main treatment) and others as "supporting".\n` +
      `4. Use the correct variant index (0-based) for each product. Choose the variant that makes sense for the plan duration.\n` +
      `5. Set quantity appropriately (usually 1, but 2+ if the plan is for a longer duration).\n` +
      `6. Plans should increase in duration/value: e.g. "Starter" (short), "Recommended" (medium), "Complete" (long).\n` +
      `7. Mark exactly ONE plan as recommended (the best value for the user's condition).\n` +
      `8. Calculate realistic plan durations in days based on the products.\n` +
      `9. Write a warm, personalized 2-3 sentence response explaining why these products suit the user.\n\n` +
      `Respond in ${language === 'hi' ? 'Hindi (Devanagari)' : 'English'}.\n\n` +
      `Return EXACTLY this JSON structure:\n` +
      `{\n` +
      `  "response": "Your warm personalized message to the user",\n` +
      `  "plans": [\n` +
      `    {\n` +
      `      "name": "Plan name (e.g. Starter, Recommended, Complete)",\n` +
      `      "tagline": "Short tagline for the plan",\n` +
      `      "durationLabel": "e.g. 1 Month, 2 Months",\n` +
      `      "durationDays": 30,\n` +
      `      "products": [\n` +
      `        {\n` +
      `          "handle": "exact-product-handle",\n` +
      `          "variantIndex": 0,\n` +
      `          "quantity": 1,\n` +
      `          "role": "primary",\n` +
      `          "reason": "Why this product helps"\n` +
      `        }\n` +
      `      ],\n` +
      `      "expectedResults": "What results to expect with this plan",\n` +
      `      "recommended": false\n` +
      `    }\n` +
      `  ],\n` +
      `  "chips": ["Suggestion 1", "Suggestion 2"]\n` +
      `}`

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemMsg }],
      temperature: 0.7,
      max_tokens: 1500,
      response_format: { type: 'json_object' },
    })

    let parsed: any = {}
    try {
      parsed = JSON.parse(completion.choices[0]?.message?.content?.trim() || '{}')
    } catch { /* fallback */ }

    const gptPlans: GPTPlan[] = Array.isArray(parsed.plans) ? parsed.plans : []

    // ── Build validated bundles from GPT response ──────────────────────────
    // Create a handle → enriched product lookup
    const productByHandle = new Map<string, EnrichedProduct>()
    for (const p of enrichedProducts) {
      productByHandle.set(p.handle, p)
    }

    const bundles: Bundle[] = []

    for (const plan of gptPlans) {
      const bundleProducts: BundleProduct[] = []
      let totalPrice = 0
      let hasValidProduct = false

      for (const gptProd of plan.products) {
        const product = productByHandle.get(gptProd.handle)
        if (!product) {
          console.warn(`[sales-agent] GPT referenced unknown product handle: "${gptProd.handle}", skipping`)
          continue
        }

        // Select the variant
        const variantIdx = Math.min(
          Math.max(0, gptProd.variantIndex || 0),
          product.variants.length - 1
        )
        const variant = product.variants[variantIdx] || product.variants[0]
        if (!variant) continue

        const qty = Math.max(1, gptProd.quantity || 1)
        const unitPrice = variant.price
        const lineTotal = unitPrice * qty
        totalPrice += lineTotal
        hasValidProduct = true

        // Extract numeric variant ID from Shopify GID
        const rawId = variant.id
        const numericId = rawId.includes('/') ? rawId.split('/').pop() || rawId : rawId

        bundleProducts.push({
          productId: product.handle,
          productName: product.title,
          role: gptProd.role === 'supporting' ? 'supporting' : 'primary',
          imageUrl: product.imageUrl,
          shopifyUrl: product.shopifyUrl,
          shopifyVariantId: numericId,
          price: unitPrice,
          quantity: qty,
          supplyDays: product.supplyDays || plan.durationDays || 30,
          totalDays: (product.supplyDays || plan.durationDays || 30) * qty,
          dosageInstructions: product.dosageInstructions,
          resultsTimeline: product.resultsTimeline,
        })
      }

      if (!hasValidProduct || bundleProducts.length === 0) continue

      totalPrice = Math.round(totalPrice)
      const duration = plan.durationDays || 30
      const perDay = duration > 0 ? Math.round(totalPrice / duration) : 0

      // Calculate savings: compare against buying individual products at full price
      // Use the first (cheapest) plan as baseline for comparison
      let savingsLabel: string | null = null
      if (bundles.length > 0 && bundles[0].perDayPrice > 0 && perDay < bundles[0].perDayPrice) {
        const savingsPct = Math.round(((bundles[0].perDayPrice - perDay) / bundles[0].perDayPrice) * 100)
        if (savingsPct > 0) savingsLabel = `Save ${savingsPct}% per day`
      }

      bundles.push({
        name: plan.name || `Plan ${bundles.length + 1}`,
        tagline: plan.tagline || 'Curated for your needs',
        duration,
        durationLabel: plan.durationLabel || `${duration} Days`,
        products: bundleProducts,
        totalPrice,
        perDayPrice: perDay,
        savingsLabel,
        expectedResults: plan.expectedResults || 'Gradual improvement in your wellness.',
        recommended: plan.recommended || false,
      })
    }

    // ── Fallback: if GPT didn't return valid plans, build a simple one ──────
    if (bundles.length === 0) {
      console.warn('[sales-agent] GPT returned no valid plans, building fallback from top products')
      const fallbackBundle = buildFallbackBundle(enrichedProducts, concern)
      if (fallbackBundle) bundles.push(fallbackBundle)
    }

    // ── Ensure exactly one bundle is "recommended" ─────────────────────────
    const recBundles = bundles.filter(b => b.recommended)
    if (recBundles.length === 0 && bundles.length > 0) {
      // Pick the middle bundle
      const midIdx = Math.floor(bundles.length / 2)
      bundles[midIdx].recommended = true
    } else if (recBundles.length > 1) {
      // Keep only the first one recommended
      let found = false
      for (const b of bundles) {
        if (b.recommended) {
          if (found) b.recommended = false
          else found = true
        }
      }
    }

    // Order metadata
    const orderMeta = {
      paymentMethods: ['UPI', 'Credit Card', 'Debit Card', 'Net Banking', 'EMI', 'Cash on Delivery'],
      shippingThreshold: 999,
      shippingMessage: 'Free shipping on orders above ₹999',
      returnPolicy: '7-day easy returns',
      guarantee: '100% Ayurvedic • Clinically Tested • GMP Certified',
    }

    return NextResponse.json({
      bundles,
      response: parsed.response || 'Based on your consultation, I have prepared personalized wellness plans for you.',
      chips: Array.isArray(parsed.chips)
        ? parsed.chips
        : ['How should I take this?', 'Any side effects?', 'How soon will I see results?'],
      orderMeta,
    }, { headers: cors })

  } catch (error) {
    console.error('[sales-agent] Error:', error)
    return NextResponse.json(
      { error: 'Sales agent failed', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500, headers: cors }
    )
  }
}

// ─── Fallback bundle builder ──────────────────────────────────────────────────
/**
 * If GPT fails to return valid plans, build a simple fallback bundle
 * from the top available products that match the user's concern.
 */
function buildFallbackBundle(
  products: EnrichedProduct[],
  concern: string
): Bundle | null {
  if (products.length === 0) return null

  const concernLower = concern.toLowerCase()

  // Score products by relevance to the concern
  const scored = products.map(p => {
    let score = 0
    const searchText = `${p.title} ${p.description} ${p.healthIssues || ''} ${p.tags.join(' ')}`.toLowerCase()

    // Check for keyword overlap with the concern
    const keywords = concernLower.split(/\s+/).filter(w => w.length > 2)
    for (const kw of keywords) {
      if (searchText.includes(kw)) score += 2
    }

    // Bonus for products with available variants
    if (p.variants.some(v => v.available && v.price > 0)) score += 1

    return { product: p, score }
  })

  // Sort by relevance score
  scored.sort((a, b) => b.score - a.score)

  // Take top 2-3 products
  const selected = scored.slice(0, Math.min(3, scored.length))
  if (selected.length === 0) return null

  const bundleProducts: BundleProduct[] = selected.map((item, idx) => {
    const variant = item.product.variants.find(v => v.available && v.price > 0) || item.product.variants[0]
    if (!variant) return null

    const rawId = variant.id
    const numericId = rawId.includes('/') ? rawId.split('/').pop() || rawId : rawId

    return {
      productId: item.product.handle,
      productName: item.product.title,
      role: idx === 0 ? 'primary' as const : 'supporting' as const,
      imageUrl: item.product.imageUrl,
      shopifyUrl: item.product.shopifyUrl,
      shopifyVariantId: numericId,
      price: variant.price,
      quantity: 1,
      supplyDays: item.product.supplyDays || 30,
      totalDays: item.product.supplyDays || 30,
      dosageInstructions: item.product.dosageInstructions,
      resultsTimeline: item.product.resultsTimeline,
    }
  }).filter(Boolean) as BundleProduct[]

  if (bundleProducts.length === 0) return null

  const totalPrice = Math.round(bundleProducts.reduce((s, p) => s + p.price * p.quantity, 0))

  return {
    name: 'Recommended',
    tagline: 'Curated for your needs',
    duration: 30,
    durationLabel: '1 Month',
    products: bundleProducts,
    totalPrice,
    perDayPrice: Math.round(totalPrice / 30),
    savingsLabel: null,
    expectedResults: 'Gradual improvement in energy, wellness, and overall vitality within the first month.',
    recommended: true,
  }
}
