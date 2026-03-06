/**
 * Document List Component
 * Shows documents for an agent with upload functionality
 */
'use client'

import { useState, useRef } from 'react'
import { Document } from '@prisma/client'

interface DocumentListProps {
  agentId: string
  documents: Document[]
}

export default function DocumentList({ agentId, documents: initialDocuments }: DocumentListProps) {
  const [documents, setDocuments] = useState(initialDocuments)
  const [uploading, setUploading] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setUploading(true)

    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('agentId', agentId)

      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Upload failed')
      }

      // Add document to list (optimistic update)
      setDocuments((prev) => [
        {
          id: data.documentId,
          agentId,
          filename: file.name,
          filepath: '',
          fileSize: file.size,
          mimeType: file.type,
          extractedText: null,
          status: 'pending',
          chunksCount: 0,
          embeddingsCount: 0,
          errorMessage: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        ...prev,
      ])

      // Poll for status updates
      pollDocumentStatus(data.documentId)
    } catch (error) {
      console.error('Upload error:', error)
      alert('Failed to upload file. Please try again.')
    } finally {
      setUploading(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  const pollDocumentStatus = async (documentId: string) => {
    const maxAttempts = 60 // 5 minutes max
    let attempts = 0

    const interval = setInterval(async () => {
      attempts++
      try {
        const response = await fetch(`/api/documents/${documentId}`)
        if (response.ok) {
          const data = await response.json()
          setDocuments((prev) =>
            prev.map((doc) => (doc.id === documentId ? data : doc))
          )

          if (data.status === 'completed' || data.status === 'failed') {
            clearInterval(interval)
          }
        }
      } catch (error) {
        console.error('Status poll error:', error)
      }

      if (attempts >= maxAttempts) {
        clearInterval(interval)
      }
    }, 5000) // Poll every 5 seconds
  }

  const handleDelete = async (documentId: string, filename: string) => {
    if (!confirm(`Are you sure you want to delete "${filename}"? This action cannot be undone.`)) {
      return
    }

    setDeleting(documentId)

    try {
      const response = await fetch(`/api/documents/${documentId}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Delete failed')
      }

      // Remove document from list (optimistic update)
      setDocuments((prev) => prev.filter((doc) => doc.id !== documentId))
    } catch (error) {
      console.error('Delete error:', error)
      alert('Failed to delete document. Please try again.')
    } finally {
      setDeleting(null)
    }
  }

  const getStatusBadge = (status: string) => {
    const styles = {
      pending: 'bg-yellow-100 text-yellow-800',
      processing: 'bg-blue-100 text-blue-800',
      completed: 'bg-green-100 text-green-800',
      failed: 'bg-red-100 text-red-800',
    }

    return (
      <span className={`px-2 py-1 text-xs font-semibold rounded-full ${styles[status as keyof typeof styles] || styles.pending}`}>
        {status}
      </span>
    )
  }

  return (
    <div className="bg-white shadow rounded-lg flex flex-col" style={{ height: '600px' }}>
      <div className="px-4 py-3 border-b border-gray-200 flex justify-between items-center">
        <h2 className="text-lg font-medium text-gray-900">Knowledge Base</h2>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.txt,.md,.doc,.docx"
          onChange={handleFileSelect}
          className="hidden"
          id="file-upload"
        />
        <label
          htmlFor="file-upload"
          className="px-3 py-1 text-sm font-medium text-indigo-600 hover:text-indigo-500 cursor-pointer"
        >
          Upload
        </label>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {uploading && (
          <div className="mb-4 text-sm text-gray-500">Uploading and processing...</div>
        )}

        {documents.length === 0 ? (
          <div className="text-center text-gray-500 py-8">
            <p className="mb-4">No documents yet</p>
            <label
              htmlFor="file-upload"
              className="inline-block px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 cursor-pointer"
            >
              Upload Document
            </label>
            <p className="mt-2 text-xs text-gray-400">PDF, TXT, DOCX supported</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {documents.map((doc) => (
              <li key={doc.id} className="border border-gray-200 rounded-lg p-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{doc.filename}</p>
                    <div className="mt-1 flex items-center space-x-2">
                      {getStatusBadge(doc.status)}
                      <span className="text-xs text-gray-500">
                        {(doc.fileSize / 1024).toFixed(1)} KB
                      </span>
                    </div>
                    {doc.status === 'completed' && (
                      <p className="mt-1 text-xs text-gray-500">
                        {doc.chunksCount} chunks, {doc.embeddingsCount} embeddings
                      </p>
                    )}
                    {doc.status === 'failed' && doc.errorMessage && (
                      <p className="mt-1 text-xs text-red-600">{doc.errorMessage}</p>
                    )}
                    {doc.status === 'processing' && (
                      <p className="mt-1 text-xs text-blue-600">Processing document...</p>
                    )}
                  </div>
                  <button
                    onClick={() => handleDelete(doc.id, doc.filename)}
                    disabled={deleting === doc.id}
                    className="ml-3 p-1.5 text-gray-400 hover:text-red-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    title="Delete document"
                  >
                    {deleting === doc.id ? (
                      <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    ) : (
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    )}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
