/**
 * Agent Detail Page
 * Features a sticky in-page sidebar with numbered section navigation.
 * All sections and components are unchanged — only the layout is improved.
 */
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth-options'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import DocumentList from '@/components/DocumentList'
import AgentDetailClient from '@/components/AgentDetailClient'
import EmbedCodeGenerator from '@/components/EmbedCodeGenerator'

import Card from '@/components/ui/Card'
import Badge from '@/components/ui/Badge'
import Button from '@/components/ui/Button'
import AgentPageLayout from '@/components/AgentPageLayout'
import SectionHeader from '@/components/SectionHeader'
import type { AgentSidebarSection } from '@/components/AgentPageLayout'

/* ── Icons ────────────────────────────────────────────────────────── */
function IconOverview() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  )
}
function IconChat() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  )
}
function IconKnowledge() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
    </svg>
  )
}

function IconEmbed() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
    </svg>
  )
}

function IconConversations() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z" />
    </svg>
  )
}

export default async function AgentDetailPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.email) redirect('/auth/signin')

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: { id: true },
  })
  if (!user) redirect('/auth/signin')

  const agent = await prisma.agent.findFirst({
    where: { id: params.id, userId: user.id },
    include: {
      documents: { orderBy: { createdAt: 'desc' } },
      chatMessages: { orderBy: { createdAt: 'asc' }, take: 50 },
    },
  })
  if (!agent) redirect('/dashboard/agents')

  /* ── Sidebar section definitions ──────────────────────────────── */
  const sections: AgentSidebarSection[] = [
    {
      id: 'overview',
      label: 'Overview',
      icon: <IconOverview />,
      description: 'Agent details & prompt',
    },
    {
      id: 'chat',
      label: 'Chat Preview',
      icon: <IconChat />,
      description: 'Test the agent live',
    },
    {
      id: 'knowledge',
      label: 'Knowledge Base',
      icon: <IconKnowledge />,
      badge: agent.documents.length,
      description: 'Uploaded documents',
    },

    {
      id: 'embed',
      label: 'Embed Widget',
      icon: <IconEmbed />,
      description: 'Add to your website',
    },
    {
      id: 'conversations',
      label: 'Conversations',
      icon: <IconConversations />,
      badge: agent.chatMessages.length,
      description: 'Review & analyze sessions',
    },
  ]

  return (
    <>
      {/* Mobile header (visible < xl) */}
      <div className="xl:hidden mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard/agents"
            className="inline-flex items-center text-sm text-indigo-600 dark:text-indigo-400 hover:text-indigo-700"
          >
            <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Agents
          </Link>
          <span className="text-gray-300 dark:text-gray-600">/</span>
          <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100 truncate max-w-[180px]">
            {agent.name}
          </h1>
        </div>
        <Link href={`/dashboard/agents/${agent.id}/edit`}>
          <Button variant="outline" className="text-sm">Edit</Button>
        </Link>
      </div>

      {/* Desktop breadcrumb (visible ≥ xl) */}
      <div className="hidden xl:flex items-center gap-2 mb-6 text-sm text-gray-500 dark:text-gray-400">
        <Link href="/dashboard" className="hover:text-gray-700 dark:hover:text-gray-200 transition-colors">Dashboard</Link>
        <span>/</span>
        <Link href="/dashboard/agents" className="hover:text-gray-700 dark:hover:text-gray-200 transition-colors">Agents</Link>
        <span>/</span>
        <span className="text-gray-900 dark:text-gray-100 font-medium">{agent.name}</span>
      </div>

      <AgentPageLayout
        agentId={agent.id}
        agentName={agent.name}
        agentLanguage={agent.language.toUpperCase()}
        sections={sections}
      >
        {/* ── 1. OVERVIEW ─────────────────────────────────────────── */}
        <section>
          <SectionHeader
            id="overview"
            step={1}
            icon={<IconOverview />}
            title="Overview"
            description="Your agent's identity and core system prompt"
            action={
              <Link href={`/dashboard/agents/${agent.id}/edit`}>
                <Button variant="outline" className="text-sm gap-1.5">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                  Edit Agent
                </Button>
              </Link>
            }
          />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
            <Card>
              <div className="p-4 text-center">
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Language</p>
                <Badge variant="info" className="text-sm px-3 py-1">{agent.language.toUpperCase()}</Badge>
              </div>
            </Card>
            <Card>
              <div className="p-4 text-center">
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Documents</p>
                <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{agent.documents.length}</p>
              </div>
            </Card>
            <Card>
              <div className="p-4 text-center">
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Messages</p>
                <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{agent.chatMessages.length}</p>
              </div>
            </Card>
          </div>
        </section>

        {/* ── 2. CHAT PREVIEW ─────────────────────────────────────── */}
        <section>
          <SectionHeader
            id="chat"
            step={2}
            icon={<IconChat />}
            title="Chat Preview"
            description="Test your agent interactively before deploying"
          />
          <AgentDetailClient
            agentId={agent.id}
            agentName={agent.name}
            initialMessages={agent.chatMessages}
            defaultLanguage={agent.language || 'en'}
          />
          <Card className="mt-4 border-dashed border-indigo-200 dark:border-indigo-800 bg-indigo-50/30 dark:bg-indigo-950/20">
            <div className="p-4 flex items-start gap-3">
              <div className="flex-shrink-0 mt-0.5">
                <svg className="w-4 h-4 text-indigo-500 dark:text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <p className="text-xs text-indigo-700 dark:text-indigo-300 leading-relaxed">
                This chat uses the <strong>dashboard API endpoint</strong> for testing. The embedded widget on your website uses a separate public endpoint for visitors.
              </p>
            </div>
          </Card>
        </section>

        {/* ── 3. KNOWLEDGE BASE ────────────────────────────────────── */}
        <section>
          <SectionHeader
            id="knowledge"
            step={3}
            icon={<IconKnowledge />}
            title="Knowledge Base"
            description="Upload PDF, Word, or text documents to train your agent"
          />
          <Card>
            <div className="p-6">
              <DocumentList agentId={agent.id} documents={agent.documents} />
            </div>
          </Card>
        </section>



        {/* ── 4. EMBED WIDGET ──────────────────────────────────────── */}
        <section>
          <SectionHeader
            id="embed"
            step={4}
            icon={<IconEmbed />}
            title="Embed Widget"
            description="Copy the snippet below to add this agent to any webpage"
          />
          <Card>
            <div className="p-6">
              <EmbedCodeGenerator agentId={agent.id} agentName={agent.name} />
            </div>
          </Card>
        </section>

        {/* ── 5. CONVERSATIONS ─────────────────────────────────────── */}
        <section>
          <SectionHeader
            id="conversations"
            step={5}
            icon={<IconConversations />}
            title="Conversations"
            description="Review every consultation session, AI responses, and token usage"
            action={
              <Link href={`/dashboard/agents/${agent.id}/conversations`}>
                <Button variant="outline" className="text-sm gap-1.5">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  Open Full Review
                </Button>
              </Link>
            }
          />
          <Card>
            <div className="p-6 flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500 dark:text-gray-400">Total messages stored</p>
                <p className="text-4xl font-bold text-gray-900 dark:text-gray-100 mt-1">{agent.chatMessages.length}</p>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">Open the full review to inspect each session, every AI turn, and token consumption.</p>
              </div>
              <Link href={`/dashboard/agents/${agent.id}/conversations`}>
                <div className="h-16 w-16 rounded-2xl bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center text-indigo-600 dark:text-indigo-400 hover:bg-indigo-200 dark:hover:bg-indigo-800/40 transition-colors cursor-pointer">
                  <IconConversations />
                </div>
              </Link>
            </div>
          </Card>
        </section>
      </AgentPageLayout>
    </>
  )
}
