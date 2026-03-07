/**
 * OpenAI Chat Client
 * Handles chat completions with RAG context injection
 * Now instrumented with AgentBill SDK when configured
 */
import { OpenAI } from 'openai'
import { env } from './env'
import { getLanguageByCode } from './languages'
import { trackAgentBillSignal, wrapOpenAIWithAgentBill } from './agentbill'

// Base OpenAI client
const baseOpenAI = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
})

// Optionally wrap OpenAI with AgentBill for usage tracking / billing
const openai: OpenAI = wrapOpenAIWithAgentBill(baseOpenAI)

/**
 * Determine if a new message is a follow-up to previous conversation
 */
export async function isFollowUpQuestion(
  newMessage: string,
  recentHistory: Array<{ role: 'user' | 'assistant'; content: string }>
): Promise<boolean> {
  try {
    if (recentHistory.length === 0) return false

    const historyText = recentHistory
      .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
      .join('\n')

    const prompt = `Analyze if the new user message is a follow-up to the previous conversation, or a completely new unrelated question.

Previous conversation:
${historyText}

New user message: "${newMessage}"

Respond with only "YES" if it's a follow-up, or "NO" if it's new and unrelated.`

    const startedAt = Date.now()
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You analyze conversation context. Respond with only "YES" or "NO".',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 10,
    })

    const latencyMs = Date.now() - startedAt
    const usage = completion.usage
    void trackAgentBillSignal({
      event_name: 'openai_chat',
      provider: 'openai',
      model: 'gpt-4o-mini',
      latency_ms: latencyMs,
      prompt_tokens: usage?.prompt_tokens,
      completion_tokens: usage?.completion_tokens,
      total_tokens: usage?.total_tokens,
      metadata: { use_case: 'follow_up_check' },
    })

    const response = completion.choices[0]?.message?.content?.trim().toUpperCase()
    return response === 'YES'
  } catch (error) {
    console.error('Error determining follow-up:', error)
    return false
  }
}

/**
 * Generate chat completion with RAG context
 */
