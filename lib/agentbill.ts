/**
 * AgentBill shared initialization and helpers
 * Keeps usage tracking optional and non-blocking
 */
import {
  AgentBill,
  AgentBillTracer,
  signal,
  setSignalConfig,
  type AgentBillWrapper,
  type SignalOptions,
  type TrackSignalParams,
} from '@agentbill-sdk/sdk'
import { env } from './env'

let cachedAgentBill: AgentBillWrapper | null | undefined
let cachedSignalAgentBill: AgentBillWrapper | null | undefined
let cachedAgentBillTracer: AgentBillTracer | null | undefined

export function getAgentBillClient(): AgentBillWrapper | null {
  if (cachedAgentBill !== undefined) {
    return cachedAgentBill
  }

  if (!env.AGENTBILL_API_KEY) {
    cachedAgentBill = null
    return cachedAgentBill
  }

  try {
    cachedAgentBill = AgentBill.init({
      apiKey: env.AGENTBILL_API_KEY,
      debug: env.NODE_ENV !== 'production',
    })
  } catch (err) {
    console.error('Failed to initialize AgentBill SDK:', err)
    cachedAgentBill = null
  }

  return cachedAgentBill
}

function getAgentBillSignalClient(): AgentBillWrapper | null {
  if (cachedSignalAgentBill !== undefined) {
    return cachedSignalAgentBill
  }

  if (!env.AGENTBILL_API_KEY) {
    cachedSignalAgentBill = null
    return cachedSignalAgentBill
  }

  try {
    cachedSignalAgentBill = AgentBill.init({
      apiKey: env.AGENTBILL_API_KEY,
      baseUrl: 'https://api.agentbill.io/functions/v1',
      debug: env.NODE_ENV !== 'production',
    })
  } catch (err) {
    console.error('Failed to initialize AgentBill Signal SDK:', err)
    cachedSignalAgentBill = null
  }

  return cachedSignalAgentBill
}

function getAgentBillTracer(): AgentBillTracer | null {
  if (cachedAgentBillTracer !== undefined) {
    return cachedAgentBillTracer
  }

  if (!env.AGENTBILL_API_KEY) {
    cachedAgentBillTracer = null
    return cachedAgentBillTracer
  }

  try {
    cachedAgentBillTracer = new AgentBillTracer({
      apiKey: env.AGENTBILL_API_KEY,
      baseUrl: 'https://api.agentbill.io',
      debug: env.NODE_ENV !== 'production',
    })
  } catch (err) {
    console.error('Failed to initialize AgentBill tracer:', err)
    cachedAgentBillTracer = null
  }

  return cachedAgentBillTracer
}

function applySpanAttributes(
  tracer: AgentBillTracer,
  spanId: string,
  attributes?: Record<string, string | number | boolean>
): void {
  if (!attributes) return
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      tracer.setSpanAttribute(spanId, key, value)
    }
  }
}

export function startAgentBillSpan(
  name: string,
  attributes?: Record<string, string | number | boolean>
): { spanId: string; traceId: string } | null {
  const tracer = getAgentBillTracer()
  if (!tracer) return null

  const traceContext = tracer.startSpan(name)
  applySpanAttributes(tracer, traceContext.spanId, attributes)
  return { spanId: traceContext.spanId, traceId: traceContext.traceId }
}

export function endAgentBillSpan(
  spanId: string,
  attributes?: Record<string, string | number | boolean>,
  status?: { code: number; message?: string }
): void {
  const tracer = getAgentBillTracer()
  if (!tracer) return

  applySpanAttributes(tracer, spanId, attributes)
  if (status) {
    tracer.setSpanStatus(spanId, status.code, status.message)
  }
  tracer.endSpan(spanId)
}

export function wrapOpenAIWithAgentBill<T extends object>(client: T): T {
  const agentbill = getAgentBillClient()

  if (agentbill?.wrapOpenAI) {
    try {
      return agentbill.wrapOpenAI(client) as T
    } catch (err) {
      console.error('Failed to wrap OpenAI client with AgentBill:', err)
    }
  }

  return client
}

export async function trackAgentBillSignal(params: TrackSignalParams): Promise<void> {
  const agentbill = getAgentBillSignalClient() ?? getAgentBillClient()
  if (!agentbill?.trackSignal) {
    if (env.NODE_ENV !== 'production') {
      console.log('[AgentBill] Skipped (no API key or SDK not ready):', params.event_name)
    }
    return
  }

  try {
    if (env.NODE_ENV !== 'production') {
      console.log('[AgentBill] Sending signal:', params.event_name, {
        provider: params.provider,
        model: params.model,
        latency_ms: params.latency_ms,
      })
    }
    const result = await agentbill.trackSignal(params)
    if (env.NODE_ENV !== 'production') {
      if (result?.success === false) {
        console.warn('[AgentBill] Signal rejected:', params.event_name, result.error || 'Unknown error')
      } else {
        console.log('[AgentBill] Tracked:', params.event_name)
      }
    }
    if (result?.success === false && isInvalidPathError(result.error)) {
      await trackSignalViaOtelCollector(params)
    }
  } catch (err) {
    console.error('AgentBill trackSignal error:', err)
    await trackSignalViaOtelCollector(params)
  }
}

function isInvalidPathError(error?: string): boolean {
  if (!error) return false
  return error.toLowerCase().includes('requested path is invalid')
}

function buildSignalOptions(params: TrackSignalParams): SignalOptions {
  const metadata = {
    ...params.metadata,
    provider: params.provider,
    model: params.model,
    latency_ms: params.latency_ms,
    prompt_tokens: params.prompt_tokens,
    completion_tokens: params.completion_tokens,
    total_tokens: params.total_tokens,
    error_type: params.error_type,
    error_message: params.error_message,
  }

  const filteredMetadata = Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined)
  )

  return {
    revenue: params.revenue,
    currency: params.currency,
    customerId: params.customer_id,
    sessionId: params.session_id,
    traceId: params.trace_id,
    spanId: params.span_id,
    parentSpanId: params.parent_span_id,
    orderExternalId: params.order_external_id,
    metadata: Object.keys(filteredMetadata).length ? filteredMetadata : undefined,
  }
}

async function trackSignalViaOtelCollector(params: TrackSignalParams): Promise<void> {
  if (!env.AGENTBILL_API_KEY) return

  try {
    setSignalConfig({
      apiKey: env.AGENTBILL_API_KEY,
      debug: env.NODE_ENV !== 'production',
    })
    const result = await signal(params.event_name, buildSignalOptions(params))
    if (env.NODE_ENV !== 'production') {
      if (result?.success === false) {
        console.warn('[AgentBill] Signal fallback rejected:', params.event_name, result.error || 'Unknown error')
      } else {
        console.log('[AgentBill] Tracked via signal():', params.event_name)
      }
    }
  } catch (err) {
    console.error('AgentBill signal fallback error:', err)
  }
}
