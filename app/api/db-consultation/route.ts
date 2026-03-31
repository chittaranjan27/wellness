/**
 * /api/db-consultation
 *
 * Database-driven conversational consultation endpoint.
 *
 * How it works:
 * 1. Fetches the consultative sales script + live product/pricing data from DB
 * 2. Loads conversation history (DB preferred, client fallback)
 * 3. Calls the LLM — one natural, conversational response per turn
 * 4. Detects if a product was mentioned → returns a price card for the UI sidebar
 * 5. Saves both messages with token usage metadata
 *
 * The LLM follows the 8-phase script in consultation-flow.service.ts
 * conversationally. No rigid node graph. No chip buttons.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getConsultationFlowPrompt } from '@/lib/consultation-flow.service'
import { OpenAI } from 'openai'
import { env } from '@/lib/env'
import { getLanguageByCode } from '@/lib/languages'

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
interface Product {
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
}

interface AgeSegment {
  segment_id: string
  recommended_product_id: string
}

interface HealthIssue {
  health_issue: string
  primary_product: string
  supporting_product: string | null
  target_age_group: string | null
  key_message: string | null
  urgency_level: string | null
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin')
  const cors = corsHeaders(origin)

  try {
    const body = await req.json()
    const {
      agentId,
      message,
      language = 'en',
      visitorId,
      sessionId,
      conversationHistory = [],
    } = body

    if (!agentId || !message) {
      return NextResponse.json({ error: 'Missing agentId or message' }, { status: 400, headers: cors })
    }

    // ── 1. Verify agent ────────────────────────────────────────────────────
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, name: true },
    })
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404, headers: cors })
    }

    // ── 2. Load consultation script + product data (cached 5 min) ─────────
    const [flowSystemPrompt, products, ageSegments, healthIssues] = await Promise.all([
      getConsultationFlowPrompt(),
      prisma.$queryRawUnsafe<Product[]>(`SELECT * FROM products ORDER BY product_id`),
      prisma.$queryRawUnsafe<AgeSegment[]>(`SELECT segment_id, recommended_product_id FROM age_segments`),
      prisma.$queryRawUnsafe<HealthIssue[]>(`SELECT * FROM health_issue_matrix ORDER BY id`),
    ])

    // ── 3. Load conversation history from DB ───────────────────────────────
    const msgWhere = sessionId
      ? { agentId, sessionId }
      : visitorId
        ? { agentId, visitorId }
        : { agentId }

    const dbMessages = await prisma.chatMessage.findMany({
      where: msgWhere,
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { role: true, content: true },
    })

    // DB history takes priority; fall back to client-provided history
    const history: Array<{ role: 'user' | 'assistant'; content: string }> =
      dbMessages.length > 0
        ? dbMessages.reverse().map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
        : (conversationHistory as Array<{ role: 'user' | 'assistant'; content: string }>)

    // ── 4. Build system prompt ─────────────────────────────────────────────
    const langInfo = getLanguageByCode(language)
    const languageName = langInfo?.openaiLanguage || 'English'
    const systemPrompt = buildSystemPrompt(flowSystemPrompt, language, languageName)

    // ── 5. Call LLM ────────────────────────────────────────────────────────
    const llmMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: message },
    ]

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: llmMessages as any,
      temperature: 0.7,
      max_tokens: 700,
      response_format: { type: "json_object" }
    })

    const rawResponse = completion.choices[0]?.message?.content?.trim() || '{}'
    const usage = completion.usage

    let parsedResponse: any = { response: rawResponse, recommended_products: [], options: [] }
    try {
      parsedResponse = JSON.parse(rawResponse)
    } catch (e) {
      console.error('[db-consultation] Failed to parse JSON response:', e)
    }

    const responseText = parsedResponse.response || rawResponse || ''
    const recommendedProducts = Array.isArray(parsedResponse.recommended_products) ? parsedResponse.recommended_products : []
    const suggestions = Array.isArray(parsedResponse.options) ? parsedResponse.options : []

    // ── 6b. Detect product mention → return price card ────────────────
    const productCard = detectProductCard(responseText, products, ageSegments, history, message)

    // ── 6c. Detect context-relevant products from conversation ─────────
    const contextProducts = detectContextProducts(
      [...history, { role: 'user', content: message }, { role: 'assistant', content: responseText }],
      products,
      healthIssues,
      ageSegments
    )

    // ── 7. Save messages to DB ────────────────────────────────────────────
    try {
      await prisma.chatMessage.createMany({
        data: [
          {
            agentId,
            sessionId: sessionId || null,
            visitorId: visitorId || null,
            role: 'user',
            content: message,
            metadata: { source: 'consultation' } as any,
          },
          {
            agentId,
            sessionId: sessionId || null,
            visitorId: visitorId || null,
            role: 'assistant',
            content: responseText,
            metadata: {
              source: 'consultation',
              promptTokens: usage?.prompt_tokens,
              completionTokens: usage?.completion_tokens,
              totalTokens: usage?.total_tokens,
            } as any,
          },
        ],
      })
    } catch (saveErr) {
      console.error('[db-consultation] Failed to save messages:', saveErr)
    }

    // ── 8. Return response ────────────────────────────────────────
    return NextResponse.json(
      {
        response: responseText,
        product: productCard,
        contextProducts: contextProducts.length > 0 ? contextProducts : undefined,
        recommendedProducts: recommendedProducts.length > 0 ? recommendedProducts : undefined,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
        tokenUsage: {
          prompt: usage?.prompt_tokens ?? 0,
          completion: usage?.completion_tokens ?? 0,
          total: usage?.total_tokens ?? 0,
        },
      },
      { headers: cors }
    )
  } catch (error) {
    console.error('[db-consultation] Error:', error)
    return NextResponse.json(
      {
        error: 'Consultation failed',
        details: error instanceof Error ? error.message : 'Unknown',
      },
      { status: 500, headers: cors }
    )
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the full system prompt:
 * - One-line brand header with language instruction
 * - Full consultative sales script from DB
 * - Response rules (one message at a time, include price, etc.)
 */
