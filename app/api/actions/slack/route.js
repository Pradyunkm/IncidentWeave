import { NextResponse } from 'next/server'

export async function POST(req) {
  const { message, owner, incidentId } = await req.json()

  const webhookUrl = process.env.SLACK_WEBHOOK_URL
  if (!webhookUrl) {
    return NextResponse.json({ ok: false, error: 'SLACK_WEBHOOK_URL is not set' }, { status: 500 })
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `🚨 *IncidentWeave Action Approved*\n*Task:* ${message}\n*Owner:* ${owner || 'Unassigned'}\n*Incident:* ${incidentId}`,
    }),
  })

  if (!res.ok) return NextResponse.json({ ok: false, error: 'Slack webhook failed' }, { status: 500 })
  return NextResponse.json({ ok: true })
}
