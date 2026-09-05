# IncidentWeave — Hackathon Submission Package

> **AI-powered multi-party incident command room** built on Agora Conversational AI

---

## 1. Project Description

**IncidentWeave** turns a chaotic multi-person incident call into a structured, actionable intelligence feed — in real time, using voice.

When a production outage hits, the typical incident call is a mess: engineers talk over each other, people state conflicting metrics, action items get lost, and whoever is taking notes misses half of it. IncidentWeave joins the call as an AI incident commander. It listens to every participant simultaneously, extracts structured claims from what is said, detects contradictions between speakers, surfaces action items for human approval, and fires them to Jira, Slack, or PagerDuty — all while showing a live Truth Graph of what is known, disputed, and being acted on.

**The problem it solves:** Engineering teams lose 20–40 minutes per incident just to coordination overhead — figuring out what has already been checked, who owns what action, and whether two engineers are arguing about the same thing or different things. IncidentWeave eliminates that overhead by being the incident's memory.

**Who uses it:** 2–5 engineers, SREs, product managers, and business stakeholders in the same Agora voice room, each joining with their name and role. The AI hears everyone. The dashboard is shared on a wall screen.

---

## 2. Technical Architecture

```
 INCIDENT ROOM PARTICIPANTS
 ┌─────────────────────────────────────────────┐
 │  Engineer (UID: A)                           │
 │  SRE       (UID: B)   ──RTC Audio──▶         │
 │  Product   (UID: C)                           │
 └─────────────────────────────────────────────┘
                    │
                    ▼ Agora RTC SDK (agora-rtc-react)
 ┌─────────────────────────────────────────────────────┐
 │         AGORA CONVERSATIONAL AI ENGINE              │
 │                                                     │
 │  STT: Deepgram nova-3  (real-time transcription)    │
 │   ↓                                                 │
 │  LLM: GPT-4o-mini  +  ADA_PROMPT                   │
 │       → produces spoken reply                       │
 │       → appends structured JSON claim block         │
 │   ↓                                                 │
 │  TTS: MiniMax speech_2_6_turbo                      │
 └──────────────────────────┬──────────────────────────┘
                            │ RTM Data Channel
                            ▼ (agora-agent-client-toolkit)
 ┌─────────────────────────────────────────────────────┐
 │         BROWSER CLIENT (ConversationComponent)      │
 │                                                     │
 │  AgoraVoiceAI.TRANSCRIPT_UPDATED event              │
 │    → parseClaimFromAgentResponse(text)              │
 │    → findLastHumanUid() → speakerUid                │
 │    → POST /api/incident/claim                       │
 └──────────────────────────┬──────────────────────────┘
                            │
                            ▼
 ┌─────────────────────────────────────────────────────┐
 │         NEXT.JS API ROUTES                          │
 │                                                     │
 │  POST /api/incident/claim                           │
 │    → INCR incident:{id}:seq   (atomic counter)      │
 │    → LPUSH incident:{id}:claims                     │
 │    → LPUSH incident:{id}:actions  (if action)       │
 │                                                     │
 │  GET  /api/incident/state                           │
 │    → LRANGE claims + actions + HGETALL roster       │
 │                                                     │
 │  POST /api/incident/roster                          │
 │    → HSET incident:{id}:roster {uid: {name, role}}  │
 │                                                     │
 │  POST /api/actions/slack      → Slack webhook       │
 │  POST /api/actions/jira       → Jira REST API v3    │
 │  POST /api/actions/pagerduty  → PagerDuty API v2    │
 └──────────────────────────┬──────────────────────────┘
                            │ Upstash Redis (REST)
                            ▼
 ┌─────────────────────────────────────────────────────┐
 │         LIVE DASHBOARD  /dashboard                  │
 │                                                     │
 │  Stats Bar        — counts by claim type            │
 │  Truth Graph      — ReactFlow, seq-matched edges    │
 │  Claims Feed      — color-coded, speaker + role     │
 │  Incident Timeline— chronological, T+mm:ss markers  │
 │  Action Gate      — approve/reject + staleness badge │
 │  Roster Panel     — live participant list in header  │
 └─────────────────────────────────────────────────────┘
```

### Claim data shape

Every claim stored in Redis has the following shape:

