/**
 * Home Page
 * Redirects to dashboard if authenticated, otherwise to signin
 */
import { redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth-options'

export default async function Home() {
  const session = await getServerSession(authOptions)

  if (session) {
    redirect('/dashboard')
  } else {
    redirect('/auth/signin')
  }
}
