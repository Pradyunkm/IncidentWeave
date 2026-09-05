'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import dynamic from 'next/dynamic'
import { Slack, Ticket, Bell, CheckCircle, XCircle, Clock, Users, Activity, GitBranch, AlertTriangle, Zap, Eye, List, HelpCircle, ChevronDown } from 'lucide-react'

const TruthGraph   = dynamic(() => import('@/components/TruthGraph'),   { ssr: false })
const IncidentTimeline = dynamic(() => import('@/components/IncidentTimeline'), { ssr: false })

function getIncidentId() {
  if (typeof window === 'undefined') return 'demo-001'
  return new URLSearchParams(window.location.search).get('id') || 'demo-001'
}

const POLL_INTERVAL_MS  = 4000
const STALE_THRESHOLD_MS = 10 * 60 * 1000   // 10 minutes

// ── colour maps ─────────────────────────────────────────────────────────────
const claimTypeColors = {
  fact:          'bg-emerald-500/10 border-emerald-500/30 text-emerald-200',
  hypothesis:    'bg-amber-500/10   border-amber-500/30   text-amber-200',
  contradictory: 'bg-red-500/10     border-red-500/30     text-red-200',
  action:        'bg-blue-500/10    border-blue-500/30    text-blue-200',
  unknown:       'bg-slate-500/10   border-slate-500/30   text-slate-200',
}

const statusColors = {
  pending:  'bg-amber-500/15   border-amber-500/40   text-amber-300',
  approved: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300',
  rejected: 'bg-red-500/15     border-red-500/40     text-red-300',
}

// ── helpers ─────────────────────────────────────────────────────────────────
const ToolIcon = ({ tool, size = 16 }) => {
  if (tool === 'slack')     return <Slack     size={size} className="text-purple-400" />
  if (tool === 'jira')      return <Ticket    size={size} className="text-blue-400"   />
  if (tool === 'pagerduty') return <Bell      size={size} className="text-orange-400" />
  return <Activity size={size} className="text-white/40" />
}

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

function formatAge(timestamp, now) {
  const sec = Math.floor((now - timestamp) / 1000)
  if (sec < 60)  return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60)  return `${min} min ago`
  return `${Math.floor(min / 60)}h ago`
}

// ── severity from conflict count ─────────────────────────────────────────────
function deriveSeverity(claims) {
  const conflicts = claims.filter(c => c.type === 'contradictory').length
  if (conflicts >= 3) return { label: 'SEV-1', color: 'text-red-400',    bg: 'bg-red-500/15    border-red-500/40'    }
  if (conflicts >= 1) return { label: 'SEV-2', color: 'text-orange-400', bg: 'bg-orange-500/15 border-orange-500/40' }
  return               { label: 'SEV-3', color: 'text-amber-400',  bg: 'bg-amber-500/15  border-amber-500/40'  }
}

// ── sub-panels ───────────────────────────────────────────────────────────────

/** Section card shell — consistent dark-glass panel */
function Panel({ title, icon: Icon, children, badge, className = '' }) {
  return (
    <div
      className={`flex flex-col rounded-xl overflow-hidden ${className}`}
      style={{ background: 'rgba(13,20,40,0.7)', border: '1px solid rgba(255,255,255,0.07)' }}
    >
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/6">
        {Icon && <Icon size={13} className="text-white/35 flex-shrink-0" />}
        <h2 className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/50">{title}</h2>
        {badge && <span className="ml-auto">{badge}</span>}
      </div>
      <div className="flex-1 overflow-y-auto">
        {children}
      </div>
    </div>
  )
}

