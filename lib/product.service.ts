import { Document } from '@prisma/client'
import { OpenAI } from 'openai'
import { env } from './env'

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
})

/**
 * In-memory cache for product recommendations by agent and consultation context.
 * Stores products with their associated conditions/issues for reuse across similar consultations.
 */
type CachedProductRecommendations = {
  products: ProductResult[]
  conditions: string[]
  recommendedNames: string[]
  cachedAt: number
  agentId: string
}

const productRecommendationCache = new Map<string, CachedProductRecommendations[]>() // agentId -> array of cached recommendations
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000 // 7 days in milliseconds
const MAX_CACHE_ENTRIES_PER_AGENT = 50 // Limit cache size per agent

export type ProductResult = {
  id: string
  title: string | null
  description: string | null
  price: string | null
  url: string
  imageUrl: string | null
  features: string[]
  relevanceScore?: number
}

export type ProductSource = Pick<Document, 'id' | 'filepath' | 'filename' | 'extractedText'>

/**
 * Detect if user is asking about products or showing purchase intent
 */
export const isProductRequest = (text: string) => {
  const lower = text.toLowerCase()

  const keywords = [
    'product', 'products', 'item', 'items',
    'details', 'detail', // e.g. "product details", "give me the details"
    'buy', 'purchase', 'shop', 'shopping',
    'price', 'cost', 'pricing',
    'link', 'links', 'url',
    'recommend', 'recommendation', 'suggest', 'suggestion',
    'list', 'show', 'find', 'search',
    'available', 'offer', 'offering',
    'catalog', 'catalogue'
  ]

  return keywords.some(keyword => lower.includes(keyword))
}

/**
 * Detect if user is accepting the assistant's offer to show products.
 * Matches against the exact Stage D phrasing: "Would you like me to show you what we recommend for you?"
 * Also matches chips: "Yes, show me" and common affirmations after a product offer.
 */
export function isAcceptingProductOffer(userMessage: string, lastAssistantMessage: string | null): boolean {
  if (!userMessage || typeof userMessage !== 'string') return false
  const msg = userMessage.trim().toLowerCase()

  // Direct chip click — "Yes, show me" is the exact Stage D chip label
  if (msg === 'yes, show me' || msg === 'yes show me') return true

  const shortAffirmations = ['yes', 'yeah', 'yep', 'sure', 'please', 'ok', 'okay', 'show me', 'show them', 'sounds good', 'go ahead']
  const isAffirmation = msg.length <= 50 && shortAffirmations.some(a => msg === a || msg.startsWith(a + ' ') || msg.startsWith(a + ',') || msg.startsWith(a + '.'))
  if (!isAffirmation) return false
  if (!lastAssistantMessage || typeof lastAssistantMessage !== 'string') return false
  const last = lastAssistantMessage.toLowerCase()

  // Match against the actual Stage D phrasing and common variations
  const offeredProducts =
    last.includes('recommend for you') ||            // Stage D: "what we recommend for you"
    last.includes('recommend for your') ||            // variation
    last.includes('show you what we recommend') ||    // Stage D full phrase
    last.includes('suitable products') ||             // legacy phrasing
    last.includes('recommended products') ||          // variation
    last.includes('i can show you') ||                // variation
    (last.includes('show you') && last.includes('product')) ||  // "show you...products"
    (last.includes('would you like') && last.includes('recommend')) // "would you like me to...recommend"
  return offeredProducts
}

/**
 * Known consultation concern categories from Stage A of the consultation flow.
 * These are the exact options presented to the user.
 */
const KNOWN_CONCERNS: { keywords: string[]; label: string }[] = [
  { keywords: ['low energy', 'fatigue', 'tired', 'exhausted', 'no energy', 'weakness', 'lethargy'], label: 'Low energy & fatigue' },
  { keywords: ['stamina', 'performance', 'endurance', 'lasting longer', 'timing', 'physical activity'], label: 'Stamina & performance' },
  { keywords: ['confidence', 'intimate', 'bedroom', 'erection', 'ed', 'premature', 'intimate wellness'], label: 'Confidence & intimate wellness' },
  { keywords: ['diabetes', 'sugar', 'blood sugar', 'insulin', 'glucose', 'diabetic'], label: 'Diabetes / Blood sugar' },
  { keywords: ['strength', 'recovery', 'muscle', 'gym', 'body building', 'fitness', 'general strength'], label: 'General strength & recovery' },
]

/**
 * Detect the specific consultation concern selected by the user in Stage A.
 * Scans conversation history for concern selection (button click or natural language).
 * Returns the matched concern label or null if not found.
 */
function detectSelectedConcern(
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>
): string | null {
  if (conversationHistory.length === 0) return null

  // Check early user messages (Stage A selection is typically in the first 1-4 user messages)
  const userMessages = conversationHistory
    .filter((m) => m.role === 'user')
    .slice(0, 5) // Only check early messages for concern selection

  for (const msg of userMessages) {
    const lower = msg.content.toLowerCase().trim()

    // 1. Exact match against known concern labels (user clicked a button)
    for (const concern of KNOWN_CONCERNS) {
      if (lower === concern.label.toLowerCase()) return concern.label
    }

    // 2. Keyword match for natural-language descriptions
    for (const concern of KNOWN_CONCERNS) {
      const matchCount = concern.keywords.filter((kw) => lower.includes(kw)).length
      // Require at least one keyword match, prefer more specific matches
      if (matchCount >= 1) return concern.label
    }
  }

  return null
}

/**
 * Extract user problems, concerns, issues, and conditions from report or conversation.
 * PRIORITY ORDER:
 * 1. Specific concern selected in Stage A of the consultation flow
 * 2. Presenting concerns from the consultation report
 * 3. Assessment problems from the report
 * 4. Keyword extraction from conversation (fallback)
 *
 * This identifies the specific issues discussed during consultation for precise product matching.
 */
function extractUserProblems(reportData?: any, conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []): string[] {
  const problems: string[] = []

  // HIGHEST PRIORITY: Detect the specific concern selected during Stage A
  const selectedConcern = detectSelectedConcern(conversationHistory)
  if (selectedConcern) {
    problems.push(selectedConcern)
    console.log(`[ProductService] Detected selected concern: "${selectedConcern}"`)
  }

  if (reportData) {
    // Extract from presenting concerns (primary issues)
    if (reportData.presentingConcerns && Array.isArray(reportData.presentingConcerns)) {
      problems.push(...reportData.presentingConcerns)
    }

    // Extract from assessment problems (identified issues)
    if (reportData.assessment?.problems && Array.isArray(reportData.assessment.problems)) {
      problems.push(...reportData.assessment.problems)
    }

    // Extract from client history (conditions mentioned)
    if (reportData.clientHistory && typeof reportData.clientHistory === 'string') {
      const historyText = reportData.clientHistory
      const conditionKeywords = ['condition', 'diagnosis', 'symptom', 'issue', 'problem', 'disorder', 'disease', 'syndrome']
      const sentences = historyText.split(/[.!?]+/).filter((s: string) => s.trim().length > 15)
      sentences.forEach((sentence: string) => {
        if (conditionKeywords.some(keyword => sentence.toLowerCase().includes(keyword))) {
          problems.push(sentence.trim())
        }
      })
    }

    // Fallback to old structure
    if (reportData.problems && Array.isArray(reportData.problems)) {
      problems.push(...reportData.problems)
    }
  }

  // If no report data and no selected concern, extract from conversation
  if (problems.length === 0 && conversationHistory.length > 0) {
    const userMessages = conversationHistory
      .filter((msg) => msg.role === 'user')
      .map((msg) => msg.content)
      .join(' ')
    if (userMessages) {
      // Use targeted health-concern keywords (removed overly broad words like 'need', 'want', 'back')
      const concernKeywords = [
        'problem', 'issue', 'concern', 'symptom', 'pain', 'difficulty', 'struggle',
        'condition', 'diagnosis', 'suffering', 'experiencing',
        'headache', 'stress', 'sleep', 'anxiety', 'digestion', 'energy', 'fatigue',
        'mood', 'focus', 'recovery', 'immunity', 'inflammation', 'weight', 'fitness', 'strength',
        'stamina', 'performance', 'confidence', 'intimate', 'diabetes', 'blood sugar',
        'tired', 'exhausted', 'weakness', 'endurance'
      ]
      const sentences = userMessages.split(/[.!?]+/).filter((s: string) => s.trim().length > 10)
      sentences.forEach((sentence: string) => {
        if (concernKeywords.some((keyword) => sentence.toLowerCase().includes(keyword))) {
          problems.push(sentence.trim())
        }
      })
      // Also add longer user messages if no keywords matched
      if (problems.length === 0 && userMessages.trim().length > 30) {
        problems.push(userMessages.slice(0, 300).trim())
      }
    }
  }

  return [...new Set(problems.filter((p) => p && p.trim().length > 0))]
}

