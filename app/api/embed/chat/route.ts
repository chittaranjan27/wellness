/**
 * Public Embed Chat API Route — "Offers & Products" mode
 *
 * Consultation is handled exclusively by /api/db-consultation.
 * This route handles:
 *   1. Visitor / session tracking
 *   2. OTP email actions (get_profile, update_profile, request_otp, verify_otp)
 *   3. General / "Offers" chat with RAG + product lookup
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { generateChatResponse } from '@/lib/openai'
import { generateEmbedding } from '@/lib/embeddings'
import { findSimilarChunks } from '@/lib/vector-db'
import { createHash } from 'crypto'
import { sendOtpEmail } from '@/lib/email'
import {
  buildProductResults,
  isProductRequest,
  isAcceptingProductOffer,
  type ProductResult,
  type ProductSource,
} from '@/lib/product.service'

export const runtime = 'nodejs'

const prismaAny = prisma as any

// ─── CORS helper ─────────────────────────────────────────────────────────────
function cors(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 200, headers: cors(req.headers.get('origin')) })
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin')
  const corsHeaders = cors(origin)

  try {
    const body = await request.json()
    const { agentId, message, language, visitorId, sessionId, action, profile, email, code } = body

    if (!agentId) {
      return NextResponse.json({ error: 'Missing agentId' }, { status: 400, headers: corsHeaders })
    }
    if (!message && !action) {
      return NextResponse.json({ error: 'Missing message' }, { status: 400, headers: corsHeaders })
    }

    // Client IP / user-agent for visitor tracking
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0] ||
      request.headers.get('x-real-ip') ||
      'unknown'
    const userAgent = request.headers.get('user-agent') || 'unknown'

    const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString()
    const hashOtp = (otp: string) => createHash('sha256').update(otp).digest('hex')

    // ── Visitor tracking ────────────────────────────────────────────────────
    // Use upsert (atomic find-or-create) to avoid race-condition P2002 errors
    // when two requests arrive simultaneously with the same visitorId.
    let visitor: any = null
    if (visitorId) {
      try {
        if (prismaAny.visitor?.upsert) {
          visitor = await prismaAny.visitor.upsert({
            where: { id: visitorId },
            create: { id: visitorId, agentId, ip, userAgent, firstSeen: new Date(), lastSeen: new Date() },
            update: { lastSeen: new Date() },
          })
        }
      } catch (err: any) {
        // Silently skip if the visitors table doesn't exist yet (migration pending)
        const isTableMissing = err?.code === 'P2021' || err?.message?.includes('does not exist')
        if (!isTableMissing) {
          console.error('[EmbedChat] Visitor tracking error:', err)
        }
      }
    }

    // ── Session tracking ────────────────────────────────────────────────────
    if (sessionId && visitorId) {
      try {
        if (prismaAny.chatSession?.createMany) {
          await prismaAny.chatSession.createMany({
            data: [{ id: sessionId, visitorId, agentId, startedAt: new Date() }],
            skipDuplicates: true,
          })
        }
      } catch (err: any) {
        if (!err?.message?.includes('does not exist')) {
          console.error('[EmbedChat] Session tracking error:', err)
        }
      }
    }

    // ── Load agent ──────────────────────────────────────────────────────────
    let agent: any = null
    try {
      agent = await prisma.agent.findUnique({
        where: { id: agentId },
        include: { documents: { where: { status: 'completed' } }, settings: true },
      })
    } catch {
      agent = await prisma.agent.findUnique({
        where: { id: agentId },
        include: { documents: { where: { status: 'completed' } } },
      })
    }
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404, headers: corsHeaders })
    }

    // ── Action handlers (profile / OTP) ─────────────────────────────────────
    const isProfileComplete = (p: any) => Boolean(p?.name)

    if (action) {
      if (!visitorId) {
        return NextResponse.json({ error: 'Missing visitorId' }, { status: 400, headers: corsHeaders })
      }
      if (!prismaAny.visitor?.upsert) {
        return NextResponse.json(
          { error: 'Visitor model not available. Run: npx prisma generate' },
          { status: 500, headers: corsHeaders }
        )
      }

      // Use the visitor already fetched/created at the top of this request,
      // or do a safe upsert as fallback (no race-condition risk).
      const ensuredVisitor =
        visitor ??
        (await prismaAny.visitor.upsert({
          where: { id: visitorId },
          create: { id: visitorId, agentId, ip, userAgent, firstSeen: new Date(), lastSeen: new Date() },
          update: { lastSeen: new Date() },
        }))

      if (action === 'get_profile') {
        return NextResponse.json(
          { profile: ensuredVisitor, profileComplete: isProfileComplete(ensuredVisitor) },
          { headers: corsHeaders }
        )
      }

      if (action === 'update_profile') {
        const updates = profile || {}
        const emailChanged = updates.email && updates.email !== ensuredVisitor.email
        const updated = await prismaAny.visitor.update({
          where: { id: visitorId },
          data: {
            name: updates.name ?? ensuredVisitor.name,
            age: typeof updates.age === 'number' ? updates.age : ensuredVisitor.age,
            origin: updates.origin ?? ensuredVisitor.origin,
            phone: updates.phone !== undefined ? updates.phone : ensuredVisitor.phone,
            phoneSkipped: updates.phoneSkipped ?? ensuredVisitor.phoneSkipped,
            email: updates.email ?? ensuredVisitor.email,
            emailVerifiedAt: emailChanged ? null : ensuredVisitor.emailVerifiedAt,
            emailOtpHash: emailChanged ? null : ensuredVisitor.emailOtpHash,
            emailOtpExpiresAt: emailChanged ? null : ensuredVisitor.emailOtpExpiresAt,
            emailOtpAttempts: emailChanged ? 0 : ensuredVisitor.emailOtpAttempts,
            lastSeen: new Date(),
          },
        })
        const complete = isProfileComplete(updated)
        const final =
          complete && !updated.profileCompletedAt
            ? await prismaAny.visitor.update({ where: { id: visitorId }, data: { profileCompletedAt: new Date() } })
            : updated
        return NextResponse.json({ profile: final, profileComplete: isProfileComplete(final) }, { headers: corsHeaders })
      }

      if (action === 'request_otp') {
        const otpEmail = email || ensuredVisitor.email
        if (!otpEmail) {
          return NextResponse.json({ error: 'Missing email' }, { status: 400, headers: corsHeaders })
        }
        const otpCode = generateOtp()
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
        await prismaAny.visitor.update({
          where: { id: visitorId },
          data: {
            email: otpEmail,
            emailOtpHash: hashOtp(otpCode),
            emailOtpExpiresAt: expiresAt,
            emailOtpAttempts: 0,
            emailVerifiedAt: null,
            lastSeen: new Date(),
          },
        })
        try {
          await sendOtpEmail(otpEmail, otpCode)
        } catch {
          return NextResponse.json(
            { error: 'Email service not configured. Please try again later.' },
            { status: 500, headers: corsHeaders }
          )
        }
        return NextResponse.json({ sent: true }, { headers: corsHeaders })
      }

      if (action === 'verify_otp') {
        if (!code) {
          return NextResponse.json({ error: 'Missing code' }, { status: 400, headers: corsHeaders })
        }
        if (!ensuredVisitor.emailOtpHash || !ensuredVisitor.emailOtpExpiresAt) {
          return NextResponse.json({ error: 'OTP not requested' }, { status: 400, headers: corsHeaders })
        }
        if (ensuredVisitor.emailOtpExpiresAt < new Date()) {
          return NextResponse.json({ error: 'OTP expired' }, { status: 400, headers: corsHeaders })
        }
        if (hashOtp(String(code)) !== ensuredVisitor.emailOtpHash) {
          await prismaAny.visitor.update({
            where: { id: visitorId },
            data: { emailOtpAttempts: (ensuredVisitor.emailOtpAttempts || 0) + 1, lastSeen: new Date() },
          })
          return NextResponse.json({ verified: false }, { status: 400, headers: corsHeaders })
        }
        const verified = await prismaAny.visitor.update({
          where: { id: visitorId },
          data: {
            emailVerifiedAt: new Date(),
            emailOtpHash: null,
            emailOtpExpiresAt: null,
            emailOtpAttempts: 0,
            lastSeen: new Date(),
          },
        })
        const complete = isProfileComplete(verified)
        const final =
          complete && !verified.profileCompletedAt
            ? await prismaAny.visitor.update({ where: { id: visitorId }, data: { profileCompletedAt: new Date() } })
            : verified
        return NextResponse.json(
          { verified: true, profile: final, profileComplete: isProfileComplete(final) },
          { headers: corsHeaders }
        )
      }
    }

    // ── General / Offers chat ───────────────────────────────────────────────
    const responseLanguage = language || (agent as any).language || 'en'

    // Fetch conversation history for this session
    const msgWhere = sessionId
      ? { agentId, sessionId }
      : visitorId
        ? { agentId, visitorId }
        : { agentId }

    const recentMessages = await prisma.chatMessage.findMany({
      where: msgWhere,
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { role: true, content: true },
    })
    const conversationHistory = recentMessages
      .reverse()
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    // RAG context retrieval
    let contextChunks: string[] = []
    let relatedDocuments: ProductSource[] = []
    if ((agent as any).documents?.length > 0) {
      try {
        const lastAssistant = [...conversationHistory].reverse().find((m) => m.role === 'assistant')?.content ?? null
        let ragQuery = message
        if (isAcceptingProductOffer(message, lastAssistant)) {
          const concern = conversationHistory.filter((m) => m.role === 'user').slice(0, 3).map((m) => m.content).join(' ')
          if (concern.trim().length > 5) ragQuery = `Ayurvedic products for: ${concern}`
        }
        const embedding = await generateEmbedding(ragQuery)
        const similar = await findSimilarChunks(embedding, agentId, 5)
        if (similar.length > 0) {
          const chunkIds = similar.map((c) => c.chunkId)
          const chunks = await prisma.documentChunk.findMany({
            where: { id: { in: chunkIds }, document: { agentId } },
            select: { text: true, documentId: true },
          })
          contextChunks = chunks.map((c) => c.text)
          const docIds = Array.from(new Set(chunks.map((c) => c.documentId)))
          if (docIds.length > 0) {
            relatedDocuments = await prisma.document.findMany({
              where: { id: { in: docIds } },
              select: { id: true, filepath: true, filename: true, extractedText: true },
            }) as ProductSource[]
          }
        }
      } catch (err) {
        console.error('[EmbedChat] RAG error:', err)
      }
    }

    // Build system prompt
    let systemPrompt = (agent as any).settings?.systemPrompt || (agent as any).systemPrompt || ''
    if (visitor) {
      const parts = [
        visitor.name ? `Name: ${visitor.name}` : null,
        visitor.age ? `Age: ${visitor.age}` : null,
        visitor.origin ? `Origin: ${visitor.origin}` : null,
      ].filter(Boolean)
      if (parts.length) {
        systemPrompt += `\n\nVisitor profile:\n${parts.join('\n')}\nPersonalize your responses. Do not ask for age, location, phone, or email — the system collects them separately.`
      }
    }

    const agentSettings = (agent as any).settings
      ? {
        temperature: (agent as any).settings.temperature ?? undefined,
        model: (agent as any).settings.model ?? undefined,
        maxTokens: (agent as any).settings.maxTokens ?? undefined,
      }
      : undefined

    // Generate response
    const responseText = await generateChatResponse(
      systemPrompt,
      message,
      contextChunks,
      responseLanguage,
      conversationHistory,
      agentSettings
    )

    // Product lookup (only when user explicitly asks)
    let products: ProductResult[] = []
    const lastAssistant = [...conversationHistory].reverse().find((m) => m.role === 'assistant')?.content ?? null
    if (isProductRequest(message) || isAcceptingProductOffer(message, lastAssistant)) {
      try {
        const baseDocs =
          relatedDocuments.length > 0
            ? relatedDocuments
            : await prisma.document.findMany({
              where: { agentId, filepath: { startsWith: 'http' } },
              orderBy: { createdAt: 'desc' },
              take: 30,
              select: { id: true, filepath: true, filename: true, extractedText: true },
            }) as ProductSource[]

        const productPageDocs = await prisma.document.findMany({
          where: { agentId, AND: [{ filepath: { startsWith: 'http' } }, { filepath: { contains: '/product/' } }] },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: { id: true, filepath: true, filename: true, extractedText: true },
        }) as ProductSource[]

        const seen = new Set(baseDocs.map((d) => d.id))
        const docs = [...productPageDocs.filter((d) => !seen.has(d.id) && (seen.add(d.id), true)), ...baseDocs]
        products = await buildProductResults(docs, 10, conversationHistory, undefined, agentId)
      } catch (err) {
        console.error('[EmbedChat] Product fetch error:', err)
      }
    }

    // Save messages
    try {
      await prismaAny.chatMessage.createMany({
        data: [
          {
            agentId,
            sessionId: sessionId || null,
            visitorId: visitorId || null,
            role: 'user',
            content: message,
            metadata: { source: 'embed', contextChunksCount: contextChunks.length },
          },
          {
            agentId,
            sessionId: sessionId || null,
            visitorId: visitorId || null,
            role: 'assistant',
            content: responseText,
            metadata: { source: 'embed', contextChunksCount: contextChunks.length },
          },
        ],
      })
    } catch (err) {
      console.error('[EmbedChat] Failed to save messages:', err)
    }

    return NextResponse.json(
      {
        response: responseText,
        contextUsed: contextChunks.length > 0,
        products: products.length > 0 ? products : null,
      },
      { headers: corsHeaders }
    )
  } catch (error) {
    console.error('[EmbedChat] Error:', error)
    return NextResponse.json(
      { error: 'Failed to process chat message', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500, headers: cors(request.headers.get('origin')) }
    )
  }
}