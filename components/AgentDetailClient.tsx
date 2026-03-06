/**
 * Agent Detail Client Component
 * Sets the agent context for the chat widget
 */
'use client'

import { useEffect } from 'react'
import { useAgent } from '@/contexts/AgentContext'
import { ChatMessage as ChatMessageType } from '@prisma/client'

interface AgentDetailClientProps {
  agentId: string
  agentName: string
  initialMessages: ChatMessageType[]
  defaultLanguage: string
}

export default function AgentDetailClient({
  agentId,
  agentName,
  initialMessages,
  defaultLanguage,
}: AgentDetailClientProps) {
  const { setAgent, clearAgent } = useAgent()

  useEffect(() => {
    setAgent(agentId, agentName, initialMessages, defaultLanguage)
    return () => {
      clearAgent()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, agentName, defaultLanguage])

  return null
}