/** Titles that indicate a category/general page, not a specific product. Never show these in the catalog. */
const PAGE_OR_CATEGORY_TITLES = [
  /^Shop$/i,
  /^Wishlist$/i,
  /^Cart$/i,
  /^Account$/i,
  /^Login$/i,
  /^Register$/i,
  /^Vedaone$/i,           // category/brand page name only
  /^Beauty$/i,
  /^Health$/i,
  /^Wellness$/i,
  /^Offers?$/i,
  /^Brands$/i,
  /Your Wellness Wishlist/i,
  /Save Your Favorite/i,
  /Stock status/i,
  /No products added/i,
  /Useful links/i,
  /Quick Links/i,
  /All Products/i,
  /^About\s/i,
  /^Contact\s/i,
  /Return to Shop/i,
  /Continue Shopping/i,
]

function isPageOrCategoryTitle(title: string | null): boolean {
  if (!title || title.length < 2) return true
  const t = title.trim()
  return PAGE_OR_CATEGORY_TITLES.some((re) => re.test(t))
}

const PRICE_EXCLUSION_PATTERN = /(sale|discount|original|was|old price|compare at|regular price|save|list price|markdown)/i
const CURRENT_PRICE_HINT_PATTERN = /(current price|price\s*[:=]|our price|final price)/i

function isExcludedPriceContext(context: string): boolean {
  return PRICE_EXCLUSION_PATTERN.test(context)
}

function extractCurrentPrice(text: string): string | null {
  const currencyPattern = /(د\.إ|AED|USD|EUR|GBP|\$)\s*[\d,]+(?:\.\d{2})?/gi
  let match: RegExpExecArray | null
  const candidates: Array<{ value: string; score: number }> = []
  while ((match = currencyPattern.exec(text)) !== null) {
    const value = match[0].trim()
    const start = Math.max(0, match.index - 40)
    const end = Math.min(text.length, match.index + value.length + 40)
    const context = text.slice(start, end).toLowerCase()
    if (isExcludedPriceContext(context)) {
      continue
    }
    const score = CURRENT_PRICE_HINT_PATTERN.test(context) ? 2 : 1
    candidates.push({ value, score })
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0].value
}

/**
 * Extract multiple products from a listing/category page (e.g. shop page with many products).
 * Parses price patterns to extract product titles dynamically from website content.
 * Excludes page/category titles (Shop, Wishlist, etc.).
 */
function extractMultipleProductsFromListing(doc: ProductSource): Partial<ProductResult>[] {
  if (!doc.extractedText) return []

  const text = doc.extractedText
  const urlMatch = doc.filepath?.match(/^(https?:\/\/[^\s]+)/i)
  const baseUrl = urlMatch ? urlMatch[1] : (doc.filepath || '')
  const results: Partial<ProductResult>[] = []
  const seenTitles = new Set<string>()
  const titleToIndex = new Map<string, number>()

  function addProduct(rawTitle: string, priceStr: string, matchIndex: number) {
    let title = rawTitle
      .replace(/\s*(?:Original price was:.*|Current price is:.*|Add to cart).*$/i, '')
      .trim()
    if (!title || title.length < 3) return
    if (title.length > 200) return
    if (isPageOrCategoryTitle(title)) return
    if (/^(Only|Warehouse|contact@|Privacy|Disclaimer|Return Policy|Terms|Quick Links|login|Register|Account|Wishlist|Orders|Cart|Shop|→|1 2 3|price:)/i.test(title)) return

    const contextStart = Math.max(0, matchIndex - 40)
    const contextEnd = Math.min(text.length, matchIndex + priceStr.length + 40)
    const context = text.slice(contextStart, contextEnd)
    if (isExcludedPriceContext(context)) {
      return
    }

    const price = priceStr.includes('.') ? priceStr : `${priceStr}.00`
    const displayPrice = /د\.إ|AED/i.test(text) ? `د.إ ${price}` : `AED ${price}`

    // If title is a bundle (contains "+"), split into separate products
    const parts = title.split(/\s*\+\s*/).map((s) => s.trim()).filter((s) => s.length >= 3)
    const titlesToAdd = parts.length > 1 ? parts : [title]

    for (const t of titlesToAdd) {
      if (t.length > 120) continue
      const norm = t.toLowerCase().replace(/\s+/g, ' ').slice(0, 80)
      if (seenTitles.has(norm)) {
        const existingIndex = titleToIndex.get(norm)
        if (existingIndex !== undefined) {
          const existing = results[existingIndex]
          const current = (existing.price || '').replace(/[^\d.]/g, '')
          const next = price.replace(/[^\d.]/g, '')
          const currentNum = current ? Number(current) : NaN
          const nextNum = next ? Number(next) : NaN
          // Prefer lower price (often current sale price) or latest if current is missing
          if (!Number.isNaN(nextNum) && (Number.isNaN(currentNum) || nextNum <= currentNum)) {
            existing.price = displayPrice
          }
        }
        continue
      }
      seenTitles.add(norm)
      titleToIndex.set(norm, results.length)
      results.push({
        id: `${doc.id}-${results.length}`,
        title: t.slice(0, 200),
        description: null,
        price: displayPrice,
        url: baseUrl,
        imageUrl: null,
        features: [],
        docId: doc.id,
        docText: doc.extractedText ?? undefined,
      } as Partial<ProductResult> & { docId?: string; docText?: string })
    }
  }

  // UAE dirham (د.إ) - common in logs
  let m: RegExpExecArray | null
  const re1 = /(.+?)\s*د\.إ\s*([\d,]+\.?\d*)/g
  while ((m = re1.exec(text)) !== null) {
    addProduct((m[1] || '').trim(), (m[2] || '').trim(), m.index)
  }
  // AED
  const re2 = /(.+?)\s*AED\s*([\d,]+\.?\d*)/gi
  while ((m = re2.exec(text)) !== null) {
    addProduct((m[1] || '').trim(), (m[2] || '').trim(), m.index)
  }
  // $ price
  const re3 = /(.+?)\s*\$\s*([\d,]+\.?\d*)/g
  while ((m = re3.exec(text)) !== null) {
    addProduct((m[1] || '').trim(), (m[2] || '').trim(), m.index)
  }

  return results
}

/**
 * Extract product information from document text (single product per document).
 */
