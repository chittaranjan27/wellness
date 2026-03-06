/**
 * Website Crawler Service — Product-Focused
 * Crawls a website and extracts ONLY product pages.
 * Non-product pages (blogs, about, checkout, etc.) are skipped
 * so the knowledge base contains only clean product data.
 */
import { isProductUrl, isProductPage, extractProductData } from './htmlCleaner'
import { chunkText, sanitizeText } from './textChunker'
import { generateEmbeddingsBatch } from './embeddings'
import { storeEmbedding } from './vector-db'
import { prisma } from './prisma'

const MAX_DEPTH = 3        // Maximum crawl depth
const MAX_PAGES = 50       // Maximum product pages to process
const REQUEST_DELAY = 800  // ms between requests (polite crawling)

interface CrawlState {
  visited: Set<string>
  queue: Array<{ url: string; depth: number }>
  pagesProcessed: number
  pagesSkipped: number
  chunksCreated: number
}

/** ── URL helpers ─────────────────────────────────────────────────────────── */

function getBaseUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return url
  }
}

function normalizeUrl(href: string, baseUrl: string): string | null {
  try {
    const abs = href.startsWith('http') ? href : new URL(href, baseUrl).href
    const u = new URL(abs)
    u.hash = ''
    let normalized = u.href
    if (normalized.endsWith('/') && normalized !== `${u.protocol}//${u.host}/`) {
      normalized = normalized.slice(0, -1)
    }
    return normalized
  } catch {
    return null
  }
}

function isInternalUrl(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).hostname === new URL(baseUrl).hostname
  } catch {
    return false
  }
}

/** ── Network helpers ─────────────────────────────────────────────────────── */

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; WellnessBot/1.0; +https://wellness.ai/bot)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    // 15-second timeout
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  return response.text()
}

/** ── Link extractor ──────────────────────────────────────────────────────── */

function extractLinks(html: string, baseUrl: string): string[] {
  try {
    const { JSDOM } = require('jsdom')
    const doc = new JSDOM(html).window.document
    const hrefs = new Set<string>()
    for (const anchor of Array.from(doc.querySelectorAll('a[href]')) as Element[]) {
      const href = anchor.getAttribute('href')
      if (!href) continue
      const normalized = normalizeUrl(href, baseUrl)
      if (normalized && isInternalUrl(normalized, baseUrl)) {
        hrefs.add(normalized)
      }
    }
    return [...hrefs]
  } catch {
    return []
  }
}

/** ── Core page processor ─────────────────────────────────────────────────── */

/**
 * Fetch a page, verify it is a product page, extract structured product data,
 * chunk it, generate embeddings, and persist everything to the database.
 *
 * @returns Number of embedded chunks created, or -1 if the page was skipped.
 */
async function processPage(
  url: string,
  agentId: string,
  crawlJobId: string
): Promise<number> {
  console.log(`[Crawler] Fetching: ${url}`)

  // ── Step 1: Fetch HTML ────────────────────────────────────────────────────
  let html: string
  try {
    html = await fetchHtml(url)
  } catch (err) {
    console.warn(`[Crawler] Fetch failed for ${url}:`, err)
    return -1
  }

  // ── Step 2: Confirm it's a product page ───────────────────────────────────
  if (!isProductPage(html)) {
    console.log(`[Crawler] Skipped (not a product page): ${url}`)
    return -1
  }

  // ── Step 3: Extract structured product data ───────────────────────────────
  const product = extractProductData(html, url)

  // Require at least a name or a description — skip otherwise
  if (!product.name && !product.description && !product.structuredText) {
    console.warn(`[Crawler] Skipped (no product data extracted): ${url}`)
    return -1
  }

  // Sanitize the structured text block
  const sanitizedText = sanitizeText(product.structuredText)
  if (sanitizedText.length < 50) {
    console.warn(`[Crawler] Skipped (structured text too short): ${url}`)
    return -1
  }

  console.log(`[Crawler] Product found: "${product.name || '(unnamed)'}" — ${url}`)

  // ── Step 4: Create Document record ────────────────────────────────────────
  const doc = await prisma.document.create({
    data: {
      agentId,
      // Use product name as filename; fall back to last URL segment
      filename: product.name
        ? `${product.name.slice(0, 80).replace(/[^a-zA-Z0-9 _-]/g, '')}.product`
        : (new URL(url).pathname.split('/').pop() || 'product') + '.html',
      filepath: url,
      fileSize: sanitizedText.length,
      mimeType: 'text/html',
      extractedText: sanitizedText,
      status: 'processing',
      chunksCount: 0,
      embeddingsCount: 0,
    },
  })

  // ── Step 5: Chunk the structured text ─────────────────────────────────────
  const chunks = chunkText(sanitizedText)
  console.log(`[Crawler] ${chunks.length} chunk(s) for "${product.name || url}"`)

  // ── Step 6: Persist chunks ────────────────────────────────────────────────
  const chunkRecords = await Promise.all(
    chunks.map((chunk, index) =>
      prisma.documentChunk.create({
        data: {
          documentId: doc.id,
          chunkIndex: index,
          text: sanitizeText(chunk.text),
          startIndex: chunk.startIndex,
          endIndex: chunk.endIndex,
        },
      })
    )
  )

  // ── Step 7: Generate and store embeddings ─────────────────────────────────
  const chunkIds = chunkRecords.map((c) => c.id)
  const chunkTexts = chunkRecords.map((c) => c.text)
  let chunksWithEmbeddings = 0
  const BATCH = 100

  for (let i = 0; i < chunkTexts.length; i += BATCH) {
    const batchTexts = chunkTexts.slice(i, i + BATCH)
    const batchIds = chunkIds.slice(i, i + BATCH)
    try {
      const embeddings = await generateEmbeddingsBatch(batchTexts)
      await Promise.all(
        embeddings.map((emb, idx) => storeEmbedding(batchIds[idx], agentId, emb, batchTexts[idx]))
      )
      chunksWithEmbeddings += embeddings.length
    } catch (err) {
      console.error('[Crawler] Embedding batch failed:', err)
    }
  }

  // ── Step 8: Mark document complete ────────────────────────────────────────
  await prisma.document.update({
    where: { id: doc.id },
    data: {
      status: 'completed',
      chunksCount: chunks.length,
      embeddingsCount: chunksWithEmbeddings,
    },
  })

  console.log(`[Crawler] ✓ ${url} — ${chunksWithEmbeddings} embeddings stored`)
  return chunksWithEmbeddings
}

