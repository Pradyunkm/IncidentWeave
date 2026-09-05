import { redis } from '@/lib/redis'
import { NextResponse } from 'next/server'

// POST /api/chat/messages
// Body: { incidentId, message: { id, from, fromName, fromRole, to, text, timestamp } }
export async function POST(req) {
  const { incidentId, message } = await req.json()
  if (!incidentId || !message) {
    return NextResponse.json({ ok: false, error: 'incidentId and message required' }, { status: 400 })
  }

  await redis.lpush(`incident:${incidentId}:chat`, JSON.stringify(message))
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
  // LPUSH stores newest-first; reverse so oldest is first for display
  const messages = raw.map(m => JSON.parse(m)).reverse()

  return NextResponse.json({ messages })
}
