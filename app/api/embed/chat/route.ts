/**
 * Public Embed Chat API Route
 * Handles chat messages for embedded agents (no authentication required)
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { generateChatResponse, extractConditionsAndSuggestions } from '@/lib/openai'
import { generateEmbedding } from '@/lib/embeddings'
import { findSimilarChunks } from '@/lib/vector-db'
import { createHash } from 'crypto'
import { sendOtpEmail } from '@/lib/email'
import { buildProductResults, listProductsFromDocuments, isProductRequest, isAcceptingProductOffer, type ProductResult, type ProductSource, extractRecommendedProductNames } from '@/lib/product.service'

export const runtime = 'nodejs'

const prismaAny = prisma as any

export async function POST(request: NextRequest) {
  // Handle CORS for embedded requests
  const origin = request.headers.get('origin')
  const corsHeaders = {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }

  // Handle preflight
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, { status: 200, headers: corsHeaders })
  }

  try {
    const body = await request.json()
    const { agentId, message, language, visitorId, sessionId, action, profile, email, code } = body

    if (!agentId) {
      return NextResponse.json({ error: 'Missing agentId' }, { status: 400, headers: corsHeaders })
    }

    if (!message && !action) {
      return NextResponse.json({ error: 'Missing message' }, { status: 400, headers: corsHeaders })
    }

    // Get client IP and user agent for visitor tracking
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0] ||
      request.headers.get('x-real-ip') ||
      'unknown'
    const userAgent = request.headers.get('user-agent') || 'unknown'

    const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString()
    const hashOtp = (otp: string) => createHash('sha256').update(otp).digest('hex')

    // Handle visitor tracking (graceful degradation if tables don't exist)
    let visitor = null
    if (visitorId) {
      try {
        // Check if visitor exists in Prisma client (client might not be regenerated)
        if (prismaAny.visitor && typeof prismaAny.visitor.findUnique === 'function') {
          // Find or create visitor
          visitor = await prismaAny.visitor.findUnique({
            where: { id: visitorId },
          })

          if (!visitor) {
            // Create new visitor
            visitor = await prismaAny.visitor.create({
              data: {
                id: visitorId,
                agentId,
                ip,
                userAgent,
                firstSeen: new Date(),
                lastSeen: new Date(),
              },
            })
          } else {
            // Update last seen
            visitor = await prismaAny.visitor.update({
              where: { id: visitorId },
              data: { lastSeen: new Date() },
            })
          }
        } else {
          console.warn('[Embed Chat] Visitor model not found in Prisma client. Run: npx prisma generate')
        }
      } catch (error: any) {
        // If table doesn't exist, skip visitor tracking (migration not run yet)
        if (error?.code === 'P2021' || error?.message?.includes('does not exist') || error?.message?.includes('undefined')) {
          console.warn('[Embed Chat] Visitor table not found, skipping visitor tracking. Run database migration.')
        } else {
          console.error('[Embed Chat] Error tracking visitor:', error)
        }
      }
    }

    // Handle session tracking (graceful degradation if tables don't exist)
    if (sessionId && visitorId) {
      try {
        // Check if chatSession exists in Prisma client (client might not be regenerated)
        if (prismaAny.chatSession && typeof prismaAny.chatSession.createMany === 'function') {
          // Use createMany + skipDuplicates to avoid unique constraint errors
          await prismaAny.chatSession.createMany({
            data: [
              {
                id: sessionId,
                visitorId,
                agentId,
                startedAt: new Date(),
              },
            ],
            skipDuplicates: true,
          })
        } else if (prismaAny.chatSession && typeof prismaAny.chatSession.upsert === 'function') {
          // Fallback: upsert if createMany isn't available
          await prismaAny.chatSession.upsert({
            where: { id: sessionId },
            create: {
              id: sessionId,
              visitorId,
              agentId,
              startedAt: new Date(),
            },
            update: {},
          })
        } else {
          console.warn('[Embed Chat] ChatSession model not found in Prisma client. Run: npx prisma generate')
        }
      } catch (error: any) {
        // If table doesn't exist, skip session tracking (migration not run yet)
        if (error?.code === 'P2021' || error?.message?.includes('does not exist') || error?.message?.includes('undefined')) {
          console.warn('[Embed Chat] ChatSession table not found, skipping session tracking. Run database migration.')
        } else {
          console.error('[Embed Chat] Error tracking session:', error)
        }
      }
    }

    // Get agent (public access - no authentication required for embedded agents)
    let agent = null
    try {
      agent = await prisma.agent.findUnique({
        where: { id: agentId },
        include: {
          documents: {
            where: { status: 'completed' },
          },
          settings: true,
        },
      })
    } catch (error: any) {
      if (error?.code === 'P2021' || error?.message?.includes('agent_settings')) {
        agent = await prisma.agent.findUnique({
          where: { id: agentId },
          include: {
            documents: {
              where: { status: 'completed' },
            },
          },
        })
      } else {
        throw error
      }
    }

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404, headers: corsHeaders })
    }

    // Consultation can start once we have the user's name. Email is only requested
    // after the report is ready (optional, for sending the report).
    const isProfileComplete = (profile: any) => {
      return Boolean(profile?.name)
    }

    const enrichReportWithVisitor = (report: any, profile: any) => {
      if (!report || typeof report !== 'object') return report
      const clientInfo = report.clientInfo && typeof report.clientInfo === 'object' ? report.clientInfo : {}
      report.clientInfo = {
        name: profile?.name ?? clientInfo.name ?? null,
        age: profile?.age ?? clientInfo.age ?? null,
        origin: profile?.origin ?? clientInfo.origin ?? null,
        phone: profile?.phone ?? clientInfo.phone ?? null,
        email: profile?.email ?? clientInfo.email ?? null,
      }
      return report
    }

    if (action) {
      if (!visitorId) {
        return NextResponse.json({ error: 'Missing visitorId' }, { status: 400, headers: corsHeaders })
      }

      if (!prismaAny.visitor || typeof prismaAny.visitor.findUnique !== 'function') {
        return NextResponse.json(
          { error: 'Visitor model not available. Run: npx prisma generate' },
          { status: 500, headers: corsHeaders }
        )
      }

      const existingVisitor = await prismaAny.visitor.findUnique({ where: { id: visitorId } })
      const ensuredVisitor = existingVisitor
        ? existingVisitor
        : await prismaAny.visitor.create({
          data: {
            id: visitorId,
            agentId,
            ip,
            userAgent,
            firstSeen: new Date(),
            lastSeen: new Date(),
          },
        })

      if (action === 'get_profile') {
        return NextResponse.json(
          {
            profile: ensuredVisitor,
            profileComplete: isProfileComplete(ensuredVisitor),
          },
          { headers: corsHeaders }
        )
      }

      if (action === 'update_profile') {
        const updates = profile || {}
        const emailChanged = updates.email && updates.email !== ensuredVisitor.email
        const updatedVisitor = await prismaAny.visitor.update({
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

        const profileComplete = isProfileComplete(updatedVisitor)
        if (profileComplete && !updatedVisitor.profileCompletedAt) {
          const completedVisitor = await prismaAny.visitor.update({
            where: { id: visitorId },
            data: { profileCompletedAt: new Date() },
          })

          return NextResponse.json(
            {
              profile: completedVisitor,
              profileComplete: true,
            },
            { headers: corsHeaders }
          )
        }

        return NextResponse.json(
          {
            profile: updatedVisitor,
            profileComplete: profileComplete,
          },
          { headers: corsHeaders }
        )
      }

      if (action === 'request_otp') {
        const otpEmail = email || ensuredVisitor.email
        if (!otpEmail) {
          return NextResponse.json({ error: 'Missing email' }, { status: 400, headers: corsHeaders })
        }

        const otpCode = generateOtp()
        const otpHash = hashOtp(otpCode)
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

        await prismaAny.visitor.update({
          where: { id: visitorId },
          data: {
            email: otpEmail,
            emailOtpHash: otpHash,
            emailOtpExpiresAt: expiresAt,
            emailOtpAttempts: 0,
            emailVerifiedAt: null,
            lastSeen: new Date(),
          },
        })

        try {
          await sendOtpEmail(otpEmail, otpCode)
        } catch (error) {
          console.error('[Embed Chat] OTP email send failed:', error)
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

        const incomingHash = hashOtp(String(code))
        if (incomingHash !== ensuredVisitor.emailOtpHash) {
          await prismaAny.visitor.update({
            where: { id: visitorId },
            data: {
              emailOtpAttempts: (ensuredVisitor.emailOtpAttempts || 0) + 1,
              lastSeen: new Date(),
            },
          })

          return NextResponse.json({ verified: false }, { status: 400, headers: corsHeaders })
        }

        const verifiedVisitor = await prismaAny.visitor.update({
          where: { id: visitorId },
          data: {
            emailVerifiedAt: new Date(),
            emailOtpHash: null,
            emailOtpExpiresAt: null,
            emailOtpAttempts: 0,
            lastSeen: new Date(),
          },
        })

        const profileComplete = isProfileComplete(verifiedVisitor)
        const finalVisitor = profileComplete && !verifiedVisitor.profileCompletedAt
          ? await prismaAny.visitor.update({
            where: { id: visitorId },
            data: { profileCompletedAt: new Date() },
          })
          : verifiedVisitor

        return NextResponse.json(
          {
            verified: true,
            profile: finalVisitor,
            profileComplete: isProfileComplete(finalVisitor),
          },
          { headers: corsHeaders }
        )
      }
    }

    // Get language from agent or use provided language
    const responseLanguage = language || agent.language || 'en'

    // Retrieve conversation history for the current session FIRST
    // (needed by RAG query enhancement and stage detection)
    // The AI needs the FULL conversation to detect which consultation stage it's in.
    const messageWhere = sessionId
      ? { agentId, sessionId }
      : visitorId
        ? { agentId, visitorId }
        : { agentId }

    const getExistingReport = async () => {
      if (!prismaAny.consultationReport?.findFirst) return null
      return prismaAny.consultationReport.findFirst({
        where: {
          agentId,
          sessionId: sessionId || null,
        },
        orderBy: { createdAt: 'desc' },
      })
    }
    const recentMessages = await prisma.chatMessage.findMany({
      where: messageWhere,
      orderBy: { createdAt: 'desc' },
      take: 20, // Enough to cover the full consultation (A→E is ~10 messages)
      select: {
        role: true,
        content: true,
      },
    })

    // Reverse to get chronological order (oldest first)
    const conversationHistory = recentMessages.reverse().map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    }))

    // Retrieve relevant context from knowledge base using RAG
    let contextChunks: string[] = []
    let relatedDocuments: ProductSource[] = []
    if (agent.documents.length > 0) {
      try {
        // Determine the best query for embedding search
        // If user is accepting a product offer ("Yes, show me"), use their identified concern
        // instead of the generic acceptance message, so RAG finds concern-relevant products
        let ragQuery = message
        const lastAssistantMsg = conversationHistory.length > 0
          ? [...conversationHistory].reverse().find((m) => m.role === 'assistant')?.content ?? null
          : null
        if (isAcceptingProductOffer(message, lastAssistantMsg)) {
          // Extract the user's actual concern from earlier in the conversation
          const userConcernMessages = conversationHistory
            .filter((m) => m.role === 'user')
            .slice(0, 3) // Concern is in early messages
            .map((m) => m.content)
            .join(' ')
          if (userConcernMessages.trim().length > 5) {
            ragQuery = `Ayurvedic products for: ${userConcernMessages}`
            console.log(`[RAG] Enhanced query for product stage: "${ragQuery.slice(0, 100)}..."`)
          }
        }

        // Generate embedding for the (possibly enhanced) query
        const queryEmbedding = await generateEmbedding(ragQuery)

        // Find similar chunks from vector DB
        const similarChunks = await findSimilarChunks(queryEmbedding, agentId, 5)

        if (similarChunks.length > 0) {
          // Get full chunk texts from database
          const chunkIds = similarChunks.map((c) => c.chunkId)

          const chunks = await prisma.documentChunk.findMany({
            where: {
              id: { in: chunkIds },
              document: { agentId },
            },
            select: { text: true, documentId: true },
          })

          contextChunks = chunks.map((chunk) => chunk.text)

          const documentIds = Array.from(new Set(chunks.map((chunk) => chunk.documentId)))
          if (documentIds.length > 0) {
            relatedDocuments = await prisma.document.findMany({
              where: { id: { in: documentIds } },
              select: {
                id: true,
                filepath: true,
                filename: true,
                extractedText: true,
              },
            })
          }
        }
      } catch (error) {
        console.error('[RAG] Error retrieving RAG context:', error)
        // Continue without context if RAG fails
      }
    }

    const lastAssistantMessage = conversationHistory.length > 0
      ? [...conversationHistory].reverse().find((m) => m.role === 'assistant')?.content ?? null
      : null
    const productRequest = Boolean(
      message && (isProductRequest(message) || isAcceptingProductOffer(message, lastAssistantMessage))
    )

    // For the consultation flow, ALWAYS pass conversation history to the AI.
    // The AI must see the full conversation to detect the current stage (A→H).
    // Without history, it resets to Stage A every turn.
    const isFollowUp = conversationHistory.length > 0
    const historyToUse = conversationHistory
    if (historyToUse.length > 0) {
      console.log(`[Embed Chat] Including ${historyToUse.length} previous messages in context`)
    }

    // Track response time
    const startTime = Date.now()

    // Get agent settings if available
    const agentSettings = (agent as any).settings
      ? {
        temperature: (agent as any).settings.temperature ?? undefined,
        model: (agent as any).settings.model ?? undefined,
        maxTokens: (agent as any).settings.maxTokens ?? undefined,
      }
      : undefined

    // Use custom system prompt from settings if available, otherwise use agent's default
    let systemPrompt = (agent as any).settings?.systemPrompt || agent.systemPrompt

    // Add visitor profile context for personalized responses
    if (visitor) {
      const profileParts = [
        visitor.name ? `Name: ${visitor.name}` : null,
        visitor.age ? `Age: ${visitor.age}` : null,
        visitor.origin ? `Origin: ${visitor.origin}` : null,
        visitor.phone ? `Phone: ${visitor.phone}` : null,
        visitor.email ? `Email: ${visitor.email}` : null,
      ].filter(Boolean)

      if (profileParts.length > 0) {
        systemPrompt += `\n\nVisitor profile (only what they have shared):\n${profileParts.join('\n')}\nUse this to personalize responses. Do not ask for age, location, phone, or email — the system handles profile collection separately.`
      }
    }

    // Get full conversation history for product relevance filtering
    const fullConversationHistory = await prisma.chatMessage.findMany({
      where: {
        agentId,
        ...(sessionId ? { sessionId } : {}), // Current session only
      },
      orderBy: { createdAt: 'asc' },
      select: {
        role: true,
        content: true,
      },
    })

    // Generate response using OpenAI with RAG context
    // Pass conversation history only if it's a follow-up question
    let responseText: string
    let reportPayload: any | null = null
    let products: any[] = [] // Initialize products to ensure it's always defined
    try {
      // If user is asking for products/links, generate report first (if not exists)
      // Then use report data for better product relevance filtering
      // IMPORTANT: Each consultation session gets a FRESH report based only on the current session.
      // Past reports are stored separately and not reused, allowing users to have multiple consultations over time.
      if (productRequest) {
        const existingReport = await getExistingReport()
        if (!existingReport) {
          // Get ALL messages from the CURRENT session only
          // This ensures each new consultation gets a fresh report with only current session data
          // Past consultations remain stored separately for reference
          const reportMessages = await prisma.chatMessage.findMany({
            where: {
              agentId,
              ...(sessionId ? { sessionId } : {}), // Only current session messages - ensures fresh report per session
            },
            orderBy: { createdAt: 'asc' },
            // No limit - get ALL messages to ensure nothing is skipped, every interaction is recorded
            select: { role: true, content: true, createdAt: true },
          })

          if (reportMessages.length === 0) {
            responseText = 'Please share your concerns first so I can prepare your consultation report.'
            // Build products without report data (no conversation context yet)
            const productsWithoutReport = await buildProductResults(
              relatedDocuments.length > 0
                ? relatedDocuments
                : await prisma.document.findMany({
                  where: { agentId, filepath: { startsWith: 'http' } },
                  orderBy: { createdAt: 'desc' },
                  take: 5,
                  select: {
                    id: true,
                    filepath: true,
                    filename: true,
                    extractedText: true,
                  },
                }),
              5,
              fullConversationHistory.map(msg => ({
                role: msg.role as 'user' | 'assistant',
                content: msg.content,
              }))
            )
            return NextResponse.json(
              {
                response: responseText,
                contextUsed: contextChunks.length > 0,
                isFollowUp,
                report: null,
                products: productsWithoutReport.length > 0 ? productsWithoutReport : null,
              },
              { headers: corsHeaders }
            )
          } else {
            const profileBlock = visitor
              ? [
                visitor.name ? `Name: ${visitor.name}` : null,
                visitor.age ? `Age: ${visitor.age}` : null,
                visitor.origin ? `Origin: ${visitor.origin}` : null,
                visitor.phone ? `Phone: ${visitor.phone}` : null,
                visitor.email ? `Email: ${visitor.email}` : null,
              ].filter(Boolean).join('\n')
              : ''

            // Format conversation transcript with clear structure - include EVERY message
            // Format with timestamps and ensure nothing is skipped
            const conversationTranscript = reportMessages.map((m, idx) => {
              const roleLabel = m.role === 'user' ? 'Client' : 'Consultant'
              const timestamp = m.createdAt
                ? new Date(m.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
                : ''
              return `[${idx + 1}] ${timestamp ? `(${timestamp}) ` : ''}${roleLabel}: ${m.content}`
            }).join('\n\n')

            const reportPrompt = `You are a professional consultant creating a detailed consultation report. Analyze the COMPLETE conversation below and generate a comprehensive, well-structured report in strict JSON format.\n\n` +
              `CRITICAL REQUIREMENTS:\n` +
              `1. Include EVERY question asked by the consultant and EVERY response from the client - NOTHING should be skipped\n` +
              `2. If the client gave short or brief answers (e.g., "yes", "no", "maybe", single words, fragments), rewrite them into proper, well-structured sentences that maintain the original meaning but improve readability\n` +
              `3. Preserve the chronological order of all interactions\n` +
              `4. Ensure the conversationTranscript field contains the FULL conversation with all questions and answers\n\n` +
              `REPORT STRUCTURE (all fields required, use null or empty array if unknown):\n` +
              `{\n` +
              `  "clientInfo": { "name": string, "age": number, "origin": string, "email": string, "phone": string },\n` +
              `  "consultationDate": string (ISO date format),\n` +
              `  "executiveSummary": string (2-3 sentence overview of the consultation),\n` +
              `  "presentingConcerns": array of strings (main issues/concerns raised by client),\n` +
              `  "clientHistory": string (relevant background information shared),\n` +
              `  "assessment": {\n` +
              `    "problems": array of strings (identified problems/issues),\n` +
              `    "goals": array of strings (client's stated goals/objectives),\n` +
              `    "constraints": array of strings (limitations, barriers, or constraints mentioned)\n` +
              `  },\n` +
              `  "previousAttempts": array of strings (what client has tried before, if mentioned),\n` +
              `  "recommendations": array of strings (specific, actionable recommendations provided),\n` +
              `  "actionPlan": {\n` +
              `    "immediateSteps": array of strings (urgent/priority actions),\n` +
              `    "shortTermGoals": array of strings (next 1-2 weeks),\n` +
              `    "longTermGoals": array of strings (next 1-3 months)\n` +
              `  },\n` +
              `  "followUpQuestions": array of strings (questions to consider for future sessions),\n` +
              `  "conversationTranscript": string (FULL formatted conversation transcript with ALL questions and answers, with brief responses rewritten into proper sentences)\n` +
              `}\n\n` +
              `INSTRUCTIONS:\n` +
              `- Extract ALL information from the conversation - nothing should be omitted\n` +
              `- Rewrite brief client responses into complete, well-structured sentences while preserving original meaning\n` +
              `- Be specific and detailed in recommendations and action plans\n` +
              `- Organize information logically and professionally\n` +
              `- The conversationTranscript MUST include EVERY interaction in chronological order\n` +
              `- Use clear, professional language throughout\n` +
              `- Return ONLY valid JSON, no markdown formatting, no code blocks\n\n` +
              (profileBlock ? `CLIENT PROFILE:\n${profileBlock}\n\n` : '') +
              `COMPLETE CONVERSATION (${reportMessages.length} total messages - include ALL):\n${conversationTranscript}\n\n` +
              `Generate the consultation report now, ensuring every question and answer is included:`

            const reportText = await generateChatResponse(
              'You are a professional consultant. Output valid JSON only.',
              reportPrompt,
              [],
              responseLanguage,
              []
            )

            let reportJson: any = null
            try {
              reportJson = JSON.parse(reportText)
            } catch (error) {
              reportJson = { raw: reportText }
            }

            // Ensure conversation transcript is included with ALL messages
            // If LLM didn't generate it or it's incomplete, create a comprehensive one
            if (!reportJson.conversationTranscript || reportJson.conversationTranscript.length < conversationTranscript.length) {
              // Format with enhanced readability - rewrite brief responses
              const enhancedTranscript = reportMessages.map((m, idx) => {
                const roleLabel = m.role === 'user' ? 'Client' : 'Consultant'
                const timestamp = m.createdAt
                  ? new Date(m.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
                  : ''
                let content = m.content

                // Enhance brief responses for better readability
                // Rewrite short/brief user responses into proper, well-structured sentences
                if (m.role === 'user') {
                  const trimmed = content.trim()
                  const lowerTrimmed = trimmed.toLowerCase()

                  // Rewrite common brief responses into complete sentences
                  if (lowerTrimmed === 'yes' || lowerTrimmed === 'y' || lowerTrimmed === 'yeah' || lowerTrimmed === 'yep') {
                    content = 'Yes, I agree with that.'
                  } else if (lowerTrimmed === 'no' || lowerTrimmed === 'n' || lowerTrimmed === 'nope' || lowerTrimmed === 'nah') {
                    content = 'No, I do not agree with that.'
                  } else if (lowerTrimmed === 'maybe' || lowerTrimmed === 'perhaps' || lowerTrimmed === 'possibly') {
                    content = 'Perhaps, I am not entirely sure about that.'
                  } else if (lowerTrimmed === 'ok' || lowerTrimmed === 'okay') {
                    content = 'Okay, I understand.'
                  } else if (lowerTrimmed === 'thanks' || lowerTrimmed === 'thank you' || lowerTrimmed === 'thx') {
                    content = 'Thank you for that information.'
                  } else if (trimmed.length < 15 && !trimmed.includes('.') && !trimmed.includes('!') && !trimmed.includes('?')) {
                    // Very short responses without punctuation - enhance them
                    // Capitalize first letter and add period if missing
                    if (trimmed.length > 0) {
                      content = trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
                      if (!content.endsWith('.') && !content.endsWith('!') && !content.endsWith('?')) {
                        content += '.'
                      }
                    }
                  }
                }

                return `[${idx + 1}] ${timestamp ? `(${timestamp}) ` : ''}${roleLabel}: ${content}`
              }).join('\n\n')

              reportJson.conversationTranscript = enhancedTranscript
            }

            // Add consultation date if missing
            if (!reportJson.consultationDate) {
              reportJson.consultationDate = new Date().toISOString()
            }

            reportJson = enrichReportWithVisitor(reportJson, visitor)

            reportPayload = reportJson
            try {
              if (prismaAny.consultationReport?.create) {
                await prismaAny.consultationReport.create({
                  data: {
                    agentId,
                    visitorId: visitorId || null,
                    sessionId: sessionId || null,
                    content: reportJson,
                  },
                })
              }
            } catch (error) {
              console.error('[Embed Chat] Error saving report:', error)
            }

          }
        } else {
          reportPayload = enrichReportWithVisitor(existingReport?.content, visitor)
          // Backfill stored report if clientInfo was missing
          if (
            reportPayload &&
            existingReport &&
            prismaAny.consultationReport?.update &&
            (!existingReport.content?.clientInfo || Object.keys(existingReport.content?.clientInfo || {}).length === 0)
          ) {
            try {
              await prismaAny.consultationReport.update({
                where: { id: existingReport.id },
                data: { content: reportPayload },
              })
            } catch (error) {
              console.error('[Embed Chat] Error updating report client info:', error)
            }
          }
        }
      }

      // Build products: prefer exact product pages (/product/[id]) over general shop page
      if (productRequest) {
        const baseDocs =
          relatedDocuments.length > 0
            ? relatedDocuments
            : await prisma.document.findMany({
              where: { agentId, filepath: { startsWith: 'http' } },
              orderBy: { createdAt: 'desc' },
              take: 30,
              select: {
                id: true,
                filepath: true,
                filename: true,
                extractedText: true,
              },
            })
        const productPageDocs = await prisma.document.findMany({
          where: {
            agentId,
            AND: [
              { filepath: { startsWith: 'http' } },
              { filepath: { contains: '/product/' } }, // /product/[id] - exact product page URLs
            ],
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: { id: true, filepath: true, filename: true, extractedText: true },
        })
        const seenIds = new Set(baseDocs.map((d: { id: string }) => d.id))
        const docsForProducts = [
          ...productPageDocs.filter((d: { id: string }) => !seenIds.has(d.id) && (seenIds.add(d.id), true)),
          ...baseDocs,
        ]
        products = await buildProductResults(
          docsForProducts,
          10, // Return up to 10 products (enough for 3-4 recommendations)
          fullConversationHistory.map(msg => ({
            role: msg.role as 'user' | 'assistant',
            content: msg.content,
          })),
          reportPayload, // Pass report data for enhanced context extraction
          agentId // Enable caching and reuse
        )
      }

      responseText = await generateChatResponse(
        systemPrompt,
        message,
        contextChunks,
        responseLanguage,
        historyToUse,
        agentSettings
      )

      // AUTOMATIC PRODUCT DETECTION: Check if assistant response contains product recommendations
      // If so, automatically fetch and display products (don't wait for user to ask)
      if (!productRequest) {
        // Check if the assistant response contains product recommendations
        const typedHistory = fullConversationHistory.map(msg => ({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        }))
        const updatedHistoryWithResponse = [...typedHistory, { role: 'user' as const, content: message }, { role: 'assistant' as const, content: responseText }]
        const recommendedNames = await extractRecommendedProductNames(reportPayload, updatedHistoryWithResponse)

        if (recommendedNames.length > 0) {
          console.log(`[EmbedChat] Auto-detected ${recommendedNames.length} product recommendations in assistant response`)
          // Fetch products automatically if not already fetched
          if (products.length === 0) {
            const baseDocsForAuto =
              relatedDocuments.length > 0
                ? relatedDocuments
                : await prisma.document.findMany({
                  where: { agentId, filepath: { startsWith: 'http' } },
                  orderBy: { createdAt: 'desc' },
                  take: 30,
                  select: {
                    id: true,
                    filepath: true,
                    filename: true,
                    extractedText: true,
                  },
                })
            const productPageDocsForAuto = await prisma.document.findMany({
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
            const seenIdsAuto = new Set(baseDocsForAuto.map((d: { id: string }) => d.id))
            const docsForProductsAuto = [
              ...productPageDocsForAuto.filter((d: { id: string }) => !seenIdsAuto.has(d.id) && (seenIdsAuto.add(d.id), true)),
              ...baseDocsForAuto,
            ]
            products = await buildProductResults(
              docsForProductsAuto,
              10, // Return up to 10 products
              updatedHistoryWithResponse as Array<{ role: 'user' | 'assistant'; content: string }>,
              reportPayload,
              agentId
            )
            console.log(`[EmbedChat] Auto-fetched ${products.length} products for recommendations`)
          }
        }
      }

    } catch (error) {
      // Re-throw to surface the error
      throw error
    }

    // Extract conditions and suggestions for clickable buttons at EVERY stage
    // Chips are needed for Stage E ("Help me choose"), Stage F (concern re-selection), etc.
    let suggestions: Array<{ label: string; prompt: string }> = []
    try {
      const historyForExtraction = [
        ...fullConversationHistory.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        { role: 'user' as const, content: message },
        { role: 'assistant' as const, content: responseText },
      ]
      const extracted = await extractConditionsAndSuggestions(historyForExtraction, responseLanguage)
      if (extracted.suggestions.length > 0) {
        suggestions = extracted.suggestions
        console.log(`[EmbedChat] Extracted ${extracted.conditions.length} conditions, ${suggestions.length} suggestions`)
      }
    } catch (extractErr) {
      console.error('[EmbedChat] Suggestion extraction failed:', extractErr)
    }

    const responseTime = Date.now() - startTime

    // ── CONTEXT PRODUCTS: Only show products relevant to user's concern ──────────
    // Uses the user's identified concern to filter products — not just keyword matching.
    let contextProducts: typeof products = []
    if (products.length === 0) {
      try {
        // Detect the user's concern from conversation to filter context products
        const allHistory = [
          ...fullConversationHistory.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
          { role: 'user' as const, content: message },
        ]
        const userConcernMessages = allHistory
          .filter((m) => m.role === 'user')
          .slice(0, 3)
          .map((m) => m.content.toLowerCase())
          .join(' ')

        // Only show context products if we can detect a concern
        const hasConcernContext = userConcernMessages.length > 10

        if (hasConcernContext) {
          const ctxDocs = await prisma.document.findMany({
            where: {
              agentId,
              AND: [
                { filepath: { startsWith: 'http' } },
                { filepath: { contains: '/product/' } },
              ],
            },
            orderBy: { createdAt: 'desc' },
            take: 40,
            select: { id: true, filepath: true, filename: true, extractedText: true },
          })
          if (ctxDocs.length > 0) {
            // Build keyword list from user's concern messages (not generic messages)
            const concernKeywords = userConcernMessages.match(/\b\w{4,}\b/g) || []
            // Filter out generic/common words that don't indicate a specific concern
            const genericWords = new Set(['want', 'need', 'help', 'like', 'show', 'know', 'tell', 'please', 'thank', 'thanks', 'what', 'have', 'with', 'this', 'that', 'your', 'more', 'also', 'just', 'good', 'well', 'been', 'much', 'very', 'some', 'from'])
            const filteredKeywords = concernKeywords.filter((kw) => !genericWords.has(kw))

            if (filteredKeywords.length > 0) {
              // Use listProductsFromDocuments for reliable extraction + keyword ranking
              const allCatalog = await listProductsFromDocuments(ctxDocs)

              // Score each product by keyword overlap with the user's concern
              type ScoredProduct = ProductResult & { _score: number }
              const scored: ScoredProduct[] = allCatalog.map((p: ProductResult): ScoredProduct => {
                const haystack = `${p.title ?? ''} ${p.description ?? ''} ${(p.features ?? []).join(' ')}`.toLowerCase()
                const score = filteredKeywords.reduce((s: number, kw: string) => s + (haystack.includes(kw) ? 1 : 0), 0)
                return { ...p, _score: score }
              })

              // Only show products that actually match concern keywords (score > 0)
              const relevant = scored.filter((p) => p._score > 0)
              relevant.sort((a: ScoredProduct, b: ScoredProduct) => b._score - a._score || (a.title ?? '').localeCompare(b.title ?? ''))
              contextProducts = relevant.slice(0, 4).map(({ _score: _s, ...p }: ScoredProduct) => p as ProductResult)
              console.log(`[EmbedChat] Context products for sidebar: ${contextProducts.length} concern-relevant (top scores: ${relevant.slice(0, 4).map((p: ScoredProduct) => p._score).join(',')})`)
            }
          }
        }
      } catch (ctxErr) {
        console.warn('[EmbedChat] Context product fetch failed (non-critical):', ctxErr)
      }
    }

    // Save user message and assistant response to database with visitor/session tracking
    try {
      await prismaAny.chatMessage.createMany({
        data: [
          {
            agentId,
            sessionId: sessionId || null,
            visitorId: visitorId || null,
            role: 'user',
            content: message,
            metadata: {
              contextChunksCount: contextChunks.length,
              source: 'embed',
              isFollowUp,
            },
          },
          {
            agentId,
            sessionId: sessionId || null,
            visitorId: visitorId || null,
            role: 'assistant',
            content: responseText,
            metadata: {
              contextChunksCount: contextChunks.length,
              source: 'embed',
              isFollowUp,
            },
          },
        ],
      })
    } catch (error: any) {
      // Log but don't fail if message saving fails
      // Handle case where columns don't exist yet (migration not run)
      if (error?.code === 'P2011' || error?.message?.includes('Unknown column')) {
        console.warn('[Embed Chat] ChatMessage columns not found, saving without visitor/session IDs. Run database migration.')
        // Try saving without visitor/session IDs as fallback
        try {
          await prismaAny.chatMessage.createMany({
            data: [
              {
                agentId,
                role: 'user',
                content: message,
                metadata: {
                  contextChunksCount: contextChunks.length,
                  source: 'embed',
                  isFollowUp,
                },
              },
              {
                agentId,
                role: 'assistant',
                content: responseText,
                metadata: {
                  contextChunksCount: contextChunks.length,
                  source: 'embed',
                  isFollowUp,
                },
              },
            ],
          })
        } catch (fallbackError) {
          console.error('Failed to save embed chat message (fallback):', fallbackError)
        }
      } else {
        console.error('Failed to save embed chat message:', error)
      }
    }


    return NextResponse.json(
      {
        response: responseText,
        contextUsed: contextChunks.length > 0,
        isFollowUp,
        report: reportPayload,
        products: products.length > 0 ? products : null,
        contextProducts: contextProducts.length > 0 ? contextProducts : null,
        suggestions: suggestions.length > 0 ? suggestions : null,
      },
      { headers: corsHeaders }
    )
  } catch (error) {
    console.error('Embed Chat API error:', error)
    return NextResponse.json(
      { error: 'Failed to process chat message', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500, headers: corsHeaders }
    )
  }
}