```json
{
  "id": "uuid-v4",
  "seq": 7,
  "type": "contradictory",
  "claim": "Database CPU is only 30%, not 98% as previously stated",
  "speaker": "Rahul",
  "speakerUid": "1002",
  "confidence": 0.92,
  "conflicts_with_seq": 3,
  "timestamp": 1778475000000
}
```

Three separate identifiers serve three different purposes:

| Field | Purpose |
|---|---|
| `id` | Database / UI identity (UUID) |
| `seq` | Incident-local claim number — used by the LLM to reference earlier claims in `conflicts_with_seq` |
| `speakerUid` | Actual Agora RTC UID of the participant who triggered this agent turn — real, not inferred |

### Conflict resolution in TruthGraph

```js
// Reliable: exact integer match on seq
const target = claims.find(x => Number(x.seq) === Number(current.conflicts_with_seq))

// Previous approach (removed): brittle substring match
// claims.find(x => x.claim.includes(c.conflicts_with?.slice(0, 20)))
```

---

## 3. Agora Technology Integration

### 3.1 Agora Conversational AI Engine (`agora-agents`)

The entire voice intelligence pipeline runs through Agora's hosted ConvAI service:

```typescript
// app/api/invite-agent/route.ts
const agent = new Agent({ client, instructions: ADA_PROMPT, greeting: GREETING })
  .withStt(new DeepgramSTT({ model: 'nova-3', language: 'en' }))
  .withLlm(new OpenAI({ model: 'gpt-4o-mini', maxHistory: 15 }))
  .withTts(new MiniMaxTTS({ model: 'speech_2_6_turbo', voiceId: 'English_captivating_female1' }))

const session = agent.createSession({
  channel: channel_name,
  agentUid,
  remoteUids: remoteUidList,  // listens to ALL participants, not just one
  idleTimeout: 30,
  expiresIn: ExpiresIn.hours(1),
})
```

**Key Agora ConvAI features used:**

| Feature | How it's used |
|---|---|
| `remoteUids: string[]` | Accepts multiple UIDs — enables true multi-party rooms |
| VAD turn detection | `silence_duration_ms: 480`, `interrupt_duration_ms: 160` — natural conversation pacing |
| `enable_rtm: true` | RTM data channel delivers transcript + metric events to the browser |
| `enable_metrics: true` | Latency metrics surface in the pipeline metrics panel |
| `audio_scenario: 'chorus'` | Ultra-low-latency profile for web clients |
| `maxHistory: 15` | Conversation memory window for context-aware claim extraction |

### 3.2 Agora RTC SDK (`agora-rtc-react`)

```typescript
// Multi-party: any participant who joins the same channel_name joins the same room
const { isConnected: joinSuccess } = useJoin({
  appid: NEXT_PUBLIC_AGORA_APP_ID,
  channel: agoraData.channel,   // = shared Room ID from the join form
  token: agoraData.token,
  uid: parseInt(agoraData.uid, 10),
}, isReady)

// Track new participants joining mid-call for roster + agent awareness
useClientEvent(client, 'user-joined', (user) => {
  // Registers participant in Redis roster → dashboard shows real names
  fetch('/api/incident/roster', { method: 'POST', body: JSON.stringify({
    uid: String(user.uid), name: agoraData.participantName, role: agoraData.participantRole
  }) })
})
```

### 3.3 Agora RTM + Agent Client Toolkit (`agora-agent-client-toolkit`)

```typescript
// AgoraVoiceAI bridges RTC + RTM to deliver transcript events
const ai = await AgoraVoiceAI.init({
  rtcEngine: client,
  rtmConfig: { rtmEngine: rtmClient },
  renderMode: TranscriptHelperMode.TEXT,
})

// Every completed agent turn is parsed for a JSON claim block
ai.on(AgoraVoiceAIEvents.TRANSCRIPT_UPDATED, (transcript) => {
  // ConversationComponent processes END/INTERRUPTED agent turns
  // → parseClaimFromAgentResponse(text)
  // → findLastHumanUid(transcript, idx) → speakerUid
  // → POST /api/incident/claim with enriched claim
})
```

### 3.4 Token Architecture

```typescript
// generate-agora-token/route.ts
// All participants joining the same room use the same channel name
// (set by the Room ID field in LandingPage)
const token = RtcTokenBuilder.buildTokenWithRtm(
  APP_ID, APP_CERTIFICATE,
  channelName,  // = Room ID = shared across all participants
  uid.toString(),
  RtcRole.PUBLISHER,
  expirationTime, expirationTime
)
```