/** ── Public API ──────────────────────────────────────────────────────────── */

/**
 * Crawl a website starting from startUrl, collecting ONLY product pages.
 */
export async function crawlWebsite(
  agentId: string,
  startUrl: string,
  maxDepth: number = MAX_DEPTH,
  maxPages: number = MAX_PAGES
): Promise<{
  pagesCrawled: number
  pagesSkipped: number
  chunksCreated: number
  error?: string
}> {
  const baseUrl = getBaseUrl(startUrl)

  const state: CrawlState = {
    visited: new Set(),
    queue: [{ url: startUrl, depth: 0 }],
    pagesProcessed: 0,
    pagesSkipped: 0,
    chunksCreated: 0,
  }

  // Create crawl job record
  const crawlJob = await prisma.crawlJob.create({
    data: {
      agentId,
      url: startUrl,
      status: 'crawling',
      pagesCrawled: 0,
      pagesTotal: 0,
      chunksCreated: 0,
      metadata: { maxDepth, maxPages, mode: 'product-only' },
    },
  })

  try {
    while (state.queue.length > 0 && state.pagesProcessed < maxPages) {
      const { url, depth } = state.queue.shift()!

      if (state.visited.has(url) || depth > maxDepth) continue
      state.visited.add(url)

      // ── URL-level filter: skip obviously non-product URLs ─────────────────
      if (!isProductUrl(url)) {
        console.log(`[Crawler] Skipped by URL filter: ${url}`)
        state.pagesSkipped++
        continue
      }

      try {
        const result = await processPage(url, agentId, crawlJob.id)

        if (result >= 0) {
          // Genuine product page processed
          state.chunksCreated += result
          state.pagesProcessed++
        } else {
          // Page fetched but not a product page
          state.pagesSkipped++
        }

        // Update crawl job progress
        await prisma.crawlJob.update({
          where: { id: crawlJob.id },
          data: {
            pagesCrawled: state.pagesProcessed,
            chunksCreated: state.chunksCreated,
          },
        })

        // ── Extract links for next depth level ─────────────────────────────
        if (depth < maxDepth) {
          try {
            const html = await fetchHtml(url)
            const links = extractLinks(html, baseUrl)
            for (const link of links) {
              if (!state.visited.has(link) && state.queue.length < maxPages * 3) {
                state.queue.push({ url: link, depth: depth + 1 })
              }
            }
          } catch {
            // Link extraction failure is non-fatal
          }
        }

        // Polite delay
        if (state.queue.length > 0) {
          await new Promise((r) => setTimeout(r, REQUEST_DELAY))
        }
      } catch (err) {
        console.error(`[Crawler] Unexpected error for ${url}:`, err)
        state.pagesSkipped++
      }
    }

    // Mark job complete
    await prisma.crawlJob.update({
      where: { id: crawlJob.id },
      data: {
        status: 'completed',
        pagesCrawled: state.pagesProcessed,
        chunksCreated: state.chunksCreated,
      },
    })

    console.log(
      `[Crawler] Done — ${state.pagesProcessed} product pages, ` +
      `${state.pagesSkipped} skipped, ${state.chunksCreated} chunks`
    )

    return {
      pagesCrawled: state.pagesProcessed,
      pagesSkipped: state.pagesSkipped,
      chunksCreated: state.chunksCreated,
    }
  } catch (err) {
    await prisma.crawlJob.update({
      where: { id: crawlJob.id },
      data: {
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
      },
    })

    return {
      pagesCrawled: state.pagesProcessed,
      pagesSkipped: state.pagesSkipped,
      chunksCreated: state.chunksCreated,
      error: err instanceof Error ? err.message : 'Unknown error',
    }
  }
}
