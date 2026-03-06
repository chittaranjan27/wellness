/**
 * Dashboard Layout
 * Modern layout with sidebar and header
 */
import { redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth-options'
import Sidebar from '@/components/ui/Sidebar'
import { AgentProvider } from '@/contexts/AgentContext'
import DashboardChatWidget from '@/components/DashboardChatWidget'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await getServerSession(authOptions)

  if (!session) {
    redirect('/auth/signin')
  }

  return (
    <AgentProvider>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <Sidebar user={session.user} />
        <div className="lg:pl-64">
          <main className="py-6 px-4 sm:px-6 lg:px-8">
            {children}
          </main>
        </div>
        <DashboardChatWidget />
      </div>
    </AgentProvider>
  )
}
