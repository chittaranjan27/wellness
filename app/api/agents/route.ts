/**
 * Agents API Route
 * Handles CRUD operations for AI agents
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth-options'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

// GET: List all agents for the authenticated user
export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      select: { id: true },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const agents = await prisma.agent.findMany({
      where: { userId: user.id },
      include: {
        documents: {
          select: {
            id: true,
            status: true,
          },
        },
        _count: {
          select: {
            chatMessages: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json(agents)
  } catch (error) {
    console.error('Agents GET error:', error)
    return NextResponse.json({ error: 'Failed to fetch agents' }, { status: 500 })
  }
}

// POST: Create a new agent
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { name, language = 'en' } = body

    if (!name) {
      return NextResponse.json({ error: 'Missing agent name' }, { status: 400 })
    }

    // System prompt is managed entirely in openai.ts — use a fixed placeholder in DB
    const systemPrompt = 'Managed by openai.ts'

    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      select: { id: true },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const agent = await prisma.agent.create({
      data: {
        name,
        systemPrompt,
        language,
        userId: user.id,
      },
    })

    return NextResponse.json(agent, { status: 201 })
  } catch (error) {
    console.error('Agents POST error:', error)
    return NextResponse.json({ error: 'Failed to create agent' }, { status: 500 })
  }
}