function buildSystemPrompt(
  flowPrompt: string,
  language: string,
  languageName: string
): string {
  let prompt =
    `You are a professional, empathetic wellness sales consultant for StayOn Wellness. ` +
    `Your goal is to guide men toward the right Ayurvedic supplement through genuine, caring conversation.\n\n`

  // ── Strict language enforcement ──────────────────────────────────────
  if (language === 'hi') {
    prompt +=
      `LANGUAGE RULE (MANDATORY — NEVER BREAK THIS):\n` +
      `The user chose Hindi. You MUST respond ENTIRELY in Hindi (Devanagari script) for the ENTIRE conversation.\n` +
      `• Every response must be in Hindi. Do NOT switch to English even if the user types in English.\n` +
      `• Only exception: product names, brand names ("StayOn"), and prices (₹) may stay in English.\n` +
      `• Use warm Hindi words like "ji", "bhai", "theek hai" naturally.\n` +
      `• NEVER mix Hindi and English sentences.\n\n`
  } else {
    prompt +=
      `LANGUAGE RULE (MANDATORY — NEVER BREAK THIS):\n` +
      `The user chose English. You MUST respond ENTIRELY in English for the ENTIRE conversation.\n` +
      `• Every response must be in English. Do NOT switch to Hindi even if the user types in Hindi.\n` +
      `• You may use "Namaste" as greeting and sprinkle "ji" or "bhai" for cultural warmth, but content stays English.\n` +
      `• NEVER write full sentences in Hindi.\n\n`
  }

  prompt += flowPrompt

  prompt +=
    `\n\n——————————————————————————\n` +
    `RESPONSE FORMAT RULES:\n` +
    `• You MUST respond with a perfectly valid JSON object.\n` +
    `• Write the "response" property as plain, conversational prose — no bullet points, no numbered lists.\n` +
    `• Maximum 3–4 sentences per response (Phase 4 product recommendations and Phase 6 guidance may be slightly longer).\n` +
    `• When recommending a product, ALWAYS include its exact ₹ price from the PRODUCT CATALOG.\n` +
    `• End every response with a single, clear next question or action — never leave the user hanging.\n\n` +
    `JSON STRUCTURE REQUIRED:\n` +
    `{\n` +
    `  "response": "Your conversational text here",\n` +
    `  "recommended_products": ["Exact Product Name 1", "Exact Product Name 2"],\n` +
    `  "options": [\n` +
    `    { "label": "Short label", "prompt": "Full first-person text" },\n` +
    `    { "label": "Short label 2", "prompt": "Full first-person text 2" }\n` +
    `  ]\n` +
    `}\n\n` +
    `Rules for "options" array:\n` +
    `• Provide 2–4 highly contextual, stage-appropriate reply options the user might pick based EXACTLY on what you just said in the "response".\n` +
    `• Write them from the USER's first-person perspective (e.g. "Yes, I'd like to try it").\n` +
    `• Keep each label under 5 words.\n` +
    `• Options MUST match the user's selected language exactly (e.g. Hindi user = Hindi options, English user = English options).\n` +
    `• Include a mix of agreeable answers and hesitating or curious follow-up questions.\n\n` +
    `Rules for "recommended_products" array:\n` +
    `• ONLY list exact product names from the PRODUCT CATALOG if you are actively recommending them in this specific turn.\n` +
    `• Otherwise, it should be an empty array [].\n`

  return prompt
}

