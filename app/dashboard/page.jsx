'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import dynamic from 'next/dynamic'
import {
  Slack,
  Ticket,
  Bell,
  CheckCircle,
  XCircle,
  Clock,
  Users,
  Activity,
  GitBranch,
  AlertTriangle,
  Zap,
  HelpCircle,
  ChevronDown,
  Sparkles,
  RefreshCw,
  Plus,
  FileText,
  Copy,
  Check,
  MessageSquare,
  Volume2,
} from 'lucide-react'

const TruthGraph = dynamic(() => import('@/components/TruthGraph'), { ssr: false })
const IncidentTimeline = dynamic(() => import('@/components/IncidentTimeline'), { ssr: false })

function getIncidentId() {
  if (typeof window === 'undefined') return 'demo-001'
  return new URLSearchParams(window.location.search).get('id') || 'demo-001'
}

const POLL_INTERVAL_MS = 3500
const STALE_THRESHOLD_MS = 10 * 60 * 1000 // 10 minutes

// ── colour maps ─────────────────────────────────────────────────────────────
const claimTypeColors = {
  fact: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200',
  hypothesis: 'bg-amber-500/10 border-amber-500/30 text-amber-200',
  contradictory: 'bg-red-500/10 border-red-500/30 text-red-200',
  action: 'bg-blue-500/10 border-blue-500/30 text-blue-200',
  unknown: 'bg-slate-500/10 border-slate-500/30 text-slate-200',
}

const statusColors = {
  pending: 'bg-amber-500/15 border-amber-500/40 text-amber-300',
  approved: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300',
  rejected: 'bg-red-500/15 border-red-500/40 text-red-300',
}

