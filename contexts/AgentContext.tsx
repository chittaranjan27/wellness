/**
 * Agent Context
 * Provides current agent context for the chat widget
 */
'use client'

import { createContext, useContext, useState, ReactNode } from 'react'
import { ChatMessage as ChatMessageType } from '@prisma/client'

interface AgentContextType {
  agentId: string | null
  agentName: string | null
  initialMessages: ChatMessageType[]
  defaultLanguage: string
  setAgent: (agentId: string, agentName: string, initialMessages: ChatMessageType[], defaultLanguage?: string) => void
  clearAgent: () => void
}

const AgentContext = createContext<AgentContextType | undefined>(undefined)

export function AgentProvider({ children }: { children: ReactNode }) {
  const [agentId, setAgentId] = useState<string | null>(null)
  const [agentName, setAgentName] = useState<string | null>(null)
  const [initialMessages, setInitialMessages] = useState<ChatMessageType[]>([])
  const [defaultLanguage, setDefaultLanguage] = useState<string>('en')

  const setAgent = (
    id: string,
    name: string,
    messages: ChatMessageType[],
    language: string = 'en'
  ) => {
    setAgentId(id)
    setAgentName(name)
    setInitialMessages(messages)
    setDefaultLanguage(language)
  }

  const clearAgent = () => {
    setAgentId(null)
    setAgentName(null)
    setInitialMessages([])
    setDefaultLanguage('en')
  }

  return (
    <AgentContext.Provider
      value={{
        agentId,
        agentName,
        initialMessages,
        defaultLanguage,
        setAgent,
        clearAgent,
      }}
    >
      {children}
    </AgentContext.Provider>
  )
}

export function useAgent() {
  const context = useContext(AgentContext)
  if (context === undefined) {
    throw new Error('useAgent must be used within an AgentProvider')
  }
  return context
}