---

## 4. API Route Inventory

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/invite-agent` | Start ConvAI agent session, accepts `requester_ids[]` |
| `POST` | `/api/stop-conversation` | Stop agent session by ID |
| `GET` | `/api/generate-agora-token` | Issue RTC + RTM token for a channel |
| `POST` | `/api/incident/claim` | Store claim in Redis with atomic `seq` counter |
| `GET` | `/api/incident/state` | Return claims, actions, and roster for a dashboard poll |
| `POST` | `/api/incident/roster` | Register/update participant name + role |
| `DELETE` | `/api/incident/roster` | Remove participant on leave |
| `POST` | `/api/actions/slack` | Fire approved action to Slack webhook |
| `POST` | `/api/actions/jira` | Create Jira issue via REST API v3 |
| `POST` | `/api/actions/pagerduty` | Create PagerDuty incident via API v2 |

---

## 5. Demo Video Script

**Duration target: 3–4 minutes**

### Scene 1 — The problem (0:00–0:20)
> "You're 15 minutes into a P1 call. Three engineers are talking at once. Someone says error rate is 34%. Someone else says it's 12%. Nobody knows who owns the rollback."

### Scene 2 — Join the room (0:20–0:50)
Show two browser tabs side by side — Tab A: "Arun / Engineer", Tab B: "Priya / SRE".
Both enter Room ID `incident-sept3`. Both click **Join Incident Room**.
Dashboard opens. Header shows both participants in the roster panel.

### Scene 3 — Voice conversation (0:50–2:10)
**Arun** speaks: *"Payment API is returning 503s since 5:42 PM. Error rate is 34%."*
AI responds: *"Confirmed. Which regions are affected?"*

Dashboard: claim #1 appears as green FACT. Truth Graph shows one node.

**Priya** speaks: *"Actually it started at 6 PM and the rate is only 12%. I'm looking at the metrics right now."*
AI responds: *"Flagging a contradiction — claim 1 said 34% at 5:42 PM."*

Dashboard: claim #2 appears as red CONTRADICTORY. Truth Graph draws an animated red edge from node 2 to node 1.

**Arun** speaks: *"We need to create a Jira ticket for the auth team and page the on-call SRE."*
AI responds: *"Got it. Flagging both for approval."*

Dashboard: Two action cards appear in the Approval Gate — one Jira, one PagerDuty.

### Scene 4 — Human approval (2:10–2:45)
Click **Approve** on the Jira action → toast: "Jira ticket created: KAN-47"
Click **Approve** on the PagerDuty action → toast: "PagerDuty escalation created!"

Switch to Timeline tab — show T+0:00, T+1:23, T+2:05 entries.

### Scene 5 — Staleness (2:45–3:10)
Show a pending action card with amber "⚠ 11 min — Awaiting owner" badge.
*"If an action has no update after 10 minutes, IncidentWeave flags it."*

### Scene 6 — Close (3:10–3:30)
Pull back to show full dashboard: Stats Bar (3 facts, 1 contradiction, 2 actions), Truth Graph with edges, Timeline, Approval Gate all live-updating.
*"That's IncidentWeave — structured intelligence from voice, in real time, with real external actions."*

---

## 6. Pitch Deck Outline

### Slide 1 — Title
**IncidentWeave**: AI incident commander for engineering teams
Built on Agora Conversational AI

### Slide 2 — The Problem
- Average P1 incident: 45 min to resolve, 20 min lost to coordination
- 3 people talk simultaneously → contradictions go unnoticed
- Action items get lost in Slack threads
- Notes taken during the call are always incomplete

### Slide 3 — The Solution
> "What if the incident call had an AI member who never missed a word?"
- Joins as a participant in your voice room
- Listens to every speaker simultaneously
- Extracts, classifies, and cross-references every claim
- Surfaces action items for human approval before firing them

### Slide 4 — Live Demo (screenshot / GIF)
[Truth Graph with animated contradiction edge]
[Action Approval Gate with PagerDuty card]

### Slide 5 — How It Works (Architecture diagram)
[Use the architecture image]

### Slide 6 — Agora Technology
| Layer | Agora Tech |
|---|---|
| Voice room | Agora RTC SDK |
| Speech-to-text | Agora ConvAI → Deepgram nova-3 |
| Intelligence | Agora ConvAI → GPT-4o-mini |
| Voice response | Agora ConvAI → MiniMax TTS |
| Transcript events | Agora RTM + agent-client-toolkit |
| Multi-party | remoteUids[] (all participants) |

### Slide 7 — Key Differentiators
1. **Multi-party**: Agent hears all participants, not just one
2. **Reliable contradiction detection**: seq-based graph edges, not fuzzy text
3. **Real speaker attribution**: actual Agora UID → name/role, not LLM guess
4. **Human-in-the-loop**: nothing fires until a human clicks Approve
5. **Three real integrations**: Jira + Slack + PagerDuty

### Slide 8 — Built to Grow
- Silence Governor (flag dead air > N minutes)
- Decision Memory (cross-incident similarity)
- Historical analytics (MTTR reduction tracking)
- SOC 2 audit trail from Redis claim log

---

## 7. Environment Variables

Add to `.env.local`:

```bash
# Agora (required)
NEXT_PUBLIC_AGORA_APP_ID=
NEXT_AGORA_APP_CERTIFICATE=

