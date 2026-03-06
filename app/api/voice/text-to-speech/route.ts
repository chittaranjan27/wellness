/**
 * Text-to-Speech API Route
 * Uses ElevenLabs API to generate speech from text
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth-options'
import { ElevenLabsClient } from 'elevenlabs'
import { env } from '@/lib/env'
import { endAgentBillSpan, startAgentBillSpan, trackAgentBillSignal } from '@/lib/agentbill'

export const runtime = 'nodejs'

const elevenlabs = new ElevenLabsClient({
  apiKey: env.ELEVENLABS_API_KEY,
})

export async function POST(request: NextRequest) {
  try {
    // Allow public access for embedded chats
    // Note: In production, consider adding rate limiting or other protections
    const session = await getServerSession(authOptions)
    const origin = request.headers.get('origin') || ''
    const referer = request.headers.get('referer') || ''
    
    // Allow if authenticated OR if request is from embed page
    const isEmbedRequest = origin.includes('/embed/') || referer.includes('/embed/')
    
    if (!session?.user?.email && !isEmbedRequest) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { text, language = 'en', voiceId } = body

    if (!text) {
      return NextResponse.json({ error: 'Missing text' }, { status: 400 })
    }

    // Import language utilities
    const { getLanguageByCode, getDefaultLanguage } = await import('@/lib/languages')
    
    // Get voice ID based on language if not provided
    const langInfo = getLanguageByCode(language) || getDefaultLanguage()
    const selectedVoiceId = voiceId || langInfo.elevenlabsVoiceId || '21m00Tcm4TlvDq8ikWAM'

    // Use multilingual model for non-English languages
    const modelId = language === 'en' ? 'eleven_monolingual_v1' : 'eleven_multilingual_v2'

    const startedAt = Date.now()
    const spanContext = startAgentBillSpan('elevenlabs.text_to_speech', {
      'gen_ai.system': 'elevenlabs',
      'gen_ai.request.model': modelId,
      'gen_ai.operation.name': 'text_to_speech',
      model: modelId,
      provider: 'elevenlabs',
      'voice.id': selectedVoiceId,
      'voice.language': language,
    })

    // Generate speech using ElevenLabs
    let audio
    try {
      audio = await elevenlabs.generate({
        voice: selectedVoiceId,
        text: text,
        model_id: modelId,
      })
    } catch (error) {
      if (spanContext) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        endAgentBillSpan(
          spanContext.spanId,
          {
            error: true,
            'error.message': message,
          },
          { code: 2, message }
        )
      }
      throw error
    }

    const latencyMs = Date.now() - startedAt
    if (spanContext) {
      endAgentBillSpan(spanContext.spanId, {
        latency_ms: latencyMs,
        input_characters: text.length,
      })
    }

    // Track usage with AgentBill (non-blocking, optional)
    void trackAgentBillSignal({
      event_name: 'voice_tts',
      provider: 'elevenlabs',
      model: modelId,
      latency_ms: latencyMs,
      metadata: {
        model: modelId,
        voiceId: selectedVoiceId,
        language,
        isEmbedRequest,
        userEmail: session?.user?.email || null,
        input_characters: text.length,
      },
    })

    // Stream audio directly to client for faster playback
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of audio) {
            controller.enqueue(chunk)
          }
          controller.close()
        } catch (error) {
          controller.error(error)
        }
      },
    })

    // Return streaming audio response
    return new Response(stream, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Disposition': 'inline; filename="speech.mp3"',
      },
    })
  } catch (error) {
    console.error('Text-to-speech error:', error)
    return NextResponse.json(
      { error: 'Failed to generate speech', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
