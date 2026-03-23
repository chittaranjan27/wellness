/**
 * GET /api/agents/[id]/conversations
 * Returns all chat sessions for an agent with their messages and token estimates.
 * Token usage is computed as: ceil(chars / 4) — standard LLM approximation.
 * If the message metadata already carries real token fields they are used instead.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth-options'
import { prisma } from '@/lib/prisma'

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      select: { id: true },
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    // Verify ownership
    const agent = await prisma.agent.findFirst({
      where: { id: params.id, userId: user.id },
      select: { id: true, name: true },
    })
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 403 })

    // Fetch all sessions for this agent, newest first
    const sessions = await prisma.$queryRawUnsafe<Array<{
      id: string
      visitorId: string | null
      startedAt: string
      endedAt: string | null
      createdAt: string
    }>>(
      `SELECT id, "visitorId", "startedAt", "endedAt", "createdAt"
       FROM chat_sessions
       WHERE "agentId" = $1
       ORDER BY "startedAt" DESC`,
      params.id
    )

    // Fetch all messages for this agent grouped by sessionId
    const allMessages = await prisma.chatMessage.findMany({
      where: { agentId: params.id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        sessionId: true,
        role: true,
        content: true,
        metadata: true,
        createdAt: true,
      },
    })

    // Group messages by sessionId
    const messagesBySession: Record<string, typeof allMessages> = {}
    for (const msg of allMessages) {
      const sid = msg.sessionId ?? '__no_session__'
      if (!messagesBySession[sid]) messagesBySession[sid] = []
      messagesBySession[sid].push(msg)
    }

    // Build the response
    const result = sessions.map((s) => {
      const msgs = messagesBySession[s.id] ?? []

      let totalPromptTokens = 0
      let totalCompletionTokens = 0
      let totalTokens = 0

      const messages = msgs.map((m, idx) => {
        const meta = (m.metadata as Record<string, unknown>) ?? {}
        // Use real token data if available; otherwise estimate
        const promptTok = typeof meta.promptTokens === 'number' ? meta.promptTokens : 0
        const completionTok = typeof meta.completionTokens === 'number' ? meta.completionTokens : 0
        const estimated = estimateTokens(m.content)
        const tokensForTurn = promptTok + completionTok > 0 ? promptTok + completionTok : estimated

        if (m.role === 'assistant') {
          totalCompletionTokens += completionTok > 0 ? completionTok : estimated
          totalPromptTokens += promptTok
        } else {
          totalPromptTokens += promptTok > 0 ? promptTok : estimated
        }
        totalTokens += tokensForTurn

        return {
          id: m.id,
          index: idx + 1,
          role: m.role as 'user' | 'assistant',
          content: m.content,
          createdAt: m.createdAt,
          tokens: tokensForTurn,
          isEstimated: promptTok + completionTok === 0,
          metadata: meta,
        }
      })

      // Duration in seconds
      const startMs = new Date(s.startedAt).getTime()
      const endMs = s.endedAt ? new Date(s.endedAt).getTime()
        : msgs.length > 0 ? new Date(msgs[msgs.length - 1].createdAt).getTime()
        : startMs
      const durationSec = Math.round((endMs - startMs) / 1000)

      return {
        sessionId: s.id,
        visitorId: s.visitorId,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationSec,
        messageCount: msgs.length,
        tokenUsage: {
          totalTokens,
          totalPromptTokens,
          totalCompletionTokens,
          isEstimated: messages.some((m) => m.isEstimated),
        },
        messages,
      }
    })

    // Also handle messages with no session
    const noSessionMsgs = messagesBySession['__no_session__'] ?? []
    if (noSessionMsgs.length > 0) {
      let totalTokens = 0
      const messages = noSessionMsgs.map((m, idx) => {
        const est = estimateTokens(m.content)
        totalTokens += est
        return {
          id: m.id,
          index: idx + 1,
          role: m.role as 'user' | 'assistant',
          content: m.content,
          createdAt: m.createdAt,
          tokens: est,
          isEstimated: true,
          metadata: (m.metadata as Record<string, unknown>) ?? {},
        }
      })
      result.push({
        sessionId: '__no_session__',
        visitorId: null,
        startedAt: noSessionMsgs[0].createdAt.toISOString(),
        endedAt: null,
        durationSec: 0,
        messageCount: noSessionMsgs.length,
        tokenUsage: {
          totalTokens,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          isEstimated: true,
        },
        messages,
      })
    }

    return NextResponse.json({
      agentId: agent.id,
      agentName: agent.name,
      totalSessions: result.length,
      totalMessages: allMessages.length,
      totalTokensEstimated: result.reduce((sum, s) => sum + s.tokenUsage.totalTokens, 0),
      sessions: result,
    })
  } catch (error) {
    console.error('[Conversations API] Error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch conversations', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 }
    )
  }
}
