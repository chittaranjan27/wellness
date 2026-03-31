/**
 * POST /api/sales-agent
 *
 * Sales-focused endpoint that:
 * 1. Receives user concern + conversation history
 * 2. Loads products & pricing from PostgreSQL (with supply_days for trial grouping)
 * 3. Calls GPT-4o-mini with a sales system prompt including the product catalog
 * 4. GPT returns which product to recommend as primary, which as supporting
 * 5. Builds plans for standard tiers (15, 30, 60, 90 days) using REAL packs:
 *    — If an exact-duration pack exists (e.g. 60-day pack), use it (qty=1)
 *    — If not, combine smaller packs (e.g. 2×30-day = 60 days)
 * 6. Fetches Shopify catalog to resolve correct variant IDs
 * 7. Returns bundles, warm response, suggestion chips, and order metadata
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { OpenAI } from 'openai'
import { env } from '@/lib/env'
import { getAllShopifyProducts, isShopifyConfigured } from '@/lib/shopify'

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
interface DBProduct {
  product_id: string
  product_name: string
  price_inr_min: string
  price_inr_max: string
  supply_days: number
  funnel_role: string
  discount_eligible: boolean
  discount_pct: string | null
  health_issues: string | null
  dosage_instructions: string | null
  results_timeline: string | null
  image_url: string | null
  shopify_url: string | null
  shopify_variant_id: string | null
}

interface BundleProduct {
  productId: string
  productName: string
  role: 'primary' | 'supporting'
  imageUrl: string | null
  shopifyUrl: string | null
  shopifyVariantId: string | null
  price: number        // price PER UNIT of this pack
  quantity: number     // how many of this pack to add (e.g. 2×30-day = 60 days)
  supplyDays: number   // supply_days of the individual pack
  totalDays: number    // effective days this line covers = supplyDays × quantity
  dosageInstructions: string | null
  resultsTimeline: string | null
}

interface Bundle {
  name: string
  tagline: string
  duration: number         // target duration in days
  durationLabel: string
  products: BundleProduct[]
  totalPrice: number       // sum of (price × quantity) for all products
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

function extractDays(title: string): number | null {
  const match = title.match(/\b(\d+)\s*[-–]?\s*(day|days)\b/i)
  if (match) return parseInt(match[1], 10)
  const monthMatch = title.match(/\b(\d+)\s*[-–]?\s*(month|months)\b/i)
  if (monthMatch) return parseInt(monthMatch[1], 10) * 30
  return null
}

// ─── Shopify types ────────────────────────────────────────────────────────────
interface ShopifyVariantInfo {
  id: string
  title: string
  price: string
  available: boolean
}

interface ShopifyProductInfo {
  id: string
  title: string
  handle: string
  imageUrl: string | null
  url: string
  variants: ShopifyVariantInfo[]
}

// ─── Pack-selection logic ─────────────────────────────────────────────────────

/**
 * For a given target duration, figure out which pack to use and how many.
 *
 * Strategy (greedy, prefer exact match):
 *  1. If an exact-duration pack exists → use it, qty=1
 *  2. Otherwise, find the largest pack that divides evenly into targetDays
 *  3. If none divides evenly, find the largest pack ≤ targetDays and use
 *     ceil(targetDays / packDays) units
 *  4. Fallback: use the smallest available pack with appropriate qty
 *
 * Returns { product, quantity } or null if no variants exist.
 */
function selectPackForDuration(
  variants: DBProduct[],
  targetDays: number
): { product: DBProduct; quantity: number } | null {
  if (variants.length === 0) return null

  // Sort variants by supply_days ascending
  const sorted = [...variants]
    .filter(v => v.supply_days > 0)
    .sort((a, b) => a.supply_days - b.supply_days)

  if (sorted.length === 0) {
    // No supply_days data at all — just use first variant, qty=1
    return { product: variants[0], quantity: 1 }
  }

  // 1. Exact match
  const exact = sorted.find(v => v.supply_days === targetDays)
  if (exact) return { product: exact, quantity: 1 }

  // 2. Find the largest pack that divides evenly into targetDays
  for (let i = sorted.length - 1; i >= 0; i--) {
    const packDays = sorted[i].supply_days
    if (packDays <= targetDays && targetDays % packDays === 0) {
      return { product: sorted[i], quantity: targetDays / packDays }
    }
  }

  // 3. Find the largest pack ≤ targetDays and use ceil
  const smallerPacks = sorted.filter(v => v.supply_days <= targetDays)
  if (smallerPacks.length > 0) {
    const bestPack = smallerPacks[smallerPacks.length - 1] // largest ≤ target
    const qty = Math.ceil(targetDays / bestPack.supply_days)
    return { product: bestPack, quantity: qty }
  }

  // 4. All packs are larger than target — use the smallest pack, qty=1
  return { product: sorted[0], quantity: 1 }
}