/**
 * Scan the LLM's response for product name mentions.
 * Returns a formatted price card if a product is identified.
 * Also checks the conversation history for age clues to infer the right product.
 */
function detectProductCard(
  responseText: string,
  products: Product[],
  ageSegments: AgeSegment[],
  history: Array<{ role: string; content: string }>,
  userMessage: string
): object | null {
  const lowerResp = responseText.toLowerCase()

  // Direct product name match in the response
  for (const product of products) {
    if (lowerResp.includes(product.product_name.toLowerCase())) {
      return formatCard(product)
    }
  }

  // Infer from age segment mention
  const allText = [...history.map((m) => m.content), userMessage, responseText]
    .join(' ')
    .toLowerCase()

  const agePatterns: Record<string, string[]> = {
    '24-35': ['24', '25', '26', '27', '28', '29', '30', '31', '32', '33', '34', '35', '24–35', '24-35'],
    '35-45': ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '35–45', '35-45'],
    '45-55': ['46', '47', '48', '49', '50', '51', '52', '53', '54', '55', '45–55', '45-55'],
    '55+': ['56', '57', '58', '59', '60', '61', '62', '63', '64', '65', '55+'],
  }

  for (const [_range, keywords] of Object.entries(agePatterns)) {
    if (keywords.some((kw) => allText.includes(kw))) {
      // Find recommended product for this age segment
      const seg = ageSegments.find((s) =>
        keywords.some((kw) => s.segment_id?.toLowerCase().includes(kw) || _range.includes(kw))
      )
      if (seg) {
        const recommended = products.find((p) => p.product_id === seg.recommended_product_id)
        if (recommended) return formatCard(recommended)
      }
      break
    }
  }

  return null
}

function formatCard(product: Product): object {
  const priceDisplay =
    product.price_inr_min === product.price_inr_max
      ? `₹${product.price_inr_min}`
      : `₹${product.price_inr_min} – ₹${product.price_inr_max}`

  const discountNote =
    product.discount_eligible && product.discount_pct
      ? ` · Save ${product.discount_pct}% on bundle`
      : ''

  return {
    id: product.product_id,
    title: product.product_name,
    price: `${priceDisplay}${discountNote}`,
    priceMin: product.price_inr_min,
    priceMax: product.price_inr_max,
    supplyDays: product.supply_days,
    capsuleCount: product.capsule_count,
    dailyDose: product.daily_dose_caps,
    market: product.market,
    funnel_role: product.funnel_role,
    imageUrl: product.image_url || null,
    url: product.shopify_url || '',
  }
}

/**
 * Analyze full conversation context and return relevant products based on
 * keyword detection and health issue matrix matching.
 * Products are scored by relevance — the most matching concerns appear first.
 * Returns formatted product cards with image/url for the UI panel.
 */
