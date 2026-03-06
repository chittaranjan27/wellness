/**
 * Text Chunking Utility
 * Handles text sanitization and chunking for embeddings
 */

// Optimized chunk settings for better retrieval accuracy
const CHUNK_SIZE = 1500 // Characters per chunk
const CHUNK_OVERLAP = 300 // Overlap between chunks

/**
 * Sanitize text by removing null bytes and invalid UTF-8 sequences
 * PostgreSQL doesn't allow null bytes in UTF-8 text fields
 */
export function sanitizeText(text: string): string {
  if (!text) return text
  
  // Remove null bytes (0x00) - these cause PostgreSQL UTF-8 errors
  let sanitized = text.replace(/\x00/g, '')
  
  // Remove other control characters except newlines (\n), tabs (\t), and carriage returns (\r)
  sanitized = sanitized.replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  
  // Ensure valid UTF-8 encoding
  try {
    // Convert to buffer and back to string to ensure valid UTF-8
    // This will throw if there are invalid UTF-8 sequences
    const buffer = Buffer.from(sanitized, 'utf-8')
    sanitized = buffer.toString('utf-8')
  } catch (error) {
    console.warn('[TextChunker] UTF-8 encoding error, attempting recovery:', error)
    // Fallback: remove invalid UTF-8 sequences
    sanitized = sanitized.replace(/[\uFFFD]/g, '') // Remove replacement characters
    // Try encoding again
    try {
      const buffer = Buffer.from(sanitized, 'utf-8')
      sanitized = buffer.toString('utf-8')
    } catch (e) {
      // If still failing, use a more aggressive approach
      sanitized = sanitized.split('').filter(char => {
        try {
          Buffer.from(char, 'utf-8')
          return true
        } catch {
          return false
        }
      }).join('')
    }
  }
  
  // Normalize excessive whitespace but preserve structure
  // Replace multiple spaces with single space, but keep newlines
  sanitized = sanitized.replace(/[ \t]+/g, ' ')
  sanitized = sanitized.replace(/\n{3,}/g, '\n\n') // Max 2 consecutive newlines
  
  return sanitized.trim()
}

/**
 * Split text into chunks with overlap
 * Uses sliding window approach for better context preservation
 */
export function chunkText(text: string, chunkSize: number = CHUNK_SIZE, overlap: number = CHUNK_OVERLAP): Array<{
  text: string
  startIndex: number
  endIndex: number
}> {
  const chunks: Array<{ text: string; startIndex: number; endIndex: number }> = []
  let startIndex = 0

  while (startIndex < text.length) {
    const endIndex = Math.min(startIndex + chunkSize, text.length)
    const chunkText = text.substring(startIndex, endIndex)

    // Try to break at sentence boundaries for better chunk quality
    let actualEndIndex = endIndex
    if (endIndex < text.length) {
      // Look for sentence endings near the chunk boundary
      const sentenceEndings = /[.!?]\s+/g
      let match
      let lastMatchEnd = startIndex

      while ((match = sentenceEndings.exec(chunkText)) !== null) {
        lastMatchEnd = startIndex + match.index + match[0].length
      }

      // If we found a sentence ending, use it
      if (lastMatchEnd > startIndex + chunkSize * 0.7) {
        actualEndIndex = lastMatchEnd
      }
    }

    chunks.push({
      text: text.substring(startIndex, actualEndIndex).trim(),
      startIndex,
      endIndex: actualEndIndex,
    })

    // Move start index with overlap
    startIndex = actualEndIndex - overlap
    if (startIndex <= chunks[chunks.length - 1].startIndex) {
      startIndex = chunks[chunks.length - 1].endIndex
    }
  }

  return chunks
}
