import { NextResponse } from 'next/server'

export async function POST(req) {
  const { summary, owner, incidentId } = await req.json()

  const apiKey = process.env.PAGERDUTY_API_KEY
  const serviceId = process.env.PAGERDUTY_SERVICE_ID

  if (!apiKey || !serviceId) {
    return NextResponse.json(
      { ok: false, error: 'PAGERDUTY_API_KEY or PAGERDUTY_SERVICE_ID is not set' },
      { status: 500 }
    )
  }

  const body = {
    incident: {
      type: 'incident',
      title: summary || 'IncidentWeave escalation',
      service: { id: serviceId, type: 'service_reference' },
      body: {
        type: 'incident_body',
        details: `Escalated by IncidentWeave${owner ? ` — owner: ${owner}` : ''}${incidentId ? ` — incident: ${incidentId}` : ''}.`,
      },
    },
  }

  const res = await fetch('https://api.pagerduty.com/incidents', {
    method: 'POST',
    headers: {
      Authorization: `Token token=${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.pagerduty+json;version=2',
      From: process.env.PAGERDUTY_FROM_EMAIL || 'oncall@example.com',
    },
    body: JSON.stringify(body),
  })

  const data = await res.json()
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: data }, { status: 500 })
  }
  return NextResponse.json({ ok: true, incidentId: data.incident?.id, incidentUrl: data.incident?.html_url })
}
