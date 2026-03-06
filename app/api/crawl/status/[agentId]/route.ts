/**
 * Crawl Status API Route
 * GET /api/crawl/status/:agentId - Get crawl status for an agent
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth-options'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

export async function GET(
  request: NextRequest,
  { params }: { params: { agentId: string } }
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

    const { agentId } = params

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

    // Get latest crawl job
    const crawlJob = await prisma.crawlJob.findFirst({
      where: { agentId },
      orderBy: { createdAt: 'desc' },
    })

    if (!crawlJob) {
      return NextResponse.json({
        status: 'none',
        message: 'No crawl jobs found',
      })
    }

    return NextResponse.json({
      id: crawlJob.id,
      status: crawlJob.status,
      url: crawlJob.url,
      pagesCrawled: crawlJob.pagesCrawled,
      pagesTotal: crawlJob.pagesTotal,
      chunksCreated: crawlJob.chunksCreated,
      errorMessage: crawlJob.errorMessage,
      createdAt: crawlJob.createdAt,
      updatedAt: crawlJob.updatedAt,
    })
  } catch (error) {
    console.error('Crawl Status API error:', error)
    return NextResponse.json(
      { error: 'Failed to get crawl status', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
