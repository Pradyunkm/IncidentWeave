'use client'

const typeColors = {
  fact:          { bg: 'bg-emerald-500/15', border: 'border-emerald-500/40', text: 'text-emerald-400', dot: '#22c55e' },
  hypothesis:    { bg: 'bg-amber-500/15',   border: 'border-amber-500/40',   text: 'text-amber-400',   dot: '#eab308' },
  contradictory: { bg: 'bg-red-500/15',     border: 'border-red-500/40',     text: 'text-red-400',     dot: '#ef4444' },
  action:        { bg: 'bg-blue-500/15',    border: 'border-blue-500/40',    text: 'text-blue-400',    dot: '#3b82f6' },
  unknown:       { bg: 'bg-slate-500/15',   border: 'border-slate-500/40',   text: 'text-slate-400',   dot: '#94a3b8' },
}

function formatRelative(startTs, ts) {
  const diffMs = Math.max(0, ts - startTs)
  const diffSec = Math.floor(diffMs / 1000)
  const m = Math.floor(diffSec / 60)
  const s = diffSec % 60
  return `T+${m}:${s.toString().padStart(2, '0')}`
}

/**
 * IncidentTimeline — displays claims AND actions sorted chronologically.
 *
 * Props:
 *   claims  — array of claim objects (from /api/incident/state)
 *   actions — array of action objects (optional, merged into timeline)
 *   roster  — uid→{name,role} map for speaker labels
 */
export default function IncidentTimeline({ claims = [], actions = [], roster = {} }) {
  // Normalise actions into timeline-compatible events
  const actionEvents = actions.map(a => ({
    id:        `action-${a.id}`,
    type:      'action',
    claim:     a.task || a.claim || '(action)',
    timestamp: a.timestamp,
    seq:       a.seq,
    speaker:   a.owner ? `Owner: ${a.owner}` : null,
    speakerUid: a.speakerUid ?? null,
    status:    a.status,
    isAction:  true,
  }))

  // Merge claims + action events, then sort by timestamp ascending
  const allEvents = [...claims, ...actionEvents].sort((a, b) => a.timestamp - b.timestamp)

  const startTs = allEvents[0]?.timestamp ?? Date.now()

  if (allEvents.length === 0) {
    return (
      <div className="h-20 flex items-center justify-center text-white/30 text-xs">
        No events yet — timeline appears as claims are logged
      </div>
    )
  }

  return (
    <div className="relative pl-6 space-y-0">
      {/* Vertical spine */}
      <div className="absolute left-2 top-2 bottom-2 w-px bg-white/10" />

      {allEvents.map((c, i) => {
        const colors = typeColors[c.type] ?? typeColors.unknown
        const speakerName =
          c.speaker ||
          (c.speakerUid && roster[c.speakerUid]?.name) ||
          (c.speakerUid ? `UID ${c.speakerUid}` : null)

        return (
          <div key={c.id || i} className="relative flex gap-3 pb-3 group">
            {/* Timeline dot */}
            <div
              className="absolute -left-[1px] mt-1.5 w-2.5 h-2.5 rounded-full border-2 border-[#07111f] z-10 flex-shrink-0"
              style={{ background: colors.dot }}
            />

            <div className={`flex-1 rounded-lg border px-3 py-2 text-xs ${colors.bg} ${colors.border} transition-all group-hover:brightness-110`}>
              <div className="flex items-center gap-2 flex-wrap mb-0.5">
                {/* Relative time */}
                <span className="font-mono text-white/40 text-[10px] w-14 flex-shrink-0">
                  {formatRelative(startTs, c.timestamp)}
                </span>
                {/* Type badge */}
                <span className={`text-[10px] font-bold uppercase tracking-wider ${colors.text}`}>
                  {c.type}
                </span>
                {/* Speaker / owner */}
                {speakerName && (
                  <span className="text-[10px] text-white/40">· {speakerName}</span>
                )}
                {/* Action status badge */}
                {c.isAction && c.status && (
                  <span className={`text-[10px] rounded px-1 py-0.5 font-medium ${
                    c.status === 'approved' ? 'bg-emerald-500/20 text-emerald-400' :
                    c.status === 'rejected' ? 'bg-red-500/20 text-red-400' :
                    'bg-amber-500/20 text-amber-400'
                  }`}>
                    {c.status}
                  </span>
                )}
                {/* Seq */}
                <span className="ml-auto text-[10px] text-white/20 font-mono">#{c.seq ?? i + 1}</span>
              </div>
              <p className="text-white/80 leading-snug">{c.claim}</p>
              {/* Conflict marker */}
              {c.conflicts_with_seq != null && (
                <p className="mt-0.5 text-[10px] text-red-400/70">
                  ⚡ contradicts claim #{c.conflicts_with_seq}
                </p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
