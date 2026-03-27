/**
 * Language configuration and utilities
 * Supports multiple languages for chat, speech recognition, and text-to-speech
 */

export interface Language {
  code: string
  name: string
  nativeName: string
  speechRecognitionLang: string // Web Speech API language code
  elevenlabsVoiceId?: string // ElevenLabs voice ID for TTS
  openaiLanguage?: string // Language name for OpenAI prompts
}

export const SUPPORTED_LANGUAGES: Language[] = [
  {
    code: 'en',
    name: 'English',
    nativeName: 'English',
    speechRecognitionLang: 'en-US',
    elevenlabsVoiceId: '21m00Tcm4TlvDq8ikWAM', // Default English voice
    openaiLanguage: 'English',
  },
  {
    code: 'hi',
    name: 'Hindi',
    nativeName: 'हिन्दी',
    speechRecognitionLang: 'hi-IN',
    elevenlabsVoiceId: '21m00Tcm4TlvDq8ikWAM', // Will need to find Hindi voice
    openaiLanguage: 'Hindi',
  },
]

export function getLanguageByCode(code: string): Language | undefined {
  return SUPPORTED_LANGUAGES.find((lang) => lang.code === code)
}

export function getDefaultLanguage(): Language {
  return SUPPORTED_LANGUAGES[0] // English
}

export function getLanguageName(code: string): string {
  const lang = getLanguageByCode(code)
  return lang ? lang.nativeName : code
}
