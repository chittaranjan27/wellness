/**
 * Chat API Route
 * Handles chat messages with RAG context retrieval
 * Uses Node.js runtime (default, no edge functions)
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth-options'
import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import { generateChatResponse, extractConditionsAndSuggestions } from '@/lib/openai'
import { generateEmbedding } from '@/lib/embeddings'
import { findSimilarChunks } from '@/lib/vector-db'
import { buildProductResults, listProductsFromDocuments, isProductRequest, isAcceptingProductOffer, type ProductSource, extractRecommendedProductNames } from '@/lib/product.service'

export const runtime = 'nodejs' // Explicitly set Node.js runtime

export async function GET(request: NextRequest) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions)
    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const agentId = searchParams.get('agentId')

    if (!agentId) {
      return NextResponse.json({ error: 'Missing agentId' }, { status: 400 })
    }

    // Get user
    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Verify agent ownership (security: ensure user owns the agent)
    const agent = await prisma.agent.findFirst({
      where: {
        id: agentId,
        userId: user.id,
      },
    })

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found or access denied' }, { status: 403 })
    }

    // Fetch all messages for this agent
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

export async function POST(request: NextRequest) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions)
    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { agentId, message, language } = body

    if (!agentId || !message) {
      return NextResponse.json({ error: 'Missing agentId or message' }, { status: 400 })
    }

    // Get user
    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Verify agent ownership (security: ensure user owns the agent)
    const agent = await prisma.agent.findFirst({
      where: {
        id: agentId,
        userId: user.id,
      },
      include: {
        documents: {
          where: { status: 'completed' },
        },
        settings: true,
      },
    })

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found or access denied' }, { status: 403 })
    }

    // Run RAG embedding + conversation history fetches in parallel for faster response
    const responseLanguage = language || agent.language || 'en'
    const startTime = Date.now()

    const [queryEmbeddingOrNull, recentMessages, fullConversationHistory] = await Promise.all([
      agent.documents.length > 0 ? generateEmbedding(message) : Promise.resolve(null),
      prisma.chatMessage.findMany({
        where: { agentId },
        orderBy: { createdAt: 'desc' },
        take: 4,
        select: { role: true, content: true },
      }),
      prisma.chatMessage.findMany({
        where: { agentId },
        orderBy: { createdAt: 'asc' },
        take: 50,
        select: { role: true, content: true },
      }),
    ])

    const conversationHistory = recentMessages.reverse().map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    }))
    const lastAssistantMessage = conversationHistory.length > 0
      ? [...conversationHistory].reverse().find((m) => m.role === 'assistant')?.content ?? null
      : null
    const productRequest = Boolean(
      message && (isProductRequest(message) || isAcceptingProductOffer(message, lastAssistantMessage))
    )
    const historyToUse = conversationHistory
    const isFollowUp = conversationHistory.length > 0
    const fullHistoryTyped = fullConversationHistory.map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    }))

    // RAG: resolve context chunks using embedding (when we have documents)
    let contextChunks: string[] = []
    let relatedDocuments: ProductSource[] = []
    if (agent.documents.length > 0 && queryEmbeddingOrNull) {
      try {
        const similarChunks = await findSimilarChunks(queryEmbeddingOrNull, agentId, 4)
        if (similarChunks.length > 0) {
          const chunkIds = similarChunks.map((c) => c.chunkId)
          const chunks = await prisma.documentChunk.findMany({
            where: { id: { in: chunkIds }, document: { agentId } },
            select: { text: true, documentId: true },
          })
          contextChunks = chunks.map((c) => c.text)
          const documentIds = Array.from(new Set(chunks.map((c) => c.documentId)))
          if (documentIds.length > 0) {
            relatedDocuments = await prisma.document.findMany({
              where: { id: { in: documentIds } },
            })
          }
        }
      } catch (error) {
        console.error('[RAG] Error retrieving context:', error)
      }
    }

    const agentSettings = agent.settings
      ? {
        temperature: agent.settings.temperature ?? undefined,
        model: agent.settings.model ?? undefined,
        maxTokens: agent.settings.maxTokens ?? undefined,
      }
      : undefined
    const systemPrompt = agent.settings?.systemPrompt || agent.systemPrompt

    const baseDocs = relatedDocuments.length
      ? relatedDocuments
      : await prisma.document.findMany({
        where: { agentId, filepath: { startsWith: 'http' } },
        orderBy: { createdAt: 'desc' },
        take: 30,
        select: { id: true, filepath: true, filename: true, extractedText: true },
      })
    const productPageDocs = productRequest
      ? await prisma.document.findMany({
        where: {
          agentId,
          AND: [
            { filepath: { startsWith: 'http' } },
            { filepath: { contains: '/product/' } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true, filepath: true, filename: true, extractedText: true },
      })
      : []
    const seenIds = new Set(baseDocs.map((d) => d.id))
    const docsForProducts = productRequest
      ? [
        ...productPageDocs.filter((d) => !seenIds.has(d.id) && (seenIds.add(d.id), true)),
        ...baseDocs,
      ]
      : baseDocs

    // When product request: run LLM and product results in parallel
    let responseText: string
    let products: Awaited<ReturnType<typeof buildProductResults>> = []
    try {
      if (productRequest) {
        const [text, productResults] = await Promise.all([
          generateChatResponse(
            systemPrompt,
            message,
            contextChunks,
            responseLanguage,
            historyToUse,
            agentSettings
          ),
          buildProductResults(
            docsForProducts,
            5,
            fullHistoryTyped,
            undefined,
            agentId
          ),
        ])
        responseText = text
        products = productResults
      } else {
        responseText = await generateChatResponse(
          systemPrompt,
          message,
          contextChunks,
          responseLanguage,
          historyToUse,
          agentSettings
        )
      }
    } catch (error) {
      throw error
    }

    // AUTOMATIC PRODUCT DETECTION: Check if assistant response contains product recommendations
    // If so, automatically fetch and display products (don't wait for user to ask)
    if (!productRequest) {
      const updatedHistoryWithResponse = [...fullHistoryTyped, { role: 'user' as const, content: message }, { role: 'assistant' as const, content: responseText }]
      const recommendedNames = await extractRecommendedProductNames(undefined, updatedHistoryWithResponse)

      if (recommendedNames.length > 0) {
        console.log(`[Chat] Auto-detected ${recommendedNames.length} product recommendations in assistant response`)
        // Fetch products automatically
        const productPageDocs = await prisma.document.findMany({
          where: {
            agentId,
            AND: [
              { filepath: { startsWith: 'http' } },
              { filepath: { contains: '/product/' } },
            ],
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: { id: true, filepath: true, filename: true, extractedText: true },
        })
        const seenIds = new Set(baseDocs.map((d) => d.id))
        const docsForProducts = [
          ...productPageDocs.filter((d) => !seenIds.has(d.id) && (seenIds.add(d.id), true)),
          ...baseDocs,
        ]
        products = await buildProductResults(
          docsForProducts,
          10, // Return up to 10 products
          updatedHistoryWithResponse as Array<{ role: 'user' | 'assistant'; content: string }>,
          undefined, // reportData
          agentId // Enable caching and reuse
        )
        console.log(`[Chat] Auto-fetched ${products.length} products for recommendations`)
      }
    }

    // Extract conditions and suggestions (consultation phase only; skip when products)
    let suggestions: Array<{ label: string; prompt: string }> = []
    if (products.length === 0) {
      try {
        const historyForExtraction = [
          ...fullHistoryTyped,
          { role: 'user' as const, content: message },
          { role: 'assistant' as const, content: responseText },
        ]
        const extracted = await extractConditionsAndSuggestions(historyForExtraction, responseLanguage)
        if (extracted.suggestions.length > 0) {
          suggestions = extracted.suggestions
          console.log(`[Chat] Extracted ${extracted.conditions.length} conditions, ${suggestions.length} suggestions`)
        }
      } catch (extractErr) {
        console.error('[Chat] Suggestion extraction failed:', extractErr)
      }
    }

    const responseTime = Date.now() - startTime

    // Save user message and assistant response to database
    await prisma.chatMessage.createMany({
      data: [
        {
          agentId,
          role: 'user',
          content: message,
          metadata: {
            contextChunksCount: contextChunks.length,
            isFollowUp,
          },
        },
        {
          agentId,
          role: 'assistant',
          content: responseText,
          metadata: {
            contextChunksCount: contextChunks.length,
            isFollowUp,
          },
        },
      ],
    })


    return NextResponse.json({
      response: responseText,
      contextUsed: contextChunks.length > 0,
      isFollowUp,
      products: products.length > 0 ? products : null,
      suggestions: suggestions.length > 0 ? suggestions : null,
    })
  } catch (error) {
    console.error('Chat API error:', error)
    return NextResponse.json(
      { error: 'Failed to process chat message', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

export async function DELETE(request: NextRequest) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions)
    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const agentId = searchParams.get('agentId')

    if (!agentId) {
      return NextResponse.json({ error: 'Missing agentId' }, { status: 400 })
    }

    // Get user
    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Verify agent ownership (security: ensure user owns the agent)
    const agent = await prisma.agent.findFirst({
      where: {
        id: agentId,
        userId: user.id,
      },
    })

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found or access denied' }, { status: 403 })
    }

    // Delete all messages for this agent
    await prisma.chatMessage.deleteMany({
      where: { agentId },
    })

    return NextResponse.json({ success: true, message: 'Chat cleared successfully' })
  } catch (error) {
    console.error('Clear chat API error:', error)
    return NextResponse.json(
      { error: 'Failed to clear chat', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}