// ─── Shopify variant resolution ───────────────────────────────────────────────
function findShopifyMatch(
  dbProduct: DBProduct,
  shopifyCatalog: ShopifyProductInfo[]
): { variantId: string | null; imageUrl: string | null; shopifyUrl: string | null } {
  // First priority: use DB-stored shopify_variant_id
  if (dbProduct.shopify_variant_id) {
    return {
      variantId: dbProduct.shopify_variant_id,
      imageUrl: dbProduct.image_url,
      shopifyUrl: dbProduct.shopify_url,
    }
  }

  // Second: match against Shopify catalog by product title → variant
  const dbTitle = dbProduct.product_name.toLowerCase()
  const dbBase = getProductBaseName(dbProduct.product_name)
  const dbDays = dbProduct.supply_days

  for (const sp of shopifyCatalog) {
    const spBase = getProductBaseName(sp.title)
    // Check base name similarity
    if (spBase !== dbBase && !sp.title.toLowerCase().includes(dbBase) && !dbTitle.includes(spBase)) {
      continue
    }

    // If this Shopify product has variants, find the one matching supply_days
    if (sp.variants.length > 1) {
      for (const v of sp.variants) {
        const vDays = extractDays(v.title)
        if (vDays === dbDays) {
          return { variantId: v.id, imageUrl: sp.imageUrl, shopifyUrl: sp.url }
        }
      }
    }

    // Fallback: check if Shopify product title contains the days
    const spDays = extractDays(sp.title)
    if (spDays === dbDays || (spDays === null && sp.variants.length === 1)) {
      const firstAvailable = sp.variants.find(v => v.available !== false) || sp.variants[0]
      return {
        variantId: firstAvailable?.id || null,
        imageUrl: sp.imageUrl,
        shopifyUrl: sp.url,
      }
    }
  }

  // Last resort: return DB values
  return {
    variantId: dbProduct.shopify_variant_id,
    imageUrl: dbProduct.image_url,
    shopifyUrl: dbProduct.shopify_url,
  }
}

// ─── Bundle building ──────────────────────────────────────────────────────────

/**
 * Build plan bundles for the user.
 *
 * Plan tiers are the standard durations available in the DB: [15, 30, 60, 90] days.
 * We only create tiers for which at least the primary product can be fulfilled.
 *
 * For each tier duration:
 *   - If an exact pack exists (e.g. 60-day pack), use it with qty=1
 *   - If not, combine smaller packs (e.g. 2×30-day = 60 days)
 *   - Supporting product follows the same logic independently
 */
