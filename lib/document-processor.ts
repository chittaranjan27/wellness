/**
 * Document Processing Service
 * Handles text extraction, chunking, and embedding generation
 */
import fs from 'fs/promises'
import path from 'path'
import pdfParse from 'pdf-parse'
import mammoth from 'mammoth'
import { generateEmbeddingsBatch } from './embeddings'
import { storeEmbedding, deleteDocumentEmbeddings } from './vector-db'
import { prisma } from './prisma'

// Optimized chunk settings for better retrieval accuracy
// Increased chunk size for better context preservation
// Increased overlap for better context continuity between chunks
const CHUNK_SIZE = 1500 // Characters per chunk (increased from 1000 for better context)
const CHUNK_OVERLAP = 300 // Overlap between chunks (increased from 200 for better context preservation)

/**
 * Sanitize text by removing null bytes and invalid UTF-8 sequences
 * PostgreSQL doesn't allow null bytes in UTF-8 text fields
 */
function sanitizeText(text: string): string {
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
    console.warn('[DocumentProcessor] UTF-8 encoding error, attempting recovery:', error)
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
 * Extract text from uploaded file based on MIME type
 */
export async function extractText(filepath: string, mimeType: string): Promise<string> {
  try {
    if (mimeType === 'application/pdf') {
      const dataBuffer = await fs.readFile(filepath)
      const data = await pdfParse(dataBuffer)
      return data.text
    } else if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      mimeType === 'application/msword'
    ) {
      const dataBuffer = await fs.readFile(filepath)
      const result = await mammoth.extractRawText({ buffer: dataBuffer })
      return result.value
    } else if (mimeType === 'text/plain' || mimeType === 'text/markdown') {
      return await fs.readFile(filepath, 'utf-8')
    } else {
      throw new Error(`Unsupported file type: ${mimeType}`)
    }
  } catch (error) {
    console.error('Text extraction error:', error)
    throw new Error(`Failed to extract text: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
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

/**
 * Process document: extract, chunk, embed, and store
 * This is the main function called after document upload
 */
export async function processDocument(documentId: string): Promise<void> {
  try {
    // Fetch document
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      include: { agent: true },
    })

    if (!document) {
      throw new Error('Document not found')
    }

    // Update status to processing
    await prisma.document.update({
      where: { id: documentId },
      data: { status: 'processing' },
    })

    // Extract text
    let extractedText = await extractText(document.filepath, document.mimeType)
    
    if (!extractedText) {
      throw new Error('No text could be extracted from the document')
    }
    
    console.log(`[DocumentProcessor] Extracted ${extractedText.length} characters from document`)
    
    // Sanitize extracted text to remove null bytes and invalid UTF-8 sequences
    const originalLength = extractedText.length
    extractedText = sanitizeText(extractedText)
    const sanitizedLength = extractedText.length
    
    if (originalLength !== sanitizedLength) {
      console.log(`[DocumentProcessor] Sanitized text: removed ${originalLength - sanitizedLength} invalid characters`)
    }
    
    if (!extractedText || extractedText.length === 0) {
      throw new Error('No valid text could be extracted from the document after sanitization')
    }

    // Update document with extracted text
    await prisma.document.update({
      where: { id: documentId },
      data: { extractedText },
    })

    // Chunk text
    const chunks = chunkText(extractedText)

    // Create chunk records in database (sanitize chunk text as well)
    const chunkRecords = await Promise.all(
      chunks.map((chunk, index) =>
        prisma.documentChunk.create({
          data: {
            documentId,
            chunkIndex: index,
            text: sanitizeText(chunk.text), // Sanitize chunk text
            startIndex: chunk.startIndex,
            endIndex: chunk.endIndex,
          },
        })
      )
    )

    // Generate embeddings in batches (OpenAI allows batch requests)
    const batchSize = 100
    const chunkIds = chunkRecords.map((chunk) => chunk.id)
    const chunkTexts = chunkRecords.map((chunk) => chunk.text)

    console.log(`[DocumentProcessor] Processing ${chunkTexts.length} chunks in batches of ${batchSize} for document ${documentId}`)
    
    let successfulBatches = 0
    let failedBatches = 0

    for (let i = 0; i < chunkTexts.length; i += batchSize) {
      const batch = chunkTexts.slice(i, i + batchSize)
      const batchIds = chunkIds.slice(i, i + batchSize)

      try {
        console.log(`[DocumentProcessor] Processing batch ${i / batchSize + 1}/${Math.ceil(chunkTexts.length / batchSize)} (chunks ${i}-${Math.min(i + batchSize, chunkTexts.length)})`)
        
        const embeddings = await generateEmbeddingsBatch(batch)
        console.log(`[DocumentProcessor] Generated ${embeddings.length} embeddings for batch`)

        // Store embeddings directly in document_chunks table
        await Promise.all(
          embeddings.map((embedding, idx) =>
            storeEmbedding(batchIds[idx], document.agentId, embedding, batch[idx])
          )
        )
        console.log(`[DocumentProcessor] Stored ${embeddings.length} embeddings in database`)
        
        successfulBatches++
      } catch (error) {
        console.error(`[DocumentProcessor] Error processing batch ${i}-${i + batchSize}:`, error)
        console.error(`[DocumentProcessor] Error details:`, error instanceof Error ? error.stack : String(error))
        failedBatches++
        // Continue with next batch
      }
    }

    console.log(`[DocumentProcessor] Completed processing: ${successfulBatches} successful batches, ${failedBatches} failed batches`)

    // Update document status to completed
    await prisma.document.update({
      where: { id: documentId },
      data: {
        status: 'completed',
        chunksCount: chunks.length,
        embeddingsCount: chunkRecords.length,
      },
    })
  } catch (error) {
    console.error('[DocumentProcessor] Document processing error:', error)
    console.error('[DocumentProcessor] Error details:', error instanceof Error ? error.stack : String(error))

    // Update document status to failed (with error handling to prevent cascading errors)
    try {
      const errorMessage = error instanceof Error 
        ? error.message.substring(0, 500) // Limit error message length
        : 'Unknown error'
      
      await prisma.document.update({
        where: { id: documentId },
        data: {
          status: 'failed',
          errorMessage: sanitizeText(errorMessage), // Sanitize error message too
        },
      })
    } catch (updateError) {
      console.error('[DocumentProcessor] Failed to update document status:', updateError)
      // Don't throw here - we want to throw the original error
    }

    throw error
  }
}

/**
 * Delete document and cleanup associated data
 */
export async function deleteDocument(documentId: string): Promise<void> {
  try {
    // Fetch chunks before deletion
    const chunks = await prisma.documentChunk.findMany({
      where: { documentId },
      select: { id: true },
    })

    const chunkIds = chunks.map((chunk) => chunk.id)

    // Delete embeddings from vector DB
    await deleteDocumentEmbeddings(chunkIds)

    // Delete document file from filesystem
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: { filepath: true },
    })

    if (document) {
      try {
        await fs.unlink(document.filepath)
      } catch (error) {
        console.error('Error deleting file:', error)
        // Continue even if file deletion fails
      }
    }

    // Delete document (cascades to chunks)
    await prisma.document.delete({
      where: { id: documentId },
    })
  } catch (error) {
    console.error('Error deleting document:', error)
    throw error
  }
}
