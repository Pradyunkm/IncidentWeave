import { redis } from '@/lib/redis'
import { NextResponse } from 'next/server'

// POST /api/chat/messages
// Body: { incidentId, message: { id, from, fromName, fromRole, to, text, timestamp } }
export async function POST(req) {
  const { incidentId, message } = await req.json()
  if (!incidentId || !message) {
    return NextResponse.json({ ok: false, error: 'incidentId and message required' }, { status: 400 })
  }

  // Always store as a JSON string to guarantee consistent retrieval format
  const value = typeof message === 'string' ? message : JSON.stringify(message)
  await redis.lpush(`incident:${incidentId}:chat`, value)
  // Keep last 500 messages
  await redis.ltrim(`incident:${incidentId}:chat`, 0, 499)
  // Expire alongside the incident (24h)
  await redis.expire(`incident:${incidentId}:chat`, 86400)

  return NextResponse.json({ ok: true })
}

// GET /api/chat/messages?id=<incidentId>
export async function GET(req) {
  const { searchParams } = new URL(req.url)
  const incidentId = searchParams.get('id') || 'default'

  const raw = await redis.lrange(`incident:${incidentId}:chat`, 0, -1)
  // LPUSH stores newest-first; reverse so oldest is first for display.
  // Upstash Redis may auto-deserialize stored JSON strings into objects —
  // handle both string and object cases defensively.
  const messages = raw
    .map(m => {
      if (typeof m === 'string') {
        try { return JSON.parse(m) } catch { return null }
      }
      // Already deserialized by Redis client
      return (typeof m === 'object' && m !== null) ? m : null
    })
    .filter(Boolean)
    .reverse()

  return NextResponse.json({ messages })
}
