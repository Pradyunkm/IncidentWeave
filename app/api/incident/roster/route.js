import { redis } from '@/lib/redis'
import { NextResponse } from 'next/server'

// POST: register or update a participant in the room roster
// Body: { incidentId, uid, name, role }
export async function POST(req) {
  const { incidentId, uid, name, role } = await req.json()
  if (!incidentId || !uid) {
    return NextResponse.json({ ok: false, error: 'incidentId and uid required' }, { status: 400 })
  }
  await redis.hset(`incident:${incidentId}:roster`, {
    [uid]: JSON.stringify({ uid, name: name || uid, role: role || 'Participant' }),
  })
  // Keep roster alive for 24h alongside the incident
  await redis.expire(`incident:${incidentId}:roster`, 86400)
  return NextResponse.json({ ok: true })
}

// DELETE: remove a participant (e.g., on leave)
export async function DELETE(req) {
  const { searchParams } = new URL(req.url)
  const incidentId = searchParams.get('id') || 'default'
  const uid = searchParams.get('uid')
  if (!uid) return NextResponse.json({ ok: false, error: 'uid required' }, { status: 400 })
  await redis.hdel(`incident:${incidentId}:roster`, uid)
  return NextResponse.json({ ok: true })
}