// ── helpers ─────────────────────────────────────────────────────────────────
const ToolIcon = ({ tool, size = 16 }) => {
  if (tool === 'slack') return <Slack size={size} className="text-purple-400" />
  if (tool === 'jira') return <Ticket size={size} className="text-blue-400" />
  if (tool === 'pagerduty') return <Bell size={size} className="text-orange-400" />
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
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} min ago`
  return `${Math.floor(min / 60)}h ago`
}

function formatMessageTime(createdAt) {
  if (!createdAt) return ''
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(createdAt))
}

// ── severity from conflict count ─────────────────────────────────────────────
function deriveSeverity(claims) {
  const conflicts = claims.filter((c) => c.type === 'contradictory').length
  if (conflicts >= 3) return { label: 'SEV-1', color: 'text-red-400', bg: 'bg-red-500/15 border-red-500/40' }
  if (conflicts >= 1) return { label: 'SEV-2', color: 'text-orange-400', bg: 'bg-orange-500/15 border-orange-500/40' }
  return { label: 'SEV-3', color: 'text-amber-400', bg: 'bg-amber-500/15 border-amber-500/40' }
}

// ── sub-panels ───────────────────────────────────────────────────────────────

function Panel({ title, icon: Icon, children, badge, action, className = '' }) {
  return (
    <div
      className={`flex flex-col rounded-xl overflow-hidden ${className}`}
      style={{ background: 'rgba(13,20,40,0.7)', border: '1px solid rgba(255,255,255,0.07)' }}
    >
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/6">
        {Icon && <Icon size={13} className="text-white/35 flex-shrink-0" />}
        <h2 className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/50">{title}</h2>
        {badge && <span className="ml-1">{badge}</span>}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  )
}

function ParticipantsPanel({ roster }) {
  const entries = Object.values(roster)
  return (
    <Panel title="Live Participants" icon={Users} badge={<span className="text-xs text-white/40">({entries.length})</span>}>
      {entries.length === 0 ? (
        <div className="px-4 py-6 text-xs text-white/25 text-center">No participants joined yet</div>
      ) : (
        <div className="px-3 py-3 space-y-1.5">
          {entries.map((p) => (
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

function IncidentStatePanel({ claims, actions, incidentStatus }) {
  const counts = { fact: 0, hypothesis: 0, contradictory: 0, unknown: 0 }
  claims.forEach((c) => {
    if (c.type in counts) counts[c.type]++
  })
  const openActions = actions.filter((a) => a.status === 'pending').length
  const sev = deriveSeverity(claims)

  return (
    <Panel title="Incident State" icon={Activity}>
      <div className="px-4 py-3 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-xs font-bold rounded-md px-2 py-1 border ${sev.bg} ${sev.color}`}>
            🔴 {sev.label}
          </span>
          <span className="text-xs font-semibold text-white/60 uppercase tracking-wider">{incidentStatus}</span>
        </div>

        <div className="space-y-1.5">
          {[
            { label: 'Facts', val: counts.fact, color: 'text-emerald-400' },
            { label: 'Hypotheses', val: counts.hypothesis, color: 'text-amber-400' },
            { label: 'Conflicts', val: counts.contradictory, color: 'text-red-400' },
            { label: 'Unknowns', val: counts.unknown, color: 'text-slate-400' },
            { label: 'Open Actions', val: openActions, color: 'text-blue-400' },
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

function IntegrationsPanel({ approvedTools }) {
  const integrations = [
    { id: 'agora', label: 'Agora Voice AI', always: true },
    { id: 'jira', label: 'Jira Ticketing', always: false },
    { id: 'slack', label: 'Slack Incident Channel', always: false },
    { id: 'pagerduty', label: 'PagerDuty On-Call', always: null },
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
              {wasUsed && <span className="ml-auto text-[10px] text-emerald-400/60">✓ active</span>}
            </div>
          )
        })}

        {approvedTools.size > 0 && (
          <div className="mt-3 pt-3 border-t border-white/6 space-y-1">
            <p className="text-[10px] text-white/30 font-semibold uppercase tracking-wider mb-1.5">Last execution</p>
            {['Human approved', ...[...approvedTools].map((t) => `${t.charAt(0).toUpperCase() + t.slice(1)} dispatched`)].map((step) => (
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

function UnknownPanel({ claims }) {
  const unknowns = claims.filter((c) => c.type === 'unknown')
  return (
    <Panel title="Unknown / Missing Information" icon={HelpCircle}>
      {unknowns.length === 0 ? (
        <div className="px-4 py-5 text-xs text-white/25 text-center">No open unknowns</div>
      ) : (
        <div className="px-3 py-3 space-y-2">
          {unknowns.map((c) => (
            <div key={c.id} className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2">
              <div className="flex items-start gap-2">
                <AlertTriangle size={11} className="text-amber-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs text-white/80 leading-snug">{c.claim}</p>
                  <p className="text-[10px] text-amber-400/60 mt-0.5">
                    {c.conflicts_with_seq != null ? 'Conflicting reports between participants' : 'Needs verification'}
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

function ActionsPanel({ actions, now, loadingActionId, onApprove, onReject }) {
  const pendingActions = actions.filter((a) => a.status === 'pending')
  const resolvedActions = actions.filter((a) => a.status !== 'pending')

  const badge =
    pendingActions.length > 0 ? (
      <span className="text-xs font-bold text-amber-400 border border-amber-500/30 rounded px-1.5 py-0.5 animate-pulse">
        {pendingActions.length} pending
      </span>
    ) : null

  return (
    <Panel title="⚠ Action Approval Gate" icon={CheckCircle} badge={badge} className="min-h-0">
      {pendingActions.length === 0 && resolvedActions.length === 0 && (
        <div className="h-20 flex flex-col items-center justify-center gap-1 text-white/25 text-xs">
          <CheckCircle size={20} />
          <p>No actions proposed yet</p>
        </div>
      )}

      <div className="px-3 py-3 space-y-3 max-h-[380px] overflow-y-auto">
        {pendingActions.map((action) => {
          const isStale = now - action.timestamp > STALE_THRESHOLD_MS
          const ageLabel = formatAge(action.timestamp, now)
          return (
            <div
              key={action.id}
              className={`rounded-xl border p-4 space-y-3 ${
                isStale ? 'border-orange-500/40 bg-orange-500/5' : 'border-amber-500/30 bg-amber-500/5'
              }`}
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex-shrink-0">
                  <ToolIcon tool={action.tool} size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`text-xs font-semibold uppercase tracking-wider ${
                        action.tool === 'pagerduty' ? 'text-orange-400' : action.tool === 'slack' ? 'text-purple-400' : 'text-blue-400'
                      }`}
                    >
                      {action.tool ?? 'action'}
                    </span>
                    {action.owner && <span className="text-xs text-white/40">→ {action.owner}</span>}
                    <span
                      className={`ml-auto flex items-center gap-1 text-xs rounded px-1.5 py-0.5 border ${
                        isStale ? 'text-orange-400 border-orange-500/30 bg-orange-500/10' : 'text-white/30 border-white/10'
                      }`}
                    >
                      {isStale && <AlertTriangle size={10} />}
                      {ageLabel}
                      {isStale && ' · Awaiting owner'}
                    </span>
                  </div>
                  <p className="text-sm text-white/90 mt-1 leading-snug">{action.task}</p>
                  {action.claim && <p className="text-xs text-white/25 mt-0.5 italic line-clamp-1">"{action.claim}"</p>}
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => onReject(action)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  <XCircle size={12} /> Reject
                </button>
                <button
                  onClick={() => onApprove(action)}
                  disabled={loadingActionId === action.id}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    action.tool === 'pagerduty' ? 'bg-orange-600 hover:bg-orange-500' : 'bg-emerald-600 hover:bg-emerald-500'
                  }`}
                >
                  <CheckCircle size={12} />
                  {loadingActionId === action.id ? 'Executing…' : 'Approve'}
                </button>
              </div>
            </div>
          )
        })}

        {resolvedActions.map((action) => (
          <div key={action.id} className={`rounded-xl border p-3 flex items-center gap-3 ${statusColors[action.status] ?? statusColors.pending}`}>
            <ToolIcon tool={action.tool} size={16} />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wider opacity-60">
                {action.status} · {action.tool}
              </p>
              <p className="text-sm opacity-80 truncate">{action.task}</p>
            </div>
            {action.status === 'approved' ? (
              <CheckCircle size={14} className="text-emerald-400 flex-shrink-0" />
            ) : (
              <XCircle size={14} className="text-red-400 flex-shrink-0" />
            )}
          </div>
        ))}
      </div>
    </Panel>
  )
}

function LiveTranscriptsPanel({ transcripts, onAnalyze, isAnalyzing }) {
  return (
    <Panel
      title="Live Shared Transcripts"
      icon={Volume2}
      badge={<span className="text-xs text-white/40">({transcripts.length} turns)</span>}
      action={
        <button
          onClick={onAnalyze}
          disabled={isAnalyzing || transcripts.length === 0}
          className="flex items-center gap-1 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-xs font-semibold text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-40 transition-colors"
          title="Extract claims and actions from speech"
        >
          <Sparkles size={12} className={isAnalyzing ? 'animate-spin' : ''} />
          <span>{isAnalyzing ? 'Analyzing…' : 'Analyze Speech'}</span>
        </button>
      }
    >
      {transcripts.length === 0 ? (
        <div className="h-44 flex flex-col items-center justify-center gap-2 text-white/25 text-xs text-center px-4">
          <MessageSquare size={22} className="opacity-40" />
          <p>No spoken turns in this room yet.</p>
          <p className="text-[11px] text-white/20">Spoken sentences from participants appear here and get analyzed into claims.</p>
        </div>
      ) : (
        <div className="px-3 py-3 space-y-2 max-h-72 overflow-y-auto">
          {transcripts.map((t, idx) => {
            const isAgent = Boolean(t.isAgent) || String(t.uid) === '100'
            const speakerName = t.speakerName || (isAgent ? 'IncidentWeave AI' : `User ${t.uid}`)
            const role = t.speakerRole || ''
            return (
              <div
                key={`${t.turn_id ?? idx}`}
                className={`rounded-lg p-2.5 border text-xs leading-relaxed ${
                  isAgent ? 'bg-violet-950/20 border-violet-500/20 text-violet-100' : 'bg-white/4 border-white/8 text-white/90'
                }`}
              >
                <div className="flex items-center justify-between mb-1 text-[10px] text-white/40 font-medium">
                  <span className={`font-semibold ${isAgent ? 'text-violet-300' : 'text-cyan-300'}`}>
                    {speakerName} {role && `(${role})`}
                  </span>
                  <span>{formatMessageTime(t.createdAt)}</span>
                </div>
                <p className="text-white/80">{t.text}</p>
              </div>
            )
          })}
        </div>
      )}
    </Panel>
  )
}

function Toasts({ toasts }) {
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-xs">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`px-4 py-2.5 rounded-xl text-sm font-medium shadow-xl border ${
            t.type === 'error' ? 'bg-red-900/90 border-red-500/40 text-red-100' : 'bg-emerald-900/90 border-emerald-500/40 text-emerald-100'
          }`}
        >
          {t.msg}
        </div>
      ))}
    </div>
  )
}

// ── Main Dashboard ────────────────────────────────────────────────────────────
export default function IncidentDashboard() {
  const INCIDENT_ID = useRef(getIncidentId()).current

  const [claims, setClaims] = useState([])
  const [actions, setActions] = useState([])
  const [roster, setRoster] = useState({})
  const [transcripts, setTranscripts] = useState([])
  const [loadingActionId, setLoadingActionId] = useState(null)
  const [toasts, setToasts] = useState([])
  const [approvedTools, setApprovedTools] = useState(new Set())
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [autoAnalyze, setAutoAnalyze] = useState(true)
  const [diagnosis, setDiagnosis] = useState(null)

  // Modals state
  const [isAddClaimOpen, setIsAddClaimOpen] = useState(false)
  const [isSummaryOpen, setIsSummaryOpen] = useState(false)
  const [summaryMarkdown, setSummaryMarkdown] = useState('')
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [copiedSummary, setCopiedSummary] = useState(false)

  // New claim form state
  const [newClaimType, setNewClaimType] = useState('fact')
  const [newClaimText, setNewClaimText] = useState('')
  const [newClaimTool, setNewClaimTool] = useState('jira')

  // Manual incident status
  const [incidentStatus, setIncidentStatus] = useState('Investigating')
  const INCIDENT_STATUSES = ['Investigating', 'Mitigating', 'Monitoring', 'Resolved']

  const now = useNow()

  const addToast = useCallback((msg, type = 'success') => {
    const id = Date.now()
    setToasts((prev) => [...prev, { id, msg, type }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4500)
  }, [])

  // ── Polling: state & transcripts ──────────────────────────────────────────
  const fetchState = useCallback(async () => {
    try {
      const [stateRes, transcriptRes] = await Promise.all([
        fetch(`/api/incident/state?id=${INCIDENT_ID}`),
        fetch(`/api/incident/transcript?id=${INCIDENT_ID}`),
      ])

      if (stateRes.ok) {
        const data = await stateRes.json()
        setClaims(data.claims || [])
        setRoster(data.roster || {})
        setActions((prev) => {
          const overrides = Object.fromEntries(prev.filter((a) => a.status !== 'pending').map((a) => [a.id, a.status]))
          return (data.actions || []).map((a) => ({ ...a, status: overrides[a.id] ?? a.status }))
        })
      }

      if (transcriptRes.ok) {
        const tData = await transcriptRes.json()
        setTranscripts(tData.transcripts || [])
      }
    } catch (err) {
      console.error('Dashboard poll error:', err)
    }
  }, [INCIDENT_ID])

  useEffect(() => {
    fetchState()
    const interval = setInterval(fetchState, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [fetchState])

  // ── AI Analysis Trigger ───────────────────────────────────────────────────
  const runAnalysis = useCallback(
    async (silent = false) => {
      if (isAnalyzing) return
      setIsAnalyzing(true)
      try {
        const res = await fetch('/api/incident/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ incidentId: INCIDENT_ID }),
        })
        const data = await res.json()
        if (data.ok) {
          setDiagnosis(data.diagnosis)
          if (!silent) {
            addToast(
              `Analyzed ${data.analyzedTurns} turns: extracted ${data.extractedClaimsCount} claims & ${data.extractedActionsCount} actions!`
            )
          }
          await fetchState()
        } else if (!silent) {
          addToast(data.error || 'Analysis failed', 'error')
        }
      } catch (err) {
        console.error('Analyze error:', err)
        if (!silent) addToast('Analysis request error', 'error')
      } finally {
        setIsAnalyzing(false)
      }
    },
    [INCIDENT_ID, isAnalyzing, addToast, fetchState]
  )

  // Auto-analyze periodically if new transcripts arrive
  useEffect(() => {
    if (!autoAnalyze || transcripts.length === 0) return
    const timer = setTimeout(() => {
      runAnalysis(true)
    }, 8000)
    return () => clearTimeout(timer)
  }, [transcripts.length, autoAnalyze, runAnalysis])

  // ── Add Manual Claim / Action ─────────────────────────────────────────────
  async function handleCreateManualClaim(e) {
    e.preventDefault()
    const text = newClaimText.trim()
    if (!text) return

    try {
      const claimPayload = {
        type: newClaimType,
        claim: text,
        speaker: 'Commander (Dashboard)',
        confidence: 1.0,
        action:
          newClaimType === 'action'
            ? {
                tool: newClaimTool,
                task: text,
                owner: 'Commander',
              }
            : null,
      }

      const res = await fetch('/api/incident/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ incidentId: INCIDENT_ID, claim: claimPayload }),
      })

      if (res.ok) {
        addToast(`Added ${newClaimType} to incident stream`)
        setNewClaimText('')
        setIsAddClaimOpen(false)
        await fetchState()
      } else {
        addToast('Failed to add claim', 'error')
      }
    } catch {
      addToast('Error submitting claim', 'error')
    }
  }

  // ── Fetch Post-Mortem Report ──────────────────────────────────────────────
  async function openSummaryModal() {
    setIsSummaryOpen(true)
    setSummaryLoading(true)
    try {
      const res = await fetch(`/api/incident/summary?id=${INCIDENT_ID}`)
      const data = await res.json()
      setSummaryMarkdown(data.markdown || '# No incident data recorded yet.')
    } catch {
      setSummaryMarkdown('# Error loading report.')
    } finally {
      setSummaryLoading(false)
    }
  }

  function copySummaryReport() {
    navigator.clipboard.writeText(summaryMarkdown).then(() => {
      setCopiedSummary(true)
      setTimeout(() => setCopiedSummary(false), 2000)
    })
  }

  // ── Action handlers ───────────────────────────────────────────────────────
  async function handleApprove(action) {
    setLoadingActionId(action.id)
    setActions((prev) => prev.map((a) => (a.id === action.id ? { ...a, status: 'approved' } : a)))
    try {
      if (action.tool === 'slack') {
        const res = await fetch('/api/actions/slack', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: action.task, owner: action.owner, incidentId: INCIDENT_ID }),
        })
        if (res.ok) {
          addToast('Slack message dispatched!')
          setApprovedTools((s) => new Set([...s, 'slack']))
        } else addToast('Slack failed — check SLACK_WEBHOOK_URL', 'error')
      }
      if (action.tool === 'jira') {
        const res = await fetch('/api/actions/jira', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ summary: action.task, owner: action.owner }),
        })
        const data = await res.json()
        if (res.ok) {
          addToast(`Jira ticket created: ${data.issue}`)
          setApprovedTools((s) => new Set([...s, 'jira']))
        } else addToast('Jira failed — check credentials', 'error')
      }
      if (action.tool === 'pagerduty') {
        const res = await fetch('/api/actions/pagerduty', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ summary: action.task, owner: action.owner, incidentId: INCIDENT_ID }),
        })
        if (res.ok) {
          addToast('PagerDuty escalation dispatched!')
          setApprovedTools((s) => new Set([...s, 'pagerduty']))
        } else addToast('PagerDuty failed — check API key', 'error')
      }
      await fetch('/api/incident/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    setActions((prev) => prev.map((a) => (a.id === action.id ? { ...a, status: 'rejected' } : a)))
    addToast('Action rejected')
  }

  const sev = deriveSeverity(claims)
  const pendingCount = actions.filter((a) => a.status === 'pending').length

  return (
    <div className="min-h-screen text-white font-sans" style={{ background: '#07111f' }}>
      <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 0 }}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'radial-gradient(circle at 10% 20%, rgba(56,189,248,0.05) 0%, transparent 40%)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'radial-gradient(circle at 90% 80%, rgba(139,92,246,0.05) 0%, transparent 40%)',
          }}
        />
      </div>

      <Toasts toasts={toasts} />

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header
        className="sticky top-0 z-40 px-6 py-3 flex items-center gap-4 border-b flex-wrap"
        style={{
          background: 'rgba(7,17,31,0.92)',
          backdropFilter: 'blur(16px)',
          borderColor: 'rgba(255,255,255,0.07)',
        }}
      >
        <div className="flex items-center gap-3 flex-shrink-0">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold text-white shadow"
            style={{ background: 'linear-gradient(135deg, #3b82f6, #7c3aed)' }}
          >
            IW
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-bold tracking-tight">IncidentWeave</h1>
              <span className="rounded bg-cyan-500/15 border border-cyan-500/30 px-1.5 py-0.2 text-[9px] font-bold text-cyan-300 uppercase tracking-wider">
                Command
              </span>
            </div>
            <p className="text-[10px] text-white/35 font-mono">{INCIDENT_ID}</p>
          </div>
        </div>

        <span className={`text-xs font-bold rounded-md px-2.5 py-1 border ${sev.bg} ${sev.color}`}>{sev.label}</span>

        {pendingCount > 0 && (
          <span className="flex items-center gap-1.5 text-xs font-semibold text-amber-400 border border-amber-500/30 bg-amber-500/10 rounded-md px-2.5 py-1 animate-pulse">
            <AlertTriangle size={12} />
            {pendingCount} action{pendingCount > 1 ? 's' : ''} awaiting approval
          </span>
        )}

        {/* Action Controls */}
        <div className="ml-auto flex items-center gap-2.5 flex-wrap">
          {/* Analyze Now Button */}
          <button
            onClick={() => runAnalysis(false)}
            disabled={isAnalyzing}
            className="flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/15 hover:bg-cyan-500/25 px-3 py-1.5 text-xs font-bold text-cyan-300 transition-all shadow-sm disabled:opacity-50"
            title="Analyze meeting transcripts to extract claims, contradictions, and actions"
          >
            <Sparkles size={13} className={isAnalyzing ? 'animate-spin' : ''} />
            <span>{isAnalyzing ? 'Analyzing…' : 'Analyze Transcripts'}</span>
          </button>

          {/* Auto-Analyze toggle */}
          <button
            onClick={() => setAutoAnalyze((prev) => !prev)}
            className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
              autoAnalyze ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300' : 'border-white/10 bg-white/5 text-white/40'
            }`}
            title="Automatically analyze new speech turns every 8 seconds"
          >
            <RefreshCw size={11} className={autoAnalyze ? 'text-emerald-400' : ''} />
            <span>Auto-Analyze {autoAnalyze ? 'ON' : 'OFF'}</span>
          </button>

          {/* Manual Add Claim */}
          <button
            onClick={() => setIsAddClaimOpen(true)}
            className="flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 px-2.5 py-1.5 text-xs font-medium text-white/80 transition-colors"
          >
            <Plus size={13} />
            <span>Add Event</span>
          </button>

          {/* Post-Mortem Report */}
          <button
            onClick={openSummaryModal}
            className="flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 px-2.5 py-1.5 text-xs font-medium text-white/80 transition-colors"
          >
            <FileText size={13} />
            <span>Report</span>
          </button>

          {/* Manual Incident Status */}
          <div className="flex items-center gap-1.5 pl-2 border-l border-white/10">
            <label className="text-[11px] text-white/40 font-medium">Status:</label>
            <div className="relative">
              <select
                id="incident-status-select"
                value={incidentStatus}
                onChange={(e) => setIncidentStatus(e.target.value)}
                className="appearance-none rounded-lg border border-white/12 bg-white/6 pl-2.5 pr-7 py-1 text-xs font-semibold text-white focus:outline-none focus:border-cyan-500/40 cursor-pointer"
                style={{ background: 'rgba(255,255,255,0.06)' }}
              >
                {INCIDENT_STATUSES.map((s) => (
                  <option key={s} value={s} style={{ background: '#0d1421' }}>
                    {s}
                  </option>
                ))}
              </select>
              <ChevronDown size={11} className="absolute right-2 top-1/2 -translate-y-1/2 text-white/40 pointer-events-none" />
            </div>
          </div>
        </div>
      </header>

      <main className="relative z-10 max-w-screen-2xl mx-auto px-4 py-5 space-y-5">
        {/* ── AI Intelligence Diagnosis Card ───────────────────────────────── */}
        <div
          className="rounded-2xl p-4 sm:p-5 border transition-all"
          style={{
            background: 'linear-gradient(135deg, rgba(13,20,40,0.85), rgba(20,24,55,0.85))',
            borderColor: 'rgba(56,189,248,0.2)',
            boxShadow: '0 0 40px rgba(56,189,248,0.03)',
          }}
        >
          <div className="flex items-start justify-between gap-4 flex-wrap mb-3">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-cyan-500/20 border border-cyan-500/30 flex items-center justify-center text-cyan-300">
                <Sparkles size={16} />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white tracking-wide">Incident Intelligence & Root Cause Analysis</h3>
                <p className="text-xs text-white/45">Real-time reasoning derived from multi-party voice transcripts and telemetry</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-cyan-500/20 bg-cyan-500/5 px-2.5 py-0.5 text-[11px] font-mono text-cyan-300">
                {transcripts.length} voice turns analyzed
              </span>
              <span className="rounded-full border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-0.5 text-[11px] font-mono text-emerald-300">
                {claims.length} claims verified
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5 pt-2">
            {/* Primary Hypothesis / Root Cause */}
            <div className="rounded-xl border border-white/8 bg-white/3 p-3.5 space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-300">
                <AlertTriangle size={13} />
                <span>Current Root Cause Theory</span>
              </div>
              <p className="text-xs text-white/80 leading-relaxed font-medium">
                {diagnosis?.rootCause ||
                  (claims.find((c) => c.type === 'hypothesis')?.claim
                    ? `Theory: ${claims.find((c) => c.type === 'hypothesis').claim}`
                    : claims.find((c) => c.type === 'fact')?.claim
                      ? `Investigating: ${claims.find((c) => c.type === 'fact').claim}`
                      : 'Awaiting speech turns from voice call to establish root cause theory.')}
              </p>
            </div>

            {/* Contradiction / Conflict Status */}
            <div className="rounded-xl border border-white/8 bg-white/3 p-3.5 space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-red-300">
                <GitBranch size={13} />
                <span>Contradiction Detection</span>
              </div>
              <p className="text-xs text-white/80 leading-relaxed font-medium">
                {claims.filter((c) => c.conflicts_with_seq != null).length > 0
                  ? `Active disagreement: ${claims.filter((c) => c.conflicts_with_seq != null).length} contradictory claim(s) detected between speakers.`
                  : 'No open contradictions. Team reports align on verified telemetry.'}
              </p>
            </div>

            {/* Next Recommended Action */}
            <div className="rounded-xl border border-white/8 bg-white/3 p-3.5 space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-cyan-300">
                <CheckCircle size={13} />
                <span>Recommended Action</span>
              </div>
              <p className="text-xs text-white/80 leading-relaxed font-medium">
                {actions.find((a) => a.status === 'pending')?.task ||
                  diagnosis?.recommendedAction ||
                  'Dispatch Slack broadcast or Jira investigation ticket to align responders.'}
              </p>
            </div>
          </div>
        </div>

        {/* ── Row 1: Participants, State, Integrations ──────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <ParticipantsPanel roster={roster} />
          <IncidentStatePanel claims={claims} actions={actions} incidentStatus={incidentStatus} />
          <IntegrationsPanel approvedTools={approvedTools} />
        </div>

        {/* ── Row 2: Truth Graph ────────────────────────────────────────────── */}
        <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(13,20,40,0.7)', border: '1px solid rgba(255,255,255,0.07)' }}>
          <div className="flex items-center gap-2 px-4 py-3 border-b border-white/6">
            <GitBranch size={13} className="text-white/35" />
            <h2 className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/50">Truth Graph</h2>
            <span className="text-[10px] text-white/20 border border-white/10 rounded px-1.5 py-0.5 ml-1">
              {claims.length} nodes · {claims.filter((c) => c.conflicts_with_seq != null).length} conflicts
            </span>
          </div>
          {claims.length === 0 ? (
            <div className="h-52 flex flex-col items-center justify-center gap-2 text-white/25 text-center px-4">
              <GitBranch size={28} className="opacity-40" />
              <p className="text-sm font-medium">Start speaking in the incident room to see claims graphed here</p>
              <p className="text-xs text-white/35 max-w-md">
                Claims, hypotheses, and contradictory statements link automatically as participants discuss the outage.
              </p>
            </div>
          ) : (
            <TruthGraph claims={claims} />
          )}
          <div className="px-4 pb-3 pt-2 flex gap-5 flex-wrap border-t border-white/5">
            {[
              ['fact', '#22c55e'],
              ['hypothesis', '#eab308'],
              ['contradictory', '#ef4444'],
              ['action', '#3b82f6'],
              ['unknown', '#94a3b8'],
            ].map(([type, color]) => (
              <div key={type} className="flex items-center gap-1.5 text-xs text-white/35">
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                {type}
              </div>
            ))}
          </div>
        </div>

        {/* ── Row 3: Incident Timeline ──────────────────────────────────────── */}
        <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(13,20,40,0.7)', border: '1px solid rgba(255,255,255,0.07)' }}>
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

        {/* ── Row 4: Live Transcripts, Unknowns & Action Approval Gate ─────── */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          <LiveTranscriptsPanel transcripts={transcripts} onAnalyze={() => runAnalysis(false)} isAnalyzing={isAnalyzing} />
          <UnknownPanel claims={claims} />
          <ActionsPanel actions={actions} now={now} loadingActionId={loadingActionId} onApprove={handleApprove} onReject={handleReject} />
        </div>
      </main>

      {/* ── Add Claim / Event Modal ───────────────────────────────────────── */}
      {isAddClaimOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-md rounded-2xl border border-white/15 bg-[#0d1527] p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <h3 className="text-base font-bold text-white">Add Incident Event / Claim</h3>
              <button onClick={() => setIsAddClaimOpen(false)} className="text-white/40 hover:text-white transition-colors">
                ✕
              </button>
            </div>
            <form onSubmit={handleCreateManualClaim} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-white/60 mb-1">Event Type</label>
                <select
                  value={newClaimType}
                  onChange={(e) => setNewClaimType(e.target.value)}
                  className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500"
                >
                  <option value="fact">Fact (Confirmed measurement or metric)</option>
                  <option value="hypothesis">Hypothesis (Theory or potential cause)</option>
                  <option value="contradictory">Contradiction (Conflicting report)</option>
                  <option value="action">Action (Task for Jira / Slack / PagerDuty)</option>
                  <option value="unknown">Unknown (Missing / unverified info)</option>
                </select>
              </div>

              {newClaimType === 'action' && (
                <div>
                  <label className="block text-xs font-semibold text-white/60 mb-1">Target Integration Tool</label>
                  <select
                    value={newClaimTool}
                    onChange={(e) => setNewClaimTool(e.target.value)}
                    className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500"
                  >
                    <option value="jira">Jira (Create Ticket)</option>
                    <option value="slack">Slack (Broadcast to Channel)</option>
                    <option value="pagerduty">PagerDuty (Page On-Call)</option>
                  </select>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-white/60 mb-1">Description / Claim Text</label>
                <textarea
                  required
                  rows={3}
                  value={newClaimText}
                  onChange={(e) => setNewClaimText(e.target.value)}
                  placeholder={
                    newClaimType === 'fact'
                      ? 'e.g., Payment gateway returning 503 errors at 34% rate'
                      : newClaimType === 'hypothesis'
                        ? 'e.g., Suspect redis connection pool exhaustion'
                        : 'e.g., Scale payment pods to 10 replicas'
                  }
                  className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-white/10">
                <button
                  type="button"
                  onClick={() => setIsAddClaimOpen(false)}
                  className="rounded-lg border border-white/10 px-4 py-2 text-xs font-medium text-white/60 hover:bg-white/5"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-cyan-600 hover:bg-cyan-500 px-4 py-2 text-xs font-bold text-white transition-colors"
                >
                  Add to Stream
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Post-Mortem / Incident Report Modal ────────────────────────────── */}
      {isSummaryOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-2xl rounded-2xl border border-white/15 bg-[#0d1527] p-6 shadow-2xl space-y-4 max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-white/10 pb-3 flex-shrink-0">
              <div className="flex items-center gap-2">
                <FileText size={18} className="text-cyan-400" />
                <h3 className="text-base font-bold text-white">Post-Mortem Incident Report</h3>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={copySummaryReport}
                  disabled={summaryLoading}
                  className="flex items-center gap-1.5 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-xs font-bold text-cyan-300 hover:bg-cyan-500/20 transition-colors"
                >
                  {copiedSummary ? <Check size={12} /> : <Copy size={12} />}
                  <span>{copiedSummary ? 'Copied!' : 'Copy Markdown'}</span>
                </button>
                <button onClick={() => setIsSummaryOpen(false)} className="text-white/40 hover:text-white transition-colors">
                  ✕
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto rounded-lg border border-white/10 bg-black/30 p-4 font-mono text-xs text-white/80 whitespace-pre-wrap leading-relaxed">
              {summaryLoading ? 'Generating incident report…' : summaryMarkdown}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