function extractProductInfo(doc: ProductSource): Partial<ProductResult> | null {
  if (!doc.extractedText) return null

  const text = doc.extractedText

  // Extract title - try multiple patterns
  let title: string | null = null
  const titlePatterns = [
    /(?:title|name|product|item)[:\s]+([^\n\r]+)/i,
    /<h[1-3][^>]*>([^<]+)<\/h[1-3]>/i,
    /^#+\s*([^\n]+)/m,
    /"([^"]{10,100})"/, // Quoted text that might be a title
  ]
  for (const pattern of titlePatterns) {
    const match = text.match(pattern)
    if (match && match[1] && match[1].trim().length > 3) {
      title = match[1].trim()
      break
    }
  }
  if (!title && doc.filename) {
    title = doc.filename.replace(/\.[^.]*$/, '') // Remove extension
  }

  // Extract price - only keep current/final price (skip sale/old/discount)
  let price: string | null = extractCurrentPrice(text)
  if (!price) {
    const pricePatterns = [
      /(?:current price is|our price|final price)[:\s]*([A-Z]{0,3}\s*[\d,]+(?:\.\d{2})?)/i,
      /(?:price|cost|pricing)[:\s]+([^\n\r]+)/i,
      /\$[\d,]+(?:\.\d{2})?/,
      /(?:USD|EUR|GBP|INR|د\.إ|AED)\s*[\d,]+(?:\.\d{2})?/i,
      /[\d,]+(?:\.\d{2})?\s*(?:USD|EUR|GBP|INR|dollars?|euros?|rupees?)/i,
    ]
    for (const pattern of pricePatterns) {
      const match = text.match(pattern)
      if (match) {
        const candidate = (match[1] || match[0]).trim()
        if (isExcludedPriceContext(candidate)) continue
        price = candidate.substring(0, 50) // Avoid huge blob
        break
      }
    }
  }

  // Extract description
  let description: string | null = null
  const descPatterns = [
    /(?:description|details|about|overview)[:\s]+([^\n\r]{20,500})/i,
    /<p[^>]*>([^<]{20,500})<\/p>/i,
  ]
  for (const pattern of descPatterns) {
    const match = text.match(pattern)
    if (match && match[1] && match[1].trim().length > 20) {
      description = match[1].trim().substring(0, 300) // Limit length
      break
    }
  }

  // Extract image URL - try multiple patterns
  // Priority: stored "Image: https://..." format from crawler, then HTML img tags, then direct URLs
  let imageUrl: string | null = null
  const imagePatterns = [
    /^Image:\s*(https?:\/\/[^\s\n\r<>"']+)/im, // Stored format from crawler (highest priority)
    /(?:image|img|photo|picture)[:\s]+(https?:\/\/[^\s\n\r<>"']+)/i,
    /<img[^>]+src=["']([^"']+)["']/i,
    /(https?:\/\/[^\s\n\r<>"']+\.(?:jpg|jpeg|png|gif|webp|svg)(?:\?[^\s<>"']*)?)/i,
    /!\[[^\]]*\]\((https?:\/\/[^\)]+)\)/i, // Markdown image
  ]
  for (const pattern of imagePatterns) {
    const match = text.match(pattern)
    if (match && match[1]) {
      let extractedUrl = match[1].trim()

      // Resolve relative URLs if we have a base URL
      if (extractedUrl.startsWith('//')) {
        extractedUrl = `https:${extractedUrl}`
      } else if (extractedUrl.startsWith('/') && doc.filepath) {
        try {
          const baseUrl = doc.filepath.match(/^(https?:\/\/[^\/]+)/i)?.[1]
          if (baseUrl) {
            extractedUrl = new URL(extractedUrl, baseUrl).href
          }
        } catch {
          // If URL resolution fails, keep original
        }
      }

      // Validate it's actually an image URL (skip data URIs, icons, logos)
      if (extractedUrl &&
        !extractedUrl.startsWith('data:') &&
        !extractedUrl.includes('icon') &&
        !extractedUrl.includes('logo') &&
        !extractedUrl.includes('avatar') &&
        (extractedUrl.match(/\.(jpg|jpeg|png|gif|webp|svg)(\?|$)/i) ||
          extractedUrl.includes('image') ||
          extractedUrl.includes('img') ||
          extractedUrl.includes('photo') ||
          extractedUrl.includes('product'))) {
        imageUrl = extractedUrl
        break
      }
    }
  }

  // Extract URL
  const urlMatch = doc.filepath?.match(/^(https?:\/\/[^\s]+)/i)
  const url = urlMatch ? urlMatch[1] : (doc.filepath || '')

  // Only return if we have at least a title
  if (!title) return null

  return {
    id: doc.id,
    title,
    description,
    price,
    url,
    imageUrl,
    features: [],
  }
}

/**
 * Split a recommendation string into likely product names by splitting on common separators.
 */
function splitRecommendationIntoProductNames(text: string): string[] {
  const out: string[] = []
  const parts = text.split(/\s*(?:,|;| and | \+ |\|\s*)\s*/i)
  for (const p of parts) {
    const t = p.trim().replace(/\s*[.:].*$/, '').trim()
    if (t.length >= 3 && t.length <= 100) out.push(t)
  }
  return out
}

/**
 * Dynamically extract product names from consultation text using AI.
 * No hardcoded patterns - extracts only products explicitly mentioned or recommended.
 */
async function extractProductNamesFromText(content: string): Promise<string[]> {
  if (!content || content.trim().length < 10) return []

  try {
    const prompt = `Extract ONLY the specific product names that are EXPLICITLY mentioned or recommended in the following consultation text.

CRITICAL RULES:
1. Return ONLY product names that are clearly stated as recommendations (e.g., "I recommend X", "You should use Y", "Try Z")
2. Do NOT extract products that are:
   - Only mentioned in examples or comparisons
   - Generic categories without a specific brand/name (e.g., "face wash", "cream", "tablets")
   - Mentioned in passing without recommendation
   - Part of general advice (e.g., "drink water", "exercise")
3. If the text mentions products but doesn't explicitly recommend them, return an empty array
4. Be very strict - only extract if there's clear intent to recommend

Text:
${content.substring(0, 3000)}

Respond with ONLY a JSON array of product names, or an empty array [] if no products are explicitly recommended.
Example: ["Product Name 1", "Product Name 2"] or []`

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You extract ONLY explicitly recommended product names from consultation text. Be very strict - only extract products that are clearly recommended, not just mentioned. Return ONLY a JSON array. No markdown, no explanations. If no products are explicitly recommended, return an empty array [].'
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 300,
    })

    let jsonText = completion.choices[0]?.message?.content?.trim() || '[]'
    const block = jsonText.match(/\[[\s\S]*\]/)
    if (block) jsonText = block[0]

    try {
      const names = JSON.parse(jsonText) as string[]
      return names.filter((name): name is string =>
        typeof name === 'string' && name.trim().length >= 3 && name.trim().length <= 150
      ).map(n => n.trim())
    } catch {
      return []
    }
  } catch (error) {
    console.error('[ProductService] AI extraction error:', error)
    // Fallback: use simple text splitting without hardcoded patterns
    return splitRecommendationIntoProductNames(content)
  }
}

/**
 * Dynamically extract recommended product names from current consultation using AI.
 * No hardcoded patterns - fully dynamic based on consultation recommendations.
 * Prefers the most recent assistant message to show only current recommendations.
 */
export async function extractRecommendedProductNames(
  reportData?: any,
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []
): Promise<string[]> {
  const allNames: string[] = []

  // Report: recommendations and action plan - extract dynamically using AI
  if (reportData?.recommendations && Array.isArray(reportData.recommendations)) {
    for (const rec of reportData.recommendations) {
      const s = String(rec).trim()
      if (s.length > 2) {
        allNames.push(s)
        allNames.push(...splitRecommendationIntoProductNames(s))
        // Also extract via AI for better accuracy
        const aiNames = await extractProductNamesFromText(s)
        allNames.push(...aiNames)
      }
    }
  }
  if (reportData?.actionPlan?.immediateSteps && Array.isArray(reportData.actionPlan.immediateSteps)) {
    for (const step of reportData.actionPlan.immediateSteps) {
      const s = String(step).trim()
      if (s.length > 2) {
        allNames.push(...splitRecommendationIntoProductNames(s))
        const aiNames = await extractProductNamesFromText(s)
        allNames.push(...aiNames)
      }
    }
  }

  // Assistant messages: extract product names dynamically (order = oldest to newest)
  for (const msg of conversationHistory) {
    if (msg.role !== 'assistant' || !msg.content) continue
    const aiNames = await extractProductNamesFromText(msg.content)
    allNames.push(...aiNames)
  }

  // Prefer latest: if the last assistant message contains product recommendations, use only those
  // so the catalog updates automatically when recommendations change
  const lastAssistant = [...conversationHistory].reverse().find((m) => m.role === 'assistant' && m.content)
  if (lastAssistant?.content) {
    const fromLast = await extractProductNamesFromText(lastAssistant.content)
    const fromLastSplit = fromLast.flatMap((s) => [s, ...splitRecommendationIntoProductNames(s)])
    if (fromLastSplit.length > 0) {
      const unique = [...new Set(fromLastSplit)].filter(Boolean).slice(0, 30)
      return unique
    }
  }

  return [...new Set(allNames)].filter(Boolean).slice(0, 50)
}

/**
 * Normalize string for fuzzy match (lowercase, collapse spaces, remove punctuation).
 */
function normalizeForMatch(s: string): string {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s]/g, '').trim()
}

