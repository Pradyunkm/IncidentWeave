import { redis } from '@/lib/redis'
import { NextResponse } from 'next/server'

// POST /api/incident/transcript
// Body: { incidentId, item: { turn_id, uid, speakerName, speakerRole, text, status, createdAt } }
export async function POST(req) {
  try {
    const { incidentId, item } = await req.json()
    if (!incidentId || !item || !item.turn_id) {
      return NextResponse.json(
        { ok: false, error: 'incidentId and item with turn_id required' },
        { status: 400 }
      )
    }

    const value = typeof item === 'string' ? item : JSON.stringify(item)
    // LPUSH stores newest first
    await redis.lpush(`incident:${incidentId}:transcripts`, value)
    // Retain up to 500 transcript turns
    await redis.ltrim(`incident:${incidentId}:transcripts`, 0, 499)
    // 24 hour TTL for room transcript
    await redis.expire(`incident:${incidentId}:transcripts`, 86400)

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[api/incident/transcript] POST failed:', err)
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}

// GET /api/incident/transcript?id=<incidentId>
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url)
    const incidentId = searchParams.get('id') || 'default'

    const raw = await redis.lrange(`incident:${incidentId}:transcripts`, 0, -1)
    // LPUSH stores newest first, so reverse to chronological order (oldest first)
    const transcripts = (raw || [])
      .map((entry) => {
        if (typeof entry === 'string') {
          try {
            return JSON.parse(entry)
          } catch {
            return null
          }
        }
        return typeof entry === 'object' && entry !== null ? entry : null
      })
      .filter(Boolean)
      .reverse()

    // Deduplicate by turn_id if multiple instances were logged
    const seen = new Set()
    const deduplicated = []
    for (const item of transcripts) {
      const key = `${item.turn_id ?? ''}_${item.uid ?? ''}`
      if (!seen.has(key)) {
        seen.add(key)
        deduplicated.push(item)
      }
    }

    return NextResponse.json({ transcripts: deduplicated })
  } catch (err) {
    console.error('[api/incident/transcript] GET failed:', err)
    return NextResponse.json({ transcripts: [] })
  }
}
