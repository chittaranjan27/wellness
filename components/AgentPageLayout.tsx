/**
 * AgentPageLayout
 * Client wrapper that renders a sticky in-page sidebar alongside agent content.
 * Tracks the active section via IntersectionObserver — no routing changes needed.
 */
'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'

export interface AgentSidebarSection {
    id: string
    label: string
    icon: React.ReactNode
    badge?: string | number
    description: string
}

interface AgentPageLayoutProps {
    agentId: string
    agentName: string
    agentLanguage: string
    sections: AgentSidebarSection[]
    children: React.ReactNode
}

export default function AgentPageLayout({
    agentId,
    agentName,
    agentLanguage,
    sections,
    children,
}: AgentPageLayoutProps) {
    const [activeSection, setActiveSection] = useState(sections[0]?.id ?? '')
    const observerRef = useRef<IntersectionObserver | null>(null)

    useEffect(() => {
        const sectionEls = sections
            .map((s) => document.getElementById(s.id))
            .filter(Boolean) as HTMLElement[]

        observerRef.current = new IntersectionObserver(
            (entries) => {
                const visible = entries.filter((e) => e.isIntersecting)
                if (visible.length > 0) {
                    // pick the topmost visible section
                    const topmost = visible.reduce((a, b) =>
                        a.boundingClientRect.top < b.boundingClientRect.top ? a : b
                    )
                    setActiveSection(topmost.target.id)
                }
            },
            { root: null, rootMargin: '-20% 0px -60% 0px', threshold: 0 }
        )

        sectionEls.forEach((el) => observerRef.current!.observe(el))
        return () => observerRef.current?.disconnect()
    }, [sections])

    const scrollTo = (id: string) => {
        const el = document.getElementById(id)
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
    }

    return (
        <div className="flex gap-8 items-start min-h-screen">
            {/* ── Agent In-Page Sidebar ─────────────────────────────────── */}
            <aside className="hidden xl:flex flex-col w-64 flex-shrink-0 sticky top-6 self-start">
                {/* Agent Identity Card */}
                <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm overflow-hidden mb-4">
                    <div className="h-1.5 w-full bg-gradient-to-r from-emerald-400 via-teal-500 to-cyan-500" />
                    <div className="p-4">
                        <div className="flex items-center gap-3 mb-3">
                            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white font-bold text-sm shadow-inner flex-shrink-0">
                                {agentName[0]?.toUpperCase() ?? 'A'}
                            </div>
                            <div className="min-w-0">
                                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">{agentName}</p>
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 uppercase tracking-wide">
                                    {agentLanguage}
                                </span>
                            </div>
                        </div>
                        <Link
                            href={`/dashboard/agents/${agentId}/edit`}
                            className="flex items-center justify-center gap-1.5 w-full text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/20 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 rounded-lg px-3 py-2 transition-colors"
                        >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                            Edit Agent Settings
                        </Link>
                    </div>
                </div>

                {/* Section Navigation */}
                <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm overflow-hidden">
                    <div className="px-4 pt-4 pb-2">
                        <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">
                            Sections
                        </p>
                    </div>
                    <nav className="px-2 pb-3 space-y-0.5">
                        {sections.map((section, idx) => {
                            const isActive = activeSection === section.id
                            return (
                                <button
                                    key={section.id}
                                    onClick={() => scrollTo(section.id)}
                                    className={cn(
                                        'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all duration-200 group',
                                        isActive
                                            ? 'bg-emerald-50 dark:bg-emerald-900/25 text-emerald-800 dark:text-emerald-300'
                                            : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50 hover:text-gray-900 dark:hover:text-gray-100'
                                    )}
                                >
                                    {/* Step Number */}
                                    <div
                                        className={cn(
                                            'flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold transition-colors',
                                            isActive
                                                ? 'bg-emerald-600 dark:bg-emerald-500 text-white shadow-sm'
                                                : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 group-hover:bg-gray-200 dark:group-hover:bg-gray-600'
                                        )}
                                    >
                                        {idx + 1}
                                    </div>

                                    {/* Label */}
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-1.5">
                                            <span className="text-sm font-medium leading-tight truncate">{section.label}</span>
                                            {section.badge !== undefined && section.badge !== '' && (
                                                <span
                                                    className={cn(
                                                        'inline-flex items-center justify-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold min-w-[18px]',
                                                        isActive
                                                            ? 'bg-emerald-200 dark:bg-emerald-700 text-emerald-900 dark:text-emerald-200'
                                                            : 'bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300'
                                                    )}
                                                >
                                                    {section.badge}
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5 truncate leading-tight">
                                            {section.description}
                                        </p>
                                    </div>

                                    {/* Active indicator dot */}
                                    {isActive && (
                                        <div className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400" />
                                    )}
                                </button>
                            )
                        })}
                    </nav>

                    {/* Back to all agents */}
                    <div className="px-3 pb-3 pt-1 border-t border-gray-100 dark:border-gray-700 mt-1">
                        <Link
                            href="/dashboard/agents"
                            className="flex items-center gap-2 px-3 py-2 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 rounded-lg transition-colors"
                        >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                            </svg>
                            All Agents
                        </Link>
                    </div>
                </div>
            </aside>

            {/* ── Main Content ──────────────────────────────────────────── */}
            <div className="flex-1 min-w-0 space-y-10 pb-20">
                {children}
            </div>
        </div>
    )
}
