/**
 * Environment variables validation
 * Ensures all required env vars are present at runtime
 */
export const env = {
  // Database
  DATABASE_URL: process.env.DATABASE_URL!,
  
  // NextAuth
  NEXTAUTH_URL: process.env.NEXTAUTH_URL || 'http://localhost:3000',
  NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET!,
  
  // OpenAI API (for chat and embeddings)
  OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
  
  // AgentBill SDK (optional)
  AGENTBILL_API_KEY: process.env.AGENTBILL_API_KEY || '',
  
  // Supabase (optional – app uses PostgreSQL via DATABASE_URL only)
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  
  // ElevenLabs
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY!,

  // SMTP (optional, for OTP emails)
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: parseInt(process.env.SMTP_PORT || '0'),
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  SMTP_FROM: process.env.SMTP_FROM || '',
  
  // File Upload
  UPLOAD_DIR: process.env.UPLOAD_DIR || './uploads',
  MAX_FILE_SIZE: parseInt(process.env.MAX_FILE_SIZE || '10485760'), // 10MB default
  
  // Node Environment
  NODE_ENV: process.env.NODE_ENV || 'development',
} as const

// Validate required environment variables
const requiredEnvVars = [
  'DATABASE_URL',
  'NEXTAUTH_SECRET',
  'OPENAI_API_KEY',
  'ELEVENLABS_API_KEY',
] as const

for (const key of requiredEnvVars) {
  if (!env[key as keyof typeof env]) {
    throw new Error(`Missing required environment variable: ${key}`)
  }
}
