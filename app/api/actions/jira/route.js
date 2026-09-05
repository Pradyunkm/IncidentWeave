import { NextResponse } from 'next/server'

export async function POST(req) {
  const { summary, owner } = await req.json()

  const { JIRA_EMAIL, JIRA_API_TOKEN, JIRA_DOMAIN, JIRA_PROJECT_KEY } = process.env

  if (!JIRA_EMAIL || !JIRA_API_TOKEN || !JIRA_DOMAIN || !JIRA_PROJECT_KEY) {
    return NextResponse.json(
      { ok: false, error: 'Jira credentials are not set' },
      { status: 500 }
    )
  }

  const credentials = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')

  const res = await fetch(
    `https://${JIRA_DOMAIN}.atlassian.net/rest/api/3/issue`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fields: {
          project: { key: JIRA_PROJECT_KEY },
          summary,
          description: {
            type: 'doc',
            version: 1,
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: `Assigned to: ${owner || 'Unassigned'}` },
                ],
              },
            ],
          },
          issuetype: { name: 'Task' },
        },
      }),
    }
  )

  const data = await res.json()
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: data }, { status: 500 })
  }
  return NextResponse.json({ ok: true, issue: data.key })
}
