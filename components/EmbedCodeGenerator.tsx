/**
 * Embed Code Generator Component
 * Generates embed code for agents
 */
'use client'

import { useState } from 'react'

interface EmbedCodeGeneratorProps {
  agentId: string
  agentName: string
  baseUrl?: string
}

export default function EmbedCodeGenerator({ agentId, agentName, baseUrl }: EmbedCodeGeneratorProps) {
  const [copied, setCopied] = useState(false)
  const [embedType, setEmbedType] = useState<'widget' | 'inline'>('widget')

  // Get base URL from window or use provided
  const getBaseUrl = () => {
    if (baseUrl) return baseUrl
    if (typeof window !== 'undefined') {
      return window.location.origin
    }
    return 'https://your-domain.com'
  }

  const widgetFloatingCode = `<script src="${getBaseUrl()}/widget.js" data-agent-id="${agentId}" data-type="floating" data-base-url="${getBaseUrl()}"></script>`

  const widgetInlineCode = `<div id="chat"></div>
<script src="${getBaseUrl()}/widget.js" data-agent-id="${agentId}" data-type="inline" data-target="chat" data-base-url="${getBaseUrl()}"></script>`

  const currentCode = embedType === 'widget' ? widgetFloatingCode : widgetInlineCode

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(currentCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  return (
    <div className="bg-white shadow rounded-lg p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Embed Code</h3>
      
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-2">Embed Type</label>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center">
            <input
              type="radio"
              value="widget"
              checked={embedType === 'widget'}
              onChange={(e) => setEmbedType(e.target.value as 'widget' | 'inline')}
              className="mr-2"
            />
            <span className="text-sm text-gray-700">Widget (Floating)</span>
          </label>
          <label className="flex items-center">
            <input
              type="radio"
              value="inline"
              checked={embedType === 'inline'}
              onChange={(e) => setEmbedType(e.target.value as 'widget' | 'inline')}
              className="mr-2"
            />
            <span className="text-sm text-gray-700">Widget (Inline)</span>
          </label>
        </div>
        <div className="mt-2 text-xs text-gray-500">
          {embedType === 'inline' && (
           <p>
           {"Make sure to add a "}
           <code className="bg-gray-100 px-1 rounded">
             {'<div id="chat"></div>'}
           </code>
           {" element where you want the chat to appear."}
         </p>

          )}
          {embedType === 'widget' && (
            <p>The floating widget will appear as a button in the bottom-right corner of your website.</p>
          )}
        </div>
      </div>

      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-gray-700">Code</label>
          <button
            onClick={handleCopy}
            className="text-sm text-indigo-600 hover:text-indigo-700 flex items-center space-x-1"
          >
            {copied ? (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span>Copied!</span>
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
        <textarea
          readOnly
          value={currentCode}
          className="w-full h-32 p-3 border border-gray-300 rounded-md font-mono text-xs bg-gray-50 text-gray-900"
          onClick={(e) => (e.target as HTMLTextAreaElement).select()}
        />
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
        <h4 className="text-sm font-medium text-blue-900 mb-2">Instructions:</h4>
        <ol className="text-sm text-blue-800 space-y-1 list-decimal list-inside">
          <li>Copy the code above</li>
          <li>{"Paste it into your website's HTML (preferably before the closing &lt;/body&gt; tag)"}</li>
          <li>The chat widget will load automatically</li>
          <li>For floating widget: A button will appear in the bottom-right corner</li>
          <li>For inline widget: Make sure the target div exists before the script runs</li>
        </ol>
        <div className="mt-2 text-xs text-blue-700">
          <strong>Note:</strong> {"If the widget doesn't appear, check the browser console for errors. Make sure the script URL is accessible."}
        </div>
      </div>
    </div>
  )
}
