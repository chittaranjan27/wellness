/**
 * Dashboard Chat API Route (authenticated)
 * Handles chat messages for the agent preview panel in the dashboard.
 * Consultation flows exclusively use /api/db-consultation.
 * This route serves: RAG-based general chat + product lookup for dashboard previews.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth-options'
import { prisma } from '@/lib/prisma'
import { generateChatResponse } from '@/lib/openai'
import { generateEmbedding } from '@/lib/embeddings'
import { findSimilarChunks } from '@/lib/vector-db'
import {
  buildProductResults,
  isProductRequest,
  isAcceptingProductOffer,
  type ProductSource,
} from '@/lib/product.service'

export const runtime = 'nodejs'

// ─── GET: fetch message history ──────────────────────────────────────────────
export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const agentId = searchParams.get('agentId')
    if (!agentId) {
      return NextResponse.json({ error: 'Missing agentId' }, { status: 400 })
    }

    const user = await prisma.user.findUnique({ where: { email: session.user.email } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const agent = await prisma.agent.findFirst({ where: { id: agentId, userId: user.id } })
    if (!agent) return NextResponse.json({ error: 'Agent not found or access denied' }, { status: 403 })

    const messages = await prisma.chatMessage.findMany({
      where: { agentId },
      orderBy: { createdAt: 'asc' },
    })
    return NextResponse.json({ messages })
  } catch (error) {
    console.error('Chat messages API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch messages', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

// ─── POST: send a message ────────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { agentId, message, language } = body
    if (!agentId || !message) {
      return NextResponse.json({ error: 'Missing agentId or message' }, { status: 400 })
    }

    const user = await prisma.user.findUnique({ where: { email: session.user.email } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const agent = await prisma.agent.findFirst({
      where: { id: agentId, userId: user.id },
      include: { documents: { where: { status: 'completed' } }, settings: true },
    })
    if (!agent) return NextResponse.json({ error: 'Agent not found or access denied' }, { status: 403 })

    const responseLanguage = language || agent.language || 'en'

    // Parallel: embedding + recent messages
    const [queryEmbeddingOrNull, recentMessages] = await Promise.all([
      agent.documents.length > 0 ? generateEmbedding(message) : Promise.resolve(null),
      prisma.chatMessage.findMany({
        where: { agentId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { role: true, content: true },
      }),
    ])

    const conversationHistory = recentMessages
      .reverse()
      .map((msg) => ({ role: msg.role as 'user' | 'assistant', content: msg.content }))

    const lastAssistantMessage =
      [...conversationHistory].reverse().find((m) => m.role === 'assistant')?.content ?? null

    const productRequest = Boolean(
      isProductRequest(message) || isAcceptingProductOffer(message, lastAssistantMessage)
    )

    // RAG context
    let contextChunks: string[] = []
    let relatedDocuments: ProductSource[] = []
    if (agent.documents.length > 0 && queryEmbeddingOrNull) {
      try {
        const similar = await findSimilarChunks(queryEmbeddingOrNull, agentId, 4)
        if (similar.length > 0) {
          const chunkIds = similar.map((c) => c.chunkId)
          const chunks = await prisma.documentChunk.findMany({
            where: { id: { in: chunkIds }, document: { agentId } },
            select: { text: true, documentId: true },
          })
          contextChunks = chunks.map((c) => c.text)
          const docIds = Array.from(new Set(chunks.map((c) => c.documentId)))
          if (docIds.length > 0) {
            relatedDocuments = await prisma.document.findMany({ where: { id: { in: docIds } } }) as ProductSource[]
          }
        }
      } catch (err) {
        console.error('[RAG] Error:', err)
      }
    }

    const agentSettings = agent.settings
      ? { temperature: agent.settings.temperature ?? undefined, model: agent.settings.model ?? undefined, maxTokens: agent.settings.maxTokens ?? undefined }
      : undefined
    const systemPrompt = (agent.settings as any)?.systemPrompt || agent.systemPrompt

    // Fetch products + generate response (parallel when product request)
    let responseText: string
    let products: Awaited<ReturnType<typeof buildProductResults>> = []

    const baseDocs = relatedDocuments.length
      ? relatedDocuments
      : await prisma.document.findMany({
          where: { agentId, filepath: { startsWith: 'http' } },
          orderBy: { createdAt: 'desc' },
          take: 30,
          select: { id: true, filepath: true, filename: true, extractedText: true },
        }) as ProductSource[]

    if (productRequest) {
      const productPageDocs = await prisma.document.findMany({
        where: { agentId, AND: [{ filepath: { startsWith: 'http' } }, { filepath: { contains: '/product/' } }] },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true, filepath: true, filename: true, extractedText: true },
      }) as ProductSource[]
      const seen = new Set(baseDocs.map((d) => d.id))
      const docs = [...productPageDocs.filter((d) => !seen.has(d.id) && (seen.add(d.id), true)), ...baseDocs]

      const [text, productResults] = await Promise.all([
        generateChatResponse(systemPrompt, message, contextChunks, responseLanguage, conversationHistory, agentSettings),
        buildProductResults(docs, 5, conversationHistory, undefined, agentId),
      ])
      responseText = text
      products = productResults
    } else {
      responseText = await generateChatResponse(
        systemPrompt, message, contextChunks, responseLanguage, conversationHistory, agentSettings
      )
    }

    // Save messages
    await prisma.chatMessage.createMany({
      data: [
        { agentId, role: 'user', content: message, metadata: { contextChunksCount: contextChunks.length } },
        { agentId, role: 'assistant', content: responseText, metadata: { contextChunksCount: contextChunks.length } },
      ],
    })

    return NextResponse.json({
      response: responseText,
      contextUsed: contextChunks.length > 0,
      products: products.length > 0 ? products : null,
    })
  } catch (error) {
    console.error('Chat API error:', error)
    return NextResponse.json(
      { error: 'Failed to process chat message', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

// ─── DELETE: clear chat history ───────────────────────────────────────────────
export async function DELETE(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const agentId = searchParams.get('agentId')
    if (!agentId) return NextResponse.json({ error: 'Missing agentId' }, { status: 400 })

    const user = await prisma.user.findUnique({ where: { email: session.user.email } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const agent = await prisma.agent.findFirst({ where: { id: agentId, userId: user.id } })
    if (!agent) return NextResponse.json({ error: 'Agent not found or access denied' }, { status: 403 })

    await prisma.chatMessage.deleteMany({ where: { agentId } })
    return NextResponse.json({ success: true, message: 'Chat cleared successfully' })
  } catch (error) {
    console.error('Clear chat API error:', error)
    return NextResponse.json(
      { error: 'Failed to clear chat', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}