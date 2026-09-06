import { redis } from '@/lib/redis'
import { NextResponse } from 'next/server'

/**
 * Intelligent Incident Transcript Analyzer
 * Parses transcripts into typed claims (facts, hypotheses, contradictions, actions, unknowns)
 * and generates root cause assessments.
 */
function analyzeTranscriptsToClaims(transcripts, existingClaims = [], roster = {}) {
  const newClaims = []
  const newActions = []
  const existingTexts = new Set(existingClaims.map(c => (c.claim || '').toLowerCase().trim()))

  // Metric extraction patterns (e.g. 503 errors, 98% CPU, 450ms latency)
  const metricRegex = /\b(\d+(?:\.\d+)?%|\b(?:50\d|40\d|200)\b|\b\d+\s*(?:ms|s|min|minutes|gb|mb|kb|req\/s|rps)\b)/i
  const hypothesisMarkers = /\b(i think|i suspect|maybe|might be|probably|could be|looks like|assuming|hypothesize|theory|perhaps)\b/i
  const contradictionMarkers = /\b(no|actually|disagree|not true|incorrect|contradicts|that's wrong|instead|differ|different)\b/i
  const actionMarkers = /\b(need to|should|please|let's|create a ticket|jira|page|pagerduty|slack|notify|restart|rollback|revert|scale|investigate|check|fix)\b/i
  const unknownMarkers = /\b(not sure|don't know|unconfirmed|missing|unclear|haven't checked|unknown)\b/i

  // Group transcripts by turns
  for (const t of transcripts) {
    const text = (t.text || '').trim()
    if (!text || text.length < 5) continue

    const lower = text.toLowerCase()
    if (existingTexts.has(lower)) continue

    const speaker = t.speakerName || roster[t.uid]?.name || (t.isAgent ? 'IncidentWeave AI' : `User ${t.uid}`)
    const speakerUid = t.uid ? String(t.uid) : null

    // 1. Check for Action
    if (actionMarkers.test(lower)) {
      let tool = 'slack'
      if (lower.includes('jira') || lower.includes('ticket') || lower.includes('issue')) tool = 'jira'
      else if (lower.includes('page') || lower.includes('pagerduty') || lower.includes('p1') || lower.includes('on-call')) tool = 'pagerduty'

      let owner = null
      if (speaker && speaker !== 'IncidentWeave AI') owner = speaker

      const cleanTask = text.replace(/^(someone should|we need to|let's|please|i will)\s*/i, '')
      newActions.push({
        tool,
        task: cleanTask.slice(0, 140),
        owner,
        claim: text.slice(0, 140),
        speaker,
        speakerUid,
        type: 'action',
      })
      existingTexts.add(lower)
      continue
    }

    // 2. Check for Contradiction
    if (contradictionMarkers.test(lower)) {
      // Find earlier claim that might conflict
      let conflictSeq = null
      if (existingClaims.length > 0) {
        const lastDifferentSpeaker = existingClaims.find(c => c.speakerUid !== speakerUid)
        if (lastDifferentSpeaker) conflictSeq = lastDifferentSpeaker.seq
      }

      newClaims.push({
        type: 'contradictory',
        claim: text.slice(0, 140),
        speaker,
        speakerUid,
        confidence: 0.88,
        conflicts_with_seq: conflictSeq,
      })
      existingTexts.add(lower)
      continue
    }

    // 3. Check for Hypothesis
    if (hypothesisMarkers.test(lower)) {
      newClaims.push({
        type: 'hypothesis',
        claim: text.slice(0, 140),
        speaker,
        speakerUid,
        confidence: 0.75,
        conflicts_with_seq: null,
      })
      existingTexts.add(lower)
      continue
    }

    // 4. Check for Fact (Metric or explicit measurement)
    if (metricRegex.test(text) || lower.includes('down') || lower.includes('error') || lower.includes('failure') || lower.includes('status')) {
      newClaims.push({
        type: 'fact',
        claim: text.slice(0, 140),
        speaker,
        speakerUid,
        confidence: 0.95,
        conflicts_with_seq: null,
      })
      existingTexts.add(lower)
      continue
    }

    // 5. Check for Unknown
    if (unknownMarkers.test(lower)) {
      newClaims.push({
        type: 'unknown',
        claim: text.slice(0, 140),
        speaker,
        speakerUid,
        confidence: 0.6,
        conflicts_with_seq: null,
      })
      existingTexts.add(lower)
      continue
    }

    // Default fact for informative speech statements
    if (text.length > 15 && !t.isAgent) {
      newClaims.push({
        type: 'fact',
        claim: text.slice(0, 140),
        speaker,
        speakerUid,
        confidence: 0.85,
        conflicts_with_seq: null,
      })
      existingTexts.add(lower)
    }
  }

  return { newClaims, newActions }
}

export async function POST(req) {
  try {
    const { incidentId } = await req.json()
    if (!incidentId) {
      return NextResponse.json({ ok: false, error: 'incidentId is required' }, { status: 400 })
    }

    // Fetch transcripts, roster, and existing claims
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

    // Analyze transcripts
    const { newClaims, newActions } = analyzeTranscriptsToClaims(transcripts, existingClaims, roster)

    let createdClaimsCount = 0
    let createdActionsCount = 0

    // Store extracted claims
    for (const c of newClaims) {
      const seq = await redis.incr(`incident:${incidentId}:seq`)
      const claimWithMeta = {
        ...c,
        seq,
        id: crypto.randomUUID(),
        timestamp: Date.now(),
      }
      await redis.lpush(`incident:${incidentId}:claims`, JSON.stringify(claimWithMeta))
      await redis.ltrim(`incident:${incidentId}:claims`, 0, 99)
      createdClaimsCount++
    }

    // Store extracted actions
    for (const a of newActions) {
      const seq = await redis.incr(`incident:${incidentId}:seq`)
      const claimWithMeta = {
        id: crypto.randomUUID(),
        seq,
        type: 'action',
        claim: a.task,
        speaker: a.speaker,
        speakerUid: a.speakerUid,
        confidence: 0.9,
        action: { tool: a.tool, task: a.task, owner: a.owner },
        timestamp: Date.now(),
      }
      await redis.lpush(`incident:${incidentId}:claims`, JSON.stringify(claimWithMeta))
      await redis.ltrim(`incident:${incidentId}:claims`, 0, 99)

      const pendingAction = {
        id: crypto.randomUUID(),
        tool: a.tool,
        task: a.task,
        owner: a.owner,
        status: 'pending',
        timestamp: Date.now(),
        seq,
        claim: a.task,
        speakerUid: a.speakerUid ?? null,
      }
      await redis.lpush(`incident:${incidentId}:actions`, JSON.stringify(pendingAction))
      await redis.ltrim(`incident:${incidentId}:actions`, 0, 99)
      createdActionsCount++
    }

    // Generate intelligent diagnosis
    const totalClaims = existingClaims.length + createdClaimsCount
    const allClaims = [...existingClaims, ...newClaims]
    const facts = allClaims.filter(c => c.type === 'fact')
    const hypotheses = allClaims.filter(c => c.type === 'hypothesis')
    const contradictions = allClaims.filter(c => c.type === 'contradictory')

    let rootCauseDiagnosis = 'Awaiting sufficient evidence from incident participants.'
    if (hypotheses.length > 0) {
      rootCauseDiagnosis = `Primary theory: ${hypotheses[0].claim} (Proposed by ${hypotheses[0].speaker || 'engineer'})`
    } else if (facts.length > 0) {
      rootCauseDiagnosis = `Investigating reported metric: ${facts[0].claim}`
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
        recommendedAction: newActions.length > 0 ? newActions[0].task : 'Continue telemetry collection',
      },
    })
  } catch (err) {
    console.error('[api/incident/analyze] error:', err)
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
