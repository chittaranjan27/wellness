/**
 * Create Agent Page
 * Form to create a new AI agent
 */
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import LanguageSelector from '@/components/LanguageSelector'

export default function NewAgentPage() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [language, setLanguage] = useState('en')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const response = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, language }),
      })

      const data = await response.json()

      if (!response.ok) {
        setError(data.error || 'Failed to create agent')
      } else {
        router.push(`/dashboard/agents/${data.id}`)
      }
    } catch (err) {
      setError('An error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="px-4 sm:px-6 lg:px-8 max-w-3xl mx-auto">
      <div className="mb-6">
        <Link
          href="/dashboard/agents"
          className="text-indigo-600 hover:text-indigo-500 text-sm font-medium"
        >
          ← Back to Agents
        </Link>
      </div>

      <h1 className="text-3xl font-bold text-gray-900 mb-6">Create New Agent</h1>

      <form onSubmit={handleSubmit} className="bg-white shadow rounded-lg p-6 space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="name" className="block text-sm font-medium text-gray-700">
            Agent Name
          </label>
          <input
            type="text"
            id="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 text-black sm:text-sm border px-3 py-2"
            placeholder="e.g., Customer Support Agent"
          />
        </div>


        <div>
          <label htmlFor="language" className="block text-sm font-medium text-gray-700 mb-2">
            Default Language
          </label>
          <LanguageSelector
            selectedLanguage={language}
            onLanguageChange={setLanguage}
          />
          <p className="mt-2 text-sm text-gray-500">
            {"Select the default language for this agent's responses. Users can change this in the chat interface."}
          </p>
        </div>

        <div className="flex justify-end space-x-3">
          <Link
            href="/dashboard/agents"
            className="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Creating...' : 'Create Agent'}
          </button>
        </div>
      </form>
    </div>
  )
}