/**
 * Duration / pack-size patterns that distinguish meaningful product variants.
 * Examples: "30 Day", "90-day", "15 days", "1 Month", "3 Months", "Pack of 2", "60 Capsules"
 */
const VARIANT_PATTERN = /\b(\d+)\s*[-–]?\s*(day|days|month|months|week|weeks|capsule|capsules|tablet|tablets|sachet|sachets|ml|gm|gram|grams|kg|pack|packs|bottle|bottles|strips?)\b/gi

/**
 * Extract the variant descriptor from a title (e.g. "30 day", "90 capsules").
 * Returns the normalized variant string, or null if none found.
 */
function extractVariantDescriptor(title: string): string | null {
  if (!title) return null
  const matches = [...title.matchAll(VARIANT_PATTERN)]
  if (matches.length === 0) return null
  // Combine all variant matches into a single key (e.g. "30 day 60 capsules")
  return matches.map(m => `${m[1]} ${m[2].toLowerCase()}`).join(' ').trim()
}

/**
 * Get a deduplication key for a product title.
 * Strips variant/duration suffixes so that the same base product name produces the same key,
 * but different variants (30-day vs 90-day) will be differentiated by includeing the variant.
 * Returns: { baseKey, fullKey } where baseKey ignores variants and fullKey includes them.
 */
