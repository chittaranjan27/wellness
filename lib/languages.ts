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
  {
    code: 'ur',
    name: 'Urdu',
    nativeName: 'اردو',
    speechRecognitionLang: 'ur-PK',
    elevenlabsVoiceId: '21m00Tcm4TlvDq8ikWAM', // Will need to find Urdu voice
    openaiLanguage: 'Urdu',
  },
  {
    code: 'bn',
    name: 'Bengali',
    nativeName: 'বাংলা',
    speechRecognitionLang: 'bn-BD',
    elevenlabsVoiceId: '21m00Tcm4TlvDq8ikWAM',
    openaiLanguage: 'Bengali',
  },
  {
    code: 'ar',
    name: 'Arabic',
    nativeName: 'العربية',
    speechRecognitionLang: 'ar-SA',
    elevenlabsVoiceId: '21m00Tcm4TlvDq8ikWAM',
    openaiLanguage: 'Arabic',
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
