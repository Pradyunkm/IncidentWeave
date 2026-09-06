import { redis } from '@/lib/redis'
import { NextResponse } from 'next/server'

// Topic fingerprinting for smart contradiction detection
function extractTopicFingerprints(text) {
  const fingerprints = []
  const pctMatches = [...text.matchAll(/\b(\d+(?:\.\d+)?)\s*%/g)]
  for (const m of pctMatches) fingerprints.push(`pct:${Math.round(parseFloat(m[1]) / 10) * 10}`)
  if (/\b50\d\b/.test(text)) fingerprints.push('topic:5xx')
  if (/\b40\d\b/.test(text)) fingerprints.push('topic:4xx')
  if (/\b(cpu|processor)\b/i.test(text)) fingerprints.push('topic:cpu')
  if (/\b(memory|ram|heap)\b/i.test(text)) fingerprints.push('topic:memory')
  if (/\b(database|db|postgres|mysql|mongo|redis)\b/i.test(text)) fingerprints.push('topic:database')
  if (/\b(network|latency|timeout)\b/i.test(text)) fingerprints.push('topic:network')
  if (/\b(api|endpoint|gateway)\b/i.test(text)) fingerprints.push('topic:api')
  if (/\b(deployment|deploy|release)\b/i.test(text)) fingerprints.push('topic:deploy')
  if (/\b(payment|transaction|checkout)\b/i.test(text)) fingerprints.push('topic:payment')
  if (/\b(pod|container|replica|k8s)\b/i.test(text)) fingerprints.push('topic:k8s')
  if (/\b(server|application server)\b/i.test(text)) fingerprints.push('topic:appserver')
  if (/\b(pool|connection pool)\b/i.test(text)) fingerprints.push('topic:connpool')
  return fingerprints
}

function topicsOverlap(textA, textB) {
  const fpA = extractTopicFingerprints(textA)
  const fpB = extractTopicFingerprints(textB)
  if (!fpA.length || !fpB.length) return false
  return fpA.some(fp => fpB.includes(fp))
}