function getDeduplicationKeys(title: string | null): { baseKey: string; fullKey: string } {
  if (!title) return { baseKey: '', fullKey: '' }
  const normalized = normalizeForMatch(title)
  const variant = extractVariantDescriptor(title)
  // Strip variant patterns and combo/bundle markers for the base key
  const base = normalized
    .replace(/\d+\s*(?:day|days|month|months|week|weeks|capsule|capsules|tablet|tablets|sachet|sachets|ml|gm|gram|grams|kg|pack|packs|bottle|bottles|strips?)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  return {
    baseKey: base,
    fullKey: variant ? `${base}||${variant}` : base,
  }
}

/**
 * Check if two products are the same base product but different variants (duration/pack size).
 */
function isDurationOrPackVariant(titleA: string | null, titleB: string | null): boolean {
  if (!titleA || !titleB) return false
  const keysA = getDeduplicationKeys(titleA)
  const keysB = getDeduplicationKeys(titleB)
  // Same base product name
  if (keysA.baseKey !== keysB.baseKey || keysA.baseKey.length < 3) return false
  // But different full keys (meaning they have different variant descriptors)
  return keysA.fullKey !== keysB.fullKey
}

/**
 * Deduplicate a product list, keeping only one entry per base product name.
 * Duration/pack-size variants (15-day vs 30-day vs 90-day) are preserved as separate entries.
 * Combo/bundle products are always preserved (never deduped against individual products).
 * When duplicates are found, the one with the higher relevance score (or the first one) is kept.
 */
function deduplicateProducts<T extends { title: string | null; url?: string; relevanceScore?: number }>(products: T[]): T[] {
  if (products.length <= 1) return products

  const seen = new Map<string, T>() // fullKey -> product
  const result: T[] = []

  for (const product of products) {
    const title = product.title || ''
    // Combo/bundle products are never deduped — always include them
    if (isComboOrBundle(title)) {
      result.push(product)
      continue
    }

    const { fullKey } = getDeduplicationKeys(title)
    if (!fullKey || fullKey.length < 3) {
      result.push(product) // Can't deduplicate without a meaningful key
      continue
    }

    const existing = seen.get(fullKey)
    if (existing) {
      // Duplicate found — keep the one with higher relevance score, or the first
      const existingScore = (existing as any).relevanceScore ?? 0
      const newScore = (product as any).relevanceScore ?? 0
      if (newScore > existingScore) {
        // Replace with the better-scored version
        const idx = result.indexOf(existing)
        if (idx >= 0) result[idx] = product
        seen.set(fullKey, product)
        console.log(`[ProductService] Dedup: replaced "${existing.title}" with higher-scored "${title}"`)
      } else {
        console.log(`[ProductService] Dedup: skipped duplicate "${title}" (already have "${existing.title}")`)
      }
    } else {
      seen.set(fullKey, product)
      result.push(product)
    }
  }

  return result
}

/**
 * Calculate similarity between two condition/issue sets (0-1, where 1 is identical).
 */
function calculateConditionSimilarity(conditions1: string[], conditions2: string[]): number {
  if (conditions1.length === 0 || conditions2.length === 0) return 0

  const set1 = new Set(conditions1.map(c => normalizeForMatch(c)))
  const set2 = new Set(conditions2.map(c => normalizeForMatch(c)))

  const intersection = new Set([...set1].filter(x => set2.has(x)))
  const union = new Set([...set1, ...set2])

  return union.size > 0 ? intersection.size / union.size : 0
}

/**
 * Store product recommendations in cache for future reuse.
 */
function cacheProductRecommendations(
  agentId: string,
  products: ProductResult[],
  conditions: string[],
  recommendedNames: string[]
): void {
  if (!agentId || products.length === 0 || conditions.length === 0) return

  const cacheEntry: CachedProductRecommendations = {
    products: products.map(p => ({ ...p })), // Deep copy
    conditions: [...conditions],
    recommendedNames: [...recommendedNames],
    cachedAt: Date.now(),
    agentId,
  }

  if (!productRecommendationCache.has(agentId)) {
    productRecommendationCache.set(agentId, [])
  }

  const agentCache = productRecommendationCache.get(agentId)!

  // Remove expired entries
  const now = Date.now()
  const validEntries = agentCache.filter(entry => now - entry.cachedAt < CACHE_TTL)

  // Add new entry
  validEntries.push(cacheEntry)

  // Limit cache size
  if (validEntries.length > MAX_CACHE_ENTRIES_PER_AGENT) {
    // Remove oldest entries
    validEntries.sort((a, b) => a.cachedAt - b.cachedAt)
    validEntries.splice(0, validEntries.length - MAX_CACHE_ENTRIES_PER_AGENT)
  }

  productRecommendationCache.set(agentId, validEntries)
}

/**
 * Retrieve cached product recommendations for similar conditions.
 * Returns products from cache if conditions are similar enough (similarity >= 0.3).
 */
function getCachedProductRecommendations(
  agentId: string,
  currentConditions: string[],
  currentRecommendedNames: string[]
): ProductResult[] {
  if (!agentId || currentConditions.length === 0) return []

  const agentCache = productRecommendationCache.get(agentId)
  if (!agentCache || agentCache.length === 0) return []

  const now = Date.now()
  const results: ProductResult[] = []
  const seenProductIds = new Set<string>()

  // Sort by similarity (highest first) and recency
  const scoredEntries = agentCache
    .filter(entry => now - entry.cachedAt < CACHE_TTL) // Only valid entries
    .map(entry => ({
      entry,
      similarity: calculateConditionSimilarity(currentConditions, entry.conditions),
      nameOverlap: calculateNameOverlap(currentRecommendedNames, entry.recommendedNames),
      age: now - entry.cachedAt,
    }))
    .filter(item => item.similarity >= 0.3 || item.nameOverlap >= 0.5) // Minimum similarity threshold
    .sort((a, b) => {
      // Sort by name overlap first (exact product matches), then similarity, then recency
      if (Math.abs(a.nameOverlap - b.nameOverlap) > 0.1) {
        return b.nameOverlap - a.nameOverlap
      }
      if (Math.abs(a.similarity - b.similarity) > 0.1) {
        return b.similarity - a.similarity
      }
      return a.age - b.age // Newer is better
    })

  // Collect products from most similar entries
  for (const { entry } of scoredEntries.slice(0, 5)) { // Top 5 most similar entries
    for (const product of entry.products) {
      const productId = product.id || product.title || ''
      if (productId && !seenProductIds.has(productId)) {
        seenProductIds.add(productId)
        results.push({ ...product }) // Deep copy
      }
    }
  }

  return results.slice(0, 10) // Limit to 10 cached products
}

/**
 * Calculate overlap between two recommended name sets.
 */
function calculateNameOverlap(names1: string[], names2: string[]): number {
  if (names1.length === 0 || names2.length === 0) return 0

  const set1 = new Set(names1.map(n => normalizeForMatch(n)))
  const set2 = new Set(names2.map(n => normalizeForMatch(n)))

  const intersection = new Set([...set1].filter(x => set2.has(x)))
  const union = new Set([...set1, ...set2])

  return union.size > 0 ? intersection.size / union.size : 0
}

/**
 * Clear product recommendation cache for a specific agent (useful for debugging or resetting).
 */
export function clearProductRecommendationCache(agentId: string): void {
  if (productRecommendationCache.has(agentId)) {
    productRecommendationCache.delete(agentId)
    console.log(`[ProductService] Cleared product recommendation cache for agent: ${agentId}`)
  }
}

/**
 * Clear all product recommendation caches (useful for debugging).
 */
export function clearAllProductRecommendationCaches(): void {
  productRecommendationCache.clear()
  console.log(`[ProductService] Cleared all product recommendation caches`)
}

/**
 * Check if product title matches any of the recommended names (substring or normalized match).
 */
function productMatchesRecommendedNames(title: string | null, recommendedNames: string[]): boolean {
  if (!title || recommendedNames.length === 0) return false
  const normTitle = normalizeForMatch(title)
  for (const name of recommendedNames) {
    const normName = normalizeForMatch(name)
    if (normName.length < 3) continue
    if (normTitle.includes(normName) || normName.includes(normTitle)) return true
  }
  return false
}

/**
 * Check if product title matches this single recommended name (for one-to-one mapping).
 */
function productMatchesSingleRecommendedName(productTitle: string | null, recommendedName: string): boolean {
  if (!productTitle || !recommendedName) return false
  const normTitle = normalizeForMatch(productTitle)
  const normName = normalizeForMatch(recommendedName)
  if (normName.length < 3) return false
  return normTitle.includes(normName) || normName.includes(normTitle)
}

/** Prefer exact or closer name match when multiple products match one recommended name. */
function matchScore(productTitle: string | null, recommendedName: string): number {
  if (!productTitle || !recommendedName) return 0
  const normTitle = normalizeForMatch(productTitle)
  const normName = normalizeForMatch(recommendedName)
  if (normName.length < 3) return 0

  // Exact match
  if (normTitle === normName) return 10

  // One contains the other (high confidence)
  if (normTitle.includes(normName) || normName.includes(normTitle)) {
    // Prefer if one starts with the other (even higher confidence)
    if (normTitle.startsWith(normName) || normName.startsWith(normTitle)) return 8
    return 5
  }

  // Check for word-level matches (more lenient)
  const titleWords = normTitle.split(/\s+/).filter(w => w.length >= 3)
  const nameWords = normName.split(/\s+/).filter(w => w.length >= 3)
  const matchingWords = nameWords.filter(word => titleWords.some(tw => tw.includes(word) || word.includes(tw)))

  // If most words match, it's likely a match
  if (nameWords.length > 0 && matchingWords.length >= Math.ceil(nameWords.length * 0.6)) {
    return 3
  }

  return 0
}

/**
 * Search document text for a product-specific URL (/product/[id] or product page) near the product name.
 * Prefers hrefs that contain /product/ so we link to exact product pages, not the general shop.
 */
function findProductUrlInText(text: string | null, productName: string, baseUrl: string): string | null {
  if (!text || !productName) return null
  const normName = normalizeForMatch(productName)
  if (normName.length < 3) return null

  function resolveUrl(u: string): string | null {
    const t = u.trim()
    if (t.startsWith('http')) return t
    if (t.startsWith('/')) {
      try {
        return new URL(baseUrl).origin + t
      } catch {
        return null
      }
    }
    return null
  }

  const idx = text.toLowerCase().indexOf(productName.slice(0, 20).toLowerCase())
  const start = idx >= 0 ? Math.max(0, idx - 200) : 0
  const end = idx >= 0 ? Math.min(text.length, idx + productName.length + 400) : Math.min(800, text.length)
  const slice = text.slice(start, end)

  const allHrefs = [...slice.matchAll(/href\s*=\s*["']([^"']+)["']/gi)]
  const productHref = allHrefs.find((m) => /\/product\/|\/p\/[^/]+|\/item\//i.test(m[1]))
  if (productHref?.[1]) {
    const resolved = resolveUrl(productHref[1])
    if (resolved) return resolved
  }
  const anyHref = allHrefs.find((m) => m[1].trim().length > 5)
  if (anyHref?.[1]) {
    const resolved = resolveUrl(anyHref[1])
    if (resolved) return resolved
  }

  const urlMatch = slice.match(/(https?:\/\/[^\s<>"']+(?:\/[^\s<>"']*)?)/i)
  if (urlMatch?.[1] && /\/product\/|\/p\/|\/item\//i.test(urlMatch[1])) return urlMatch[1]
  return null
}

/**
 * Use OpenAI to match ALL products to user problems in a single API call.
 * Evaluates every product in the catalog and returns only the best-matched ones that clearly solve the user's issue.
 */
async function matchProductsToProblems(
  products: Partial<ProductResult>[],
  userProblems: string[]
): Promise<Array<ProductResult & { relevanceScore: number }>> {
  const eligible = products.filter(p => p.title && (p.price || p.imageUrl))
  if (eligible.length === 0 || userProblems.length === 0) {
    return eligible.map(p => ({ ...p, relevanceScore: 0.3 } as ProductResult & { relevanceScore: number }))
  }

  const problemsText = userProblems.join('\n- ')
  const productsList = eligible
    .map((p, i) => `[${i}] ${p.title}${p.description ? ` - ${p.description.substring(0, 80)}...` : ''}${p.price ? ` (${p.price})` : ''}`)
    .join('\n')

  try {
    const prompt = `EVALUATE ALL PRODUCTS: Identify which products DIRECTLY and SPECIFICALLY address the user's identified problem. Show ONLY those—no loosely related, generic, or tangentially connected products.

USER'S SPECIFIC IDENTIFIED PROBLEM/CONCERN:
${problemsText}

ALL AVAILABLE PRODUCTS (evaluate each one):
${productsList}

CRITICAL RULES:
1. Return ONLY products that are specifically formulated, designed, or marketed to treat/address the user's EXACT concern.
2. A product for "stamina" is NOT relevant if the user's concern is "low energy & fatigue" unless the product explicitly targets fatigue.
3. A product for "intimate wellness" is NOT relevant if the user's concern is "diabetes / blood sugar".
4. If a product addresses multiple concerns, it is relevant ONLY if the user's specific concern is one of them.
5. RelevanceScore: 0.0-1.0 (1.0 = specifically designed for this exact problem; exclude if <0.85).
6. Only return products with relevanceScore >= 0.85—strict threshold.
7. When in doubt, EXCLUDE the product. It is better to show fewer, highly relevant products than many loosely related ones.

Respond with ONLY a JSON array: [{"index":0,"relevanceScore":0.9},{"index":2,"relevanceScore":0.85}]`

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You evaluate products and return ONLY those that directly address the user\'s identified problem. Exclude loosely related or irrelevant products. Reply with ONLY a JSON array of {index, relevanceScore} for direct matches with score>=0.85. No markdown.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 300,
    })

    let jsonText = completion.choices[0]?.message?.content?.trim() || '[]'
    const block = jsonText.match(/\[[\s\S]*\]/)
    if (block) jsonText = block[0]
    let scores: Array<{ index: number; relevanceScore: number }> = []
    try {
      scores = JSON.parse(jsonText) as Array<{ index: number; relevanceScore: number }>
    } catch {
      scores = []
    }
    const matchedProducts: Array<ProductResult & { relevanceScore: number }> = []
    for (const { index, relevanceScore } of scores) {
      if (index >= 0 && index < eligible.length && relevanceScore >= 0.85) {
        matchedProducts.push({ ...eligible[index], relevanceScore } as ProductResult & { relevanceScore: number })
      }
    }
    return matchedProducts.sort((a, b) => b.relevanceScore - a.relevanceScore)
  } catch (error) {
    console.error('[ProductService] Batch match error:', error)
    return eligible.map(p => ({ ...p, relevanceScore: 0.5 } as ProductResult & { relevanceScore: number }))
  }
}

/**
 * Build a simple product listing from documents (listing pages → multiple products per doc).
 * Returns products with at least title and price; image optional (catalog shows placeholder).
 */
export function listProductsFromDocuments(
  documents: ProductSource[],
  limit: number = 5
): ProductResult[] {
  if (!documents || documents.length === 0) return []

  const extracted: Partial<ProductResult>[] = []
  for (const doc of documents) {
    const fromListing = extractMultipleProductsFromListing(doc)
    if (fromListing.length > 0) {
      extracted.push(...fromListing)
    } else {
      const single = extractProductInfo(doc)
      if (single) extracted.push(single)
    }
  }

  // Require at least title and price so the catalog shows real products (image optional)
  const candidates = extracted.filter((p) => p.title && p.price) as Partial<ProductResult>[]
  const mapped = candidates.map((p) => ({
    id: p.id ?? '',
    title: p.title ?? null,
    description: p.description ?? null,
    price: p.price ?? null,
    url: p.url ?? '',
    imageUrl: p.imageUrl ?? null,
    features: p.features ?? [],
  })) as ProductResult[]

  // Deduplicate: same product from multiple docs should appear only once
  // Duration/pack variants (30-day vs 90-day) are kept as separate entries
  const deduped = deduplicateProducts(mapped)
  const results = deduped.slice(0, limit)

  if (results.length > 0) {
    console.log(`[ProductService] listProductsFromDocuments: returning ${results.length} products (title+price, deduped from ${mapped.length})`)
  }
  return results
}

/** Extracted product with optional doc reference for URL resolution */
type ExtractedProductWithDoc = Partial<ProductResult> & { docId?: string; docText?: string }

/**
 * True when the document URL is a specific product page (/product/[id], /p/..., /item/..., etc.),
 * not a general shop or category listing.
 */
function isProductPageUrl(filepath: string | null): boolean {
  if (!filepath) return false
  try {
    const path = new URL(filepath).pathname.toLowerCase()
    return (
      /\/product\/|\/products\/[^/]+\/|\/p\/[^/]+|\/item\/|\/shop\/[^/]+\/[^/]+/.test(path) ||
      /\/[a-z0-9-]+-\d+\.html|\/product-\d+/.test(path)
    )
  } catch {
    return /\/product\/|\/p\/|\/item\//i.test(filepath)
  }
}

function normalizeUrlForMatch(url: string | null): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    const normalizedPath = u.pathname.replace(/\/+$/, '').toLowerCase()
    return `${u.origin}${normalizedPath}`
  } catch {
    return url.replace(/\/+$/, '').toLowerCase()
  }
}

/** Detect combo/bundle/kit products by title keywords (display these first). */
function isComboOrBundle(title: string | null): boolean {
  if (!title || title.length < 5) return false
  const lower = title.toLowerCase()
  return (
    /\bcombo\b|\bbundle\b|\bkit\b|\bpack\b|\bset\b|\bcollection\b|\bduo\b|\btrio\b/i.test(lower) ||
    /\s\+\s|\s&\s|,\s*and\s+/i.test(lower) ||
    /\d+\s*[-x×]\s*\d+/.test(lower) // e.g. "2 x 50ml"
  )
}

/**
 * Select products from catalog based on user's specific problem/condition using AI.
 * Used when no explicit product names are recommended - chooses most relevant products for the issue.
 */
async function selectProductsByUserCondition(
  products: Partial<ProductResult>[],
  userConditions: string[],
  conversationSummary: string
): Promise<Array<Partial<ProductResult> & { relevanceScore: number }>> {
  const eligible = products.filter((p) => p.title && (p.price || p.imageUrl))
  if (eligible.length === 0 || (userConditions.length === 0 && !conversationSummary.trim())) {
    return []
  }

  const conditionsText = userConditions.length > 0
    ? userConditions.join('\n- ')
    : conversationSummary.slice(0, 500)
  if (!conditionsText.trim()) return []

  const productsList = eligible
    .map(
      (p, i) =>
        `[${i}] ${p.title}${p.description ? ` - ${p.description.substring(0, 80)}` : ''}${p.price ? ` (${p.price})` : ''}`
    )
    .join('\n')

  try {
    const prompt = `EVALUATE ALL PRODUCTS: Identify which products are SPECIFICALLY formulated or designed to address the user's identified problem. Return ONLY those—exclude everything else.

USER'S SPECIFIC IDENTIFIED PROBLEM/CONDITION:
${conditionsText}

ALL AVAILABLE PRODUCTS (evaluate each one):
${productsList}

CRITICAL RULES:
1. Return ONLY products that are specifically formulated, designed, or marketed to treat/address the user's EXACT concern.
2. A product for "stamina" is NOT relevant if the user's concern is "low energy & fatigue" unless the product explicitly targets fatigue too.
3. A product for "intimate wellness" is NOT relevant if the user's concern is "diabetes / blood sugar".
4. If a product addresses multiple concerns, it is relevant ONLY if the user's specific concern is one of them.
5. Prefer combo/bundle/kit that directly targets their condition when relevant.
6. RelevanceScore: 0.0-1.0 (1.0 = specifically designed for this exact problem; exclude if <0.85).
7. Return at most 5-6 products—only those that PRECISELY address the identified problem.
8. When in doubt, EXCLUDE the product. It is better to show fewer, highly relevant products than many loosely related ones.

Respond with ONLY a JSON array: [{"index":0,"relevanceScore":0.9},{"index":2,"relevanceScore":0.85}]`

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You evaluate products and return ONLY those that directly address the user\'s identified problem. Exclude loosely related or irrelevant products. Prioritize combo/bundle when relevant. Reply with ONLY a JSON array of {index, relevanceScore} for direct matches with score>=0.85. No markdown.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 300,
    })

    let jsonText = completion.choices[0]?.message?.content?.trim() || '[]'
    const block = jsonText.match(/\[[\s\S]*\]/)
    if (block) jsonText = block[0]
    let scores: Array<{ index: number; relevanceScore: number }> = []
    try {
      scores = JSON.parse(jsonText) as Array<{ index: number; relevanceScore: number }>
    } catch {
      return []
    }
    const selected: Array<Partial<ProductResult> & { relevanceScore: number }> = []
    for (const { index, relevanceScore } of scores) {
      if (index >= 0 && index < eligible.length && relevanceScore >= 0.85) {
        const p = eligible[index]
        selected.push({ ...p, relevanceScore })
      }
    }
    return selected.sort((a, b) => b.relevanceScore - a.relevanceScore)
  } catch (error) {
    console.error('[ProductService] selectProductsByUserCondition error:', error)
    return []
  }
}