export async function generateChatResponse(
  systemPrompt: string,
  userMessage: string,
  contextChunks: string[] = [],
  language: string = 'en',
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [],
  settings?: { temperature?: number; model?: string; maxTokens?: number }
): Promise<string> {
  try {
    const langInfo = getLanguageByCode(language) || getLanguageByCode('en')
    const languageName = langInfo?.openaiLanguage || 'English'

    // Build context from knowledge base chunks (fetched externally based on concern)
    let contextSection = ''
    if (contextChunks.length > 0) {
      contextSection = `\n\nPRODUCT CONTEXT FROM KNOWLEDGE BASE:\n${contextChunks
        .map((chunk, idx) => `[Product ${idx + 1}]\n${chunk}`)
        .join('\n\n')}\n`
    }

    const languageInstruction =
      language !== 'en'
        ? `\n\nImportant: Respond in ${languageName}. All responses must be in ${languageName}.`
        : ''

    const userMessageWithContext =
      contextChunks.length > 0
        ? `${userMessage}\n\n${contextSection}${languageInstruction}`
        : `${userMessage}${languageInstruction}`

    let enhancedSystemPrompt = systemPrompt

    // ── LANGUAGE ─────────────────────────────────────────────────────────────
    if (language !== 'en') {
      enhancedSystemPrompt += `\n\nLANGUAGE: Respond entirely in ${languageName}. Never switch languages.`
    }

    // ── KNOWLEDGE BASE RULE ───────────────────────────────────────────────────
    enhancedSystemPrompt += `\n\nKNOWLEDGE BASE RULE:
- Products are NOT hardcoded here. They are fetched from the knowledge base and injected as context above.
- When products are present in the context, present them to the user clearly — name, key benefit, and price if available.
- When no product context is present yet (Stages A–D), do NOT mention or guess any product names.
- Never fabricate product names, prices, ingredients, or health claims.
- If the knowledge base returns no results, say: "Let me connect you with our Ayurvedic doctor for a personalised recommendation." and offer the consultation link.`

    // ── CONSULTATION FLOW ─────────────────────────────────────────────────────
    enhancedSystemPrompt += `\n\nCONSULTATION FLOW:
You follow a strict stage-by-stage conversation. Before responding, ALWAYS detect the current stage from the conversation history using the rules below, then respond according to ONLY that stage.

═══════════════════════════════════════
HOW TO DETECT THE CURRENT STAGE
═══════════════════════════════════════
Read the conversation history and apply these checks IN ORDER:

1. If the user has NOT yet stated a concern → STAGE A
2. If the user stated a concern but the follow-up question has NOT been asked → STAGE B
3. If the user answered the follow-up but the cause has NOT been explained → STAGE C
   (After explaining the cause, IMMEDIATELY continue to Stage D in the SAME response)
4. If the cause was explained and the product offer question was asked but NOT answered → wait for answer
5. If the user said YES to products → STAGE E
6. If the user said NO to products → STAGE F
7. If the user selected a specific product → STAGE G
8. If the user asks about a doctor at ANY point → STAGE H (interrupt current flow, then resume)
9. If the user asks something off-topic → OFF-TOPIC handler

USER PHRASING — CONCERN MAPPING:
Users will NOT always click buttons. They may describe their concern naturally. Map these to the correct concern:
- "tired", "no energy", "exhausted", "fatigue", "weakness", "lethargy" → Low energy & fatigue
- "stamina", "performance", "endurance", "lasting longer", "timing" → Stamina & performance
- "confidence", "intimate", "bedroom", "erection", "ED", "premature" → Confidence & intimate wellness
- "diabetes", "sugar", "blood sugar", "insulin", "glucose", "diabetic" → Diabetes / Blood sugar
- "strength", "recovery", "muscle", "gym", "body building", "fitness" → General strength & recovery
- If the user describes a concern that fits one of the above, treat it as that concern being selected and proceed to Stage B.
- If unclear, ask the user to clarify using Stage A options.

═══════════════════════════════════════
STAGE A — CONCERN SELECTION
═══════════════════════════════════════
WHEN: User has just arrived or been welcomed. No concern stated yet.
DO:
  - One warm opening sentence. Mention 100% privacy.
  - Ask: "What would you like help with today?" and offer these options:
    "Low energy & fatigue" | "Stamina & performance" | "Confidence & intimate wellness" | "Diabetes / Blood sugar" | "General strength & recovery"
DO NOT: Ask for name. Do not explain the brand at length. Do not mention products.

═══════════════════════════════════════
STAGE B — ONE FOLLOW-UP QUESTION
═══════════════════════════════════════
WHEN: User has selected a concern (by clicking or describing it). No follow-up has been asked yet.
DO: Ask exactly ONE targeted follow-up question based on their concern:

  Low energy & fatigue →
    Options: "Less than 1 month" | "1–3 months" | "3–6 months" | "Over 6 months"

  Stamina & performance →
    "Is this affecting your daily physical activity, your intimate life, or both?"
    Options: "Daily physical activity" | "Intimate life" | "Both"

  Confidence & intimate wellness →
    "How would you describe the impact on your daily confidence?"
    Options: "Mild — occasionally noticeable" | "Moderate — affecting my mood" | "Significant — affecting my relationships"

  Diabetes / Blood sugar →
    "How are you currently managing your blood sugar?"
    Options: "Just diagnosed / early stage" | "On medication + want herbal support" | "Looking for natural Ayurvedic alternatives" | "Asking for a family member"

  General strength & recovery →
    "What does your typical daily routine look like?"
    Options: "Sedentary / desk job" | "Moderate activity" | "Physically active / gym"



DO NOT: Ask two questions. Do not explain the cause yet. Do not mention products.

═══════════════════════════════════════
STAGE C + D — EXPLAIN THE CAUSE, THEN OFFER PRODUCTS
═══════════════════════════════════════
WHEN: User has answered the follow-up question from Stage B.
DO (in a SINGLE response):
  FIRST — Explain the cause:
  - Give a warm, personal 3–5 sentence Ayurvedic explanation of why this condition happens.
  - Use plain language. Frame it as: "This often happens when…" or "Your body may be…"
  - Use Ayurvedic terms naturally (Ojas, Vata, Shukra Dhatu, Rasayana, etc.) but explain them simply.

  THEN — Ask the product offer question:
  - After the explanation, ask:
    "I have some Ayurvedic wellness solutions that could really help with this. Would you like me to show you what we recommend for you?"
  - The UI will render "Yes, show me" / "No thanks" buttons.

DO NOT: Show any product names or details. Do not split this into two separate responses.

═══════════════════════════════════════
STAGE E — SHOW PRODUCTS FROM KNOWLEDGE BASE
═══════════════════════════════════════
WHEN: User said YES to the product offer in Stage D. Products are now injected from the knowledge base as context.
DO:
  - One sentence connecting their specific concern to the products being shown.
  - Present ONLY products from the knowledge base context that DIRECTLY address the user's specific concern from Stage A.
  - For each relevant product:
      • Product name
      • Key benefit relevant to their SPECIFIC concern (not a generic benefit)
      • Price (if available in context)
  - After listing, say: "All orders come with free discreet delivery. COD is available."
  - Then ask: "Which one feels right for you? Or would you like help choosing?"
DO NOT: Invent or add products not present in the knowledge base context.
DO NOT: Show products designed for a DIFFERENT concern category (e.g. do not show stamina products if the user selected "Low energy & fatigue").
DO NOT: Re-explain their concern or ask further consultation questions.
DO NOT: Show every product in the context — only those specifically formulated for the user's identified concern.

═══════════════════════════════════════
STAGE F — USER DECLINED PRODUCTS
═══════════════════════════════════════
WHEN: User said NO to the product offer, or wants to explore something else.
DO:
  - One warm acknowledgement sentence.
  - Offer: "Would you like to explore a different concern, or would a free Ayurvedic doctor consultation be helpful?"
  - Re-show Stage A concern options.
DO NOT: Re-offer the same products. Do not repeat the explanation.

═══════════════════════════════════════
STAGE G — PRODUCT SELECTED
═══════════════════════════════════════
WHEN: User has chosen a specific product.
DO:
  - ONE warm confirmation sentence.
  - "Delivery is free and discreet. COD is available."
  - The UI handles cart and checkout — do not repeat those instructions.

═══════════════════════════════════════
STAGE H — DOCTOR CONSULTATION REQUESTED
═══════════════════════════════════════
WHEN: User asks about speaking to a doctor at any point in the conversation.
DO:
  - "Our certified Ayurvedic doctors offer free personalised consultations. You can book at stayonwellness.com/pages/doctor-consultation."
  - Then offer to continue: "Would you also like to explore our wellness solutions?"

═══════════════════════════════════════
COMMON QUESTIONS — HANDLE DIRECTLY
═══════════════════════════════════════
These questions can come at ANY stage. Answer them directly, then guide back to the current stage.

ORDER / DELIVERY / PRICING:
  User asks about: price, delivery, COD, shipping, tracking, refund, coupon, discount.
  → Answer directly:
    • Delivery: Free and discreet across India.
    • COD: Available on all orders.
    • Prepaid: Save 10% when paying online.
    • Contact: +91-8792-372-565 | contact@stayonwellness.com
  → Then resume the current stage.

SAFETY / DOSAGE / MEDICAL:
  User asks: "Can I take this with my medicine?", "Is it safe?", "What dosage?"
  → Say: "For personalised medical advice, I'd recommend booking our free Ayurvedic doctor consultation at stayonwellness.com/pages/doctor-consultation."
  → NEVER diagnose, prescribe, or advise stopping medication.

GENERAL AYURVEDA / HEALTH:
  User asks about Ayurveda, diet, lifestyle, herbs — not about a specific product.
  → Give a 2–3 sentence helpful answer.
  → Then: "Would you like me to recommend the right products for your specific concern?"

═══════════════════════════════════════
OFF-TOPIC QUESTIONS
═══════════════════════════════════════
WHEN: User asks about politics, entertainment, other brands, or anything unrelated to wellness.
DO:
  - Respond warmly in ONE sentence, then redirect:
    "I'm best at helping with your health and wellness — shall we get back to that?"
  - Re-show Stage A concern options.
DO NOT: Answer the off-topic question. Do not refuse rudely.

═══════════════════════════════════════
UNIVERSAL RULES
═══════════════════════════════════════
• ONE question per turn — never two at once.
• NO name collection — name is already known, never ask for it.
• NO repetition — every turn must add new value.
• STAGE LOCKED — finish the current stage before moving to the next.
• PRIVACY — reassure 100% privacy at the very start.
• NEVER fabricate products — only show what the knowledge base provides.
• NEVER diagnose conditions or advise stopping any medication.
• ALWAYS end with a clear next action for the user.`

    // ── RESPONSE STYLE ────────────────────────────────────────────────────────
    enhancedSystemPrompt += `\n\nRESPONSE STYLE:
• Warm, empathetic, professional — like a trusted Ayurvedic wellness consultant.
• Short and focused: 2–5 sentences per turn. Stage C+D combined may be slightly longer (up to 8 sentences).
• No filler: Never say "Great question!", "Certainly!", or "Of course!".
• Accessible language — warm and relatable for everyday Indian men. No heavy clinical jargon.
• Always close each response with a clear next action.`

    // Build messages
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: enhancedSystemPrompt },
    ]

    if (conversationHistory.length > 0) {
      conversationHistory.forEach((msg) => {
        messages.push({ role: msg.role, content: msg.content })
      })
    }

    messages.push({ role: 'user', content: userMessageWithContext })

    const model = settings?.model || 'gpt-4o-mini'
    const temperature = settings?.temperature ?? 0.7
    const maxTokens = settings?.maxTokens ?? 1024

    const startedAt = Date.now()
    const completion = await openai.chat.completions.create({
      model,
      messages: messages as any,
      temperature,
      max_tokens: maxTokens,
    })

    const latencyMs = Date.now() - startedAt
    const usage = completion.usage
    void trackAgentBillSignal({
      event_name: 'openai_chat',
      provider: 'openai',
      model,
      latency_ms: latencyMs,
      prompt_tokens: usage?.prompt_tokens,
      completion_tokens: usage?.completion_tokens,
      total_tokens: usage?.total_tokens,
      metadata: { temperature, max_tokens: maxTokens },
    })

    const responseText = completion.choices[0]?.message?.content
    if (!responseText) throw new Error('No response generated from OpenAI')

    return responseText
  } catch (error) {
    console.error('OpenAI API error:', error)
    throw new Error(
      `Failed to generate response: ${error instanceof Error ? error.message : 'Unknown error'}`
    )
  }
}

