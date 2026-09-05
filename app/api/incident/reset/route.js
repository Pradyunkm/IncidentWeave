import { redis } from '@/lib/redis'
import { NextResponse } from 'next/server'

/**
 * DELETE /api/incident/reset?id={incidentId}
 * Clears all Redis keys for an incident: claims, actions, roster, seq counter.
 * Protected by an optional X-Reset-Secret header (set INCIDENT_RESET_SECRET env var).
 */
export async function DELETE(req) {
  const { searchParams } = new URL(req.url)
  const incidentId = searchParams.get('id') || 'default'

  // Optional secret guard — skip if env var not set (dev convenience)
  const secret = process.env.INCIDENT_RESET_SECRET
  if (secret) {
    const provided = req.headers.get('x-reset-secret')
    if (provided !== secret) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }
  }

  const keys = [
    `incident:${incidentId}:claims`,
    `incident:${incidentId}:actions`,
    `incident:${incidentId}:roster`,
    `incident:${incidentId}:seq`,
  ]

  await Promise.all(keys.map(k => redis.del(k)))

  return NextResponse.json({ ok: true, cleared: keys, incidentId })
}

/**
 * POST /api/incident/reset  (body: { incidentId })
 * Same as DELETE but uses POST for clients that can't send DELETE with a body.
 */
export async function POST(req) {
  const body = await req.json().catch(() => ({}))
  const incidentId = body.incidentId || 'default'

  const secret = process.env.INCIDENT_RESET_SECRET
  if (secret) {
    const provided = req.headers.get('x-reset-secret')
    if (provided !== secret) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }
  }

  const keys = [
    `incident:${incidentId}:claims`,
    `incident:${incidentId}:actions`,
    `incident:${incidentId}:roster`,
    `incident:${incidentId}:seq`,
  ]

  await Promise.all(keys.map(k => redis.del(k)))

  return NextResponse.json({ ok: true, cleared: keys, incidentId })
}
