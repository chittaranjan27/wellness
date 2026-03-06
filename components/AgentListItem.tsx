/**
 * Agent List Item Component
 * Displays an agent with edit and delete actions
 */
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

interface Agent {
  id: string
  name: string
  systemPrompt: string
  updatedAt: Date | string
  _count: {
    documents: number
    chatMessages: number
  }
}

interface AgentListItemProps {
  agent: Agent
}

export default function AgentListItem({ agent }: AgentListItemProps) {
  const router = useRouter()
  const [isDeleting, setIsDeleting] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  const handleDelete = async () => {
    if (!showConfirm) {
      setShowConfirm(true)
      return
    }

    setIsDeleting(true)
    try {
      const response = await fetch(`/api/agents/${agent.id}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        const data = await response.json()
        alert(data.error || 'Failed to delete agent')
        return
      }

      // Refresh the page to show updated list
      router.refresh()
    } catch (error) {
      alert('An error occurred while deleting the agent')
    } finally {
      setIsDeleting(false)
      setShowConfirm(false)
    }
  }

  const handleEdit = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    router.push(`/dashboard/agents/${agent.id}/edit`)
  }

  return (
    <li>
      <div className="block hover:bg-gray-50">
        <div className="px-4 py-4 sm:px-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center flex-1 min-w-0">
              <Link
                href={`/dashboard/agents/${agent.id}`}
                className="text-sm font-medium text-indigo-600 truncate hover:text-indigo-800"
              >
                {agent.name}
              </Link>
            </div>
            <div className="ml-4 flex items-center space-x-2 flex-shrink-0">
              <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 text-green-800">
                Active
              </span>
              <div className="flex items-center space-x-1">
                <button
                  onClick={handleEdit}
                  className="p-1 text-indigo-600 hover:text-indigo-800 hover:bg-indigo-50 rounded transition-colors"
                  title="Edit agent"
                  aria-label="Edit agent"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                    />
                  </svg>
                </button>
                {showConfirm ? (
                  <div className="flex items-center space-x-1">
                    <button
                      onClick={handleDelete}
                      disabled={isDeleting}
                      className="p-1 text-red-600 hover:text-red-800 hover:bg-red-50 rounded transition-colors disabled:opacity-50"
                      title="Confirm delete"
                      aria-label="Confirm delete"
                    >
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    </button>
                    <button
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setShowConfirm(false)
                      }}
                      className="p-1 text-gray-600 hover:text-gray-800 hover:bg-gray-50 rounded transition-colors"
                      title="Cancel"
                      aria-label="Cancel"
                    >
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      handleDelete()
                    }}
                    disabled={isDeleting}
                    className="p-1 text-red-600 hover:text-red-800 hover:bg-red-50 rounded transition-colors disabled:opacity-50"
                    title="Delete agent"
                    aria-label="Delete agent"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="mt-2 sm:flex sm:justify-between">
            <div className="sm:flex">
              <p className="flex items-center text-sm text-gray-500">
                {agent._count.documents} documents
              </p>
              <p className="mt-2 flex items-center text-sm text-gray-500 sm:mt-0 sm:ml-6">
                {agent._count.chatMessages} messages
              </p>
            </div>
            <div className="mt-2 flex items-center text-sm text-gray-500 sm:mt-0">
              <p>Updated {new Date(agent.updatedAt).toLocaleDateString()}</p>
            </div>
          </div>
          <div className="mt-2">
            <p className="text-sm text-gray-600 line-clamp-2">{agent.systemPrompt.substring(0, 150)}...</p>
          </div>
        </div>
      </div>
    </li>
  )
}
