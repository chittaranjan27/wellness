/**
 * NextAuth Configuration
 * Handles authentication with email/password credentials
 * Uses Prisma adapter for session management
 */
import NextAuth from 'next-auth'
import { authOptions } from '@/lib/auth-options'

const handler = NextAuth(authOptions)

export { handler as GET, handler as POST }
