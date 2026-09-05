import { redis } from '@/lib/redis'
import { NextResponse } from 'next/server'

export async function POST(req) {
  const body = await req.json()
  const { incidentId, claim } = body

  // Atomic monotonic counter — gives each claim a seq the LLM can reference for conflict linking.
  const seq = await redis.incr(`incident:${incidentId}:seq`)

  const claimWithTimestamp = {
    ...claim,
    seq,
    timestamp: Date.now(),
    id: crypto.randomUUID(),
  }

  await redis.lpush(`incident:${incidentId}:claims`, JSON.stringify(claimWithTimestamp))
  await redis.ltrim(`incident:${incidentId}:claims`, 0, 99)

  // If this claim carries an action, push it to the pending actions list
  if (claimWithTimestamp.action) {
    const pendingAction = {
      ...claimWithTimestamp.action,
      id: crypto.randomUUID(),
      status: 'pending',
      timestamp: Date.now(),
      seq,
      claim: claimWithTimestamp.claim,
      speakerUid: claimWithTimestamp.speakerUid ?? null,
    }
    await redis.lpush(`incident:${incidentId}:actions`, JSON.stringify(pendingAction))
    await redis.ltrim(`incident:${incidentId}:actions`, 0, 99)
  }

  return NextResponse.json({ ok: true, claim: claimWithTimestamp })
}