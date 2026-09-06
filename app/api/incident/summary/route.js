import { redis } from '@/lib/redis'
import { NextResponse } from 'next/server'

/**
 * GET /api/incident/summary?id={incidentId}
 * Returns a structured incident report derived from all stored claims and the roster.
 * This is a pure data summary — no external LLM call needed; the structure is rich enough.
 */
export async function GET(req) {
  const { searchParams } = new URL(req.url)
  const incidentId = searchParams.get('id') || 'default'

  const [claimsRaw, actionsRaw, rosterRaw] = await Promise.all([
    redis.lrange(`incident:${incidentId}:claims`, 0, -1),
    redis.lrange(`incident:${incidentId}:actions`, 0, -1),
    redis.hgetall(`incident:${incidentId}:roster`),
  ])

  const parseItem = (item) => {
    if (typeof item === 'object' && item !== null) return item
    try { return JSON.parse(item) } catch { return null }
  }

  const claims = (claimsRaw || []).map(parseItem).filter(Boolean)
  const actions = (actionsRaw || []).map(parseItem).filter(Boolean)

  const roster = {}
  if (rosterRaw) {
    for (const [uid, val] of Object.entries(rosterRaw)) {
      roster[uid] = parseItem(val) || { uid, name: `User ${uid}`, role: 'Participant' }
    }
  }

  // --- Build summary ---
  const sorted = [...claims].sort((a, b) => a.timestamp - b.timestamp)
  const startTs = sorted[0]?.timestamp ?? Date.now()
  const endTs = sorted[sorted.length - 1]?.timestamp ?? Date.now()
  const durationMs = endTs - startTs
  const durationMin = Math.round(durationMs / 60000)

  const byType = { fact: [], hypothesis: [], contradictory: [], action: [], unknown: [] }
  for (const c of sorted) {
    const t = c.type || 'unknown'
    if (byType[t]) byType[t].push(c)
    else byType.unknown.push(c)
  }

  const contradictions = sorted.filter(c => c.conflicts_with_seq != null)
  const pendingActions = actions.filter(a => a.status === 'pending')
  const approvedActions = actions.filter(a => a.status === 'approved')
  const rejectedActions = actions.filter(a => a.status === 'rejected')

  // Participants
  const participants = Object.values(roster)

  // Build markdown report
  const lines = []
  lines.push(`# Incident Report — ${incidentId}`)
  lines.push(``)
  lines.push(`**Generated:** ${new Date().toISOString()}`)
  lines.push(`**Duration:** ${durationMin} minute${durationMin !== 1 ? 's' : ''} (${claims.length} total claims)`)
  lines.push(`**Participants:** ${participants.map(p => `${p.name} (${p.role})`).join(', ') || 'Unknown'}`)
  lines.push(``)

  lines.push(`## Summary`)
  lines.push(``)
  lines.push(`| Type | Count |`)
  lines.push(`|---|---|`)
  lines.push(`| ✅ Facts | ${byType.fact.length} |`)
  lines.push(`| 🟡 Hypotheses | ${byType.hypothesis.length} |`)
  lines.push(`| 🔴 Contradictions | ${byType.contradictory.length} |`)
  lines.push(`| 🔵 Actions | ${byType.action.length} |`)
  lines.push(`| ⚪ Unknown | ${byType.unknown.length} |`)
  lines.push(``)

  if (byType.fact.length > 0) {
    lines.push(`## Confirmed Facts`)
    lines.push(``)
    for (const c of byType.fact) {
      const speaker = c.speaker || (c.speakerUid && roster[c.speakerUid]?.name) || 'Unknown'
      lines.push(`- **[#${c.seq}]** ${c.claim} *(${speaker})*`)
    }
    lines.push(``)
  }

  if (byType.hypothesis.length > 0) {
    lines.push(`## Open Hypotheses`)
    lines.push(``)
    for (const c of byType.hypothesis) {
      const speaker = c.speaker || (c.speakerUid && roster[c.speakerUid]?.name) || 'Unknown'
      lines.push(`- **[#${c.seq}]** ${c.claim} *(${speaker})*`)
    }
    lines.push(``)
  }

  if (contradictions.length > 0) {
    lines.push(`## Contradictions Detected`)
    lines.push(``)
    for (const c of contradictions) {
      const speaker = c.speaker || (c.speakerUid && roster[c.speakerUid]?.name) || 'Unknown'
      lines.push(`- **[#${c.seq}]** ${c.claim} — *contradicts claim #${c.conflicts_with_seq}* *(${speaker})*`)
    }
    lines.push(``)
  }

  if (actions.length > 0) {
    lines.push(`## Actions`)
    lines.push(``)
    lines.push(`| # | Tool | Task | Owner | Status |`)
    lines.push(`|---|---|---|---|---|`)
    for (const a of actions) {
      lines.push(`| ${a.seq ?? '-'} | ${a.tool ?? '-'} | ${a.task} | ${a.owner ?? 'Unassigned'} | ${a.status} |`)
    }
    lines.push(``)
  }

  lines.push(`## Timeline (first 10 events)`)
  lines.push(``)
  for (const c of sorted.slice(0, 10)) {
    const relMs = c.timestamp - startTs
    const relMin = Math.floor(relMs / 60000)
    const relSec = Math.floor((relMs % 60000) / 1000)
    const ts = `T+${relMin}:${String(relSec).padStart(2, '0')}`
    lines.push(`- **${ts}** [${c.type?.toUpperCase() ?? 'UNKNOWN'}] ${c.claim}`)
  }
  if (sorted.length > 10) {
    lines.push(`- *… and ${sorted.length - 10} more events*`)
  }
  lines.push(``)

  const markdown = lines.join('\n')

  return NextResponse.json({
    incidentId,
    generatedAt: new Date().toISOString(),
    durationMinutes: durationMin,
    participants,
    stats: {
      total: claims.length,
      facts: byType.fact.length,
      hypotheses: byType.hypothesis.length,
      contradictions: byType.contradictory.length,
      actions: byType.action.length,
      unknown: byType.unknown.length,
      pendingActions: pendingActions.length,
      approvedActions: approvedActions.length,
      rejectedActions: rejectedActions.length,
    },
    facts: byType.fact,
    hypotheses: byType.hypothesis,
    contradictions,
    actions,
    timeline: sorted,
    markdown,
  })
}
