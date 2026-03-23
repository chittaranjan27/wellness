/**
 * OpenAI Chat Client
 * Handles chat completions with RAG context injection.
 * Consultation flow is handled exclusively by /api/db-consultation.
 * This module is now a lightweight wrapper used only for non-consultation
 * purposes (report generation, product search, general chat).
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
 * Generate chat completion — general purpose (reports, product search, offers).
 * Consultation responses are handled exclusively by /api/db-consultation.
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

    // Inject any RAG product context chunks
    let contextSection = ''
    if (contextChunks.length > 0) {
      contextSection = `\n\nPRODUCT CONTEXT:\n${contextChunks
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

    // Build messages
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
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
 * Extract conditions and suggestions for general (non-consultation) chat.
 * Returns empty for now — the new /api/db-consultation endpoint
 * handles chip generation natively from DB node choices.
 */
export async function extractConditionsAndSuggestions(
  _conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
  _language: string = 'en'
): Promise<{ conditions: string[]; suggestions: ChatSuggestion[] }> {
  return { conditions: [], suggestions: [] }
}