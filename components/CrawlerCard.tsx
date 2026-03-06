/**
 * Website Crawler Card Component
 * Interface for crawling websites
 */
'use client'

import { useState, useEffect } from 'react'
import Card from './ui/Card'
import Button from './ui/Button'
import Badge from './ui/Badge'

interface CrawlStatus {
  status: string
  pagesCrawled: number
  chunksCreated: number
  url?: string
}

interface CrawlerCardProps {
  agentId: string
}

export default function CrawlerCard({ agentId }: CrawlerCardProps) {
  const [crawlUrl, setCrawlUrl] = useState('')
  const [crawling, setCrawling] = useState(false)
  const [crawlStatus, setCrawlStatus] = useState<CrawlStatus | null>(null)

  useEffect(() => {
    loadCrawlStatus()
  }, [agentId])

  const loadCrawlStatus = async () => {
    try {
      const res = await fetch(`/api/crawl/status/${agentId}`)
      if (res.ok) {
        const data = await res.json()
        if (data.status !== 'none') {
          setCrawlStatus(data)
        }
      }
    } catch (error) {
      console.error('Error loading crawl status:', error)
    }
  }

  const startCrawl = async () => {
    if (!crawlUrl.trim()) {
      alert('Please enter a URL')
      return
    }

    setCrawling(true)
    try {
      const res = await fetch('/api/crawl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, url: crawlUrl }),
      })

      if (res.ok) {
        alert('Crawl started! Check status below.')
        setCrawlUrl('')
        // Poll for status updates
        const interval = setInterval(() => {
          loadCrawlStatus()
        }, 3000)
        setTimeout(() => clearInterval(interval), 60000) // Stop after 1 minute
      } else {
        alert('Failed to start crawl')
      }
    } catch (error) {
      console.error('Crawl error:', error)
      alert('Error starting crawl')
    } finally {
      setCrawling(false)
    }
  }

  return (
    <Card>
      <div className="p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Website Crawler</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Website URL
            </label>
            <div className="flex space-x-2">
              <input
                type="url"
                value={crawlUrl}
                onChange={(e) => setCrawlUrl(e.target.value)}
                placeholder="https://example.com"
                className="flex-1 rounded-md border-gray-300 dark:border-gray-600 text-black dark:text-white shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm border px-3 py-2 bg-white dark:bg-gray-800"
              />
              <Button onClick={startCrawl} disabled={crawling || !crawlUrl.trim()}>
                {crawling ? 'Crawling...' : 'Start Crawl'}
              </Button>
            </div>
          </div>
          {crawlStatus && (
            <div className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Status: <Badge>{crawlStatus.status}</Badge>
                </p>
              </div>
              <div className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                <p>Pages Crawled: {crawlStatus.pagesCrawled}</p>
                <p>Chunks Created: {crawlStatus.chunksCreated}</p>
                {crawlStatus.url && (
                  <p className="text-xs text-gray-500 truncate">URL: {crawlStatus.url}</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}
