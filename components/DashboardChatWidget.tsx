/**
 * Dashboard Chat Widget
 * Wrapper for FloatingChatWidget that uses AgentContext
 */
'use client'

import { useAgent } from '@/contexts/AgentContext'
import FloatingChatWidget from './FloatingChatWidget'

export default function DashboardChatWidget() {
  const { agentId, agentName, initialMessages, defaultLanguage } = useAgent()

  if (!agentId) {
    return null
  }

  return (
    <FloatingChatWidget
      agentId={agentId}
      initialMessages={initialMessages}
      defaultLanguage={defaultLanguage}
      agentName={agentName || 'Wellness AI'}
    />
  )
}