function detectContextProducts(
  messages: Array<{ role: string; content: string }>,
  products: Product[],
  healthIssues: HealthIssue[],
  ageSegments: AgeSegment[]
): object[] {
  // Build one big lowercase text from the entire conversation
  const allText = messages.map((m) => m.content).join(' ').toLowerCase()

  // ── Keyword → concern mapping ─────────────────────────────────────────
  // Each concern group contains keywords that signal a particular health issue
  const concernKeywords: Record<string, string[]> = {
    energy: ['energy', 'tired', 'fatigue', 'exhausted', 'weak', 'weakness', 'lethargy', 'lethargic', 'drained', 'low energy', 'no energy', 'ऊर्जा', 'थकान', 'کم توانائی', 'تھکاوٹ'],
    stamina: ['stamina', 'endurance', 'fitness', 'performance', 'workout', 'exercise', 'physical', 'strength', 'स्टैमिना', 'شکتی', 'اسٹیمینا'],
    stress: ['stress', 'anxiety', 'tension', 'nervous', 'overwhelmed', 'panic', 'worried', 'burnout', 'तनाव', 'चिंता', 'ذہنی دباؤ'],
    sleep: ['sleep', 'insomnia', 'sleepless', 'restless', 'can\'t sleep', 'poor sleep', 'nighttime', 'नींद', 'नहीं आती', 'نیند'],
    hair: ['hair', 'hair fall', 'hair loss', 'baldness', 'thinning', 'receding', 'scalp', 'बाल', 'बालों का झड़ना', 'بال'],
    diabetes: ['diabetes', 'blood sugar', 'sugar level', 'diabetic', 'glucose', 'insulin', 'मधुमेह', 'शुगर', 'ذیابیطس', 'شوگر'],
    intimate: ['intimate', 'confidence', 'bedroom', 'libido', 'desire', 'sexual', 'performance anxiety', 'erectile', 'आत्मविश्वास', 'اعتماد'],
    weight: ['weight', 'obesity', 'overweight', 'body fat', 'belly', 'metabolism', 'वजन', 'موٹاپا'],
    joints: ['joint', 'knee', 'back pain', 'arthritis', 'stiffness', 'जोड़', 'घुटना', 'کمر درد'],
    recovery: ['recovery', 'healing', 'post-surgery', 'convalescence', 'rehab', 'रिकवरी', 'بحالی'],
  }

  // ── Score each concern based on keyword matches ───────────────────────
  const concernScores = new Map<string, number>()
  for (const [concern, keywords] of Object.entries(concernKeywords)) {
    let score = 0
    for (const kw of keywords) {
      // Count occurrences — more mentions = stronger signal
      const regex = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
      const matches = allText.match(regex)
      if (matches) score += matches.length
    }
    if (score > 0) concernScores.set(concern, score)
  }

  // No concerns detected yet — too early in conversation
  if (concernScores.size === 0) return []

  // Sort concerns by score (highest first)
  const rankedConcerns = [...concernScores.entries()].sort((a, b) => b[1] - a[1])

  // ── Match concerns to products via health issue matrix ────────────────
  const matchedProductIds = new Set<string>()
  const productScores = new Map<string, number>()

  for (const [concern, score] of rankedConcerns) {
    // Find health issues that match this concern
    for (const hi of healthIssues) {
      const issueText = hi.health_issue.toLowerCase()
      const keyMessage = (hi.key_message || '').toLowerCase()

      // Check if this health issue relates to the detected concern
      const relatedKeywords = concernKeywords[concern] || []
      const isMatch = relatedKeywords.some(
        (kw) => issueText.includes(kw) || keyMessage.includes(kw)
      )

      if (isMatch) {
        // Find the primary product
        const primaryProduct = products.find(
          (p) => p.product_name.toLowerCase() === hi.primary_product.toLowerCase() ||
            p.product_id.toLowerCase() === hi.primary_product.toLowerCase()
        )
        if (primaryProduct) {
          matchedProductIds.add(primaryProduct.product_id)
          productScores.set(
            primaryProduct.product_id,
            (productScores.get(primaryProduct.product_id) || 0) + score
          )
        }

        // Also add supporting product if available
        if (hi.supporting_product && hi.supporting_product !== '—' && hi.supporting_product !== '-') {
          const supportProduct = products.find(
            (p) => p.product_name.toLowerCase() === hi.supporting_product!.toLowerCase() ||
              p.product_id.toLowerCase() === hi.supporting_product!.toLowerCase()
          )
          if (supportProduct) {
            matchedProductIds.add(supportProduct.product_id)
            productScores.set(
              supportProduct.product_id,
              (productScores.get(supportProduct.product_id) || 0) + Math.ceil(score * 0.6)
            )
          }
        }
      }
    }

    // Also check direct product name mentions in conversation
    for (const product of products) {
      if (allText.includes(product.product_name.toLowerCase())) {
        matchedProductIds.add(product.product_id)
        productScores.set(
          product.product_id,
          (productScores.get(product.product_id) || 0) + 10 // High score for direct mention
        )
      }
    }
  }

  // ── Also match by age segment ─────────────────────────────────────────
  const agePatterns: Record<string, string[]> = {
    '24-35': ['24', '25', '26', '27', '28', '29', '30', '31', '32', '33', '34', '35'],
    '35-45': ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45'],
    '45-55': ['46', '47', '48', '49', '50', '51', '52', '53', '54', '55'],
    '55+': ['56', '57', '58', '59', '60', '61', '62', '63', '64', '65'],
  }

  for (const [_range, ageKws] of Object.entries(agePatterns)) {
    if (ageKws.some((kw) => allText.includes(kw))) {
      const seg = ageSegments.find((s) =>
        ageKws.some((kw) => s.segment_id?.toLowerCase().includes(kw) || _range.includes(kw))
      )
      if (seg) {
        const recommended = products.find((p) => p.product_id === seg.recommended_product_id)
        if (recommended) {
          matchedProductIds.add(recommended.product_id)
          productScores.set(
            recommended.product_id,
            (productScores.get(recommended.product_id) || 0) + 3 // Moderate score for age match
          )
        }
      }
      break
    }
  }

  // No products matched
  if (matchedProductIds.size === 0) return []

  // ── Sort by relevance score and return formatted cards ────────────────
  const matchedProducts = products
    .filter((p) => matchedProductIds.has(p.product_id))
    .sort((a, b) => (productScores.get(b.product_id) || 0) - (productScores.get(a.product_id) || 0))

  return matchedProducts.map((p) => formatCard(p))
}