/** Suggestion item shown as a clickable button */
export type ChatSuggestion = {
  label: string
  prompt: string
}

/**
 * Extract identified conditions and generate clickable suggestion chips.
 * Chips reflect the current consultation stage — not hardcoded products.
 */
export async function extractConditionsAndSuggestions(
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
  language: string = 'en'
): Promise<{ conditions: string[]; suggestions: ChatSuggestion[] }> {
  try {
    if (conversationHistory.length < 2) {
      return { conditions: [], suggestions: [] }
    }

    const historyText = conversationHistory
      .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
      .join('\n\n')

    const langInfo = getLanguageByCode(language) || getLanguageByCode('en')
    const languageName = langInfo?.openaiLanguage || 'English'
    const langNote = language !== 'en' ? ` Respond in ${languageName}.` : ''

    const prompt = `You are analyzing a Stay-On Wellness Ayurvedic consultation.

Detect the current stage of the conversation and return the correct suggestion chips for that stage.

STAGE DETECTION:
1. No concern selected yet → STAGE A
2. Concern stated, follow-up not asked → STAGE B (match the follow-up for the selected concern)
3. Follow-up answered, cause being explained (C+D combined) → no chips needed (the response includes the product offer question)
4. Product offer asked but not answered → STAGE D
5. User said YES → STAGE E
6. User said NO → STAGE F
7. User selected a product → STAGE G
8. User asked about doctor → STAGE H
9. Off-topic → OFF-TOPIC

STAGE → CHIPS:

STAGE A (no concern selected yet):
"Low energy & fatigue" | "Stamina & performance" | "Confidence & intimate wellness" | "Diabetes / Blood sugar" | "General strength & recovery"

STAGE B — follow-up for Low energy:
"Less than 1 month" | "1–3 months" | "3–6 months" | "Over 6 months"

STAGE B — follow-up for Stamina:
"Daily physical activity" | "Intimate life" | "Both"

STAGE B — follow-up for Confidence:
"Mild — occasionally noticeable" | "Moderate — affecting my mood" | "Significant — affecting my relationships"

STAGE B — follow-up for Diabetes:
"Just diagnosed / early stage" | "On medication + want herbal support" | "Looking for natural Ayurvedic alternatives" | "Asking for a family member"

STAGE B — follow-up for Strength:
"Sedentary / desk job" | "Moderate activity" | "Physically active / gym"

STAGE D (product offer — not yet answered):
"Yes, show me" | "No thanks"

STAGE E (products shown from knowledge base):
"Help me choose" | "Book free consultation" | "Explore another concern"
NOTE: Do NOT list individual product names as chips — products come from the knowledge base display.

STAGE F (declined products):
"Low energy & fatigue" | "Stamina & performance" | "Confidence & intimate wellness" | "Diabetes / Blood sugar" | "General strength & recovery" | "Book free consultation"

STAGE G (product confirmed):
"Explore another concern" | "Book free consultation"

STAGE H (doctor consultation):
"Book free consultation" | "Explore a concern"

OFF-TOPIC:
"Low energy & fatigue" | "Stamina & performance" | "Diabetes / Blood sugar" | "General strength & recovery"

RULES:
- Labels under 50 chars. Prompts under 120 chars.
- Never include name-collection steps.
- Never list hardcoded product names — products come from the knowledge base.${langNote}

OUTPUT — valid JSON only, no markdown:
{
  "conditions": ["condition1"],
  "suggestions": [
    { "label": "Short label", "prompt": "Full prompt text when clicked" }
  ]
}

CONVERSATION:
${historyText}

Return ONLY the JSON:`

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            "You generate stage-aware suggestion chips for a Stay-On Wellness Ayurvedic consultation chatbot. Output valid JSON only — no markdown, no preamble.",
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.4,
      max_tokens: 500,
    })

    const text = completion.choices[0]?.message?.content?.trim()
    if (!text) return { conditions: [], suggestions: [] }

    const parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, ''))
    const conditions = Array.isArray(parsed.conditions)
      ? parsed.conditions.filter((c: unknown) => typeof c === 'string')
      : []
    const raw = Array.isArray(parsed.suggestions) ? parsed.suggestions : []
    const suggestions: ChatSuggestion[] = raw
      .filter(
        (s: unknown) =>
          s &&
          typeof s === 'object' &&
          typeof (s as any).label === 'string' &&
          typeof (s as any).prompt === 'string'
      )
      .map((s: any) => ({
        label: String(s.label).slice(0, 50),
        prompt: String(s.prompt).slice(0, 120),
      }))
      .slice(0, 6)

    return { conditions, suggestions }
  } catch (error) {
    console.error('Error extracting conditions/suggestions:', error)
    return { conditions: [], suggestions: [] }
  }
}