/**
 * Voice Chat Button Component
 * Button for speech-to-text input
 */
'use client'

interface VoiceChatButtonProps {
  isListening: boolean
  onClick: () => void
  disabled?: boolean
}

export default function VoiceChatButton({ isListening, onClick, disabled }: VoiceChatButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium ${
        isListening
          ? 'bg-red-600 text-white border-red-600'
          : 'bg-white text-gray-700 hover:bg-gray-50'
      } focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-teal-500 disabled:opacity-50 disabled:cursor-not-allowed`}
      title={isListening ? 'Stop listening' : 'Start voice input'}
    >
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        {isListening ? (
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        ) : (
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
        )}
      </svg>
    </button>
  )
}