/** Live Participants panel */
function ParticipantsPanel({ roster }) {
  const entries = Object.values(roster)
  return (
    <Panel title="Live Participants" icon={Users}>
      {entries.length === 0 ? (
        <div className="px-4 py-6 text-xs text-white/25 text-center">No participants yet</div>
      ) : (
        <div className="px-3 py-3 space-y-1.5">
          {entries.map(p => (
            <div key={p.uid} className="flex items-center gap-2.5 rounded-lg px-3 py-2" style={{ background: 'rgba(255,255,255,0.03)' }}>
              <span className="relative flex-shrink-0">
                <span className="w-2 h-2 rounded-full bg-emerald-400 block" />
                <span className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-40" />
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-sm font-semibold text-white truncate">{p.name || 'Unknown'}</span>
                  <span className="text-[10px] text-white/40">{p.role}</span>
                </div>
                <span className="text-[10px] text-white/25 font-mono">UID {p.uid}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

/** Incident State panel — pure aggregation */
function IncidentStatePanel({ claims, actions, incidentStatus }) {
  const counts = { fact: 0, hypothesis: 0, contradictory: 0, unknown: 0 }
  claims.forEach(c => { if (c.type in counts) counts[c.type]++ })
  const openActions = actions.filter(a => a.status === 'pending').length
  const sev = deriveSeverity(claims)

  return (
    <Panel title="Incident State" icon={Activity}>
      <div className="px-4 py-3 space-y-3">
        {/* Severity + status row */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-xs font-bold rounded-md px-2 py-1 border ${sev.bg} ${sev.color}`}>
            🔴 {sev.label}
          </span>
          <span className="text-xs font-semibold text-white/60 uppercase tracking-wider">{incidentStatus}</span>
        </div>

        {/* Stat rows */}
        <div className="space-y-1.5">
          {[
            { label: 'Facts',        val: counts.fact,          color: 'text-emerald-400' },
            { label: 'Hypotheses',   val: counts.hypothesis,    color: 'text-amber-400'   },
            { label: 'Conflicts',    val: counts.contradictory, color: 'text-red-400'     },
            { label: 'Unknowns',     val: counts.unknown,       color: 'text-slate-400'   },
            { label: 'Open Actions', val: openActions,          color: 'text-blue-400'    },
          ].map(({ label, val, color }) => (
            <div key={label} className="flex items-center justify-between text-xs">
              <span className="text-white/45">{label}</span>
              <span className={`font-bold tabular-nums ${color}`}>{val}</span>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  )
}

/** Integrations panel */
function IntegrationsPanel({ approvedTools }) {
  const integrations = [
    { id: 'agora',     label: 'Agora',     always: true  },
    { id: 'jira',      label: 'Jira',      always: false },
    { id: 'slack',     label: 'Slack',     always: false },
    { id: 'pagerduty', label: 'PagerDuty', always: null  }, // amber = optional
  ]

  return (
    <Panel title="Integrations" icon={Zap}>
      <div className="px-4 py-3 space-y-2">
        {integrations.map(({ id, label, always }) => {
          const wasUsed = approvedTools.has(id)
          const status = always === true ? 'green' : always === null ? 'amber' : wasUsed ? 'green' : 'grey'
          const dot = status === 'green' ? 'bg-emerald-400' : status === 'amber' ? 'bg-amber-400' : 'bg-white/20'
          const text = status === 'green' ? 'text-emerald-400' : status === 'amber' ? 'text-amber-400' : 'text-white/30'

          return (
            <div key={id} className="flex items-center gap-2.5">
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
              <span className={`text-xs font-medium ${text}`}>{label}</span>
              {wasUsed && (
                <span className="ml-auto text-[10px] text-emerald-400/60">✓ used</span>
              )}
            </div>
          )
        })}

        {/* Execution trail — shown after any approval */}
        {approvedTools.size > 0 && (
          <div className="mt-3 pt-3 border-t border-white/6 space-y-1">
            <p className="text-[10px] text-white/30 font-semibold uppercase tracking-wider mb-1.5">Last execution</p>
            {['Human approved', ...[...approvedTools].map(t => `${t.charAt(0).toUpperCase() + t.slice(1)} notified`)].map(step => (
              <div key={step} className="flex items-center gap-1.5 text-[11px] text-emerald-400/80">
                <CheckCircle size={10} />
                {step}
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  )
}

/** Unknown / Missing information panel */
function UnknownPanel({ claims }) {
  const unknowns = claims.filter(c => c.type === 'unknown')
  return (
    <Panel title="Unknown / Missing" icon={HelpCircle}>
      {unknowns.length === 0 ? (
        <div className="px-4 py-5 text-xs text-white/25 text-center">No unresolved items</div>
      ) : (
        <div className="px-3 py-3 space-y-2">
          {unknowns.map(c => (
            <div key={c.id} className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2">
              <div className="flex items-start gap-2">
                <AlertTriangle size={11} className="text-amber-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs text-white/80 leading-snug">{c.claim}</p>
                  <p className="text-[10px] text-amber-400/60 mt-0.5">
                    {c.conflicts_with_seq != null ? 'Conflicting reports' : 'Not confirmed'}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

/** Actions panel — approve / reject gate */
function ActionsPanel({ actions, now, loadingActionId, onApprove, onReject }) {
  const pendingActions  = actions.filter(a => a.status === 'pending')
  const resolvedActions = actions.filter(a => a.status !== 'pending')

  const badge = pendingActions.length > 0
    ? <span className="text-xs font-bold text-amber-400 border border-amber-500/30 rounded px-1.5 py-0.5 animate-pulse">{pendingActions.length} pending</span>
    : null

  return (
    <Panel
      title="⚠ Human Approval Required"
      icon={CheckCircle}
      badge={badge}
      className="min-h-0"
    >
      {pendingActions.length === 0 && resolvedActions.length === 0 && (
        <div className="h-20 flex flex-col items-center justify-center gap-1 text-white/25 text-xs">
          <CheckCircle size={20} />
          <p>No actions yet</p>
        </div>
      )}

      <div className="px-3 py-3 space-y-3 max-h-[380px] overflow-y-auto">
        {pendingActions.map(action => {
          const isStale = (now - action.timestamp) > STALE_THRESHOLD_MS
          const ageLabel = formatAge(action.timestamp, now)
          return (
            <div key={action.id} className={`rounded-xl border p-4 space-y-3 ${isStale ? 'border-orange-500/40 bg-orange-500/5' : 'border-amber-500/30 bg-amber-500/5'}`}>
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex-shrink-0"><ToolIcon tool={action.tool} size={18} /></div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-xs font-semibold uppercase tracking-wider ${
                      action.tool === 'pagerduty' ? 'text-orange-400' :
                      action.tool === 'slack'     ? 'text-purple-400' : 'text-blue-400'
                    }`}>{action.tool ?? 'action'}</span>
                    {action.owner && <span className="text-xs text-white/40">→ {action.owner}</span>}
                    <span className={`ml-auto flex items-center gap-1 text-xs rounded px-1.5 py-0.5 border ${
                      isStale
                        ? 'text-orange-400 border-orange-500/30 bg-orange-500/10'
                        : 'text-white/30 border-white/10'
                    }`}>
                      {isStale && <AlertTriangle size={10} />}
                      {ageLabel}{isStale && ' · Awaiting owner'}
                    </span>
                  </div>
                  <p className="text-sm text-white/90 mt-1 leading-snug">{action.task}</p>
                  {action.claim && (
                    <p className="text-xs text-white/25 mt-0.5 italic line-clamp-1">"{action.claim}"</p>
                  )}
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <button onClick={() => onReject(action)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors">
                  <XCircle size={12} /> Reject
                </button>
                <button onClick={() => onApprove(action)} disabled={loadingActionId === action.id}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    action.tool === 'pagerduty' ? 'bg-orange-600 hover:bg-orange-500' : 'bg-emerald-600 hover:bg-emerald-500'
                  }`}>
                  <CheckCircle size={12} />
                  {loadingActionId === action.id ? 'Executing…' : 'Approve'}
                </button>
              </div>
            </div>
          )
        })}

        {resolvedActions.map(action => (
          <div key={action.id} className={`rounded-xl border p-3 flex items-center gap-3 ${statusColors[action.status] ?? statusColors.pending}`}>
            <ToolIcon tool={action.tool} size={16} />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wider opacity-60">{action.status} · {action.tool}</p>
              <p className="text-sm opacity-80 truncate">{action.task}</p>
            </div>
            {action.status === 'approved'
              ? <CheckCircle size={14} className="text-emerald-400 flex-shrink-0" />
              : <XCircle    size={14} className="text-red-400 flex-shrink-0" />
            }
          </div>
        ))}
      </div>
    </Panel>
  )
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function Toasts({ toasts }) {
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-xs">
      {toasts.map(t => (
        <div key={t.id} className={`px-4 py-2.5 rounded-xl text-sm font-medium shadow-xl border ${
          t.type === 'error'
            ? 'bg-red-900/90 border-red-500/40 text-red-100'
            : 'bg-emerald-900/90 border-emerald-500/40 text-emerald-100'
        }`}>{t.msg}</div>
      ))}
    </div>
  )
}

// ── Main dashboard ────────────────────────────────────────────────────────────
export default function IncidentDashboard() {
  const INCIDENT_ID = useRef(getIncidentId()).current

  const [claims, setClaims]                     = useState([])
  const [actions, setActions]                   = useState([])
  const [roster, setRoster]                     = useState({})
  const [loadingActionId, setLoadingActionId]   = useState(null)
  const [toasts, setToasts]                     = useState([])
  const [approvedTools, setApprovedTools]       = useState(new Set())

  // Manual incident status — human-controlled only, AI cannot change this
  const [incidentStatus, setIncidentStatus]     = useState('Investigating')
  const INCIDENT_STATUSES = ['Investigating', 'Mitigating', 'Monitoring', 'Resolved']

  const now = useNow()

  const addToast = useCallback((msg, type = 'success') => {
    const id = Date.now()
    setToasts(prev => [...prev, { id, msg, type }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4500)
  }, [])

  // ── polling ───────────────────────────────────────────────────────────────
  useEffect(() => {
    async function fetchState() {
      try {
        const res = await fetch(`/api/incident/state?id=${INCIDENT_ID}`)
        if (!res.ok) return
        const data = await res.json()
        setClaims(data.claims || [])
        setRoster(data.roster || {})
        setActions(prev => {
          // Preserve local status overrides for approved/rejected actions
          const overrides = Object.fromEntries(
            prev.filter(a => a.status !== 'pending').map(a => [a.id, a.status])
          )
          return (data.actions || []).map(a => ({ ...a, status: overrides[a.id] ?? a.status }))
        })
      } catch (err) {
        console.error('Poll error:', err)
      }
    }
    fetchState()
    const interval = setInterval(fetchState, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [INCIDENT_ID])

  // ── action handlers ───────────────────────────────────────────────────────
  async function handleApprove(action) {
    setLoadingActionId(action.id)
    setActions(prev => prev.map(a => a.id === action.id ? { ...a, status: 'approved' } : a))
    try {
      if (action.tool === 'slack') {
        const res = await fetch('/api/actions/slack', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: action.task, owner: action.owner, incidentId: INCIDENT_ID }),
        })
        if (res.ok) { addToast('Slack message sent!'); setApprovedTools(s => new Set([...s, 'slack'])) }
        else addToast('Slack failed — check SLACK_WEBHOOK_URL', 'error')
      }
      if (action.tool === 'jira') {
        const res = await fetch('/api/actions/jira', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ summary: action.task, owner: action.owner }),
        })
        const data = await res.json()
        if (res.ok) { addToast(`Jira ticket created: ${data.issue}`); setApprovedTools(s => new Set([...s, 'jira'])) }
        else addToast('Jira failed — check credentials', 'error')
      }
      if (action.tool === 'pagerduty') {
        const res = await fetch('/api/actions/pagerduty', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ summary: action.task, owner: action.owner, incidentId: INCIDENT_ID }),
        })
        if (res.ok) { addToast('PagerDuty escalation created!'); setApprovedTools(s => new Set([...s, 'pagerduty'])) }
        else addToast('PagerDuty failed — check API key', 'error')
      }
      await fetch('/api/incident/claim', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ incidentId: INCIDENT_ID, claim: { ...action, status: 'approved', type: 'fact' } }),
      })
    } catch (err) {
      console.error('Approve error:', err)
      addToast('Something went wrong', 'error')
    } finally {
      setLoadingActionId(null)
    }
  }

  function handleReject(action) {
    setActions(prev => prev.map(a => a.id === action.id ? { ...a, status: 'rejected' } : a))
    addToast('Action rejected')
  }

  const sev = deriveSeverity(claims)
  const pendingCount = actions.filter(a => a.status === 'pending').length

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen text-white font-sans" style={{ background: '#07111f' }}>
      {/* Subtle ambient glows — same as landing page but dimmer */}
      <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 0 }}>
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle at 10% 20%, rgba(56,189,248,0.05) 0%, transparent 40%)' }} />
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle at 90% 80%, rgba(139,92,246,0.05) 0%, transparent 40%)' }} />
      </div>

      <Toasts toasts={toasts} />

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header
        className="sticky top-0 z-40 px-6 py-3 flex items-center gap-4 border-b"
        style={{
          background: 'rgba(7,17,31,0.90)',
          backdropFilter: 'blur(16px)',
          borderColor: 'rgba(255,255,255,0.07)',
        }}
      >
        {/* Brand */}
        <div className="flex items-center gap-3 flex-shrink-0">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold text-white"
            style={{ background: 'linear-gradient(135deg, #3b82f6, #7c3aed)' }}
          >
            IW
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight">IncidentWeave</h1>
            <p className="text-[10px] text-white/35 font-mono">{INCIDENT_ID}</p>
          </div>
        </div>

        {/* Severity badge */}
        <span className={`text-xs font-bold rounded-md px-2.5 py-1 border ${sev.bg} ${sev.color}`}>
          {sev.label}
        </span>

        {/* Pending actions alert */}
        {pendingCount > 0 && (
          <span className="flex items-center gap-1.5 text-xs font-semibold text-amber-400 border border-amber-500/30 bg-amber-500/10 rounded-md px-2.5 py-1 animate-pulse">
            <AlertTriangle size={12} />
            {pendingCount} action{pendingCount > 1 ? 's' : ''} awaiting approval
          </span>
        )}

        {/* Manual Incident Status — human-controlled only */}
        <div className="ml-auto flex items-center gap-2">
          <label className="text-xs text-white/40 font-medium">Status:</label>
          <div className="relative">
            <select
              id="incident-status-select"
              value={incidentStatus}
              onChange={e => setIncidentStatus(e.target.value)}
              className="appearance-none rounded-lg border border-white/12 bg-white/6 pl-3 pr-8 py-1.5 text-xs font-semibold text-white focus:outline-none focus:border-cyan-500/40 focus:ring-1 focus:ring-cyan-500/20 cursor-pointer"
              style={{ background: 'rgba(255,255,255,0.06)' }}
            >
              {INCIDENT_STATUSES.map(s => (
                <option key={s} value={s} style={{ background: '#0d1421' }}>{s}</option>
              ))}
            </select>
            <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-white/40 pointer-events-none" />
          </div>

          {/* Live indicator */}
          <div className="flex items-center gap-1.5 ml-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs text-white/35">Live</span>
          </div>
        </div>
      </header>

      <main className="relative z-10 max-w-screen-2xl mx-auto px-4 py-5 space-y-5">

        {/* ── Row 1: 3 equal panels ─────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <ParticipantsPanel roster={roster} />
          <IncidentStatePanel claims={claims} actions={actions} incidentStatus={incidentStatus} />
          <IntegrationsPanel approvedTools={approvedTools} />
        </div>

        {/* ── Row 2: Truth Graph ────────────────────────────────────────────── */}
        <div
          className="rounded-xl overflow-hidden"
          style={{ background: 'rgba(13,20,40,0.7)', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          <div className="flex items-center gap-2 px-4 py-3 border-b border-white/6">
            <GitBranch size={13} className="text-white/35" />
            <h2 className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/50">Truth Graph</h2>
            <span className="text-[10px] text-white/20 border border-white/10 rounded px-1.5 py-0.5 ml-1">
              {claims.length} nodes · {claims.filter(c => c.conflicts_with_seq != null).length} conflicts
            </span>
          </div>
          {claims.length === 0 ? (
            <div className="h-52 flex flex-col items-center justify-center gap-2 text-white/20">
              <GitBranch size={28} />
              <p className="text-sm">Start the voice conversation to see claims appear here</p>
            </div>
          ) : (
            <TruthGraph claims={claims} />
          )}
          {/* Legend */}
          <div className="px-4 pb-3 pt-2 flex gap-5 flex-wrap border-t border-white/5">
            {[['fact','#22c55e'],['hypothesis','#eab308'],['contradictory','#ef4444'],['action','#3b82f6'],['unknown','#94a3b8']].map(([type, color]) => (
              <div key={type} className="flex items-center gap-1.5 text-xs text-white/35">
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                {type}
              </div>
            ))}
          </div>
        </div>

        {/* ── Row 3: Incident Timeline ──────────────────────────────────────── */}
        <div
          className="rounded-xl overflow-hidden"
          style={{ background: 'rgba(13,20,40,0.7)', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          <div className="flex items-center gap-2 px-4 py-3 border-b border-white/6">
            <Clock size={13} className="text-white/35" />
            <h2 className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/50">Incident Timeline</h2>
            <span className="text-[10px] text-white/20 border border-white/10 rounded px-1.5 py-0.5 ml-1">
              {claims.length + actions.length} events
            </span>
          </div>
          <div className="px-4 py-4 max-h-80 overflow-y-auto">
            <IncidentTimeline claims={claims} actions={actions} roster={roster} />
          </div>
        </div>

        {/* ── Row 4: Unknowns + Actions ─────────────────────────────────────── */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <UnknownPanel claims={claims} />
          <ActionsPanel
            actions={actions}
            now={now}
            loadingActionId={loadingActionId}
            onApprove={handleApprove}
            onReject={handleReject}
          />
        </div>

      </main>
    </div>
  )
}
