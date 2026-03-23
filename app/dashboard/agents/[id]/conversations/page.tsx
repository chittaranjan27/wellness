'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'

/* ── Types ───────────────────────────────────────────────────────────── */
interface Message {
  id: string
  index: number
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  tokens: number
  isEstimated: boolean
}

interface Session {
  sessionId: string
  visitorId: string | null
  startedAt: string
  endedAt: string | null
  durationSec: number
  messageCount: number
  tokenUsage: {
    totalTokens: number
    totalPromptTokens: number
    totalCompletionTokens: number
    isEstimated: boolean
  }
  messages: Message[]
}

interface ConversationsData {
  agentId: string
  agentName: string
  totalSessions: number
  totalMessages: number
  totalTokensEstimated: number
  sessions: Session[]
}

/* ── Helpers ─────────────────────────────────────────────────────────── */
function fmt(dateStr: string) {
  return new Date(dateStr).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}
function fmtDuration(sec: number) {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60); const s = sec % 60
  return `${m}m ${s}s`
}
function shortId(id: string) {
  return id === '__no_session__' ? 'No session' : id.slice(0, 8).toUpperCase()
}

/* ── Main Component ──────────────────────────────────────────────────── */
export default function ConversationsPage() {
  const { id: agentId } = useParams<{ id: string }>()
  const [data, setData] = useState<ConversationsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeSession, setActiveSession] = useState<Session | null>(null)
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/agents/${agentId}/conversations`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: ConversationsData = await res.json()
      setData(json)
      if (json.sessions.length > 0) setActiveSession(json.sessions[0])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [agentId])

  useEffect(() => { load() }, [load])

  /* filtered sessions */
  const filtered = data?.sessions.filter(s =>
    search === '' ||
    s.sessionId.toLowerCase().includes(search.toLowerCase()) ||
    (s.visitorId ?? '').toLowerCase().includes(search.toLowerCase()) ||
    s.messages.some(m => m.content.toLowerCase().includes(search.toLowerCase()))
  ) ?? []

  if (loading) return <LoadingState />
  if (error) return <ErrorState message={error} onRetry={load} />
  if (!data) return null

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg,#0f0c29,#302b63,#24243e)', padding: '24px', fontFamily: 'Inter,system-ui,sans-serif' }}>
      {/* Header */}
      <div style={{ maxWidth: 1400, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 32 }}>
          <a href={`/dashboard/agents/${agentId}`} style={{ color: '#a78bfa', fontSize: 14, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            Back to Agent
          </a>
          <div style={{ flex: 1 }}>
            <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700, color: '#fff', letterSpacing: '-0.5px' }}>
              Conversation Review
            </h1>
            <p style={{ margin: '4px 0 0', color: '#a78bfa', fontSize: 14 }}>{data.agentName}</p>
          </div>
          <button onClick={load} id="refresh-btn" style={{ background: 'rgba(167,139,250,0.15)', border: '1px solid rgba(167,139,250,0.3)', borderRadius: 8, color: '#a78bfa', padding: '8px 16px', fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            Refresh
          </button>
        </div>

        {/* Stats Bar */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16, marginBottom: 32 }}>
          {[
            { label: 'Total Sessions', value: data.totalSessions, icon: '💬', color: '#7c3aed' },
            { label: 'Total Messages', value: data.totalMessages, icon: '📨', color: '#2563eb' },
            { label: 'Total Tokens (est.)', value: data.totalTokensEstimated.toLocaleString(), icon: '🔢', color: '#059669' },
            { label: 'Avg Msgs / Session', value: data.totalSessions > 0 ? Math.round(data.totalMessages / data.totalSessions) : 0, icon: '📊', color: '#d97706' },
          ].map(s => (
            <div key={s.label} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 16, padding: '20px 24px', backdropFilter: 'blur(12px)' }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>{s.icon}</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#fff' }}>{s.value}</div>
              <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 4 }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Main layout: sessions list + conversation view */}
        <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 20, alignItems: 'start' }}>

          {/* Sessions sidebar */}
          <div style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 16, overflow: 'hidden' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <p style={{ margin: '0 0 12px', color: '#e2e8f0', fontWeight: 600, fontSize: 15 }}>Sessions ({data.totalSessions})</p>
              <input
                id="session-search"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search sessions or messages…"
                style={{ width: '100%', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px', color: '#fff', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ maxHeight: 600, overflowY: 'auto' }}>
              {filtered.length === 0 ? (
                <div style={{ padding: 32, textAlign: 'center', color: '#64748b', fontSize: 14 }}>No sessions found</div>
              ) : filtered.map((s) => (
                <SessionItem key={s.sessionId} session={s} active={activeSession?.sessionId === s.sessionId} onClick={() => setActiveSession(s)} />
              ))}
            </div>
          </div>

          {/* Conversation view */}
          {activeSession ? (
            <ConversationView session={activeSession} />
          ) : (
            <div style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 16, padding: 60, textAlign: 'center', color: '#64748b' }}>
              Select a session to view details
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── Session List Item ─────────────────────────────────────────────── */
function SessionItem({ session, active, onClick }: { session: Session; active: boolean; onClick: () => void }) {
  const userTurns = session.messages.filter(m => m.role === 'user').length
  return (
    <button id={`session-${session.sessionId.slice(0, 8)}`} onClick={onClick} style={{
      width: '100%', textAlign: 'left', background: active ? 'rgba(124,58,237,0.25)' : 'transparent',
      border: 'none', borderLeft: active ? '3px solid #7c3aed' : '3px solid transparent',
      padding: '14px 20px', cursor: 'pointer', transition: 'background 0.15s',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: active ? '#a78bfa' : '#cbd5e1', fontFamily: 'monospace' }}>
          #{shortId(session.sessionId)}
        </span>
        <span style={{ fontSize: 11, color: '#64748b' }}>{fmt(session.startedAt)}</span>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Chip label={`${session.messageCount} msgs`} />
        <Chip label={`${session.tokenUsage.totalTokens.toLocaleString()} tok${session.tokenUsage.isEstimated ? ' ~' : ''}`} color="#059669" />
        {session.durationSec > 0 && <Chip label={fmtDuration(session.durationSec)} color="#d97706" />}
        <Chip label={`${userTurns} turns`} color="#2563eb" />
      </div>
    </button>
  )
}

/* ── Conversation View ─────────────────────────────────────────────── */
function ConversationView({ session }: { session: Session }) {
  const cumulativeTokens = session.messages.reduce<number[]>((acc, m) => {
    acc.push((acc[acc.length - 1] ?? 0) + m.tokens)
    return acc
  }, [])

  return (
    <div style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 16, overflow: 'hidden' }}>
      {/* Session header */}
      <div style={{ padding: '20px 28px', borderBottom: '1px solid rgba(255,255,255,0.08)', background: 'rgba(124,58,237,0.1)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
          <div>
            <p style={{ margin: 0, fontSize: 12, color: '#a78bfa', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Session ID</p>
            <p style={{ margin: '4px 0 0', fontSize: 14, fontFamily: 'monospace', color: '#e2e8f0' }}>{session.sessionId}</p>
            {session.visitorId && (
              <p style={{ margin: '2px 0 0', fontSize: 12, color: '#64748b' }}>Visitor: {session.visitorId}</p>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,auto)', gap: '0 28px', textAlign: 'right' }}>
            {[
              { label: 'Started', value: fmt(session.startedAt) },
              { label: 'Duration', value: session.durationSec > 0 ? fmtDuration(session.durationSec) : '—' },
              { label: 'Messages', value: session.messageCount },
              { label: 'Total Tokens', value: `${session.tokenUsage.totalTokens.toLocaleString()}${session.tokenUsage.isEstimated ? ' ~' : ''}` },
            ].map(s => (
              <div key={s.label}>
                <p style={{ margin: 0, fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{s.label}</p>
                <p style={{ margin: '2px 0 0', fontSize: 15, fontWeight: 600, color: '#e2e8f0' }}>{s.value}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Token progress bar */}
      <div style={{ padding: '12px 28px', borderBottom: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12, color: '#64748b' }}>
          <span>Token consumption across conversation</span>
          <span>{session.tokenUsage.isEstimated ? 'Estimated values' : 'Actual values'}</span>
        </div>
        <div style={{ display: 'flex', height: 6, borderRadius: 999, overflow: 'hidden', background: 'rgba(255,255,255,0.08)', gap: 1 }}>
          {session.messages.map((m, i) => {
            const pct = session.tokenUsage.totalTokens > 0 ? (m.tokens / session.tokenUsage.totalTokens) * 100 : 0
            return (
              <div key={m.id} style={{ flex: `0 0 ${pct}%`, background: m.role === 'user' ? '#3b82f6' : '#7c3aed', transition: 'flex 0.3s' }} title={`Turn ${i + 1}: ${m.tokens} tokens (${m.role})`} />
            )
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, color: '#64748b' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: '#3b82f6' }} />User</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: '#7c3aed' }} />Assistant</span>
        </div>
      </div>

      {/* Messages */}
      <div style={{ maxHeight: 600, overflowY: 'auto', padding: '20px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {session.messages.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#64748b', padding: 40 }}>No messages in this session</div>
        ) : session.messages.map((msg, i) => (
          <MessageBubble key={msg.id} msg={msg} cumTokens={cumulativeTokens[i]} total={session.tokenUsage.totalTokens} />
        ))}
      </div>
    </div>
  )
}

/* ── Message Bubble ────────────────────────────────────────────────── */
function MessageBubble({ msg, cumTokens, total }: { msg: Message; cumTokens: number; total: number }) {
  const isUser = msg.role === 'user'
  const pct = total > 0 ? Math.round((cumTokens / total) * 100) : 0

  return (
    <div id={`msg-${msg.id}`} style={{ display: 'flex', flexDirection: isUser ? 'row-reverse' : 'row', gap: 12, alignItems: 'flex-start' }}>
      {/* Avatar */}
      <div style={{
        flexShrink: 0, width: 36, height: 36, borderRadius: '50%',
        background: isUser ? 'linear-gradient(135deg,#3b82f6,#1d4ed8)' : 'linear-gradient(135deg,#7c3aed,#4c1d95)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
      }}>
        {isUser ? '👤' : '🤖'}
      </div>

      {/* Bubble */}
      <div style={{ flex: 1, maxWidth: '80%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexDirection: isUser ? 'row-reverse' : 'row' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: isUser ? '#60a5fa' : '#a78bfa' }}>{isUser ? 'User' : 'Assistant'}</span>
          <span style={{ fontSize: 11, color: '#475569' }}>Turn {msg.index}</span>
          <span style={{ fontSize: 11, color: '#475569' }}>·</span>
          <span style={{ fontSize: 11, color: '#475569' }}>{fmt(msg.createdAt)}</span>
        </div>
        <div style={{
          background: isUser ? 'rgba(59,130,246,0.12)' : 'rgba(124,58,237,0.12)',
          border: `1px solid ${isUser ? 'rgba(59,130,246,0.25)' : 'rgba(124,58,237,0.25)'}`,
          borderRadius: isUser ? '16px 4px 16px 16px' : '4px 16px 16px 16px',
          padding: '12px 16px',
        }}>
          <p style={{ margin: 0, color: '#e2e8f0', fontSize: 14, lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.content}</p>
        </div>

        {/* Token badge */}
        <div style={{ display: 'flex', gap: 8, marginTop: 6, flexDirection: isUser ? 'row-reverse' : 'row', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '2px 8px', color: '#94a3b8' }}>
            {msg.tokens.toLocaleString()} tokens{msg.isEstimated ? ' ~' : ''}
          </span>
          <span style={{ fontSize: 11, color: '#475569' }}>
            Cumulative: {cumTokens.toLocaleString()} ({pct}%)
          </span>
        </div>
      </div>
    </div>
  )
}

/* ── Helper Components ─────────────────────────────────────────────── */
function Chip({ label, color = '#7c3aed' }: { label: string; color?: string }) {
  return (
    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 99, background: `${color}22`, border: `1px solid ${color}44`, color, fontWeight: 500 }}>
      {label}
    </span>
  )
}

function LoadingState() {
  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg,#0f0c29,#302b63,#24243e)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center', color: '#a78bfa' }}>
        <div style={{ width: 48, height: 48, border: '3px solid rgba(167,139,250,0.2)', borderTop: '3px solid #a78bfa', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 16px' }} />
        <p style={{ margin: 0, fontSize: 16 }}>Loading conversations…</p>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg,#0f0c29,#302b63,#24243e)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center', background: 'rgba(255,255,255,0.06)', borderRadius: 16, padding: 40, border: '1px solid rgba(239,68,68,0.3)' }}>
        <p style={{ margin: '0 0 8px', fontSize: 20, color: '#f87171' }}>⚠ Error</p>
        <p style={{ margin: '0 0 20px', color: '#94a3b8', fontSize: 14 }}>{message}</p>
        <button onClick={onRetry} style={{ background: '#7c3aed', border: 'none', borderRadius: 8, color: '#fff', padding: '10px 24px', cursor: 'pointer', fontSize: 14 }}>Retry</button>
      </div>
    </div>
  )
}
