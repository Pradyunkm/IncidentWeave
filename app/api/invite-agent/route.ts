import { NextRequest, NextResponse } from 'next/server';
import {
  AgoraClient,
  Agent,
  Area,
  DeepgramSTT,
  ExpiresIn,
  MiniMaxTTS,
  OpenAI,
} from 'agora-agents';
import { ClientStartRequest, AgentResponse } from '@/types/conversation';
import { DEFAULT_AGENT_UID } from '@/lib/agora';

// System prompt that defines the agent's personality and behavior.
const ADA_PROMPT = `You are **IncidentWeave**, an AI incident command assistant. You listen to live multi-party incident calls and extract structured intelligence in real time.

# Your Job
Listen to what participants say during an incident. After every response you give, you MUST append a JSON claim block that classifies what was just stated.

# Claim Types
- **fact**: A confirmed, measurable observation ("error rate is 34%", "CPU is at 98%")
- **hypothesis**: An unverified belief or theory ("I think it might be...", "probably caused by...")
- **contradictory**: A statement that directly contradicts a previous claim by a different participant
- **action**: Something that needs to be done ("we need to create a ticket", "someone should page the team")
- **unknown**: Unclear or insufficient information

# CRITICAL: JSON Output Rule
After EVERY response, you MUST append a JSON claim block. The JSON MUST:
1. Start with { and end with } on its own line
2. Be valid, parseable JSON — never truncate it
3. Always include all six fields: type, claim, speaker, confidence, conflicts_with_seq, action
4. Never omit the closing brace }

Exact format (copy precisely):
{"type": "fact"|"hypothesis"|"contradictory"|"action"|"unknown", "claim": "<concise statement under 120 chars>", "speaker": "<speaker name if known, else null>", "confidence": 0.0-1.0, "conflicts_with_seq": <integer or null>, "action": {"tool": "jira"|"slack"|"pagerduty", "task": "<task>", "owner": "<name or null>"} or null}

IMPORTANT: The JSON block must always be the LAST thing in your response. Never put text after it.

# Speaker Attribution
- The system tracks who is speaking by their Agora UID. When someone introduces themselves or is named, note their name in the \`speaker\` field.
- When multiple participants disagree, classify the disagreeing claim as \`contradictory\` and reference the earlier claim's \`seq\` number in \`conflicts_with_seq\`.
- Each stored claim has an auto-incremented \`seq\` number starting at 1. You will be told the current seq count periodically.

# Available Action Tools
- **jira**: Create a Jira ticket for engineering follow-up
- **slack**: Post an update to the incident Slack channel  
- **pagerduty**: Escalate and page the on-call team immediately (use only for P1/critical escalations)

# SILENT OBSERVER MODE — CRITICAL
You are an intelligent background observer in an active incident command room where human engineers are working.
- Engineers are actively conversing. Do NOT interrupt them.
- DO NOT speak unprompted to acknowledge human conversation turns.
- NEVER speak to fill silence. NEVER say "I am awaiting", "No updates being shared", or unsolicited commentary.
- While participants talk, remain COMPLETELY SILENT. Do NOT produce spoken text. Only output the JSON claim block.
- You must ONLY speak aloud when an operator directly asks or commands you to speak (for example: "IncidentWeave, please give a concise 1-sentence voice update" or "IncidentWeave status report").
- When explicitly asked to speak, give a single crisp sentence summary followed by the JSON claim block.
- Do NOT read the JSON out loud — it is for the system only.

# Contradiction Detection
When a participant states something that conflicts with an earlier claim:
1. Classify the claim as \`contradictory\`
2. Set conflicts_with_seq to the exact integer seq of the contradicted claim
3. Keep spoken response completely silent unless explicitly addressed

# Conversation Behavior
- When prompted to speak, keep spoken response to 1 crisp sentence max — this is a live voice call
- Be calm, clinical, and precise — like an experienced incident commander
- Do NOT read the JSON out loud — it is for the system only
- Do NOT say "appending JSON" or refer to the JSON block in speech

# Examples

User says: "Payment API has been returning 503s since 5:42 PM, error rate is 34%"
You say: ""
{"type": "fact", "claim": "Payment API returning 503s since 5:42 PM, error rate 34%", "speaker": null, "confidence": 0.95, "conflicts_with_seq": null, "action": null}

User says: "No, the error rate is only 12%, it started at 6 PM"
You say: ""
{"type": "contradictory", "claim": "Error rate is 12% and started at 6 PM — contradicts claim #1 (34% at 5:42 PM)", "speaker": null, "confidence": 0.9, "conflicts_with_seq": 1, "action": null}

User says: "IncidentWeave, give us a status update"
You say: "We have 2 facts logged and 1 contradiction regarding the payment API error rate."
{"type": "fact", "claim": "Status update delivered to incident team", "speaker": null, "confidence": 0.9, "conflicts_with_seq": null, "action": null}
`;

