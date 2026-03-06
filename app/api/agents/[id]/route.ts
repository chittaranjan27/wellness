/**
 * Single Agent API Route
 * Handles GET, PUT, DELETE for individual agents
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth-options'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'

export const runtime = 'nodejs'


// GET: Get agent details
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
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

    const agent = await prisma.agent.findFirst({
      where: {
        id: params.id,
        userId: user.id,
      },
      include: {
        documents: {
          orderBy: { createdAt: 'desc' },
        },
      },
    })

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    return NextResponse.json(agent)
  } catch (error) {
    console.error('Agent GET error:', error)
    return NextResponse.json({ error: 'Failed to fetch agent' }, { status: 500 })
  }
}

// PUT: Update agent
export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { name, language } = body

    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      select: { id: true },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Verify ownership
    const existingAgent = await prisma.agent.findFirst({
      where: {
        id: params.id,
        userId: user.id,
      },
    })

    if (!existingAgent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    const agent = await prisma.agent.update({
      where: { id: params.id },
      data: {
        ...(name && { name }),
        ...(language && { language }),
      },
    })

    // Revalidate the agent detail page and agents list page to show updated data
    revalidatePath(`/dashboard/agents/${params.id}`)
    revalidatePath('/dashboard/agents')

    return NextResponse.json(agent)
  } catch (error) {
    console.error('Agent PUT error:', error)
    return NextResponse.json({ error: 'Failed to update agent' }, { status: 500 })
  }
}

// DELETE: Delete agent
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
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

    // Verify ownership
    const agent = await prisma.agent.findFirst({
      where: {
        id: params.id,
        userId: user.id,
      },
    })

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    await prisma.agent.delete({
      where: { id: params.id },
    })

    return NextResponse.json({ message: 'Agent deleted successfully' })
  } catch (error) {
    console.error('Agent DELETE error:', error)
    return NextResponse.json({ error: 'Failed to delete agent' }, { status: 500 })
  }
}
