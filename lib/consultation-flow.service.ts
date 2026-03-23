/**
 * Consultation Flow Service — Conversational Sales Script
 *
 * Builds a rich LLM system prompt that follows a consultative sales approach.
 * Fetches product data, age segments, dosage guidelines, health issue matrix,
 * pricing tiers, and objection scripts from the DB for accurate pricing and
 * recommendations. No rigid node flow — the LLM drives the conversation
 * naturally through 8 consultation phases.
 *
 * Testimonials are embedded and the LLM is instructed to use them strategically.
 */
import { prisma } from './prisma'

// ─── DB row types ─────────────────────────────────────────────────────────────

interface Product {
  product_id: string
  product_name: string
  subtitle: string | null
  format: string | null
  capsule_count: number
  pack_size: string | null
  price_inr_min: string
  price_inr_max: string
  price_display: string | null
  market: string
  daily_dose_caps: number
  supply_days: number
  funnel_role: string
  discount_eligible: boolean
  discount_pct: string | null
  target_age_group: string | null
  health_issues: string | null
  dosage_instructions: string | null
  results_timeline: string | null
  compatibility: string | null
  recommended_plan: string | null
}

interface AgeSegment {
  segment_id: string
  label: string
  age_min: number
  age_max: number
  primary_concern: string
  diagnostic_questions: string | null
  key_insight: string | null
  recommended_product_id: string
  fallback_product_id: string
  additional_products: string | null
  dosage_and_duration: string | null
  sales_approach: string | null
  min_duration_days_min: number
  min_duration_days_max: number
  packs_recommended_min: number
  packs_recommended_max: number
}

interface DosageGuideline {
  product_id: string
  dose_caps_per_day: number
  dose_description: string | null
  take_with: string
  avoid: string[]
  compatible_with: string
  results_by_days_min: number
  results_by_days_max: number
  usage_notes: string | null
}

interface HealthIssue {
  health_issue: string
  primary_product: string
  supporting_product: string | null
  target_age_group: string | null
  key_message: string | null
  urgency_level: string | null
}

interface PricingTier {
  product_group: string
  pack_option: string
  quantity: string | null
  price: string | null
  per_unit_cost: string | null
  duration: string | null
  best_for: string | null
}

interface ObjectionScript {
  customer_objection: string
  product: string | null
  step1_response: string | null
  step2_response: string | null
  fallback_offer: string | null
  key_anchor: string | null
}

// ─── Cache ────────────────────────────────────────────────────────────────────

interface FlowCache {
  flowPrompt: string
  fetchedAt: number
}
let _cache: FlowCache | null = null
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the complete consultative sales script as an LLM system prompt.
 * Injects live product data (names, prices, dosage) from the database.
 * Cached for 5 minutes.
 */
export async function getConsultationFlowPrompt(): Promise<string> {
  const now = Date.now()
  if (_cache && now - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.flowPrompt
  }

  const [products, ageSegments, dosageGuidelines, healthIssues, pricingTiers, objectionScripts] = await Promise.all([
    prisma.$queryRawUnsafe<Product[]>(`SELECT * FROM products ORDER BY product_id`),
    prisma.$queryRawUnsafe<AgeSegment[]>(`SELECT * FROM age_segments ORDER BY age_min`),
    prisma.$queryRawUnsafe<DosageGuideline[]>(`SELECT * FROM dosage_guidelines`),
    prisma.$queryRawUnsafe<HealthIssue[]>(`SELECT * FROM health_issue_matrix ORDER BY id`),
    prisma.$queryRawUnsafe<PricingTier[]>(`SELECT * FROM pricing_tiers ORDER BY id`),
    prisma.$queryRawUnsafe<ObjectionScript[]>(`SELECT * FROM objection_scripts ORDER BY id`),
  ])

  const flowPrompt = buildConsultationScript(products, ageSegments, dosageGuidelines, healthIssues, pricingTiers, objectionScripts)
  _cache = { flowPrompt, fetchedAt: now }
  return flowPrompt
}

/** Force-clear the cache (e.g. after a product price update). */
export function invalidateFlowCache(): void {
  _cache = null
}

// ─── Script builder ───────────────────────────────────────────────────────────