function buildDurationBundles(
  primaryKey: string,
  supportingKey: string | null,
  products: DBProduct[],
  shopifyCatalog: ShopifyProductInfo[],
  expectedResults: { trial: string; recommended: string; complete: string }
): Bundle[] {
  // Find the primary product to determine its base name
  const primaryProduct = products.find(p => p.product_id === primaryKey)
  if (!primaryProduct) return []

  const primaryBase = getProductBaseName(primaryProduct.product_name)

  // Collect ALL variants (by base name) for primary
  const primaryVariants = products.filter(p => {
    const base = getProductBaseName(p.product_name)
    return base === primaryBase && p.supply_days > 0
  })

  // If no variants with supply_days, use the primary product itself
  if (primaryVariants.length === 0) {
    primaryVariants.push(primaryProduct)
  }

  // Collect supporting product variants
  let supportingVariants: DBProduct[] = []
  if (supportingKey) {
    const supportingProduct = products.find(p => p.product_id === supportingKey)
    if (supportingProduct) {
      const supportingBase = getProductBaseName(supportingProduct.product_name)
      supportingVariants = products.filter(p => {
        const base = getProductBaseName(p.product_name)
        return base === supportingBase && p.supply_days > 0
      })
      if (supportingVariants.length === 0) {
        supportingVariants.push(supportingProduct)
      }
    }
  }

  // Discover ALL available pack durations across all DB products
  const allPackDurations = new Set<number>()
  for (const p of products) {
    if (p.supply_days > 0) allPackDurations.add(p.supply_days)
  }
  // Standard target durations — we'll try to build tiers for each of these
  const STANDARD_TIERS = [15, 30, 60, 90]

  // Merge: use all pack durations from DB + standard tiers
  const candidateDurations = new Set<number>([...allPackDurations, ...STANDARD_TIERS])
  const sortedDurations = [...candidateDurations].sort((a, b) => a - b)

  // For each candidate duration, check if we can actually build a plan
  // (primary product must be fulfillable)
  const viableTiers: Array<{
    duration: number
    primary: { product: DBProduct; quantity: number }
    supporting: { product: DBProduct; quantity: number } | null
  }> = []

  for (const targetDays of sortedDurations) {
    const primaryPack = selectPackForDuration(primaryVariants, targetDays)
    if (!primaryPack) continue

    let supportingPack: { product: DBProduct; quantity: number } | null = null
    if (supportingVariants.length > 0) {
      supportingPack = selectPackForDuration(supportingVariants, targetDays)
    }

    viableTiers.push({ duration: targetDays, primary: primaryPack, supporting: supportingPack })
  }

  if (viableTiers.length === 0) return []

  // Assign tier names
  // Priority labels by duration range
  function getTierInfo(duration: number, idx: number, total: number): { name: string; tagline: string; recommended: boolean } {
    if (total === 1) {
      return { name: 'Recommended Plan', tagline: 'Curated for your needs', recommended: true }
    }
    if (duration <= 15) {
      return { name: 'Trial', tagline: 'Try it out', recommended: false }
    }
    if (duration <= 30) {
      return total <= 3 && idx === total - 1
        ? { name: 'Recommended', tagline: 'Most popular choice', recommended: true }
        : { name: 'Starter', tagline: 'Get started', recommended: false }
    }
    if (duration <= 60) {
      return { name: 'Recommended', tagline: 'Most popular choice', recommended: true }
    }
    return { name: 'Complete', tagline: 'Best value plan', recommended: false }
  }

  // Ensure exactly one tier is "recommended" — if none matched the heuristic,
  // pick the middle tier; if multiple matched, keep only the one closest to 30-60d
  const resultsByDuration: Record<string, string> = {}
  for (const tier of viableTiers) {
    if (tier.duration <= 15) resultsByDuration[tier.duration.toString()] = expectedResults.trial
    else if (tier.duration <= 30) resultsByDuration[tier.duration.toString()] = expectedResults.trial
    else if (tier.duration <= 60) resultsByDuration[tier.duration.toString()] = expectedResults.recommended
    else resultsByDuration[tier.duration.toString()] = expectedResults.complete
  }

  // Price of smallest primary pack for savings computation
  const smallestPrimaryPrice = Math.min(
    ...primaryVariants.map(p => parseFloat(p.price_inr_min) || 0).filter(p => p > 0)
  ) || 0
  const smallestPrimaryDays = Math.min(
    ...primaryVariants.map(p => p.supply_days).filter(d => d > 0)
  ) || 30
  const pricePerDayBase = smallestPrimaryDays > 0 ? smallestPrimaryPrice / smallestPrimaryDays : 0

  // Build the Bundle objects
  const bundles: Bundle[] = viableTiers.map((tier, idx) => {
    const tierInfo = getTierInfo(tier.duration, idx, viableTiers.length)

    const bundleProducts: BundleProduct[] = []

    // Primary
    const pShopify = findShopifyMatch(tier.primary.product, shopifyCatalog)
    const pPrice = parseFloat(tier.primary.product.price_inr_min) || 0
    bundleProducts.push({
      productId: tier.primary.product.product_id,
      productName: tier.primary.product.product_name,
      role: 'primary',
      imageUrl: pShopify.imageUrl || tier.primary.product.image_url,
      shopifyUrl: pShopify.shopifyUrl || tier.primary.product.shopify_url,
      shopifyVariantId: pShopify.variantId,
      price: pPrice,
      quantity: tier.primary.quantity,
      supplyDays: tier.primary.product.supply_days,
      totalDays: tier.primary.product.supply_days * tier.primary.quantity,
      dosageInstructions: tier.primary.product.dosage_instructions,
      resultsTimeline: tier.primary.product.results_timeline,
    })

    // Supporting
    if (tier.supporting) {
      const sShopify = findShopifyMatch(tier.supporting.product, shopifyCatalog)
      const sPrice = parseFloat(tier.supporting.product.price_inr_min) || 0
      bundleProducts.push({
        productId: tier.supporting.product.product_id,
        productName: tier.supporting.product.product_name,
        role: 'supporting',
        imageUrl: sShopify.imageUrl || tier.supporting.product.image_url,
        shopifyUrl: sShopify.shopifyUrl || tier.supporting.product.shopify_url,
        shopifyVariantId: sShopify.variantId,
        price: sPrice,
        quantity: tier.supporting.quantity,
        supplyDays: tier.supporting.product.supply_days,
        totalDays: tier.supporting.product.supply_days * tier.supporting.quantity,
        dosageInstructions: tier.supporting.product.dosage_instructions,
        resultsTimeline: tier.supporting.product.results_timeline,
      })
    }

    // Total = sum of (price × quantity) for each product line
    const totalPrice = bundleProducts.reduce((sum, bp) => sum + bp.price * bp.quantity, 0)
    const perDay = tier.duration > 0 ? Math.round(totalPrice / tier.duration) : 0

    // Savings vs buying the smallest pack proportionally for this duration
    const proportionalBase = Math.round(pricePerDayBase * tier.duration * bundleProducts.length)
    const savedAmt = proportionalBase > totalPrice ? Math.round(proportionalBase - totalPrice) : 0
    const savingsLabel = savedAmt > 0 ? `Save ₹${savedAmt}` : null

    const durationLabel = tier.duration >= 30 && tier.duration % 30 === 0
      ? `${tier.duration / 30} Month${tier.duration / 30 > 1 ? 's' : ''}`
      : `${tier.duration} Days`

    return {
      name: tierInfo.name,
      tagline: tierInfo.tagline,
      duration: tier.duration,
      durationLabel,
      products: bundleProducts,
      totalPrice: Math.round(totalPrice),
      perDayPrice: perDay,
      savingsLabel,
      expectedResults: resultsByDuration[tier.duration.toString()] || expectedResults.recommended,
      recommended: tierInfo.recommended,
    }
  })

  // Post-process: ensure exactly one bundle is "recommended"
  const recBundles = bundles.filter(b => b.recommended)
  if (recBundles.length === 0 && bundles.length > 0) {
    // Pick the middle bundle
    const midIdx = Math.floor(bundles.length / 2)
    bundles[midIdx].recommended = true
  } else if (recBundles.length > 1) {
    // Keep only the one closest to 30 days
    let closest = recBundles[0]
    for (const rb of recBundles) {
      if (Math.abs(rb.duration - 30) < Math.abs(closest.duration - 30)) closest = rb
    }
    for (const b of bundles) {
      b.recommended = (b === closest)
    }
  }

  return bundles
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

    // ── Load products from DB ──────────────────────────────────────────────
    const products = await prisma.$queryRawUnsafe<DBProduct[]>(
      `SELECT product_id, product_name, price_inr_min, price_inr_max,
              supply_days, funnel_role, discount_eligible, discount_pct,
              health_issues, dosage_instructions, results_timeline,
              image_url, shopify_url, shopify_variant_id
       FROM products ORDER BY product_id`
    )

    // ── Load Shopify catalog for variant resolution ───────────────────────
    let shopifyCatalog: ShopifyProductInfo[] = []
    if (isShopifyConfigured()) {
      try {
        const shopifyProducts = await getAllShopifyProducts()
        shopifyCatalog = shopifyProducts.map(sp => ({
          id: sp.id,
          title: sp.title,
          handle: sp.handle,
          imageUrl: sp.imageUrl,
          url: sp.url,
          variants: sp.variants.map(v => ({
            id: v.id,
            title: v.title,
            price: v.price,
            available: v.available,
          })),
        }))
      } catch (e) {
        console.warn('[sales-agent] Shopify catalog fetch failed, using DB data:', e)
      }
    }

    // ── "Ask" mode: answer dosage/safety/results questions ─────────────────
    if (mode === 'ask' && question) {
      const catalog = products.map(p =>
        `• ${p.product_name} — ₹${p.price_inr_min}, ${p.supply_days}d supply. Dosage: ${p.dosage_instructions || 'Follow label'}. Results: ${p.results_timeline || '2-4 weeks'}.`
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

    // ── "Recommend" mode: build bundles ────────────────────────────────────
    if (!concern) {
      return NextResponse.json({ error: 'Missing concern' }, { status: 400, headers: cors })
    }

    // Collect available pack info for AI awareness
    const durationGroups = new Map<string, number[]>()
    for (const p of products) {
      const base = getProductBaseName(p.product_name)
      if (!durationGroups.has(base)) durationGroups.set(base, [])
      if (p.supply_days > 0 && !durationGroups.get(base)!.includes(p.supply_days)) {
        durationGroups.get(base)!.push(p.supply_days)
      }
    }

    const catalog = products.map(p => {
      const base = getProductBaseName(p.product_name)
      const durations = durationGroups.get(base) || []
      return `• ${p.product_name} (id: ${p.product_id}) — ₹${p.price_inr_min}–₹${p.price_inr_max}, ${p.supply_days}d supply, role: ${p.funnel_role}. Tags: ${p.health_issues || 'general'}. Pack durations: ${durations.join(', ')}d. Dosage: ${p.dosage_instructions || 'N/A'}. Results: ${p.results_timeline || 'N/A'}.`
    }).join('\n')

    const systemMsg =
      `You are a wellness sales specialist for StayOn Wellness (Ayurvedic supplements for men).\n\n` +
      `The user's main concern is: "${concern}"\n\n` +
      `PRODUCT CATALOG:\n${catalog}\n\n` +
      `CONVERSATION CONTEXT:\n${conversationHistory.slice(-8).map((m: any) => `${m.role}: ${m.content}`).join('\n')}\n\n` +
      `YOUR TASK:\n` +
      `1. Choose ONE primary product that best addresses the user's concern.\n` +
      `2. Optionally choose ONE supporting product (or null if not needed).\n` +
      `3. Write expected results text for 3 phases: trial (2 weeks), recommended (1-2 months), complete (3 months).\n` +
      `4. Write a warm, personalized 2-3 sentence response explaining why these products are right for them.\n` +
      `5. Provide 2-3 suggestion chips the user might want to ask next.\n\n` +
      `Respond in ${language === 'hi' ? 'Hindi (Devanagari)' : 'English'}.\n\n` +
      `Return EXACTLY this JSON structure:\n` +
      `{\n` +
      `  "primaryProductId": "exact_product_id",\n` +
      `  "supportingProductId": "exact_product_id_or_null",\n` +
      `  "response": "Your warm conversational message",\n` +
      `  "expectedResults": {\n` +
      `    "trial": "What to expect in the first 2 weeks",\n` +
      `    "recommended": "What to expect in 1-2 months",\n` +
      `    "complete": "What to expect in 3 months"\n` +
      `  },\n` +
      `  "chips": ["Suggestion 1", "Suggestion 2"]\n` +
      `}`

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemMsg }],
      temperature: 0.7,
      max_tokens: 600,
      response_format: { type: 'json_object' },
    })

    let parsed: any = {}
    try {
      parsed = JSON.parse(completion.choices[0]?.message?.content?.trim() || '{}')
    } catch { /* fallback */ }

    // Find products by ID
    const primaryProduct = products.find(p => p.product_id === parsed.primaryProductId) || products[0]
    const supportingProductId = parsed.supportingProductId || null

    const expectedResults = parsed.expectedResults || {
      trial: 'Initial improvements in energy and vitality.',
      recommended: 'Noticeable gains in stamina, energy, and overall wellness.',
      complete: 'Comprehensive transformation with sustained results.',
    }

    // Build bundles with intelligent pack combination
    const bundles = buildDurationBundles(
      primaryProduct.product_id,
      supportingProductId,
      products,
      shopifyCatalog,
      expectedResults
    )

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
      chips: Array.isArray(parsed.chips) ? parsed.chips : ['How should I take this?', 'Any side effects?', 'How soon will I see results?'],
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