// Agent starts completely silent — only speaks when prompted via Speak button or direct question.
const GREETING = '';

// agentUid identifies the AI in the RTC channel and shares its default with the client.
const agentUid = String(DEFAULT_AGENT_UID);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value.trim();
}

// Calls Agora's Conversational AI REST API to update the running agent's subscribe_audio_uids.
// This is necessary when a new participant joins after the agent session was already created,
// because remoteUids is frozen at createSession() time and the STT pipeline won't hear new UIDs.
async function updateAgentRemoteUids({
  appId,
  appCertificate,
  agentId,
  uids,
}: {
  appId: string;
  appCertificate: string;
  agentId: string;
  uids: string[];
}): Promise<void> {
  const auth = Buffer.from(`${appId}:${appCertificate}`).toString('base64');
  const url = `https://api.agora.io/api/conversational-ai-agent/v2/projects/${appId}/agents/${agentId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ subscribe_audio_uids: uids }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Agora update agent failed (${res.status}): ${body}`);
  }
}

export async function POST(request: NextRequest) {
  try {
    // --- 1. Parse request ---

    const body: ClientStartRequest = await request.json();
    const { requester_id, requester_ids, channel_name } = body;
    // Accept either a single requester_id (legacy) or a requester_ids[] (multi-party room).
    // The SDK's remoteUids accepts a string[] so we normalise here.
    const remoteUidList: string[] =
      requester_ids && requester_ids.length > 0
        ? requester_ids
        : requester_id
          ? [requester_id]
          : [];

    // Validate required env vars on first request so misconfiguration surfaces
    // with a clear error message rather than a silent failure.
    const appId = requireEnv('NEXT_PUBLIC_AGORA_APP_ID');
    const appCertificate = requireEnv('NEXT_AGORA_APP_CERTIFICATE');

    if (!channel_name || remoteUidList.length === 0) {
      return NextResponse.json(
        { error: 'channel_name and at least one requester_id are required' },
        { status: 400 },
      );
    }

    // --- 2. Build and start the agent ---

    // AgoraClient authenticates API calls to the Agora Conversational AI service.
    // area: change to Area.EU or Area.AP for European or Asia-Pacific deployments.
    const client = new AgoraClient({
      area: Area.US,
      appId,
      appCertificate,
    });

    // Pipeline: Deepgram (reseller) STT → OpenAI (reseller) LLM → MiniMax (reseller) TTS.
    // Omit vendor API keys for supported models — AgentKit infers reseller presets on start (see Agora Console / billing).
    const agent = new Agent({
      client,
      instructions: ADA_PROMPT,
      failureMessage: 'Please wait a moment.',
      maxHistory: 50,
      // VAD controls how the agent detects the start and end of a user's turn.
      turnDetection: {
        config: {
          speech_threshold: 0.5,
          start_of_speech: {
            mode: 'vad',
            vad_config: {
              interrupt_duration_ms: 160, // ms of speech before interruption triggers
              prefix_padding_ms: 300, // audio captured before speech is detected
            },
          },
          end_of_speech: {
            mode: 'vad',
            vad_config: {
              silence_duration_ms: 480, // ms of silence before turn ends
            },
          },
        },
      },
      // RTM is required for transcript events in the browser client.
      // enable_tools is required for MCP tool invocation.
      advancedFeatures: { enable_rtm: true, enable_tools: true },
      // Required for browser RTM events:
      // - data_channel: 'rtm' enables RTM delivery path for state/metrics/errors
      // - enable_error_message emits AGENT_ERROR payloads
      // - enable_metrics emits AGENT_METRICS latency payloads
      parameters: {
        // web client → ultra-low-latency chorus profile
        audio_scenario: 'chorus',
        data_channel: 'rtm',
        enable_error_message: true,
        enable_metrics: true,
      },
    })
      .withStt(
        new DeepgramSTT({
          model: 'nova-3',
          language: 'en',
        }),
        // BYOK: uncomment the following block and set NEXT_DEEPGRAM_API_KEY
        // new DeepgramSTT({
        //   apiKey: requireEnv('NEXT_DEEPGRAM_API_KEY'),
        //   model: 'nova-3',
        //   language: 'en',
        // }),
      )
      .withLlm(
        new OpenAI({
          model: 'gpt-4o-mini',
          failureMessage: 'Please wait a moment.',
          maxHistory: 25,
          params: {
            max_tokens: 2048,
            temperature: 0.6,
            top_p: 0.92,
          },
        }),
        // BYOK: uncomment the following block and set NEXT_LLM_API_KEY and NEXT_LLM_URL
        // new OpenAI({
        //   apiKey: requireEnv('NEXT_LLM_API_KEY'),
        //   url: requireEnv('NEXT_LLM_URL'),
        //   model: 'gpt-4o-mini',
        //   greetingMessage: GREETING,
        //   failureMessage: 'Please wait a moment.',
        //   maxHistory: 15,
        //   maxTokens: 1024,
        //   temperature: 0.7,
        //   topP: 0.95,
        // }),
      )
      .withTts(
        new MiniMaxTTS({
          model: 'speech_2_6_turbo',
          voiceId: 'English_captivating_female1',
        }),
        // BYOK — ElevenLabs (set NEXT_ELEVENLABS_API_KEY; optional NEXT_ELEVENLABS_VOICE_ID)
        // new (await import('agora-agents')).ElevenLabsTTS({
        //   key: requireEnv('NEXT_ELEVENLABS_API_KEY'),
        //   modelId: 'eleven_flash_v2_5',
        //   voiceId: process.env.NEXT_ELEVENLABS_VOICE_ID ?? 'pNInz6obpgDQGcFmaJgB',
        //   sampleRate: 24000,
        // }),
      );

    // Check if an agent is already active for this channel.
    // If it is, update its subscribe_audio_uids with any new UIDs from this request
    // so late-joining participants are heard by the agent's STT pipeline.
    try {
      const { redis } = await import('@/lib/redis');
      const [cachedAgentId, cachedUidsRaw] = await Promise.all([
        redis.get(`channel:${channel_name}:agent_id`),
        redis.get(`channel:${channel_name}:remote_uids`),
      ]);

      if (cachedAgentId && typeof cachedAgentId === 'string') {
        // Merge existing UIDs with the new ones from this request.
        const existingUids: string[] = cachedUidsRaw
          ? JSON.parse(cachedUidsRaw as string)
          : [];
        const merged = Array.from(new Set([...existingUids, ...remoteUidList]));
        const hasNewUids = merged.length > existingUids.length;

        if (hasNewUids) {
          // New participant joined — update the running agent so it hears them.
          try {
            await updateAgentRemoteUids({
              appId,
              appCertificate,
              agentId: cachedAgentId,
              uids: merged,
            });
            await redis.set(
              `channel:${channel_name}:remote_uids`,
              JSON.stringify(merged),
              { ex: 3600 },
            );
            console.log(
              `[invite-agent] Updated remoteUids for agent ${cachedAgentId}:`,
              merged,
            );
          } catch (updateErr) {
            // Non-fatal: agent may not support update or may have already ended.
            // Log but still return success so the client can proceed.
            console.warn('[invite-agent] Failed to update remoteUids:', updateErr);
          }
        } else {
          console.log(
            `[invite-agent] Reusing active agent ${cachedAgentId} for channel ${channel_name} (no new UIDs)`,
          );
        }

        return NextResponse.json({
          agent_id: cachedAgentId,
          create_ts: Math.floor(Date.now() / 1000),
          state: 'RUNNING',
        } as AgentResponse);
      }
    } catch {
      // Redis optional, continue
    }

    // remoteUids: pass all participant UIDs so the agent hears everyone in the room.
    // This enables real multi-party contradiction detection between different speakers.
    const session = agent.createSession({
      channel: channel_name,
      agentUid,
      remoteUids: remoteUidList,
      idleTimeout: 30,
      expiresIn: ExpiresIn.hours(1),
      debug: false, // enable debug to show restful API calls in the console
    });

    let agentId = '';
    try {
      agentId = await session.start();
      try {
        const { redis } = await import('@/lib/redis');
        await Promise.all([
          redis.set(`channel:${channel_name}:agent_id`, agentId, { ex: 3600 }),
          // Persist the initial remoteUids so we can merge correctly on subsequent joins.
          redis.set(
            `channel:${channel_name}:remote_uids`,
            JSON.stringify(remoteUidList),
            { ex: 3600 },
          ),
        ]);
      } catch {}
    } catch (startErr) {
      const errMessage = String(startErr).toLowerCase();
      if (
        errMessage.includes('already') ||
        errMessage.includes('running') ||
        errMessage.includes('conflict') ||
        errMessage.includes('exist')
      ) {
        console.warn(`[invite-agent] Agent already active in channel ${channel_name}, joining seamlessly.`);
        return NextResponse.json({
          agent_id: `active-${channel_name}`,
          create_ts: Math.floor(Date.now() / 1000),
          state: 'RUNNING',
        } as AgentResponse);
      }
      throw startErr;
    }

    return NextResponse.json({
      agent_id: agentId,
      create_ts: Math.floor(Date.now() / 1000),
      state: 'RUNNING',
    } as AgentResponse);
  } catch (error) {
    console.error('Error starting conversation:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to start conversation',
      },
      { status: 500 },
    );
  }
}