function analyzeTranscriptsToClaims(transcripts, existingClaims = [], roster = {}) {
  const newClaims = []
  const newActions = []
  const existingTexts = new Set(existingClaims.map(c => (c.claim || '').toLowerCase().trim()))

  const hypothesisMarkers = /\b(i think|i suspect|maybe|might be|probably|could be|looks like|assuming|theory|perhaps|suspect)\b/i
  const contradictionMarkers = /\b(no,|actually|but actually|disagree|not true|incorrect|that's wrong|instead|however|but the|wait,|i checked|but i checked)\b/i
  const actionMarkers = /\b(need to|should|let's|we should|i will|i'll|create a ticket|jira|page|pagerduty|slack|notify|restart|rollback|revert|scale|investigate|check on|fix)\b/i
  const unknownMarkers = /\b(not sure|don't know|haven't confirmed|unconfirmed|missing|unclear|haven't checked|unknown|we don't know|need to verify|not confirmed|hasn't been confirmed)\b/i
  const metricRegex = /\b(\d+(?:\.\d+)?%|\b(?:50\d|40\d|200)\b|\b\d+\s*(?:ms|s|min|minutes|gb|mb|kb|req\/s|rps)\b)/i

  const allClaimsSoFar = [...existingClaims]

  for (const t of transcripts) {
    const text = (t.text || '').trim()
    if (!text || text.length < 8 || t.isAgent) continue

    const lower = text.toLowerCase()
    if (existingTexts.has(lower)) continue

    const speakerUid = t.uid ? String(t.uid) : null
    const rosterEntry = speakerUid ? roster[speakerUid] : null
    const speaker = t.speakerName || rosterEntry?.name || `User ${speakerUid || '?'}`
    const speakerRole = t.speakerRole || rosterEntry?.role || 'Participant'

    // 1. Action
    if (actionMarkers.test(lower)) {
      let tool = 'slack'
      if (lower.includes('jira') || lower.includes('ticket') || lower.includes('issue')) tool = 'jira'
      else if (lower.includes('page') || lower.includes('pagerduty') || lower.includes('on-call')) tool = 'pagerduty'
      const cleanTask = text.replace(/^(someone should|we need to|let's|please|i will|i'll|we should)\s*/i, '').trim()
      newActions.push({ tool, task: cleanTask.slice(0, 160), owner: speaker, ownerRole: speakerRole, ownerUid: speakerUid, claim: text.slice(0, 160), speaker, speakerRole, speakerUid, type: 'action' })
      existingTexts.add(lower)
      continue
    }

    // 2. Unknown
    if (unknownMarkers.test(lower)) {
      const c = { type: 'unknown', claim: text.slice(0, 160), speaker, speakerRole, speakerUid, confidence: 0.7, conflicts_with_seq: null }
      newClaims.push(c); allClaimsSoFar.push(c); existingTexts.add(lower)
      continue
    }

    // 3. Contradiction (requires topic overlap with a prior different-speaker claim)
    if (contradictionMarkers.test(lower)) {
      let conflictSeq = null, conflictFound = false
      for (let i = allClaimsSoFar.length - 1; i >= 0; i--) {
        const prev = allClaimsSoFar[i]
        if (String(prev.speakerUid) === speakerUid) continue
        if (topicsOverlap(text, prev.claim || '')) { conflictSeq = prev.seq ?? i; conflictFound = true; break }
      }
      if (conflictFound) {
        const c = { type: 'contradictory', claim: text.slice(0, 160), speaker, speakerRole, speakerUid, confidence: 0.92, conflicts_with_seq: conflictSeq }
        newClaims.push(c); allClaimsSoFar.push(c); existingTexts.add(lower)
        continue
      }
    }

    // 4. Hypothesis
    if (hypothesisMarkers.test(lower)) {
      const c = { type: 'hypothesis', claim: text.slice(0, 160), speaker, speakerRole, speakerUid, confidence: 0.78, conflicts_with_seq: null }
      newClaims.push(c); allClaimsSoFar.push(c); existingTexts.add(lower)
      continue
    }

    // 5. Fact with metric/error keywords
    if (metricRegex.test(text) || lower.includes('down') || lower.includes('error') || lower.includes('failure') || lower.includes('returning') || lower.includes('overload') || lower.includes('status')) {
      const c = { type: 'fact', claim: text.slice(0, 160), speaker, speakerRole, speakerUid, confidence: 0.95, conflicts_with_seq: null }
      newClaims.push(c); allClaimsSoFar.push(c); existingTexts.add(lower)
      continue
    }

    // 6. Default fact for informative statements
    if (text.length > 15) {
      const c = { type: 'fact', claim: text.slice(0, 160), speaker, speakerRole, speakerUid, confidence: 0.80, conflicts_with_seq: null }
      newClaims.push(c); allClaimsSoFar.push(c); existingTexts.add(lower)
    }
  }

  return { newClaims, newActions }
}

export async function POST(req) {
  try {
    const { incidentId } = await req.json()
    if (!incidentId) return NextResponse.json({ ok: false, error: 'incidentId is required' }, { status: 400 })

    const [rawTranscripts, existingClaimsRaw, rosterRaw] = await Promise.all([
      redis.lrange(`incident:${incidentId}:transcripts`, 0, -1),
      redis.lrange(`incident:${incidentId}:claims`, 0, -1),
      redis.hgetall(`incident:${incidentId}:roster`),
    ])

    const parseItem = (item) => {
      if (typeof item === 'object' && item !== null) return item
      try { return JSON.parse(item) } catch { return null }
    }

    const transcripts = (rawTranscripts || []).map(parseItem).filter(Boolean).reverse()
    const existingClaims = (existingClaimsRaw || []).map(parseItem).filter(Boolean)

    const roster = {}
    if (rosterRaw) {
      for (const [uid, val] of Object.entries(rosterRaw)) {
        roster[uid] = parseItem(val) || { uid, name: `User ${uid}`, role: 'Participant' }
      }
    }

    const { newClaims, newActions } = analyzeTranscriptsToClaims(transcripts, existingClaims, roster)

    let createdClaimsCount = 0
    let createdActionsCount = 0

    for (const c of newClaims) {
      const seq = await redis.incr(`incident:${incidentId}:seq`)
      const claimWithMeta = { ...c, seq, id: crypto.randomUUID(), timestamp: Date.now() }
      await redis.lpush(`incident:${incidentId}:claims`, JSON.stringify(claimWithMeta))
      await redis.ltrim(`incident:${incidentId}:claims`, 0, 99)
      createdClaimsCount++
    }

    for (const a of newActions) {
      const seq = await redis.incr(`incident:${incidentId}:seq`)
      const claimWithMeta = {
        id: crypto.randomUUID(), seq, type: 'action',
        claim: a.task, speaker: a.speaker, speakerRole: a.speakerRole, speakerUid: a.speakerUid,
        confidence: 0.9, action: { tool: a.tool, task: a.task, owner: a.owner, ownerRole: a.ownerRole, ownerUid: a.ownerUid }, timestamp: Date.now(),
      }
      await redis.lpush(`incident:${incidentId}:claims`, JSON.stringify(claimWithMeta))
      await redis.ltrim(`incident:${incidentId}:claims`, 0, 99)

      const pendingAction = {
        id: crypto.randomUUID(), tool: a.tool, task: a.task, owner: a.owner, ownerRole: a.ownerRole, ownerUid: a.ownerUid,
        status: 'pending', timestamp: Date.now(), seq, claim: a.task, speakerUid: a.speakerUid ?? null,
      }
      await redis.lpush(`incident:${incidentId}:actions`, JSON.stringify(pendingAction))
      await redis.ltrim(`incident:${incidentId}:actions`, 0, 99)
      createdActionsCount++
    }

    const allClaims = [...existingClaims, ...newClaims]
    const facts = allClaims.filter(c => c.type === 'fact')
    const hypotheses = allClaims.filter(c => c.type === 'hypothesis')
    const contradictions = allClaims.filter(c => c.type === 'contradictory')

    let rootCauseDiagnosis = 'Awaiting sufficient evidence from incident participants.'
    if (hypotheses.length > 0) {
      const h = hypotheses[0]
      rootCauseDiagnosis = `Primary theory: ${h.claim} (Proposed by ${h.speaker || 'engineer'}${h.speakerRole ? `, ${h.speakerRole}` : ''})`
    } else if (contradictions.length > 0) {
      rootCauseDiagnosis = `Contradictory telemetry detected. ${contradictions.length} conflicting report(s) require verification.`
    } else if (facts.length > 0) {
      rootCauseDiagnosis = `Investigating: ${facts[0].claim}`
    }

    return NextResponse.json({
      ok: true,
      analyzedTurns: transcripts.length,
      extractedClaimsCount: createdClaimsCount,
      extractedActionsCount: createdActionsCount,
      diagnosis: {
        rootCause: rootCauseDiagnosis,
        factsCount: facts.length,
        hypothesesCount: hypotheses.length,
        contradictionsCount: contradictions.length,
        recommendedAction: newActions.length > 0 ? newActions[0].task : (
          hypotheses.length > 0 ? 'Verify hypothesis with live telemetry' : 'Continue collecting voice telemetry'
        ),
      },
    })
  } catch (err) {
    console.error('[api/incident/analyze] error:', err)
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