# Upstash Redis (required for shared state)
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# Slack (optional — action integration)
SLACK_WEBHOOK_URL=

# Jira (optional — action integration)
JIRA_EMAIL=
JIRA_API_TOKEN=
JIRA_DOMAIN=
JIRA_PROJECT_KEY=

# PagerDuty (optional — action integration)
PAGERDUTY_API_KEY=
PAGERDUTY_SERVICE_ID=
PAGERDUTY_FROM_EMAIL=
```

---

## 8. GitHub Repository README (copy-paste ready)

```markdown
# IncidentWeave

AI-powered multi-party incident command room built on Agora Conversational AI.

## What it does

IncidentWeave joins your incident call as an AI participant. It listens to every 
engineer, SRE, and stakeholder simultaneously — extracting structured claims, detecting 
contradictions between speakers, and surfacing action items for human approval before 
firing them to Jira, Slack, or PagerDuty.

## Key features

- **Multi-party voice room** — any number of participants, same Room ID
- **Real-time claim extraction** — every agent turn produces a typed, seq-numbered claim
- **Truth Graph** — live ReactFlow visualization with animated contradiction edges
- **Incident Timeline** — chronological strip with relative timestamps
- **Action Approval Gate** — human-in-the-loop; nothing fires without a click
- **Staleness detection** — actions pending >10 min get an amber warning
- **Three integrations** — Jira, Slack, PagerDuty

## Stack

Next.js 16 · Agora ConvAI (Deepgram STT + GPT-4o-mini + MiniMax TTS) · 
Agora RTC/RTM · Upstash Redis · ReactFlow · lucide-react

## Run locally

\`\`\`bash
cp .env.local.example .env.local
# fill in Agora App ID + Certificate + Upstash credentials
npm install
npm run dev
\`\`\`

Open http://localhost:3000 — enter a Room ID and your name, click Join.
Open a second tab with a different name to simulate a second participant.
Open http://localhost:3000/dashboard in a third tab to see the live intelligence feed.
```

---

## 9. What Was Built vs. What Is Roadmap

### Built and working ✅

| Capability | Evidence |
|---|---|
| Multi-party voice room | `remoteUids: remoteUidList` in `invite-agent/route.ts` |
| Real speaker attribution | `findLastHumanUid()` → `speakerUid` on every claim |
| Claim extraction pipeline | `parseClaimFromAgentResponse` → `/api/incident/claim` |
| Seq-based conflict linking | Redis `INCR` seq + `conflicts_with_seq` in TruthGraph |
| Shared roster | `/api/incident/roster` + HGETALL in state route |
| Truth Graph | ReactFlow with animated contradiction edges |
| Incident Timeline | Chronological strip, T+mm:ss, type-colored |
| Action Approval Gate | Approve/Reject with loading state |
| Staleness indicator | 10-min threshold, orange badge, "Awaiting owner" |
| Jira integration | REST API v3, real ticket creation |
| Slack integration | Incoming webhook, formatted message |
| PagerDuty integration | API v2 incident creation |
| Proactive status summary | System prompt: every 5 claims, one-line spoken recap |

### Honest roadmap (not built) 🗓️

| Feature | Why deferred |
|---|---|
| Silence Governor | Complex timer logic, low demo value |
| Decision Memory | Requires vector embeddings + similarity search |
| Cross-incident analytics | Needs historical data accumulation |
| Native diarization | Would require speaker enrollment per session |
