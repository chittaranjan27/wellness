/**
 * Vector Database Service (PostgreSQL with pgvector)
 * Handles storing and retrieving embeddings for RAG
 * Uses PostgreSQL directly via Prisma raw SQL queries
 */
import { Prisma } from '@prisma/client'
import { prisma } from './prisma'
import { env } from './env'

/**
 * Store embedding in PostgreSQL document_chunks table
 * @param chunkId - Document chunk ID
 * @param agentId - Agent ID for isolation
 * @param embedding - Embedding vector
 * @param text - Original text for reference
 */
export async function storeEmbedding(
  chunkId: string,
  agentId: string,
  embedding: number[],
  text: string
): Promise<string> {
  try {
    // Store embedding as JSON in the document_chunks table
    // Using Prisma to update the chunk with the embedding
    await prisma.documentChunk.update({
      where: { id: chunkId },
      data: {
        embedding: embedding as any, // Store as JSON array
      },
    })

    console.log(`[VectorDB] Successfully stored embedding for chunk ${chunkId} (agent ${agentId})`)
    return chunkId
  } catch (error) {
    console.error('[VectorDB] Error storing embedding:', error)
    console.error('[VectorDB] Error details:', error instanceof Error ? error.stack : String(error))
    throw new Error(`Failed to store embedding: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

/**
 * Find similar chunks using vector similarity search
 * Uses PostgreSQL with pgvector extension for cosine similarity
 * @param queryEmbedding - Query embedding vector
 * @param agentId - Agent ID for isolation
 * @param limit - Number of results to return
 * @returns Array of matching chunks with similarity scores
 */
export async function findSimilarChunks(
  queryEmbedding: number[],
  agentId: string,
  limit: number = 5
): Promise<Array<{ chunkId: string; text: string; similarity: number }>> {
  try {
    console.log(`[VectorDB] Searching for similar chunks for agent ${agentId} with limit ${limit}`)
    
    // Get all chunks for this agent with their embeddings
    // We'll do client-side similarity calculation since we're storing as JSON
    const chunks = await prisma.documentChunk.findMany({
      where: {
        document: {
          agentId: agentId,
        },
        embedding: {
          not: Prisma.DbNull,
        },
      },
      select: {
        id: true,
        text: true,
        embedding: true,
      },
    })

    if (!chunks || chunks.length === 0) {
      console.warn(`[VectorDB] No chunks with embeddings found for agent ${agentId}`)
      return []
    }

    console.log(`[VectorDB] Found ${chunks.length} chunks with embeddings, calculating similarities...`)

    // Calculate cosine similarity for each chunk
    const similarities = chunks
      .map((chunk) => {
        if (!chunk.embedding) return null
        
        try {
          // Embedding is stored as JSON, so it should already be an array or we need to parse it
          const chunkEmbedding = Array.isArray(chunk.embedding) 
            ? chunk.embedding as number[]
            : typeof chunk.embedding === 'string'
            ? JSON.parse(chunk.embedding) as number[]
            : null
          
          if (!chunkEmbedding) {
            console.warn(`[VectorDB] Invalid embedding format for chunk ${chunk.id}`)
            return null
          }
          
          const similarity = cosineSimilarity(queryEmbedding, chunkEmbedding)
          
          return {
            chunkId: chunk.id,
            text: chunk.text,
            similarity,
          }
        } catch (error) {
          console.error(`[VectorDB] Error parsing embedding for chunk ${chunk.id}:`, error)
          return null
        }
      })
      .filter((item): item is { chunkId: string; text: string; similarity: number } => 
        item !== null && item.similarity > 0.7
      )
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)

    console.log(`[VectorDB] Found ${similarities.length} similar chunks above threshold`)
    return similarities
  } catch (error) {
    console.error('[VectorDB] Error finding similar chunks:', error)
    console.error('[VectorDB] Error details:', error instanceof Error ? error.stack : String(error))
    return []
  }
}

/**
 * Calculate cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    console.warn(`[VectorDB] Vector length mismatch: ${a.length} vs ${b.length}`)
    return 0
  }

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  if (denominator === 0) return 0

  return dotProduct / denominator
}

/**
 * Delete embeddings for document chunks (cleanup)
 * This is handled automatically by Prisma cascade delete, but we can add explicit cleanup if needed
 */
export async function deleteDocumentEmbeddings(chunkIds: string[]): Promise<void> {
  try {
    // Embeddings are stored in the same table, so they'll be deleted with the chunks
    // via cascade delete. No explicit cleanup needed.
    console.log(`[VectorDB] Embeddings will be deleted with chunks: ${chunkIds.length} chunks`)
  } catch (error) {
    console.error('[VectorDB] Error deleting embeddings:', error)
    // Don't throw - cleanup failures shouldn't break the app
  }
}
