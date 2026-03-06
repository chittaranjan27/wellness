/**
 * Speech-to-Text API Route
 * Note: For production, use browser-based Web Speech API or external service
 * This endpoint can be used to process server-side audio files if needed
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth-options'
import { endAgentBillSpan, startAgentBillSpan, trackAgentBillSignal } from '@/lib/agentbill'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    const origin = request.headers.get('origin') || ''
    const referer = request.headers.get('referer') || ''
    const isEmbedRequest = origin.includes('/embed/') || referer.includes('/embed/')

    if (!session?.user?.email && !isEmbedRequest) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json().catch(() => ({}))
    const transcript = typeof body?.transcript === 'string' ? body.transcript : ''
    const language = typeof body?.language === 'string' ? body.language : 'en'
    const model = typeof body?.model === 'string' ? body.model : 'web_speech_api'
    const latencyMs = typeof body?.latency_ms === 'number' ? body.latency_ms : undefined

    const spanContext = startAgentBillSpan('voice.speech_to_text', {
      'gen_ai.system': 'web_speech_api',
      'gen_ai.request.model': model,
      'gen_ai.operation.name': 'speech_to_text',
      model,
      provider: 'web_speech_api',
      'voice.language': language,
    })

    void trackAgentBillSignal({
      event_name: 'voice_stt',
      provider: 'web_speech_api',
      model,
      latency_ms: latencyMs,
      metadata: {
        model,
        language,
        isEmbedRequest,
        userEmail: session?.user?.email || null,
        transcript_characters: transcript.length,
      },
    })

    if (spanContext) {
      endAgentBillSpan(spanContext.spanId, {
        latency_ms: latencyMs ?? 0,
        input_characters: transcript.length,
      })
    }

    return NextResponse.json({
      message: 'Speech-to-text tracking recorded',
      transcript,
    })
  } catch (error) {
    console.error('Speech-to-text error:', error)
    return NextResponse.json({ error: 'Failed to process speech' }, { status: 500 })
  }
}
