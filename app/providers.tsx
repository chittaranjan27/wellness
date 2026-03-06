/**
 * Providers Component
 * Wraps app with necessary providers (SessionProvider for NextAuth)
 */
'use client'

import { SessionProvider } from 'next-auth/react'

export function Providers({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>
}
