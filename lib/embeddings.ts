/**
 * Embedding generation service
 * Uses OpenAI's embedding model for vector generation
 * Now instrumented with AgentBill SDK when configured
 */
import { OpenAI } from 'openai'
import { env } from './env'
import { trackAgentBillSignal, wrapOpenAIWithAgentBill } from './agentbill'

// Base OpenAI client for embeddings
const baseOpenAI = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
})

// Optionally wrap OpenAI with AgentBill
const openai: OpenAI = wrapOpenAIWithAgentBill(baseOpenAI)

/**
 * Generate embedding vector for text
 * Falls back to simple hash-based embedding if OpenAI is not available
 * @param text - Text to generate embedding for
 * @returns Embedding vector (1536 dimensions for text-embedding-ada-002)
 */
const EMBEDDING_MODEL = 'text-embedding-ada-002'

export async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const startedAt = Date.now()
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text,
    })
    const latencyMs = Date.now() - startedAt
    const usage = response.usage
    void trackAgentBillSignal({
      event_name: 'openai_embeddings',
      provider: 'openai',
      model: EMBEDDING_MODEL,
      latency_ms: latencyMs,
      prompt_tokens: usage?.total_tokens,
      total_tokens: usage?.total_tokens,
      metadata: { input_count: 1 },
    })
    return response.data[0].embedding
  } catch (error) {
    console.error('OpenAI embedding error:', error)
    throw error
  }
}

/**
 * Generate embeddings for multiple texts in batch
 */
export async function generateEmbeddingsBatch(texts: string[]): Promise<number[][]> {
  try {
    const startedAt = Date.now()
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: texts,
    })
    const latencyMs = Date.now() - startedAt
    const usage = response.usage
    void trackAgentBillSignal({
      event_name: 'openai_embeddings',
      provider: 'openai',
      model: EMBEDDING_MODEL,
      latency_ms: latencyMs,
      prompt_tokens: usage?.total_tokens,
      total_tokens: usage?.total_tokens,
      metadata: { input_count: texts.length },
    })
    return response.data.map(item => item.embedding)
  } catch (error) {
    console.error('OpenAI batch embedding error:', error)
    throw error
  }
}