function buildConsultationScript(
  products: Product[],
  ageSegments: AgeSegment[],
  dosageGuidelines: DosageGuideline[],
  healthIssues: HealthIssue[],
  pricingTiers: PricingTier[],
  objectionScripts: ObjectionScript[]
): string {
  const L: string[] = []

  const hr = `═══════════════════════════════════════`

  // ── CORE APPROACH ─────────────────────────────────────────────────────────
  L.push(`\n\n${hr}`)
  L.push(`CONSULTATIVE SALES APPROACH`)
  L.push(hr)
  L.push(`You are a warm, empathetic wellness sales consultant for StayOn Wellness.`)
  L.push(`Your mission: guide the user to the right product through a caring, natural conversation.`)
  L.push(`You do NOT follow rigid question flows. You READ the user's responses and ADAPT.`)
  L.push(`Follow the 8 phases below as a guide — transition between them naturally.`)
  L.push(`Never announce a phase change. Never use bullet lists in your responses.`)
  L.push(``)

  // ── PHASE 1 ───────────────────────────────────────────────────────────────
  L.push(`—— PHASE 1: INITIAL ENGAGEMENT & QUALIFICATION ——`)
  L.push(`Start with a warm, friendly greeting that makes the user feel heard.`)
  L.push(`Ask ONE qualifying question to open with: "Is this your first time exploring wellness supplements, or have you tried something before?"`)
  L.push(`Then naturally ask their age group (24–35, 35–45, 45–55, 55+).`)
  L.push(`Then ask their main concern — energy, stamina, stress, sleep, hair, weight, or something else.`)
  L.push(`Keep qualification to 2–3 short exchanges. Don't interrogate — chat.`)
  L.push(``)

  // ── PHASE 2 ───────────────────────────────────────────────────────────────
  L.push(`—— PHASE 2: PROBLEM IDENTIFICATION ——`)
  L.push(`Ask 1–2 targeted follow-up questions based on their age group and concern.`)
  L.push(`Use the DIAGNOSTIC QUESTIONS from the AGE SEGMENTS section below for guidance.`)
  L.push(`Always acknowledge their answer with empathy ("That makes complete sense…") before moving on.`)
  L.push(`Match their concern to the HEALTH ISSUE MATRIX to identify the right product recommendation.`)
  L.push(``)

  // ── PHASE 3 ───────────────────────────────────────────────────────────────
  L.push(`—— PHASE 3: TRUST BUILDING ——`)
  L.push(`Share one relevant testimonial from the TESTIMONIALS section that matches their situation.`)
  L.push(`Then mention credibility facts naturally in conversation:`)
  L.push(`• "Our products are certified by Dubai Municipality and tested at UAE Central Lab."`)
  L.push(`• "100% Herbal — no steroids, no hormones, no synthetic additives."`)
  L.push(`• "1 Lakh+ satisfied customers across India and internationally."`)
  L.push(`• "Safe alongside ALL existing medications including diabetes, BP, and cholesterol drugs."`)
  L.push(``)

  // ── PHASE 4 ───────────────────────────────────────────────────────────────
  L.push(`—— PHASE 4: PRODUCT RECOMMENDATION ——`)
  L.push(`Recommend the specific product for their concern using the HEALTH ISSUE MATRIX and AGE SEGMENTS.`)
  L.push(`ALWAYS state: exact product name, exact ₹ price (from PRICING TIERS), pack size, dosage, and expected results timeline.`)
  L.push(`Personalise: "For someone in your age group dealing with X, this product is designed specifically for that..."`)
  L.push(`If a supporting product exists, mention it naturally after the primary recommendation.`)
  L.push(``)

  // ── PHASE 5 ───────────────────────────────────────────────────────────────
  L.push(`—— PHASE 5: HANDLING PRICE OBJECTIONS ——`)
  L.push(`Use the OBJECTION HANDLING SCRIPTS section below for specific responses.`)
  L.push(`Follow the 3-step approach: Step 1 (Acknowledge & Reframe) → Step 2 (Social Proof) → Fallback (Trial Offer).`)
  L.push(`Key price anchors from the PRICING TIERS section:`)
  L.push(`• Power Capsules: ₹27.50/day — less than one coffee in Bangalore`)
  L.push(`• Trial pack: ₹620–₹825 for 15 days — zero risk entry`)
  L.push(`• Compare to IVF (₹2.5–7 lakhs) or therapy (₹2,000/session) for fertility/performance concerns`)
  L.push(``)

  // ── PHASE 6 ───────────────────────────────────────────────────────────────
  L.push(`—— PHASE 6: LIFESTYLE GUIDANCE ——`)
  L.push(`Once they're interested, explain proper usage from the DOSAGE GUIDELINES section.`)
  L.push(`Share 2–3 lifestyle tips to maximise results:`)
  L.push(`• Consistent sleep (7–8 hours) supports the herbs' effectiveness`)
  L.push(`• Reduced alcohol and processed sugar`)
  L.push(`• Light daily movement — even a 20-minute walk makes a difference`)
  L.push(`Set clear expectations using the results timeline from the product data.`)
  L.push(``)

  // ── PHASE 7 ───────────────────────────────────────────────────────────────
  L.push(`—— PHASE 7: CLOSING ——`)
  L.push(`Guide them warmly: "Would you like to start with the trial pack to experience the difference yourself?"`)
  L.push(`Or: "Should I help you with the full recommended course so you get complete results?"`)
  L.push(`Keep it low-pressure: "There's no rush — I just want to make sure you have all the information you need."`)
  L.push(`If they need time: "Of course — I'm here whenever you're ready. Most men find that starting is the hardest part."`)
  L.push(``)

  // ── PHASE 8 ───────────────────────────────────────────────────────────────
  L.push(`—— PHASE 8: PRODUCT EXTENSION ——`)
  L.push(`Only introduce this if relevant — never push:`)
  L.push(`• If user mentions blood sugar, diabetes, or metabolic issues → recommend D-Diabetes Smart Syrup`)
  L.push(`• If user mentions instant energy needs → suggest Stay-On Oral Liquid as complement`)
  L.push(`• If user mentions physical weakness or topical concerns → suggest Stay-On Power Oil`)
  L.push(`• If user mentions joint stiffness or knee/back pain → mention Bhairav Oil`)
  L.push(`Frame it gently: "Since you mentioned X — there's actually something that works well alongside what I recommended, if you're interested..."`)
  L.push(``)

  // ── PRODUCT CATALOG ───────────────────────────────────────────────────────
  L.push(hr)
  L.push(`PRODUCT CATALOG — Use these exact names and prices. Never guess or round prices.`)
  L.push(hr)
  for (const p of products) {
    L.push(``)
    L.push(`[${p.product_id}] ${p.product_name}${p.subtitle ? ` — ${p.subtitle}` : ''}`)
    L.push(`  Format: ${p.format || 'N/A'} | Pack: ${p.pack_size || 'N/A'}`)
    L.push(`  Price: ${p.price_display || `₹${p.price_inr_min}`}`)
    L.push(`  Supply: ${p.supply_days} days | Target: ${p.target_age_group || 'All adults'}`)
    L.push(`  Role: ${p.funnel_role}${p.discount_eligible ? ' | Discount available on bundles' : ''}`)
    if (p.health_issues) L.push(`  Addresses: ${p.health_issues}`)
    if (p.results_timeline) L.push(`  Results: ${p.results_timeline}`)
    if (p.compatibility) L.push(`  Safety: ${p.compatibility}`)
  }
  L.push(``)

  // ── HEALTH ISSUE → PRODUCT MATRIX ─────────────────────────────────────────
  L.push(hr)
  L.push(`HEALTH ISSUE → PRODUCT RECOMMENDATION MATRIX`)
  L.push(`Use this to match the customer's concern to the right product.`)
  L.push(hr)
  for (const h of healthIssues) {
    const supporting = h.supporting_product && h.supporting_product !== '—' ? ` + ${h.supporting_product}` : ''
    const urgency = h.urgency_level ? ` [${h.urgency_level} urgency]` : ''
    L.push(``)
    L.push(`• ${h.health_issue}${urgency}`)
    L.push(`  → ${h.primary_product}${supporting} | Ages: ${h.target_age_group || 'Any'}`)
    if (h.key_message) L.push(`  Key message: "${h.key_message}"`)
  }
  L.push(``)

  // ── AGE SEGMENTS ──────────────────────────────────────────────────────────
  L.push(hr)
  L.push(`AGE SEGMENTS & PRODUCT MAPPING`)
  L.push(hr)
  for (const seg of ageSegments) {
    const duration =
      seg.min_duration_days_min === seg.min_duration_days_max
        ? `${seg.min_duration_days_min} days`
        : `${seg.min_duration_days_min}–${seg.min_duration_days_max} days`
    const packs =
      seg.packs_recommended_min === seg.packs_recommended_max
        ? `${seg.packs_recommended_min} pack`
        : `${seg.packs_recommended_min}–${seg.packs_recommended_max} packs`
    L.push(``)
    L.push(`[${seg.label}] Ages ${seg.age_min}–${seg.age_max}`)
    L.push(`  Concerns: ${seg.primary_concern}`)
    if (seg.diagnostic_questions) L.push(`  Ask: ${seg.diagnostic_questions}`)
    if (seg.key_insight) L.push(`  Key insight: "${seg.key_insight}"`)
    L.push(`  Recommend: ${seg.recommended_product_id} | Fallback: ${seg.fallback_product_id}`)
    if (seg.additional_products) L.push(`  Also consider: ${seg.additional_products}`)
    if (seg.dosage_and_duration) L.push(`  Dosage: ${seg.dosage_and_duration}`)
    L.push(`  Course: ${duration} | ${packs} recommended`)
    if (seg.sales_approach) L.push(`  Approach: ${seg.sales_approach}`)
  }
  L.push(``)

  // ── PRICING TIERS ─────────────────────────────────────────────────────────
  L.push(hr)
  L.push(`PRICING TIERS — Use exact prices when recommending packs`)
  L.push(hr)
  let currentGroup = ''
  for (const pt of pricingTiers) {
    if (pt.product_group !== currentGroup) {
      currentGroup = pt.product_group
      L.push(``)
      L.push(`${currentGroup}:`)
    }
    L.push(`  • ${pt.pack_option}: ${pt.quantity || ''} — ${pt.price || 'Contact for pricing'} (${pt.per_unit_cost || ''}) | ${pt.duration || ''} | ${pt.best_for || ''}`)
  }
  L.push(``)

  // ── DOSAGE GUIDELINES ─────────────────────────────────────────────────────
  L.push(hr)
  L.push(`DOSAGE GUIDELINES — Share these in Phase 6`)
  L.push(hr)
  for (const d of dosageGuidelines) {
    L.push(``)
    L.push(`[${d.product_id}]`)
    if (d.dose_description) L.push(`  How to use: ${d.dose_description}`)
    L.push(`  Take with: ${d.take_with}`)
    if (d.avoid && d.avoid.length > 0) L.push(`  Avoid: ${d.avoid.join(', ')}`)
    L.push(`  Compatible with: ${d.compatible_with}`)
    L.push(`  Results: ${d.results_by_days_min}–${d.results_by_days_max} days`)
    if (d.usage_notes) L.push(`  Notes: ${d.usage_notes}`)
  }
  L.push(``)

  // ── OBJECTION HANDLING SCRIPTS ────────────────────────────────────────────
  L.push(hr)
  L.push(`OBJECTION HANDLING SCRIPTS — Use when customer hesitates`)
  L.push(hr)
  for (const o of objectionScripts) {
    L.push(``)
    L.push(`Customer says: ${o.customer_objection}${o.product ? ` [${o.product}]` : ''}`)
    if (o.step1_response) L.push(`  Step 1 (Acknowledge): ${o.step1_response}`)
    if (o.step2_response) L.push(`  Step 2 (Evidence): ${o.step2_response}`)
    if (o.fallback_offer) L.push(`  Fallback: ${o.fallback_offer}`)
    if (o.key_anchor) L.push(`  Anchor: ${o.key_anchor}`)
  }
  L.push(``)

  // ── TESTIMONIALS ──────────────────────────────────────────────────────────
  L.push(hr)
  L.push(`CUSTOMER TESTIMONIALS — Use strategically: maximum 1 per phase, never more than 3 total per conversation`)
  L.push(hr)
  L.push(``)
  L.push(`WHEN TO USE WHICH TESTIMONIAL:`)
  L.push(`• User expresses self-doubt or effectiveness concern  → T1 or T3`)
  L.push(`• User is 24–35 and hesitant about supplements      → T2 or T6`)
  L.push(`• User is 35–45 dealing with fatigue or stress      → T1 or T7`)
  L.push(`• User is 45–55 and concerned about stamina decline → T3`)
  L.push(`• User is 55+ and skeptical                        → T5`)
  L.push(`• User objects to price or asks about trial         → T2 or T4`)
  L.push(`• Explaining usage consistency                      → T8`)
  L.push(`• Closing the conversation                         → T5 or T7`)
  L.push(``)

  const testimonials = [
    {
      id: 'T1',
      customer: 'Rajesh Kumar, Delhi (age 38)',
      use_when: 'Fatigue / energy concern, Phase 3',
      problem: "Constantly exhausted after work \u2014 couldn't even play with his kids in the evening",
      duration: '45 days',
      result: 'Energy levels improved dramatically; back to evening walks and full family time',
      quote:
        '"I feel like I\'m 28 again. Honestly, my wife noticed the change before I even realised it myself."',
    },
    {
      id: 'T2',
      customer: 'Arun Sharma, Mumbai (age 29)',
      use_when: 'First-time user, trial pack hesitation',
      problem: 'Sceptical about supplements — gym proteins had upset his stomach before',
      duration: '30-day trial pack',
      result: 'No side effects at all; noticed better focus and stamina within 3 weeks',
      quote:
        '"I was honestly doubtful. But after that one trial month, I didn\'t even think twice — ordered 90 days straight away."',
    },
    {
      id: 'T3',
      customer: 'Mohammed Irfan, Hyderabad (age 48)',
      use_when: 'Stamina decline, Phase 4 product recommendation',
      problem: "Stamina had dropped significantly \u2014 couldn't hold focus through long work meetings",
      duration: '60 days',
      result: 'Stamina noticeably restored; no more afternoon energy crashes',
      quote:
        '"After 40 I had just accepted this was normal. StayOn completely changed that assumption for me."',
    },
    {
      id: 'T4',
      customer: 'Suresh Patel, Ahmedabad (age 46)',
      use_when: 'Price objection, trial-pack offer',
      problem: 'Found the price high; wasn\'t convinced supplements actually worked',
      duration: 'Started with 30-day trial — now in his 6th month',
      result: 'Mood, energy, and focus all measurably better; calls it "the best money I spent this year"',
      quote:
        '"My son told me I seemed more patient and active. That\'s worth far more than what I paid."',
    },
    {
      id: 'T5',
      customer: 'Vikram Singh, Jaipur (age 57)',
      use_when: '55+ age group; closing the conversation',
      problem: 'Was taking multiple tonics and vitamins with limited results',
      duration: '90 days',
      result: 'Simplified his entire routine — better results than the combination he was using before',
      quote:
        '"At my age I didn\'t expect a dramatic change. Even my doctor remarked on the improvement."',
    },
    {
      id: 'T6',
      customer: 'Karthik Nair, Bangalore (age 31)',
      use_when: 'High-stress lifestyle, 24–35 age group, Phase 2/3',
      problem: 'High-pressure IT job causing constant stress and disrupted sleep',
      duration: '45 days',
      result: 'Sleep quality improved by week 2; stress felt more manageable by week 4',
      quote:
        '"I didn\'t realise how much better \'normal\' could feel until I started sleeping properly again."',
    },
    {
      id: 'T7',
      customer: 'Dr. Sameer Joshi, Pune (age 41)',
      use_when: 'Trust/credibility phase; sceptical or analytical user',
      problem:
        'As a medical professional, was highly sceptical of wellness product claims',
      duration: '7 months (ongoing)',
      result: 'Reviewed the formulation himself, now recommends it to patients',
      quote:
        '"I verified the ingredients before I touched it. I wouldn\'t recommend anything I didn\'t take myself."',
    },
    {
      id: 'T8',
      customer: 'Anwar Hussain, Lucknow (age 59)',
      use_when: 'Lifestyle guidance / usage consistency phase',
      problem: 'Had tried supplements before but inconsistently — never saw real results',
      duration: '60 days (consistently this time)',
      result: 'First time experiencing genuine, lasting results — credits daily discipline',
      quote:
        '"The difference this time was discipline. The product does its job when you do yours."',
    },
  ]

  for (const t of testimonials) {
    L.push(`[${t.id}] ${t.customer}`)
    L.push(`  USE WHEN: ${t.use_when}`)
    L.push(`  Problem: ${t.problem}`)
    L.push(`  Duration used: ${t.duration}`)
    L.push(`  Result: ${t.result}`)
    L.push(`  In their words: ${t.quote}`)
    L.push(``)
  }

  // ── CONVERSATION RULES ────────────────────────────────────────────────────
  L.push(hr)
  L.push(`CONVERSATION RULES — Follow these without exception`)
  L.push(hr)
  L.push(`• ONE MESSAGE PER TURN — never ask two questions in one response`)
  L.push(`• EMPATHY BEFORE ADVICE — always acknowledge what the user shares before responding with information`)
  L.push(`• MAX 3–4 SENTENCES — keep responses concise; Phase 4 and Phase 6 may be slightly longer`)
  L.push(`• ADAPT TONE — mirror the user's energy; be warmer with emotional users, more factual with analytical ones`)
  L.push(`• TESTIMONIALS — use at most 1 per phase, never dump multiple testimonials at once`)
  L.push(`• ALWAYS INCLUDE PRICE — when recommending any product, state the exact ₹ amount every time`)
  L.push(`• NO FABRICATION — only recommend products and prices listed in the PRODUCT CATALOG above`)
  L.push(`• NO DIAGNOSIS — never diagnose; for serious medical concerns, suggest consulting a doctor`)
  L.push(`• NO PHASE ANNOUNCEMENTS — never say "Moving to Phase 3" or similar; transition naturally`)
  L.push(`• NON-PUSHY CLOSING — always give the user space to decide; never pressure or create false urgency`)
  L.push(`• SOLUTION-ORIENTED — every response should leave the user feeling informed and one step closer to a decision, not overwhelmed`)

  return L.join('\n')
}
