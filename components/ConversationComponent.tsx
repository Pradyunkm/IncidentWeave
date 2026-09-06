'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import AgoraRTC, {
  useRTCClient,
  useLocalMicrophoneTrack,
  useRemoteUsers,
  useRemoteAudioTracks,
  useClientEvent,
  useJoin,
  usePublish,
  UID,
} from 'agora-rtc-react';
import {
  AgoraVoiceAI,
  AgoraVoiceAIEvents,
  AgentState,
  MessageSalStatus,
  TranscriptHelperMode,
  TurnStatus,
  type TranscriptHelperItem,
  type UserTranscription,
  type AgentTranscription,
} from 'agora-agent-client-toolkit';
import { AgentVisualizer } from './AgentVisualizer';
// MicButtonWithVisualizer replaced with native NativeMicButton below (agora-agent-uikit causes SSR crashes)
import { DEFAULT_AGENT_UID } from '@/lib/agora';
import {
  getCurrentInProgressMessage,
  getMessageList,
  mapAgentVisualizerState,
  normalizeTimestampMs,
  normalizeTranscript,
  normalizeTranscriptSpacing,
  type IMessageListItem,
} from '@/lib/conversation';
import { MicrophoneSelector } from './MicrophoneSelector';
import {
  getConversationIssueSeverity,
  type ConnectionIssue,
} from './ConversationErrorCard';
import { ConnectionStatusPanel } from './ConnectionStatusPanel';
import { QuickstartConversationLayout } from './QuickstartConversationLayout';
import {
  QuickstartPipelineMetrics,
  type QuickstartAgentMetric,
} from './QuickstartPipelineMetrics';
import { QuickstartTranscriptPanel } from './QuickstartTranscriptPanel';
import { MeetingChat } from './MeetingChat';
import { MeetingRecorder } from './MeetingRecorder';
import { MeetingInviteModal } from './MeetingInviteModal';
import type { ConversationComponentProps } from '@/types/conversation';

// Cap the displayed issues list to avoid overwhelming the UI during a cascade of errors.
const MAX_CONNECTION_ISSUES = 6;

const RTM_TRANSCRIPT_TYPE = 'incidentweave_transcript';

type AgoraRtcWithParameters = typeof AgoraRTC & {
  setParameter?: (key: string, value: unknown) => void;
};

// Payload shape for signaling-level errors forwarded by the agent over RTM.
// The `module` field identifies which backend subsystem (LLM / ASR / TTS) raised the error.
type RtmMessageErrorPayload = {
  object: 'message.error';
  module?: string;
  code?: number;
  message?: string;
  send_ts?: number;
};

// Payload shape for SAL (Session Abstraction Layer) registration status messages.
// VP_REGISTER_FAIL and VP_REGISTER_DUPLICATE indicate RTM channel subscription problems.
type RtmSalStatusPayload = {
  object: 'message.sal_status';
  status?: string;
  timestamp?: number;
};

// Type guard for RTM signaling-level error payloads (object: 'message.error').
function isRtmMessageErrorPayload(
  value: unknown,
): value is RtmMessageErrorPayload {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { object?: unknown }).object === 'message.error'
  );
}

// Type guard for RTM SAL status payloads (object: 'message.sal_status').
function isRtmSalStatusPayload(value: unknown): value is RtmSalStatusPayload {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { object?: unknown }).object === 'message.sal_status'
  );
}