/**
 * Build product results dynamically with caching support.
 * (1) Extract user conditions/issues from current consultation;
 * (2) Dynamically extract recommended product names using AI (no hardcoded patterns);
 * (3) Check cache for similar previous consultations;
 * (4) Fetch exact matching products from website URLs (via crawler documents);
 * (5) Match products to user's current conditions using AI;
 * (6) Cache new recommendations for future reuse.
 * Only matched products are displayed - no static or unrelated products.
 */
export async function buildProductResults(
  documents: ProductSource[],
  limit: number = 10,
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [],
  reportData?: any,
  agentId?: string
): Promise<ProductResult[]> {
  if (!documents || documents.length === 0) return []

  // Extract user conditions/issues for matching and caching
  const userConditions = extractUserProblems(reportData, conversationHistory)
  const conversationSummary = conversationHistory
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n')
    .slice(0, 2000)

  // 1. Dynamically extract recommended product names from current consultation using AI
  let recommendedNames = await extractRecommendedProductNames(reportData, conversationHistory)

  // 1b. Full-catalog evaluation: when user has a problem/condition, ALWAYS evaluate ALL products
  //     and return only the best-matched solutions for their specific issue
  const useFullCatalogEvaluation =
    userConditions.length > 0 ||
    (recommendedNames.length === 0 && conversationSummary.trim().length > 50)

  if (useFullCatalogEvaluation) {
    console.log(`[ProductService] Using full-catalog evaluation for user problem (conditions: ${userConditions.length})`)
  } else if (recommendedNames.length === 0) {
    console.log(`[ProductService] No recommended product names and no user conditions - catalog empty`)
    return []
  } else {
    console.log(`[ProductService] No user problem; matching by recommended names:`, recommendedNames.slice(0, 5))
  }
  console.log(`[ProductService] User conditions:`, userConditions)

  // 2. Check cache for products from similar previous consultations
  // Only use cache if current recommendations are empty OR if cached products match current recommendations
  let cachedProducts: ProductResult[] = []
  if (agentId && userConditions.length > 0) {
    const rawCachedProducts = getCachedProductRecommendations(agentId, userConditions, recommendedNames)
    // Filter cached products to only include those that match current recommended names
    if (rawCachedProducts.length > 0 && recommendedNames.length > 0) {
      cachedProducts = rawCachedProducts.filter(cachedProduct => {
        const productTitle = cachedProduct.title || ''
        return recommendedNames.some(recName => {
          const score = matchScore(productTitle, recName)
          return score > 0 // Only include if it matches a current recommendation
        })
      })
      if (cachedProducts.length > 0) {
        console.log(`[ProductService] Found ${cachedProducts.length} cached products matching current recommendations (filtered from ${rawCachedProducts.length})`)
      } else if (rawCachedProducts.length > 0) {
        console.log(`[ProductService] Cached products found but none match current recommendations - ignoring cache`)
      }
    }
  }

  const productPageDocs = documents.filter((d) => isProductPageUrl(d.filepath))
  const listingDocs = documents.filter((d) => !isProductPageUrl(d.filepath))
  console.log(`[ProductService] Documents: ${productPageDocs.length} product-page, ${listingDocs.length} listing; recommended: ${recommendedNames.length}; full-catalog eval: ${useFullCatalogEvaluation}`)

  const productPageByUrl = new Map<string, ProductSource>()
  for (const doc of productPageDocs) {
    const norm = normalizeUrlForMatch(doc.filepath)
    if (norm) productPageByUrl.set(norm, doc)
  }

  let results: ProductResult[] = []

  // FULL-CATALOG EVALUATION PATH: When user has a problem, evaluate ALL products and return only best-matched solutions
  if (useFullCatalogEvaluation) {
    const allExtracted: Partial<ProductResult>[] = []
    for (const doc of productPageDocs) {
      const p = extractProductInfo(doc)
      if (p?.title) allExtracted.push(p)
    }
    for (const doc of listingDocs) {
      const fromListing = extractMultipleProductsFromListing(doc)
      if (fromListing.length > 0) {
        allExtracted.push(...fromListing)
      } else {
        const single = extractProductInfo(doc)
        if (single?.title) allExtracted.push(single)
      }
    }
    const withUrl = allExtracted.map((p) => {
      const baseUrl = p.url ?? ''
      const productUrl =
        (p as ExtractedProductWithDoc).docText && baseUrl && p.title
          ? findProductUrlInText((p as ExtractedProductWithDoc).docText!, p.title, baseUrl) ?? baseUrl
          : baseUrl
      return { ...p, url: productUrl || baseUrl }
    })
    // Deduplicate before AI evaluation to avoid sending the same product twice
    const dedupedExtracted = deduplicateProducts(
      withUrl.filter((p) => p.title && (p.price || p.imageUrl)) as Array<Partial<ProductResult> & { title: string | null }>
    )
    console.log(`[ProductService] Full-catalog: ${allExtracted.length} extracted → ${dedupedExtracted.length} unique products for AI evaluation`)
    const selected = await selectProductsByUserCondition(
      dedupedExtracted,
      userConditions,
      conversationSummary
    )
    results = selected.map((p) => ({
      id: p.id ?? '',
      title: p.title ?? null,
      description: p.description ?? null,
      price: p.price ?? null,
      url: p.url ?? '',
      imageUrl: p.imageUrl ?? null,
      features: p.features ?? [],
      relevanceScore: p.relevanceScore,
    })) as ProductResult[]
    console.log(`[ProductService] Full-catalog evaluation: ${results.length} best-matched products for user issue`)
  }

  // RECOMMENDED-NAME PATH: When no user problem, match products by AI-recommended names only
  if (!useFullCatalogEvaluation && results.length === 0) {
    const usedProductPageIndices = new Set<number>()
    const usedProductIds = new Set<string>() // Track by product ID to avoid duplicates
    const matchedRecommendedNames = new Set<string>() // Track which recommended names have been matched

    // CRITICAL: Ensure we match ALL recommended products - don't stop early
    // Set limit to at least the number of recommended products
    const effectiveLimit = Math.max(limit, recommendedNames.length)

    // 1. Prefer product-page documents: match recommended names to docs with /product/[id] or product URLs
    // Match each recommended name to ensure we get all recommended products
    for (const recommendedName of recommendedNames) {
      // Don't stop early - we need to match ALL recommended products
      let best: { doc: ProductSource; product: Partial<ProductResult>; score: number } | null = null
      for (let i = 0; i < productPageDocs.length; i++) {
        if (usedProductPageIndices.has(i)) continue
        const doc = productPageDocs[i]
        const product = extractProductInfo(doc)
        if (!product || !product.title) continue
        const score = matchScore(product.title, recommendedName)
        if (score > 0 && (!best || score > best.score)) {
          best = { doc, product, score }
        }
      }
      if (best) {
        const productId = best.product.id ?? best.doc.id
        // Skip if we already have this product (avoid duplicates)
        if (usedProductIds.has(productId)) {
          console.log(`[ProductService] Skipping duplicate product: ${best.product.title} (already matched to another recommendation)`)
          // Mark this recommended name as matched even if product is duplicate
          matchedRecommendedNames.add(recommendedName)
          continue
        }
        const idx = productPageDocs.indexOf(best.doc)
        usedProductPageIndices.add(idx)
        usedProductIds.add(productId)
        matchedRecommendedNames.add(recommendedName)
        const urlMatch = best.doc.filepath?.match(/^(https?:\/\/[^\s]+)/i)
        const productUrl = urlMatch ? urlMatch[1] : (best.doc.filepath ?? best.product.url ?? '')
        const productResult: ProductResult = {
          id: productId,
          title: best.product.title ?? recommendedName,
          description: best.product.description ?? null,
          price: best.product.price ?? null,
          url: productUrl,
          imageUrl: best.product.imageUrl ?? null,
          features: best.product.features ?? [],
        }
        results.push(productResult)
        console.log(`[ProductService] ✓ Matched product "${productResult.title}" for recommended name "${recommendedName}" (score: ${best.score})`)
      } else {
        console.warn(`[ProductService] ⚠ No match found for recommended name: "${recommendedName}" - will try listing docs`)
      }
    }

    // 2. For any recommended name without a product-page match, use listing docs and resolve product URL from page
    // CRITICAL: Match ALL recommended products - don't stop until all are matched or all docs are checked
    const unmatchedRecommendedNames = recommendedNames.filter(name => !matchedRecommendedNames.has(name))
    if (unmatchedRecommendedNames.length > 0 && listingDocs.length > 0) {
      console.log(`[ProductService] Checking listing docs for ${unmatchedRecommendedNames.length} unmatched recommended products:`, unmatchedRecommendedNames)
      const extractedFromListing: ExtractedProductWithDoc[] = []
      for (const doc of listingDocs) {
        const fromListing = extractMultipleProductsFromListing(doc)
        if (fromListing.length > 0) {
          extractedFromListing.push(...(fromListing as ExtractedProductWithDoc[]))
        } else {
          const single = extractProductInfo(doc)
          if (single) {
            extractedFromListing.push({ ...single, docId: doc.id, docText: doc.extractedText ?? undefined })
          }
        }
      }
      console.log(`[ProductService] Extracted ${extractedFromListing.length} products from listing docs`)

      const usedListingIndices = new Set<number>()
      // Try to match each unmatched recommended name
      for (const recommendedName of unmatchedRecommendedNames) {
        // Check if we already have a product matching this recommended name
        const alreadyMatched = results.some((r) => productMatchesSingleRecommendedName(r.title, recommendedName))
        if (alreadyMatched) {
          console.log(`[ProductService] Already matched product for recommended name: "${recommendedName}", skipping`)
          matchedRecommendedNames.add(recommendedName)
          continue
        }

        const candidates = extractedFromListing
          .map((p, i) => ({ p, i, score: matchScore(p.title ?? null, recommendedName) }))
          .filter((x) => !usedListingIndices.has(x.i) && x.score > 0)
          .sort((a, b) => b.score - a.score)

        if (candidates.length === 0) {
          console.log(`[ProductService] No candidates found in listing docs for: "${recommendedName}"`)
          continue
        }

        const { p, i } = candidates[0]
        const productId = p.id ?? `${recommendedName}-${i}`

        // Skip if we already have this product (avoid duplicates)
        if (usedProductIds.has(productId)) {
          console.log(`[ProductService] Skipping duplicate product from listing: ${p.title}`)
          continue
        }

        usedListingIndices.add(i)
        usedProductIds.add(productId)
        const baseUrl = p.url ?? ''
        const productTitle = p.title ?? recommendedName
        const productUrl =
          p.docText && baseUrl
            ? findProductUrlInText(p.docText, productTitle, baseUrl)
            : null
        matchedRecommendedNames.add(recommendedName)
        const productResult: ProductResult = {
          id: productId,
          title: p.title ?? recommendedName,
          description: p.description ?? null,
          price: p.price ?? null,
          url: productUrl ?? baseUrl,
          imageUrl: p.imageUrl ?? null,
          features: p.features ?? [],
        }
        const normUrl = normalizeUrlForMatch(productResult.url)
        const productDoc = normUrl ? productPageByUrl.get(normUrl) : null
        if (productDoc) {
          const fromProductPage = extractProductInfo(productDoc)
          if (fromProductPage?.price) productResult.price = fromProductPage.price
          if (fromProductPage?.title) productResult.title = fromProductPage.title
          if (fromProductPage?.description) productResult.description = fromProductPage.description
          if (fromProductPage?.imageUrl) productResult.imageUrl = fromProductPage.imageUrl
        }
        results.push(productResult)
        console.log(`[ProductService] ✓ Matched product from listing "${productResult.title}" for recommended name "${recommendedName}" (score: ${candidates[0].score})`)
      }
    }

    // Final check: Ensure we have products for all recommended names
    const stillUnmatched = recommendedNames.filter((name) => !matchedRecommendedNames.has(name))
    if (stillUnmatched.length > 0) {
      console.warn(`[ProductService] ⚠ WARNING: ${stillUnmatched.length} recommended products could not be matched:`, stillUnmatched)
    }
  }

  // 3. Final filter: Match products to user's current conditions using AI
  // CRITICAL: Always preserve ALL recommended products, even if AI relevance score is lower
  // If a product was explicitly recommended, it must be shown regardless of AI matching
  let finalResults: ProductResult[] = results
  if (userConditions.length > 0 && results.length > 0) {
    const matchedProducts = await matchProductsToProblems(results, userConditions)
    // Use only AI-matched products - only show products that DIRECTLY match user's condition
    finalResults = matchedProducts.map((p) => ({
      id: p.id,
      title: p.title,
      description: p.description,
      price: p.price,
      url: p.url,
      imageUrl: p.imageUrl,
      features: p.features,
      relevanceScore: p.relevanceScore,
    }))
    console.log(`[ProductService] ${finalResults.length} products (all match user condition)`)
  }

  // 4. Merge current consultation products (priority) with cached products
  // Only include cached products if they match current recommendations
  const seenProductIds = new Set<string>()
  const mergedResults: ProductResult[] = []

  // Add current consultation products first (priority)
  for (const product of finalResults) {
    const productId = product.id || product.title || ''
    if (productId && !seenProductIds.has(productId)) {
      seenProductIds.add(productId)
      mergedResults.push(product)
    }
  }

  // Add cached products that match current recommendations and aren't already included
  // Only add if we have current recommendations to match against
  if (recommendedNames.length > 0) {
    for (const cachedProduct of cachedProducts) {
      if (mergedResults.length >= limit) break
      const productId = cachedProduct.id || cachedProduct.title || ''
      if (productId && !seenProductIds.has(productId)) {
        // Double-check that cached product matches a current recommendation
        const productTitle = cachedProduct.title || ''
        const matchesCurrentRecommendation = recommendedNames.some(recName => {
          const score = matchScore(productTitle, recName)
          return score > 0
        })

        if (matchesCurrentRecommendation) {
          seenProductIds.add(productId)
          mergedResults.push(cachedProduct)
        } else {
          console.log(`[ProductService] Skipping cached product "${productTitle}" - doesn't match current recommendations`)
        }
      }
    }
  }

  // 5. Cache new products from current consultation for future reuse
  // Only cache products that were matched from current consultation, not from cache
  if (agentId && userConditions.length > 0 && finalResults.length > 0) {
    // Only cache products that were matched from current consultation (in 'results' array)
    const productsToCache = finalResults.filter(p =>
      results.some(r => (r.id === p.id) || (r.title && p.title && normalizeForMatch(r.title) === normalizeForMatch(p.title)))
    )
    if (productsToCache.length > 0) {
      cacheProductRecommendations(agentId, productsToCache, userConditions, recommendedNames)
      console.log(`[ProductService] Cached ${productsToCache.length} products for future reuse`)
    }
  }

  const finalCount = mergedResults.length
  const recommendedCount = useFullCatalogEvaluation ? finalCount : recommendedNames.length

  console.log(`[ProductService] Final catalog: ${finalCount} products (combo/bundle first)`)
  if (finalCount > 0) {
    console.log(`[ProductService] Products displayed:`, mergedResults.map((r) => r.title).join(', '))
  }

  if (!useFullCatalogEvaluation && finalCount < recommendedCount) {
    console.error(`[ProductService] ❌ MISMATCH: Only found ${finalCount} products but ${recommendedCount} were recommended!`)
    console.error(`[ProductService] Recommended products:`, recommendedNames.join(', '))
    console.error(`[ProductService] Found products:`, mergedResults.map(r => r.title).join(', '))
    const missing = recommendedNames.filter(recName =>
      !mergedResults.some(p => productMatchesSingleRecommendedName(p.title, recName))
    )
    if (missing.length > 0) {
      console.error(`[ProductService] Missing products:`, missing.join(', '))
    }
  } else if (finalCount === recommendedCount) {
    console.log(`[ProductService] ✅ Perfect match: All ${recommendedCount} recommended products found and displayed`)
  } else {
    console.log(`[ProductService] ℹ️ Found ${finalCount} products (${finalCount - recommendedCount} more than recommended)`)
  }

  // 6. Final deduplication: Remove exact duplicates while preserving duration/combo variants
  // This catches duplicates that slip through from different extraction paths (product pages + listing pages)
  const dedupedResults = deduplicateProducts(mergedResults)
  if (dedupedResults.length < mergedResults.length) {
    console.log(`[ProductService] Final dedup: removed ${mergedResults.length - dedupedResults.length} duplicate(s), ${dedupedResults.length} unique products remain`)
  }

  // 7. Sort: combo/bundle products first, then individual products; within each, by relevance
  const sorted = [...dedupedResults].sort((a, b) => {
    const aCombo = isComboOrBundle(a.title)
    const bCombo = isComboOrBundle(b.title)
    if (aCombo && !bCombo) return -1
    if (!aCombo && bCombo) return 1
    const aScore = (a as ProductResult & { relevanceScore?: number }).relevanceScore ?? 0.5
    const bScore = (b as ProductResult & { relevanceScore?: number }).relevanceScore ?? 0.5
    return bScore - aScore
  })

  const returnLimit = useFullCatalogEvaluation ? limit : Math.max(limit, recommendedNames.length)
  return sorted.slice(0, returnLimit)
}
