/**
 * Header Component
 * Top header bar with search, notifications, and user menu
 */
'use client'

import { useState } from 'react'
import { MagnifyingGlassIcon, BellIcon } from '@heroicons/react/24/outline'
import Dropdown from './Dropdown'

interface HeaderProps {
  title?: string
}

export default function Header({ title }: HeaderProps) {
  const [searchQuery, setSearchQuery] = useState('')

  return (
    <header className="sticky top-0 z-30 bg-white/80 dark:bg-gray-800/80 backdrop-blur-lg border-b border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between h-16 px-6">
        {/* Page title */}
        {title && (
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{title}</h1>
        )}

        {/* Right side actions */}
        <div className="flex items-center space-x-4">
          {/* Search */}
          <div className="hidden md:flex items-center relative">
            <MagnifyingGlassIcon className="absolute left-3 h-5 w-5 text-gray-400" />
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 pr-4 py-2 w-64 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
            />
          </div>

          {/* Notifications */}
          <button className="relative p-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors">
            <BellIcon className="h-6 w-6" />
            <span className="absolute top-1.5 right-1.5 h-2 w-2 bg-red-500 rounded-full"></span>
          </button>

          {/* User dropdown */}
          <Dropdown
            align="right"
            trigger={
              <button className="flex items-center space-x-3 p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors">
                <div className="h-8 w-8 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600"></div>
              </button>
            }
          >
            <div className="py-1">
              <div className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700">
                <p className="font-medium">Profile</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">user@example.com</p>
              </div>
              <a
                href="#"
                className="block px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                Help & Support
              </a>
            </div>
          </Dropdown>
        </div>
      </div>
    </header>
  )
}
