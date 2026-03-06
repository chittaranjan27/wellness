/**
 * Agent Settings API Route
 * PATCH /api/agent/settings/:id - Update agent settings
 * GET /api/agent/settings/:id - Get agent settings
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth-options'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Get user from database
    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      select: { id: true },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const { id: agentId } = params

    // Verify agent belongs to user
    const agent = await prisma.agent.findFirst({
      where: {
        id: agentId,
        userId: user.id,
      },
      include: { settings: true },
    })

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found or unauthorized' }, { status: 404 })
    }

    // Return settings or default values
    if (agent.settings) {
      return NextResponse.json(agent.settings)
    }

    return NextResponse.json({
      agentId,
      systemPrompt: null,
      temperature: 0.7,
      model: 'gpt-4',
      maxTokens: 1000,
      config: {},
    })
  } catch (error) {
    console.error('Agent Settings API error:', error)
    return NextResponse.json(
      { error: 'Failed to get settings', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Get user from database
    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      select: { id: true },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const { id: agentId } = params
    const body = await request.json()

    // Verify agent belongs to user
    const agent = await prisma.agent.findFirst({
      where: {
        id: agentId,
        userId: user.id,
      },
    })

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found or unauthorized' }, { status: 404 })
    }

    // Update or create settings
    const settings = await prisma.agentSettings.upsert({
      where: { agentId },
      create: {
        agentId,
        systemPrompt: body.systemPrompt,
        temperature: body.temperature ?? 0.7,
        model: body.model ?? 'gpt-4',
        maxTokens: body.maxTokens ?? 1000,
        config: body.config || {},
      },
      update: {
        systemPrompt: body.systemPrompt !== undefined ? body.systemPrompt : undefined,
        temperature: body.temperature !== undefined ? body.temperature : undefined,
        model: body.model !== undefined ? body.model : undefined,
        maxTokens: body.maxTokens !== undefined ? body.maxTokens : undefined,
        config: body.config !== undefined ? body.config : undefined,
      },
    })

    return NextResponse.json(settings)
  } catch (error) {
    console.error('Agent Settings API error:', error)
    return NextResponse.json(
      { error: 'Failed to update settings', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
