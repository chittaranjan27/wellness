/**
 * Embeddable Chat Widget Page
 * Public page that can be embedded via iframe
 * Uses the same AgentChat component as the dashboard for consistency
 */
'use client'

import { useParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import AgentChat from '@/components/AgentChat'
import { ChatMessage as ChatMessageType } from '@prisma/client'

// No persistent customer data: new visitor/session on every load so refresh starts fresh
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = Math.random() * 16 | 0
    const v = c === 'x' ? r : (r & 0x3 | 0x8)
    return v.toString(16)
  })
}

export default function EmbedChatPage() {
  const params = useParams()
  const agentId = params.agentId as string
  const [initialMessages, setInitialMessages] = useState<ChatMessageType[]>([])
  const [visitorId, setVisitorId] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)

  // New visitor and session on every load (no storage) – refresh starts fresh
  useEffect(() => {
    if (agentId) {
      setVisitorId(generateUUID())
      setSessionId(generateUUID())
    }
  }, [agentId])

  if (!agentId) {
    return (
      <div className="flex items-center justify-center h-[100dvh]">
        <p className="text-gray-500">Invalid agent ID</p>
      </div>
    )
  }

  return (
    <div className="h-[100dvh] w-full bg-white overflow-hidden">
      {visitorId && sessionId ? (
        <AgentChat
          agentId={agentId}
          initialMessages={initialMessages}
          defaultLanguage="en"
          apiEndpoint="/api/embed/chat"
          visitorId={visitorId}
          sessionId={sessionId}
        />
      ) : (
        <div className="flex items-center justify-center h-[100dvh]">
          <p className="text-gray-500">Loading...</p>
        </div>
      )}
    </div>
  )
}
