# IncidentWeave — AI Incident Command Room

[![Live Demo](https://img.shields.io/badge/Live%20Demo-incidentweave--live.vercel.app-00dfd8?style=flat-square&logo=vercel)](https://incidentweave-live.vercel.app)
[![GitHub Repository](https://img.shields.io/badge/GitHub-Pradyunkm%2FIncidentWeave-181717?style=flat-square&logo=github)](https://github.com/Pradyunkm/IncidentWeave)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)

> **Live Deployment:** [https://incidentweave-live.vercel.app](https://incidentweave-live.vercel.app)  
> **GitHub Repository:** [https://github.com/Pradyunkm/IncidentWeave](https://github.com/Pradyunkm/IncidentWeave)

**IncidentWeave** turns chaotic multi-person incident calls into structured, actionable intelligence in real time. It features a **common multi-party voice transcript** with real speaker attribution, live AI claim extraction, automated contradiction detection, a dynamic Truth Graph, and approval gates for Jira, Slack, and PagerDuty.

## Key Capabilities

- 🎙️ **Common Multi-Party Transcript**: When anyone speaks in the room, their speech is instantly broadcast over Agora RTM to all participants with their actual name, role, and timestamp.
- 🤖 **AI Incident Commander**: Listens to everyone simultaneously via Deepgram STT, GPT-4o-mini, and MiniMax TTS.
- ⚡ **Truth Graph**: Real-time ReactFlow graph visualizing facts, hypotheses, and contradictions between speakers.
- 🛡️ **Action Gate**: Human-in-the-loop approval before firing actions to Slack, Jira, or PagerDuty.
- 💬 **Live Meeting Chat & Audio Recorder**: Full in-call text chat, DM channels, and dual-track meeting audio recorder.

## Prerequisites

- [Node.js 22+](https://nodejs.org/en/download/)
- [npm](https://www.npmjs.com/) or [pnpm](https://pnpm.io/installation)
- Agora Developer Account (App ID + App Certificate)
- Upstash Redis Account (for shared state & transcript persistence)

## Run Locally

```bash
git clone https://github.com/Pradyunkm/IncidentWeave.git
cd IncidentWeave
npm install
cp env.local.example .env.local
# Add your NEXT_PUBLIC_AGORA_APP_ID, NEXT_AGORA_APP_CERTIFICATE, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to create or join an incident room. Open a second tab or share the room link with teammates to test multi-party voice and shared transcripts!

### Live Deployment

IncidentWeave is continuously deployed on Vercel:
👉 **[https://incidentweave-live.vercel.app](https://incidentweave-live.vercel.app)**

To populate Vercel env vars from your bound Agora project:

```bash
agora project use <your-project>
agora project env write .env.local
rg "^(NEXT_PUBLIC_AGORA_APP_ID|NEXT_AGORA_APP_CERTIFICATE)=" .env.local
```

Copy those two values into Vercel Project Settings -> Environment Variables.

### Environment variables

Defined in [`env.local.example`](env.local.example).

| Variable                     | Required | Notes                                                            |
| ---------------------------- | :------: | ---------------------------------------------------------------- |
| `NEXT_PUBLIC_AGORA_APP_ID`   |    ✅    | Agora Console → Project → App ID.                                |
| `NEXT_AGORA_APP_CERTIFICATE` |    ✅    | Agora Console → Project → App Certificate. **Server-side only.** |

The default agent configuration in [`app/api/invite-agent/route.ts`](app/api/invite-agent/route.ts) uses Agora-managed STT, LLM, and TTS, so no extra vendor API keys are required for the base quickstart.

## Commands

```bash
# Dev
pnpm dev                # start the Next.js dev server

# Quality
pnpm run lint           # eslint
pnpm run typecheck      # tsc --noEmit
pnpm run doctor         # local prereqs + env binding

# CI / pre-ship
pnpm run verify:api     # API contract checks
pnpm run build          # production build
pnpm run verify         # doctor + lint + typecheck + verify:api + build
```

Run `pnpm run verify` before shipping changes — it covers local prerequisites, lint, type safety, the core API route contracts, and the production build.

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./system-architecture-dark.svg">
  <img src="./system-architecture.svg" alt="System architecture">
</picture>

The browser fetches a combined RTC + RTM token (`buildTokenWithRtm`) from this app, joins the channel using a single RTC client, and uses RTM as the data channel for transcript, agent state, metrics, and error events. The Conversational AI Engine joins the same channel as the shared agent UID in [`lib/agora.ts`](lib/agora.ts) and runs the STT → LLM → TTS pipeline in Agora Cloud.

## What You Get

- browser voice client built with Next.js App Router
- RTC audio plus RTM transcript and state events
- server routes for token generation, invite, and stop
- [`AgentVisualizer`](https://agoraio-conversational-ai.github.io/agent-uikit/) for agent state and a built-in transcript panel for live turns
- per-stage latency header driven by `AGENT_METRICS`
- Agora-managed default STT, LLM, and TTS configuration

## How It Works

1. The browser requests an RTC + RTM token from `/api/generate-agora-token`.
2. The backend invites an Agora cloud agent with `/api/invite-agent`.
3. The browser joins the channel and publishes mic audio.
4. The client receives transcript, agent state, and `AGENT_METRICS` (per-stage latency) events over RTM.
5. On end, the client calls `/api/stop-conversation`, logs out RTM, and unmounts the call view so Agora React hooks clean up RTC publish/join and the local microphone track.

## Optional BYOK

The base `.env.local` contract contains only Agora credentials. If you are migrating from a supported provider, uncomment the matching snippet in [`app/api/invite-agent/route.ts`](app/api/invite-agent/route.ts) and add its variables to your local environment.

```bash
# Deepgram STT
NEXT_DEEPGRAM_API_KEY=...

# OpenAI-compatible LLM
NEXT_LLM_URL=https://api.openai.com/v1/chat/completions
NEXT_LLM_API_KEY=...

# ElevenLabs TTS
NEXT_ELEVENLABS_API_KEY=...
NEXT_ELEVENLABS_VOICE_ID=...
```

## Repo Map

- `app/api/generate-agora-token/route.ts` — issues RTC + RTM tokens
- `app/api/invite-agent/route.ts` — starts the agent session and configures the pipeline
- `app/api/stop-conversation/route.ts` — stops the agent session
- `components/LandingPage.tsx` — entry point: token fetch, RTM login, conversation lifecycle
- `components/ConversationComponent.tsx` — RTC client, transcript state, `AGENT_METRICS`, mic release
- `components/QuickstartConversationLayout.tsx` — in-call header, transcript rail, controls dock
- `components/QuickstartPipelineMetrics.tsx` — per-stage latency chips in the header
- `components/QuickstartTranscriptPanel.tsx` — live transcript rail
- `components/QuickstartPreCallCard.tsx` — pre-call hero card
- `lib/conversation.ts` — transcript normalization and visualizer state mapping
- `AGENTS.md` — primary agent-facing guide

## Troubleshooting

- **Agent does not join or transcripts are missing:** run `agora project doctor --deep`.
- **`pnpm run doctor` fails:** run `agora project env write .env.local`, then retry.
- **Manual clone / env values:** `agora project use <your-project>` then `agora project env write .env.local`.
- **RTM login fails:** keep [`app/api/generate-agora-token/route.ts`](app/api/generate-agora-token/route.ts) on `RtcTokenBuilder.buildTokenWithRtm` — RTC-only tokens will not satisfy `rtm.login`.
- **Transcript speakers inverted:** check the `uid === "0"` remap in [`components/ConversationComponent.tsx`](components/ConversationComponent.tsx).
- **Agent never appears in channel:** ensure the shared agent UID in [`lib/agora.ts`](lib/agora.ts) is used by both the client and invite route.

## More Docs

- [docs/ai/L0_repo_card.md](./docs/ai/L0_repo_card.md)
- [docs/ai/RECIPE.md](./docs/ai/RECIPE.md)
- [AGENTS.md](./AGENTS.md)

## Contributing

Pull requests welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and conventions.

## Security

Please do **not** open public issues for security reports. Email security@agora.io with details and reproduction steps.

## License

Released under the [MIT License](./LICENSE).
