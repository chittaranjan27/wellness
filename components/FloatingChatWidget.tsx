/**
 * Floating Chat Widget Component
 * A floating chat interface that appears in the bottom right corner
 */
'use client'

import { useState } from 'react'
import { ChatMessage as ChatMessageType } from '@prisma/client'
import AgentChat from './AgentChat'

interface FloatingChatWidgetProps {
  agentId: string
  initialMessages: ChatMessageType[]
  defaultLanguage?: string
  agentName?: string
}

export default function FloatingChatWidget({
  agentId,
  initialMessages,
  defaultLanguage = 'en',
  agentName = 'Wellness AI',
}: FloatingChatWidgetProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [chatKey, setChatKey] = useState(0) // Key to force remount of AgentChat

  const toggleChat = () => {
    setIsOpen(!isOpen)
  }

  const closeChat = () => {
    setIsOpen(false)
  }

  const handleClearChat = async () => {
    // Show confirmation alert
    const confirmed = window.confirm(
      'Are you sure you want to clear the chat? All previous messages will be permanently lost and cannot be recovered.'
    )

    if (!confirmed) {
      return
    }

    try {
      // Call API to clear messages
      const response = await fetch(`/api/chat?agentId=${agentId}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        throw new Error('Failed to clear chat')
      }

      // Force remount of AgentChat component with empty messages
      setChatKey((prev) => prev + 1)
    } catch (error) {
      console.error('Error clearing chat:', error)
      alert('Failed to clear chat. Please try again.')
    }
  }

  return (
    <>
      {/* Floating Chat Button */}
      {!isOpen && (
        <button
          onClick={toggleChat}
          className="fixed bottom-6 right-6 z-50 bg-teal-500 hover:bg-teal-600 text-white rounded-full p-3 shadow-lg hover:shadow-xl transition-all duration-300 flex items-center justify-center group w-14 h-14"
          aria-label="Open chat"
        >
          <img
            src="/robot-assistant.png"
            alt=""
            className="w-8 h-8 object-contain transition-transform group-hover:scale-110"
          />
          {/* Notification badge (optional - can show unread count) */}
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center animate-pulse">
            <span className="w-2 h-2 bg-white rounded-full"></span>
          </span>
        </button>
      )}

      {/* Chat Popup Window */}
      {isOpen && (
        <div
          className="fixed bottom-6 right-6 z-50 bg-white rounded-lg shadow-2xl transition-all duration-300 ease-out w-96 h-[600px] md:w-[450px] md:h-[650px] flex flex-col"
        >
          {/* Header */}
          <div className="bg-indigo-600 text-white px-4 py-3 rounded-t-lg flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <div className="w-2 h-2 bg-green-400 rounded-full"></div>
              <h3 className="font-semibold text-sm">{agentName}</h3>
            </div>
            <div className="flex items-center space-x-2">
              <button
                onClick={handleClearChat}
                className="hover:bg-teal-600 rounded p-1 transition-colors"
                aria-label="Clear chat"
                title="Clear chat"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          </div>

          {/* Chat Content */}
          <div className="flex-1 overflow-hidden">
            <AgentChat
              key={chatKey}
              agentId={agentId}
              initialMessages={chatKey === 0 ? initialMessages : []}
              defaultLanguage={defaultLanguage}
            />
          </div>
        </div>
      )}

      {/* Backdrop (optional - dims background when chat is open) */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-10 z-40 transition-opacity duration-300"
          onClick={closeChat}
          aria-hidden="true"
        />
      )}
    </>
  )
}