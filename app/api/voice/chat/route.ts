/**
 * /api/voice/chat
 *
 * Free-flowing voice conversation endpoint.
 * Completely separate from the consultation flow.
 * No predefined stages, no sales script, no product detection.
 *
 * Intent: A natural, phone-call-style conversation where the user
 * speaks and the AI specialist responds conversationally.
 */
import { NextRequest, NextResponse } from 'next/server'
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

// ─── System prompt ─────────────────────────────────────────────────────────────
function buildSystemPrompt(language: string, languageName: string): string {
  let prompt =
    `You are a friendly, empathetic wellness specialist at Wellness AI. ` +
    `Your role is to have a natural, supportive voice conversation with the user about their health and wellness concerns. ` +
    `Listen carefully to what they say, ask thoughtful follow-up questions, and offer general wellness guidance. ` +
    `Be warm, conversational, and concise — this is a voice call, so keep responses short (2–3 sentences max). ` +
    `Do not follow any predefined script or consultation stages. Just converse naturally like a caring health advisor. ` +
    `Do not use bullet points, markdown, or lists — only plain spoken language.`

  if (language !== 'en') {
    prompt += `\n\nLANGUAGE: Respond entirely in ${languageName}. Never switch to another language.`
  }

  return prompt
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin')
  const cors = corsHeaders(origin)

  try {
    const body = await req.json()
    const {
      message,
      language = 'en',
      conversationHistory = [],
    } = body

    if (!message?.trim()) {
      return NextResponse.json({ error: 'Missing message' }, { status: 400, headers: cors })
    }

    // Build messages array
    const langInfo = getLanguageByCode(language)
    const languageName = langInfo?.openaiLanguage || 'English'
    const systemPrompt = buildSystemPrompt(language, languageName)

    const llmMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      ...(conversationHistory as Array<{ role: 'user' | 'assistant'; content: string }>).slice(-20),
      { role: 'user', content: message.trim() },
    ]

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: llmMessages as any,
      temperature: 0.75,
      max_tokens: 200, // Short conversational replies for voice
    })

    const responseText = completion.choices[0]?.message?.content?.trim() || ''

    return NextResponse.json({ response: responseText }, { headers: cors })
  } catch (error) {
    console.error('[voice/chat] Error:', error)
    return NextResponse.json(
      {
        error: 'Voice chat failed',
        details: error instanceof Error ? error.message : 'Unknown',
      },
      { status: 500, headers: cors }
    )
  }
}
