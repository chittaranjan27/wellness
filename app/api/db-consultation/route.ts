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
    const [flowSystemPrompt, products, ageSegments] = await Promise.all([
      getConsultationFlowPrompt(),
      prisma.$queryRawUnsafe<Product[]>(`SELECT * FROM products ORDER BY product_id`),
      prisma.$queryRawUnsafe<AgeSegment[]>(`SELECT segment_id, recommended_product_id FROM age_segments`),
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
    })

    const rawResponse = completion.choices[0]?.message?.content?.trim() || ''
    const usage = completion.usage

    // ── 6a. Extract [OPTIONS] block from LLM response ─────────────────────
    const { cleanText: responseText, suggestions } = parseOptionsFromResponse(rawResponse)

    // ── 6b. Detect product mention → return price card ────────────────────
    const productCard = detectProductCard(responseText, products, ageSegments, history, message)

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

    // ── 8. Return response ────────────────────────────────────────────────
    return NextResponse.json(
      {
        response: responseText,
        product: productCard,
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

  if (language !== 'en') {
    prompt += `LANGUAGE: Respond entirely in ${languageName}. Never switch to another language mid-conversation.\n\n`
  }

  prompt += flowPrompt

  prompt +=
    `\n\n——————————————————————————\n` +
    `RESPONSE FORMAT RULES:\n` +
    `• Write in plain, conversational prose — no bullet points, no numbered lists, no markdown headings.\n` +
    `• Maximum 3–4 sentences per response (Phase 4 product recommendations and Phase 6 guidance may be slightly longer).\n` +
    `• When recommending a product, ALWAYS include its exact ₹ price from the PRODUCT CATALOG.\n` +
    `• When sharing a testimonial, weave it naturally into the conversation — don't present it as a list item.\n` +
    `• End every response with a single, clear next question or action — never leave the user hanging.\n` +
    `• Never say "Moving to Phase X" or reference the consultation script internally.\n\n` +
    `CLICKABLE OPTIONS (MANDATORY):\n` +
    `After EVERY response, provide 2–4 suggested reply options the user might pick.\n` +
    `Write them from the USER's first-person perspective (e.g. "Yes, I'd like to try it" not "Try the product").\n` +
    `Wrap them in an [OPTIONS] block at the very end, exactly like this:\n` +
    `[OPTIONS]\n` +
    `Option 1 text\n` +
    `Option 2 text\n` +
    `Option 3 text\n` +
    `[/OPTIONS]\n\n` +
    `Rules for options:\n` +
    `• Keep each option under 8 words — short and tappable.\n` +
    `• Include a mix: at least one agreeing answer and one that asks for more info or shows hesitation.\n` +
    `• Match the conversation language (Hindi options if responding in Hindi, etc.).\n` +
    `• NEVER skip the [OPTIONS] block.`

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
 * Parse suggested reply options from the LLM's raw response.
 *
 * The model may wrap them in [OPTIONS]…[/OPTIONS], or it might produce
 * a trailing numbered/bulleted list prefixed by "Options:", "**Options:**",
 * or similar.  This function tries multiple patterns and returns the first
 * match so we reliably strip the options from the visible text and surface
 * them as clickable chips.
 */
function parseOptionsFromResponse(raw: string): {
  cleanText: string
  suggestions: Array<{ label: string; prompt: string }>
} {
  // ── Pattern 1: explicit [OPTIONS] … [/OPTIONS] block ─────────────────
  const bracketRegex = /\[OPTIONS\]\s*([\s\S]*?)\s*\[\/OPTIONS\]/i
  const bracketMatch = raw.match(bracketRegex)
  if (bracketMatch) {
    const cleanText = raw.replace(bracketRegex, '').trim()
    const suggestions = extractLines(bracketMatch[1])
    if (suggestions.length > 0) return { cleanText, suggestions }
  }

  // ── Pattern 2: "Options:" / "**Options:**" header followed by list ───
  // Matches "Options:", "**Options**:", "**Options:**", etc. at the start of a line
  const headerRegex = /\n\s*\*{0,2}Options\*{0,2}\s*:?\s*\n([\s\S]+)$/i
  const headerMatch = raw.match(headerRegex)
  if (headerMatch) {
    const cleanText = raw.replace(headerRegex, '').trim()
    const suggestions = extractLines(headerMatch[1])
    if (suggestions.length > 0) return { cleanText, suggestions }
  }

  // ── Pattern 3: trailing numbered list (1. / 2. / 3. …) at the end ───
  // Only if the last 2-5 lines are all numbered items
  const lines = raw.split('\n')
  let trailingStart = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const stripped = lines[i].trim()
    if (!stripped) continue // skip blank trailing lines
    if (/^\d+[.)]\s+.+/.test(stripped)) {
      trailingStart = i
    } else {
      break
    }
  }
  if (trailingStart >= 0) {
    const trailingLines = lines.slice(trailingStart)
    const suggestions = extractLines(trailingLines.join('\n'))
    if (suggestions.length >= 2 && suggestions.length <= 6) {
      const cleanText = lines.slice(0, trailingStart).join('\n').trim()
      return { cleanText, suggestions }
    }
  }

  // ── No options found ─────────────────────────────────────────────────
  return { cleanText: raw, suggestions: [] }
}

/** Shared helper: split a block of text into clean option entries. */
function extractLines(block: string): Array<{ label: string; prompt: string }> {
  return block
    .split('\n')
    .map((line) =>
      line
        .replace(/^[-•*▸▹►➤●○◦\d.)\]\s]+/, '') // strip bullets, numbers, brackets
        .replace(/^\*\*(.+?)\*\*$/, '$1')         // strip bold markdown
        .trim()
    )
    .filter((line) => line.length > 0 && line.length < 120)
    .map((opt) => ({ label: opt, prompt: opt }))
}