export default function ConversationComponent({
  agoraData,
  rtmClient,
  onTokenWillExpire,
  onEndConversation,
  recorderStopRef,
}: ConversationComponentProps) {
  const client = useRTCClient();
  const remoteUsers = useRemoteUsers();

  // Subscribe to and auto-play all remote audio tracks (includes AI agent + human participants).
  // useRemoteAudioTracks handles both subscription and playback — replacing manual track.play() calls
  // which failed when tracks weren't yet subscribed.
  const { audioTracks: remoteAudioTracks } = useRemoteAudioTracks(remoteUsers);
  useEffect(() => {
    remoteAudioTracks.forEach((track) => {
      if (!track.isPlaying) {
        track.play();
      }
    });
  }, [remoteAudioTracks]);

  const [isEnabled, setIsEnabled] = useState(true);
  const [isAgentConnected, setIsAgentConnected] = useState(false);
  const [isConnectionDetailsOpen, setIsConnectionDetailsOpen] = useState(false);

  // Tracks granular RTC connection state for the status dot.
  // Agora states: DISCONNECTED | CONNECTING | CONNECTED | DISCONNECTING | RECONNECTING
  const [connectionState, setConnectionState] = useState<string>('CONNECTING');
  const agentUID = String(DEFAULT_AGENT_UID);
  const [joinedUID, setJoinedUID] = useState<UID>(0);

  // Meeting features state: chat panel, participants panel, invite modal, and live room roster
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isParticipantsOpen, setIsParticipantsOpen] = useState(false);
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [roster, setRoster] = useState<Record<string, { uid: string; name: string; role: string }>>({});

  // Transcript + agent state — managed with AgoraVoiceAI (see effect below).
  const [rawTranscript, setRawTranscript] = useState<
    TranscriptHelperItem<Partial<UserTranscription | AgentTranscription>>[]
  >([]);
  const [agentState, setAgentState] = useState<AgentState | null>(null);
  const [agentMetrics, setAgentMetrics] = useState<QuickstartAgentMetric[]>([]);

  // Shared common transcript turns from remote participants + hydrated from Redis
  const [sharedTranscripts, setSharedTranscripts] = useState<Record<string, IMessageListItem>>({});
  const savedTranscriptTurnIds = useRef<Set<string>>(new Set());
  const lastBroadcastTurnRef = useRef<Record<string, string>>({});

  // Tracks turn IDs already submitted to /api/incident/claim to prevent duplicate POSTs.
  const processedTurnIds = useRef<Set<string>>(new Set());
  const [connectionIssues, setConnectionIssues] = useState<ConnectionIssue[]>(
    [],
  );
  const addConnectionIssue = useCallback((issue: ConnectionIssue) => {
    setConnectionIssues((prev) => {
      const isDuplicate = prev.some(
        (x) =>
          x.agentUserId === issue.agentUserId &&
          x.code === issue.code &&
          x.message === issue.message &&
          Math.abs(x.timestamp - issue.timestamp) < 1500,
      );
      if (isDuplicate) return prev;
      return [issue, ...prev].slice(0, MAX_CONNECTION_ISSUES);
    });
  }, []);

  // Auto-open details panel as soon as a new issue is recorded.
  useEffect(() => {
    if (connectionIssues.length > 0) {
      setIsConnectionDetailsOpen(true);
    }
  }, [connectionIssues.length]);

  // StrictMode guard: delay `useJoin`'s ready flag until after the fake-unmount
  // cycle completes. React StrictMode fires cleanup synchronously before any
  // setTimeout callback, so the first (fake) mount's timeout is always cancelled.
  // Only the real second mount's timeout fires, meaning useJoin joins exactly once.
  const [isReady, setIsReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(() => {
      if (!cancelled) setIsReady(true);
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(id);
      setIsReady(false);
    };
  }, []);

  const { isConnected: joinSuccess } = useJoin(
    {
      appid: (process.env.NEXT_PUBLIC_AGORA_APP_ID || '').trim().replace(/[\r\n]/g, '').replace(/\\r|\\n/g, ''),
      channel: agoraData.channel,
      token: agoraData.token,
      uid: parseInt(agoraData.uid, 10),
    },
    isReady,
  );

  // Create mic track only after the StrictMode fake-unmount cycle completes (isReady).
  // Passing `true` here creates two tracks in StrictMode — the first publishes, then
  // StrictMode cleanup closes it and the second takes over, causing a ~3s audio gap.
  // isReady uses the same setTimeout(fn,0) pattern as useJoin: StrictMode cleanup fires
  // synchronously before the timeout, so only the real second mount's timer fires.
  // Do NOT pass `isEnabled` — that ties track lifetime to mute state and breaks the Web Audio
  // graph inside MicButtonWithVisualizer. Mute uses track.setEnabled() only.
  const { localMicrophoneTrack } = useLocalMicrophoneTrack(isReady);

  // ENABLE_AUDIO_PTS is a module-level SDK parameter (not on the client instance).
  // It must be set before publishing audio for transcript timing to be accurate.
  useEffect(() => {
    if (!client) return;
    try {
      (AgoraRTC as AgoraRtcWithParameters).setParameter?.(
        'ENABLE_AUDIO_PTS',
        true,
      );
    } catch (error) {
      console.warn('Could not set ENABLE_AUDIO_PTS:', error);
    }
  }, [client]);

  // Track the auto-assigned RTC UID for token renewal and agent invite.
  useEffect(() => {
    if (joinSuccess && client) {
      const uid = client.uid;
      if (uid !== null && uid !== undefined) {
        setJoinedUID(uid);
      }
    }
  }, [joinSuccess, client]);

  // Initialize AgoraVoiceAI once the channel is joined.
  //
  // Gating on `isReady && joinSuccess` is critical for StrictMode safety:
  //   - `isReady` ensures we are past the initial fake-unmount cycle, so this
  //     effect only runs on the real mount (not the discarded fake one).
  //   - Once `isReady` is true, React does NOT double-invoke this effect for
  //     subsequent state changes (`joinSuccess` becoming true). That means
  //     AgoraVoiceAI.init() is called exactly once.
  useEffect(() => {
    if (!isReady || !joinSuccess) return;

    let cancelled = false;

    (async () => {
      try {
        const ai = await AgoraVoiceAI.init({
          rtcEngine: client,
          rtmConfig: { rtmEngine: rtmClient },
          renderMode: TranscriptHelperMode.TEXT,
          enableLog: true,
        });

        if (cancelled) {
          try {
            if (AgoraVoiceAI.getInstance() === ai) {
              // Tear down only the instance created by this effect run.
              ai.unsubscribe();
              ai.destroy();
            }
          } catch {}
          return;
        }

        ai.on(AgoraVoiceAIEvents.TRANSCRIPT_UPDATED, (t) => {
          setRawTranscript([...t]);
        });
        // Agent state drives the visualizer, independent of RTC audio presence.
        ai.on(AgoraVoiceAIEvents.AGENT_STATE_CHANGED, (_, event) =>
          setAgentState(event.state),
        );
        ai.on(AgoraVoiceAIEvents.AGENT_METRICS, (_, metrics) => {
          setAgentMetrics((prev) => [...prev, metrics].slice(-8));
        });
        ai.on(AgoraVoiceAIEvents.MESSAGE_ERROR, (agentUserId, error) => {
          addConnectionIssue({
            id: `${Date.now()}-${agentUserId}-message-error-${error.code}`,
            source: 'rtm',
            agentUserId,
            code: error.code,
            message: error.message,
            timestamp: normalizeTimestampMs(error.timestamp),
          });
        });
        // SAL status: capture raw RTM messages so message.sal_status surfaces even if higher-level events don't.
        ai.on(
          AgoraVoiceAIEvents.MESSAGE_SAL_STATUS,
          (agentUserId, salStatus) => {
            if (
              salStatus.status === MessageSalStatus.VP_REGISTER_FAIL ||
              salStatus.status === MessageSalStatus.VP_REGISTER_DUPLICATE
            ) {
              addConnectionIssue({
                id: `${Date.now()}-${agentUserId}-sal-${salStatus.status}`,
                source: 'rtm',
                agentUserId,
                code: salStatus.status,
                message: `SAL status: ${salStatus.status}`,
                timestamp: normalizeTimestampMs(salStatus.timestamp),
              });
            }
          },
        );
        // Agent error: capture raw RTM messages so message.error surfaces even if higher-level events don't.
        ai.on(AgoraVoiceAIEvents.AGENT_ERROR, (agentUserId, error) => {
          addConnectionIssue({
            id: `${Date.now()}-${agentUserId}-agent-error-${error.code}`,
            source: 'agent',
            agentUserId,
            code: error.code,
            message: `${error.type}: ${error.message}`,
            timestamp: normalizeTimestampMs(error.timestamp),
          });
        });
        // subscribeMessage binds the toolkit to both RTC stream messages and RTM payloads.
        ai.subscribeMessage(agoraData.channel);
      } catch (error) {
        if (!cancelled) {
          console.error('[AgoraVoiceAI] init failed:', error);
        }
      }
    })();

    return () => {
      cancelled = true;
      try {
        const ai = AgoraVoiceAI.getInstance();
        if (ai) {
          ai.unsubscribe();
          ai.destroy();
        }
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, joinSuccess]);

  // Raw RTM parsing is kept as a fallback for signaling-level errors and SAL status.
  useEffect(() => {
    const handleRtmMessage = (event: {
      message: string | Uint8Array;
      publisher: string;
    }) => {
      const payloadText =
        typeof event.message === 'string'
          ? event.message
          : new TextDecoder().decode(event.message);

      let parsed: unknown;
      try {
        parsed = JSON.parse(payloadText);
      } catch {
        return;
      }

      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { type?: string }).type === RTM_TRANSCRIPT_TYPE
      ) {
        const item = parsed as {
          turn_id: string | number;
          uid: string;
          speakerName?: string;
          speakerRole?: string;
          text?: string;
          status?: unknown;
          createdAt?: number;
          isAgent?: boolean;
        };

        if (String(item.uid) !== String(client.uid)) {
          setSharedTranscripts((prev) => ({
            ...prev,
            [String(item.turn_id)]: {
              turn_id: item.turn_id,
              uid: item.uid,
              speakerName: item.speakerName,
              speakerRole: item.speakerRole,
              text: item.text,
              status: item.status,
              createdAt: item.createdAt,
              isAgent: Boolean(item.isAgent),
            },
          }));
        }
        return;
      }

      if (isRtmMessageErrorPayload(parsed)) {
        const p = parsed;
        addConnectionIssue({
          id: `${Date.now()}-${event.publisher}-rtm-msg-error-${p.code ?? 'unknown'}`,
          source: 'rtm-signaling',
          agentUserId: event.publisher,
          code: p.code ?? 'unknown',
          message: `${p.module ?? 'unknown'}: ${p.message ?? 'Unknown signaling error'}`,
          timestamp: normalizeTimestampMs(p.send_ts ?? Date.now()),
        });
        return;
      }

      if (isRtmSalStatusPayload(parsed)) {
        const p = parsed;
        if (
          p.status === 'VP_REGISTER_FAIL' ||
          p.status === 'VP_REGISTER_DUPLICATE'
        ) {
          addConnectionIssue({
            id: `${Date.now()}-${event.publisher}-rtm-sal-${p.status}`,
            source: 'rtm-signaling',
            agentUserId: event.publisher,
            code: p.status,
            message: `SAL status: ${p.status}`,
            timestamp: normalizeTimestampMs(p.timestamp ?? Date.now()),
          });
        }
      }
    };

    rtmClient.addEventListener('message', handleRtmMessage);
    return () => {
      rtmClient.removeEventListener('message', handleRtmMessage);
    };
  }, [rtmClient, addConnectionIssue, client?.uid]);

  // Parse ALL JSON claim blocks from an agent turn's text response.
  // Extracts every object containing a "type" key and validates it.
  // Returns the first valid claim, or an unknown-type fallback if none parse.
  function parseClaimFromAgentResponse(text: string): Record<string, unknown> | null {
    const VALID_TYPES = new Set(['fact', 'hypothesis', 'contradictory', 'action', 'unknown'])

    // Match all top-level JSON object blocks (handles both raw JSON and ```json fenced blocks)
    const patterns = [
      /\{[^{}]*"type"\s*:\s*"[^"]*"[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g,
      /```(?:json)?\s*([\s\S]*?)```/g,
    ]

    const candidates: string[] = []

    // 1. Try extracting from fenced code blocks first
    const fenced = text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)
    for (const m of fenced) {
      const inner = m[1]?.trim()
      if (inner) candidates.push(inner)
    }

    // 2. Also try raw JSON objects anywhere in the text
    const rawMatches = text.matchAll(/\{[\s\S]*?"type"\s*:\s*"[^"]*"[\s\S]*?\}/g)
    for (const m of rawMatches) {
      candidates.push(m[0])
    }

    for (const raw of candidates) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        if (typeof parsed === 'object' && parsed !== null) {
          const claimType = parsed.type as string
          // Validate type against known values; default to 'unknown' if unrecognized
          if (!VALID_TYPES.has(claimType)) {
            parsed.type = 'unknown'
          }
          // Must have a claim string
          if (typeof parsed.claim !== 'string' || !parsed.claim.trim()) {
            continue
          }
          return parsed
        }
      } catch {
        // Not valid JSON, try next candidate
      }
    }
    return null
  }

  // Walk backwards through the transcript to find the last human speaker before
  // the given agent turn index. Returns the Agora UID string, or null if none found.
  function findLastHumanUid(
    transcript: typeof rawTranscript,
    beforeIndex: number,
  ): string | null {
    for (let i = beforeIndex - 1; i >= 0; i--) {
      const uid = transcript[i].uid;
      if (uid && String(uid) !== agentUID && String(uid) !== String(DEFAULT_AGENT_UID)) {
        return String(uid);
      }
    }
    return null;
  }

  const incidentId = agoraData.incidentId ?? 'demo-001';

  // Register self into room roster when joined
  useEffect(() => {
    if (joinSuccess && agoraData.uid) {
      fetch('/api/incident/roster', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incidentId,
          uid: String(agoraData.uid),
          name: agoraData.participantName || `User-${agoraData.uid}`,
          role: agoraData.participantRole || 'Engineer',
        }),
      }).catch(() => {});
    }
  }, [joinSuccess, incidentId, agoraData]);

  // Keep live roster in sync for meeting chat and DMs
  useEffect(() => {
    let mounted = true;
    const updateRoster = () => {
      fetch(`/api/incident/state?id=${encodeURIComponent(incidentId)}`)
        .then((r) => r.json())
        .then((data) => {
          if (mounted && data.roster) {
            setRoster(data.roster);
          }
        })
        .catch(() => {});
    };

    updateRoster();
    const interval = setInterval(updateRoster, 3500);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [incidentId]);

  // When a new agent turn completes (END or INTERRUPTED), attempt to parse a claim
  // from the turn text and POST it to /api/incident/claim. Each turn is processed
  // at most once, tracked by turn_id via processedTurnIds ref.
  useEffect(() => {
    rawTranscript.forEach((item, idx) => {
      // Only process completed agent turns (agent uid is the agentUID, not local user).
      const isCompleted =
        item.status === TurnStatus.END || item.status === TurnStatus.INTERRUPTED;
      const isAgentTurn = String(item.uid) === agentUID || String(item.uid) === String(DEFAULT_AGENT_UID);
      if (!isCompleted || !isAgentTurn) return;
      if (processedTurnIds.current.has(String(item.turn_id))) return;

      processedTurnIds.current.add(String(item.turn_id));

      const text = typeof item.text === 'string' ? item.text : '';
      console.log('[IncidentWeave] Agent raw text:', text);
      const claim = parseClaimFromAgentResponse(text);
      console.log('[IncidentWeave] Parsed claim:', claim);
      if (!claim) return;

      // Attach the real Agora UID of the last human who spoke before this agent turn.
      // This gives us ground-truth speaker attribution regardless of what the LLM guessed.
      const speakerUid = findLastHumanUid(rawTranscript, idx);
      const enrichedClaim = { ...claim, speakerUid };

      // Fire-and-forget — errors are logged but never surface to the UI.
      fetch('/api/incident/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ incidentId, claim: enrichedClaim }),
      }).then(() => {
        console.log('[IncidentWeave] Claim posted:', enrichedClaim);
      }).catch((err) => {
        console.error('[incident/claim] POST failed:', err);
      });
    });
  }, [rawTranscript, agentUID, incidentId]);

  // Hydrate room transcript history from Redis on mount/room join
  useEffect(() => {
    let mounted = true;
    fetch(`/api/incident/transcript?id=${encodeURIComponent(incidentId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (mounted && Array.isArray(data.transcripts)) {
          setSharedTranscripts((prev) => {
            const next = { ...prev };
            for (const item of data.transcripts) {
              const id = String(item.turn_id);
              if (!next[id]) {
                next[id] = item;
              }
            }
            return next;
          });
        }
      })
      .catch((err) => console.warn('[incident/transcript] load failed:', err));
    return () => {
      mounted = false;
    };
  }, [incidentId]);

  // Synchronize local voice turns to all meeting participants over RTM,
  // and persist completed turns (both human and agent) to Redis.
  useEffect(() => {
    if (!rtmClient || !client?.uid) return;

    rawTranscript.forEach((item) => {
      const isLocal =
        item.uid === '0' || String(item.uid) === String(client.uid);
      const isAgentTurn =
        String(item.uid) === agentUID || String(item.uid) === String(DEFAULT_AGENT_UID);

      const turnIdStr = String(item.turn_id);
      const text = typeof item.text === 'string' ? item.text.trim() : '';
      if (!text) return;

      if (isLocal) {
        // Broadcast local speaker's turn to all participants in the room
        const turnKey = `${turnIdStr}_${item.status}_${text}`;
        if (lastBroadcastTurnRef.current[turnIdStr] !== turnKey) {
          lastBroadcastTurnRef.current[turnIdStr] = turnKey;

          const payload = JSON.stringify({
            type: RTM_TRANSCRIPT_TYPE,
            turn_id: item.turn_id,
            uid: String(client.uid),
            speakerName: agoraData.participantName || `User ${client.uid}`,
            speakerRole: agoraData.participantRole || 'Engineer',
            text: normalizeTranscriptSpacing(text),
            status: item.status,
            createdAt: normalizeTimestampMs(item._time || Date.now()),
            isAgent: false,
          });

          rtmClient.publish(agoraData.channel, payload).catch(() => {});
        }

        // When local turn completes or is interrupted, save to Redis
        if (
          (item.status === TurnStatus.END || item.status === TurnStatus.INTERRUPTED) &&
          !savedTranscriptTurnIds.current.has(turnIdStr)
        ) {
          savedTranscriptTurnIds.current.add(turnIdStr);
          fetch('/api/incident/transcript', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              incidentId,
              item: {
                turn_id: item.turn_id,
                uid: String(client.uid),
                speakerName: agoraData.participantName || `User ${client.uid}`,
                speakerRole: agoraData.participantRole || 'Engineer',
                text: normalizeTranscriptSpacing(text),
                status: item.status,
                createdAt: normalizeTimestampMs(item._time || Date.now()),
                isAgent: false,
              },
            }),
          }).catch(() => {});
        }
      } else if (isAgentTurn) {
        // When AI agent turn completes, persist it to Redis for late joiners
        if (
          (item.status === TurnStatus.END || item.status === TurnStatus.INTERRUPTED) &&
          !savedTranscriptTurnIds.current.has(turnIdStr)
        ) {
          savedTranscriptTurnIds.current.add(turnIdStr);
          fetch('/api/incident/transcript', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              incidentId,
              item: {
                turn_id: item.turn_id,
                uid: agentUID,
                speakerName: 'IncidentWeave AI',
                speakerRole: 'AI Incident Commander',
                text: normalizeTranscriptSpacing(text),
                status: item.status,
                createdAt: normalizeTimestampMs(item._time || Date.now()),
                isAgent: true,
              },
            }),
          }).catch(() => {});
        }
      }
    });
  }, [rawTranscript, agoraData, client?.uid, rtmClient, incidentId, agentUID]);

  // The toolkit uses uid="0" for local user speech — remap to actual RTC UID
  // so the transcript panel renders user messages on the correct side.
  // Also normalize punctuation spacing for display when upstream text arrives compacted.
  const transcript = useMemo(() => {
    return normalizeTranscript(rawTranscript, String(client.uid));
  }, [rawTranscript, client.uid]);

  // Unified participant list ensuring local user entered name & role are present
  // alongside all registered room participants and remote RTC users.
  const participantList = useMemo(() => {
    const map: Record<string, { uid: string; name: string; role: string }> = { ...roster };
    if (agoraData.uid) {
      const selfUid = String(agoraData.uid);
      map[selfUid] = {
        uid: selfUid,
        name: agoraData.participantName || map[selfUid]?.name || `User ${selfUid}`,
        role: agoraData.participantRole || map[selfUid]?.role || 'Engineer',
      };
    }
    remoteUsers.forEach((u) => {
      const uUid = String(u.uid);
      if (!map[uUid] && uUid !== agentUID && uUid !== String(DEFAULT_AGENT_UID)) {
        map[uUid] = {
          uid: uUid,
          name: `User ${uUid}`,
          role: 'Participant',
        };
      }
    });
    return Object.values(map);
  }, [roster, agoraData, remoteUsers, agentUID]);

  // Unified chronological transcript combining:
  // 1. Local turns (both in-progress and completed from AgoraVoiceAI)
  // 2. Remote human turns received via RTM / hydrated from Redis
  // 3. Agent turns
  const unifiedTranscriptMap = useMemo(() => {
    const map = new Map<string, IMessageListItem>();

    // 1. Seed with shared/remote/hydrated transcripts
    Object.values(sharedTranscripts).forEach((item) => {
      map.set(String(item.turn_id), { ...item });
    });

    // 2. Overlay normalized local turns from AgoraVoiceAI
    // Local turns take precedence for local user turns and agent turns
    transcript.forEach((item) => {
      const turnIdStr = String(item.turn_id);
      const uidStr = String(item.uid);
      const isAgent = uidStr === agentUID || uidStr === String(DEFAULT_AGENT_UID);
      const isLocal = !isAgent && (item.uid === '0' || uidStr === String(client?.uid));

      const existing = map.get(turnIdStr);
      map.set(turnIdStr, {
        turn_id: item.turn_id,
        uid: isLocal ? String(client?.uid) : isAgent ? agentUID : uidStr,
        text: typeof item.text === 'string' ? item.text : '',
        status: item.status,
        createdAt:
          typeof item._time === 'number'
            ? normalizeTimestampMs(item._time)
            : existing?.createdAt || Date.now(),
        speakerName: isAgent
          ? 'IncidentWeave AI'
          : isLocal
            ? (agoraData.participantName || `User ${client?.uid}`)
            : (existing?.speakerName || roster[uidStr]?.name || `User ${uidStr}`),
        speakerRole: isAgent
          ? 'AI Incident Commander'
          : isLocal
            ? (agoraData.participantRole || 'Engineer')
            : (existing?.speakerRole || roster[uidStr]?.role || ''),
        isAgent,
      });
    });

    return map;
  }, [sharedTranscripts, transcript, client?.uid, agentUID, agoraData, roster]);

  // Completed (END + INTERRUPTED) messages shown as history.
  // INTERRUPTED must be included — if the agent's first turn is cut off,
  // messageList stays empty and the first interrupted turn is never shown.
  const messageList = useMemo<IMessageListItem[]>(() => {
    const list: IMessageListItem[] = [];
    unifiedTranscriptMap.forEach((item) => {
      if (item.status !== TurnStatus.IN_PROGRESS && item.text?.trim()) {
        list.push(item);
      }
    });
    // Sort strictly chronologically
    return list.sort((a, b) => {
      const timeA = a.createdAt ?? 0;
      const timeB = b.createdAt ?? 0;
      if (timeA !== timeB) return timeA - timeB;
      return String(a.turn_id).localeCompare(String(b.turn_id));
    });
  }, [unifiedTranscriptMap]);

  const currentInProgressMessage = useMemo<IMessageListItem | null>(() => {
    // The live partial turn renders separately from the completed history list.
    let activeItem: IMessageListItem | null = null;
    unifiedTranscriptMap.forEach((item) => {
      if (item.status === TurnStatus.IN_PROGRESS && item.text?.trim()) {
        if (!activeItem || (item.createdAt ?? 0) >= (activeItem.createdAt ?? 0)) {
          activeItem = item;
        }
      }
    });
    return activeItem;
  }, [unifiedTranscriptMap]);

  // Publish local mic once the track exists; usePublish waits for RTC connection.
  usePublish([localMicrophoneTrack]);

  useClientEvent(client, 'user-joined', (user) => {
    if (user.uid.toString() === agentUID) setIsAgentConnected(true);
    // NOTE: We intentionally do NOT register the remote user's name here — we only know
    // their UID, not their chosen display name. Each participant registers themselves
    // with their real name via the joinSuccess effect and handleStartConversation.
    // Registering with our own name here would cause duplicate/wrong-name entries.
  });

  useClientEvent(client, 'user-left', (user) => {
    if (user.uid.toString() === agentUID) setIsAgentConnected(false);
  });

  // Sync isAgentConnected with remoteUsers (covers cases where user-joined/left are missed)
  useEffect(() => {
    const isAgentInRemoteUsers = remoteUsers.some(
      (user) => user.uid.toString() === agentUID,
    );
    setIsAgentConnected(isAgentInRemoteUsers);
  }, [remoteUsers, agentUID]);

  useClientEvent(client, 'connection-state-change', (curState) => {
    setConnectionState(curState);
  });

  const connectionSeverity = useMemo<'normal' | 'warning' | 'error'>(() => {
    // RTC transport problems take precedence; otherwise derive severity from captured issues.
    if (
      connectionState === 'DISCONNECTED' ||
      connectionState === 'DISCONNECTING'
    ) {
      return 'error';
    }
    if (
      connectionState === 'CONNECTING' ||
      connectionState === 'RECONNECTING'
    ) {
      return 'warning';
    }
    if (connectionIssues.length === 0) {
      return 'normal';
    }
    return connectionIssues.some(
      (issue) => getConversationIssueSeverity(issue) === 'error',
    )
      ? 'error'
      : 'warning';
  }, [connectionState, connectionIssues]);

  const visualizerState = useMemo(
    () =>
      mapAgentVisualizerState(agentState, isAgentConnected, connectionState),
    [agentState, isAgentConnected, connectionState],
  );

  /**
   * Mute/unmute via track.setEnabled() only — usePublish owns publish state.
   * If we also unpublish in the toggle, usePublish and the button fight each other
   * and break the MicButtonWithVisualizer Web Audio graph.
   */
  const handleMicToggle = useCallback(async () => {
    const next = !isEnabled;
    const track = localMicrophoneTrack;
    if (!track) {
      setIsEnabled(next);
      return;
    }
    try {
      await track.setEnabled(next);
      setIsEnabled(next);
    } catch (error) {
      console.error('Failed to toggle microphone:', error);
    }
  }, [isEnabled, localMicrophoneTrack]);

  const handleTokenWillExpire = useCallback(async () => {
    if (!onTokenWillExpire || !joinedUID) return;
    try {
      // RTC and RTM renew independently, but the quickstart fetches both in one request.
      const { rtcToken, rtmToken } = await onTokenWillExpire(
        joinedUID.toString(),
      );
      await client?.renewToken(rtcToken);
      await rtmClient.renewToken(rtmToken);
    } catch (error) {
      console.error('Failed to renew Agora token:', error);
    }
  }, [client, onTokenWillExpire, joinedUID, rtmClient]);

  useClientEvent(client, 'token-privilege-will-expire', handleTokenWillExpire);

  const handleEndConversation = useCallback(async () => {
    onEndConversation();
  }, [onEndConversation]);

  return (
    <>
      <QuickstartConversationLayout
        participantName={agoraData.participantName}
        participantRole={agoraData.participantRole}
        headerActions={
          <div className="flex items-center gap-2">
            {/* Invite Teammates / Share Room */}
            <button
              onClick={() => setIsInviteOpen(true)}
              className="flex items-center gap-1.5 rounded-lg border border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/20 px-2.5 py-1.5 text-xs font-semibold text-blue-400 transition-colors shadow-sm"
              title="Invite teammates to this incident room"
              aria-label="Invite teammates"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
              </svg>
              <span>Invite</span>
            </button>

            {/* Audio Meeting Recorder */}
            <MeetingRecorder
              localMicrophoneTrack={localMicrophoneTrack}
              remoteUsers={remoteUsers}
              incidentId={incidentId}
              onStopRef={recorderStopRef}
            />

            {/* Participants Panel Toggle */}
            <button
              onClick={() => {
                setIsParticipantsOpen((open) => !open);
                if (isChatOpen) setIsChatOpen(false);
              }}
              className={`relative flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                isParticipantsOpen
                  ? 'border-emerald-500 bg-emerald-600 text-white'
                  : 'border-white/10 bg-white/5 hover:bg-white/10 text-white/80'
              }`}
              title="Toggle participants list"
              aria-label="Toggle participants list"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <span>People</span>
              {/* Live participant count badge: roster entries + AI agent */}
              <span className={`ml-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-bold ${
                isParticipantsOpen ? 'bg-white/20 text-white' : 'bg-emerald-500/20 text-emerald-400'
              }`}>
                {participantList.length + 1 /* +1 for AI agent */}
              </span>
            </button>

            {/* Chat Panel Toggle */}
            <button
              onClick={() => {
                setIsChatOpen((open) => !open);
                if (isParticipantsOpen) setIsParticipantsOpen(false);
              }}
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                isChatOpen
                  ? 'border-blue-500 bg-blue-600 text-white'
                  : 'border-white/10 bg-white/5 hover:bg-white/10 text-white/80'
              }`}
              title="Toggle meeting chat panel"
              aria-label="Toggle chat panel"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <span>Chat</span>
            </button>
          </div>
        }
        statusPanel={
          <ConnectionStatusPanel
            connectionState={connectionState}
            connectionSeverity={connectionSeverity}
            connectionIssues={connectionIssues}
            isOpen={isConnectionDetailsOpen}
            onToggle={() => setIsConnectionDetailsOpen((open) => !open)}
          />
        }
        pipelineMetrics={<QuickstartPipelineMetrics metrics={agentMetrics} />}
        transcriptPanel={
          <QuickstartTranscriptPanel
            messageList={messageList}
            currentInProgressMessage={currentInProgressMessage}
            agentUID={agentUID}
            localUID={String(client.uid)}
            roster={roster}
            currentUserName={agoraData.participantName}
          />
        }
        visualizer={
          <div
            className="relative flex h-full min-h-[20rem] w-full max-w-4xl items-center justify-center"
            role="region"
            aria-label="AI agent status visualization"
          >
            <AgentVisualizer state={visualizerState} size="lg" />
            {/* Open Dashboard button — floats in top-right of visualizer area */}
            <a
              href={`/dashboard?id=${encodeURIComponent(incidentId)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="absolute top-3 right-3 flex items-center gap-1.5 rounded-lg border border-blue-500/40 bg-blue-500/10 px-3 py-1.5 text-xs font-semibold text-blue-400 backdrop-blur-sm transition-all hover:bg-blue-500/20 hover:border-blue-400"
              aria-label="Open incident dashboard in new tab"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
              Open Dashboard
            </a>
          </div>
        }
        controls={
          <div
            className="mx-auto flex w-fit items-center gap-3 rounded-full border border-border bg-card/80 px-4 py-2 backdrop-blur-md"
            role="group"
            aria-label="Audio controls"
          >
            <div className="conversation-mic-host flex items-center justify-center">
              <button
                id="mic-toggle-btn"
                onClick={handleMicToggle}
                aria-label={isEnabled ? 'Mute microphone' : 'Unmute microphone'}
                title={isEnabled ? 'Mute microphone' : 'Unmute microphone'}
                className={`relative flex items-center justify-center w-12 h-12 rounded-full border-2 transition-all duration-200 shadow-lg focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                  isEnabled
                    ? 'border-primary bg-primary/10 hover:bg-primary/20 text-primary focus:ring-primary'
                    : 'border-destructive bg-destructive/10 hover:bg-destructive/20 text-destructive focus:ring-destructive'
                }`}
              >
                {isEnabled ? (
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="1" y1="1" x2="23" y2="23" />
                    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                  </svg>
                )}
              </button>
            </div>
            <MicrophoneSelector localMicrophoneTrack={localMicrophoneTrack} />
          </div>
        }
        chatPanel={
          <MeetingChat
            rtmClient={rtmClient}
            channelName={agoraData.channel}
            myUid={agoraData.uid}
            myName={agoraData.participantName ?? 'Participant'}
            myRole={agoraData.participantRole ?? 'Engineer'}
            incidentId={incidentId}
            roster={roster}
          />
        }
        isChatOpen={isChatOpen}
        isParticipantsOpen={isParticipantsOpen}
        participantsPanel={
          <section className="flex h-full flex-col overflow-hidden" aria-label="Participants">
            {/* Header */}
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Participants</h2>
                <p className="text-xs text-muted-foreground">
                  {participantList.length + 1} in this room
                </p>
              </div>
              <button
                onClick={() => setIsParticipantsOpen(false)}
                className="rounded-md p-1.5 text-white/40 hover:bg-white/10 hover:text-white/80 transition-colors"
                aria-label="Close participants panel"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Participant list */}
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5">
              {/* AI Agent entry */}
              <div className="flex items-center gap-3 rounded-xl px-3 py-2.5 bg-violet-500/8 border border-violet-500/15">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 text-[11px] font-bold text-white shadow-sm">
                  AI
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-semibold text-violet-300">IncidentWeave AI</span>
                  <span className="text-[10px] text-violet-400/70 font-medium">Voice Agent</span>
                </div>
                <span className={`flex h-5 items-center gap-1 rounded-full px-2 text-[10px] font-semibold ${
                  isAgentConnected
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : 'bg-white/5 text-white/30'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    isAgentConnected ? 'bg-emerald-400 animate-pulse' : 'bg-white/20'
                  }`} />
                  {isAgentConnected ? 'Active' : 'Standby'}
                </span>
              </div>

              {/* Human participants with Name, UID, and Role */}
              {participantList.map((participant) => {
                const isSelf = participant.uid === String(agoraData.uid);
                const initials = (participant.name || '')
                  .split(' ')
                  .filter(Boolean)
                  .map((w: string) => w[0])
                  .join('')
                  .toUpperCase()
                  .slice(0, 2) || (isSelf ? 'ME' : 'U');
                const isRemoteActive = remoteUsers.some((u) => String(u.uid) === participant.uid);
                const isLive = isSelf || isRemoteActive;
                return (
                  <div
                    key={participant.uid}
                    className="flex items-center gap-3 rounded-xl px-3 py-2.5 bg-white/3 border border-white/8 hover:bg-white/5 transition-colors"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-violet-600 text-[11px] font-bold text-white shadow-sm">
                      {initials}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="flex items-center gap-1.5 truncate">
                        <span className="truncate text-sm font-semibold text-white">
                          {participant.name || `User ${participant.uid}`}
                        </span>
                        {isSelf && (
                          <span className="text-[10px] font-medium text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 rounded px-1.5 py-0.2">
                            you
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] text-white/45 font-medium mt-0.5">
                        <span className="text-cyan-400/80 font-mono">UID: {participant.uid}</span>
                        <span>•</span>
                        <span>{participant.role || 'Participant'}</span>
                      </div>
                    </div>
                    <span className={`flex h-5 items-center gap-1 rounded-full px-2 text-[10px] font-semibold ${
                      isLive ? 'bg-emerald-500/15 text-emerald-400' : 'bg-white/5 text-white/30'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        isLive ? 'bg-emerald-400' : 'bg-white/20'
                      }`} />
                      {isLive ? 'Live' : 'Away'}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Footer */}
            <div className="shrink-0 border-t border-border px-4 py-3">
              <button
                onClick={() => setIsInviteOpen(true)}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/20 px-3 py-2 text-xs font-semibold text-blue-400 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
                </svg>
                Invite More People
              </button>
            </div>
          </section>
        }
        onEndConversation={handleEndConversation}
      />

      {/* In-call Invite Teammates Modal */}
      <MeetingInviteModal
        roomId={incidentId}
        isOpen={isInviteOpen}
        onClose={() => setIsInviteOpen(false)}
      />
    </>
  );
}
