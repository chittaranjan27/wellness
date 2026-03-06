/**
 * Crawl API Route
 * POST /api/crawl - Start a website crawl
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth-options'
import { prisma } from '@/lib/prisma'
import { crawlWebsite } from '@/lib/crawler.service'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
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

    const body = await request.json()
    const { agentId, url, maxDepth, maxPages } = body

    if (!agentId || !url) {
      return NextResponse.json({ error: 'Missing agentId or url' }, { status: 400 })
    }

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

    // Validate URL
    try {
      new URL(url)
    } catch {
      return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
    }

    // Start crawl asynchronously (don't wait for completion)
    crawlWebsite(agentId, url, maxDepth || 3, maxPages || 50).catch((error) => {
      console.error('[Crawl API] Error in background crawl:', error)
    })

    // Return immediately with status
    const crawlJob = await prisma.crawlJob.findFirst({
      where: { agentId, url },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({
      message: 'Crawl started',
      crawlJobId: crawlJob?.id,
    })
  } catch (error) {
    console.error('Crawl API error:', error)
    return NextResponse.json(
      { error: 'Failed to start crawl', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
