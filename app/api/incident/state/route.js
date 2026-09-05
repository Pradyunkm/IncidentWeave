import { redis } from '@/lib/redis'
import { NextResponse } from 'next/server'

export async function GET(req) {
  const { searchParams } = new URL(req.url)
  const incidentId = searchParams.get('id') || 'default'

  const [claims, actions, rosterRaw] = await Promise.all([
    redis.lrange(`incident:${incidentId}:claims`, 0, -1),
    redis.lrange(`incident:${incidentId}:actions`, 0, -1),
    redis.hgetall(`incident:${incidentId}:roster`),
  ])

  // rosterRaw can be { uid: string | object } depending on Redis client deserialization
  const roster = {}
  if (rosterRaw) {
    for (const [uid, val] of Object.entries(rosterRaw)) {
      if (typeof val === 'object' && val !== null) {
        roster[uid] = {
          uid: val.uid ? String(val.uid) : uid,
          name: val.name || `User ${uid}`,
          role: val.role || 'Participant',
        }
      } else if (typeof val === 'string') {
        try {
          const parsed = JSON.parse(val)
          roster[uid] = {
            uid: parsed.uid ? String(parsed.uid) : uid,
            name: parsed.name || `User ${uid}`,
            role: parsed.role || 'Participant',
          }
        } catch {
          roster[uid] = { uid, name: val || `User ${uid}`, role: 'Participant' }
        }
      }
    }
  }

  const parseItem = (item) => {
    if (typeof item === 'object' && item !== null) return item
    try {
      return JSON.parse(item)
    } catch {
      return null
    }
  }

  return NextResponse.json({
    claims: (claims || []).map(parseItem).filter(Boolean),
    actions: (actions || []).map(parseItem).filter(Boolean),
    roster,
  })
}