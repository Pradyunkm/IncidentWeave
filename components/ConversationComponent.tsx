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
  ChatMessagePriority,
  ChatMessageType,
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
  stripJsonFromText,
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
  const agentUID = String(DEFAULT_AGENT_UID);

  // Separate remote human participants from the AI agent:
  // - Humans: audio always plays at full volume so participants always hear each other.
  // - AI Agent: audio is muted by default (silent observer), and ONLY plays when the user clicks "Ask AI to Speak".
  const humanRemoteUsers = useMemo(
    () =>
      remoteUsers.filter(
        (u) =>
          String(u.uid) !== agentUID &&
          String(u.uid) !== String(DEFAULT_AGENT_UID),
      ),
    [remoteUsers, agentUID],
  );
  const agentRemoteUsers = useMemo(
    () =>
      remoteUsers.filter(
        (u) =>
          String(u.uid) === agentUID ||
          String(u.uid) === String(DEFAULT_AGENT_UID),
      ),
    [remoteUsers, agentUID],
  );

  // Human audio tracks auto-play immediately so all participants hear each other clearly.
  const { audioTracks: humanAudioTracks } = useRemoteAudioTracks(humanRemoteUsers);
  useEffect(() => {
    humanAudioTracks.forEach((track) => {
      track.setVolume(100);
      if (!track.isPlaying) {
        track.play();
      }
    });
  }, [humanAudioTracks]);

  // Incident ID for Redis room history
  const incidentId = agoraData.incidentId ?? 'demo-001';

  // AI Agent audio tracks: strictly silenced until the user clicks the Speak button.
  const [isAgentSpeechAllowed, setIsAgentSpeechAllowed] = useState(false);
  const [isAgentPrompting, setIsAgentPrompting] = useState(false);
  // Master persistent transcript store: retains ALL completed turns (local, remote, agent).
  // Turns are NEVER deleted automatically. They are ONLY deleted when the user clicks "Clear".
  const [accumulatedTurns, setAccumulatedTurns] = useState<Record<string, IMessageListItem>>({});
  const clearedTurnIdsRef = useRef<Set<string>>(new Set());

  const handleClearTranscript = useCallback(() => {
    // Record all existing turn IDs as cleared so late-arriving packets are ignored
    const existingIds = Object.keys(accumulatedTurns);
    clearedTurnIdsRef.current = new Set(existingIds);

    // Empty state
    setAccumulatedTurns({});
    setSharedTranscripts({});
    setRawTranscript([]);

    fetch(`/api/incident/transcript?id=${encodeURIComponent(incidentId)}`, {
      method: 'DELETE',
    }).catch(() => {});
  }, [incidentId, accumulatedTurns]);
  const { audioTracks: agentAudioTracks } = useRemoteAudioTracks(agentRemoteUsers);

  useEffect(() => {
    agentAudioTracks.forEach((track) => {
      if (isAgentSpeechAllowed) {
        track.setVolume(100);
        if (!track.isPlaying) {
          track.play();
        }
      } else {
        track.setVolume(0);
        if (track.isPlaying) {
          track.stop();
        }
      }
    });
  }, [agentAudioTracks, isAgentSpeechAllowed]);

  // Explicit handler to invoke Agora AI agent speech on button click
  const handleTriggerAgentSpeech = useCallback(async () => {
    try {
      setIsAgentPrompting(true);
      setIsAgentSpeechAllowed(true);

      // Unmute and play agent track
      agentAudioTracks.forEach((track) => {
        track.setVolume(100);
        if (!track.isPlaying) {
          track.play();
        }
      });

      // Prompt the Agora Conversational AI agent via RTM to synthesize a spoken update
      const ai = AgoraVoiceAI.getInstance();
      if (ai) {
        await ai.sendText(agentUID, {
          messageType: ChatMessageType.TEXT,
          priority: ChatMessagePriority.INTERRUPTED,
          responseInterruptable: true,
          text: 'IncidentWeave, please give a concise 1-sentence voice update to the incident team on current findings.',
        });
      }
    } catch (err) {
      console.warn('[handleTriggerAgentSpeech] failed:', err);
    } finally {
      setTimeout(() => setIsAgentPrompting(false), 1800);
    }
  }, [agentAudioTracks, agentUID]);

  // Handler to silence and interrupt the AI agent
  const handleStopAgentSpeech = useCallback(() => {
    setIsAgentSpeechAllowed(false);
    agentAudioTracks.forEach((track) => {
      track.setVolume(0);
      if (track.isPlaying) {
        track.stop();
      }
    });
    try {
      AgoraVoiceAI.getInstance()?.interrupt(agentUID);
    } catch {}
  }, [agentAudioTracks, agentUID]);

  // Tracks turn IDs of agent responses that were explicitly activated by the user clicking "Ask AI to Speak".
  // Only activated agent turns are shown in the shared transcript. Silent agent turns are suppressed.
  const activatedAgentTurnIds = useRef<Set<string>>(new Set());

  const [isEnabled, setIsEnabled] = useState(true);
  const [isAgentConnected, setIsAgentConnected] = useState(false);
  const [isConnectionDetailsOpen, setIsConnectionDetailsOpen] = useState(false);

  // Tracks granular RTC connection state for the status dot.
  // Agora states: DISCONNECTED | CONNECTING | CONNECTED | DISCONNECTING | RECONNECTING
  const [connectionState, setConnectionState] = useState<string>('CONNECTING');
  const [joinedUID, setJoinedUID] = useState<UID>(0);

  // Meeting features state: chat panel, participants panel, invite modal, and live room roster
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isParticipantsOpen, setIsParticipantsOpen] = useState(false);
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [roster, setRoster] = useState<Record<string, { uid: string; name: string; role: string }>>({});

  // Audio volume indicator tracking to determine which human participant is actively speaking.
  // - uid 0 (or client.uid): local microphone track
  // - uid > 0: remote participant's UID
  const lastActiveSpeakerRef = useRef<{
    uid: string;
    name: string;
    role: string;
    isLocal: boolean;
    timestamp: number;
  }>({
    uid: String(client?.uid || 0),
    name: agoraData.participantName || '',
    role: agoraData.participantRole || 'Engineer',
    isLocal: true,
    timestamp: 0,
  });

  // Persistent map of turn_id -> SpeakerInfo so each turn retains its speaker identity
  const turnSpeakerMap = useRef<Record<string, {
    uid: string;
    name: string;
    role: string;
    isLocal: boolean;
  }>>({});

  // Active speaker volume indicator listener
  useEffect(() => {
    if (!client) return;
    try {
      client.enableAudioVolumeIndicator();
    } catch (err) {
      console.warn('[enableAudioVolumeIndicator] failed:', err);
    }

    const handleVolumeIndicator = (volumes: Array<{ uid: UID; level: number }>) => {
      let maxLevel = 8;
      let dominantUid: UID | null = null;

      for (const v of volumes) {
        const uidStr = String(v.uid);
        if (uidStr === agentUID || uidStr === String(DEFAULT_AGENT_UID)) continue;
        if (v.level > maxLevel) {
          maxLevel = v.level;
          dominantUid = v.uid;
        }
      }

      if (dominantUid !== null) {
        const isLocalUser = dominantUid === 0 || String(dominantUid) === String(client?.uid);
        const remoteUidStr = String(dominantUid);
        const remoteUser = roster[remoteUidStr];

        lastActiveSpeakerRef.current = {
          uid: isLocalUser ? String(client?.uid) : remoteUidStr,
          name: isLocalUser
            ? (agoraData.participantName || `User ${client?.uid}`)
            : (remoteUser?.name || `User ${remoteUidStr}`),
          role: isLocalUser
            ? (agoraData.participantRole || 'Engineer')
            : (remoteUser?.role || 'Engineer'),
          isLocal: isLocalUser,
          timestamp: Date.now(),
        };
      }
    };

    client.on('volume-indicator', handleVolumeIndicator);
    return () => {
      client.off('volume-indicator', handleVolumeIndicator);
    };
  }, [client, agentUID, agoraData, roster]);

  // Transcript + agent state — managed with AgoraVoiceAI (see effect below).
  const [rawTranscript, setRawTranscript] = useState<
    TranscriptHelperItem<Partial<UserTranscription | AgentTranscription>>[]
  >([]);
  const [agentState, setAgentState] = useState<AgentState | null>(null);
  const [agentMetrics, setAgentMetrics] = useState<QuickstartAgentMetric[]>([]);

  // Record agent turns ONLY while agent voice is actively allowed by clicking Speak.
  // Historical or silent agent turns remain suppressed.
  useEffect(() => {
    if (!isAgentSpeechAllowed) return;
    rawTranscript.forEach((item) => {
      const uidStr = String(item.uid);
      const isAgent = uidStr === agentUID || uidStr === String(DEFAULT_AGENT_UID);
      if (isAgent && item.turn_id !== undefined && item.turn_id !== null) {
        activatedAgentTurnIds.current.add(String(item.turn_id));
      }
    });
  }, [rawTranscript, isAgentSpeechAllowed, agentUID]);

  // When the AI finishes its spoken response, automatically silence audio and return to
  // Silent Observer mode so it NEVER speaks spontaneously without clicking the button.
  useEffect(() => {
    if (!isAgentSpeechAllowed) return;
    if (
      agentState === AgentState.IDLE ||
      agentState === AgentState.LISTENING ||
      agentState === AgentState.SILENT
    ) {
      const timer = setTimeout(() => {
        setIsAgentSpeechAllowed(false);
        agentAudioTracks.forEach((track) => {
          track.setVolume(0);
          if (track.isPlaying) {
            track.stop();
          }
        });
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [agentState, isAgentSpeechAllowed, agentAudioTracks]);

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

        const turnIdStr = String(item.turn_id);
        if (!clearedTurnIdsRef.current.has(turnIdStr)) {
          setAccumulatedTurns((prev) => ({
            ...prev,
            [turnIdStr]: {
              turn_id: item.turn_id,
              uid: item.uid,
              speakerName: item.speakerName,
              speakerRole: item.speakerRole || 'Engineer',
              text: item.text,
              status: item.status,
              createdAt: item.createdAt,
              isAgent: Boolean(item.isAgent),
            },
          }));
        }

        if (String(item.uid) !== String(client.uid)) {
          setSharedTranscripts((prev) => ({
            ...prev,
            [turnIdStr]: {
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
          setAccumulatedTurns((prev) => {
            const next = { ...prev };
            for (const item of data.transcripts) {
              const id = String(item.turn_id);
              if (!clearedTurnIdsRef.current.has(id) && !next[id]) {
                next[id] = item;
              }
            }
            return next;
          });
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

  // Helper to determine speaker attribution for a human turn
  const resolveTurnSpeaker = useCallback(
    (item: TranscriptHelperItem<Partial<UserTranscription | AgentTranscription>>) => {
      const turnIdStr = String(item.turn_id);
      const uidStr = String(item.uid);
      const isAgent = uidStr === agentUID || uidStr === String(DEFAULT_AGENT_UID);
      if (isAgent) {
        return {
          uid: agentUID,
          name: 'IncidentWeave AI',
          role: 'AI Incident Commander',
          isLocal: false,
        };
      }

      // 1. Check if we already cached this turn's speaker
      if (turnSpeakerMap.current[turnIdStr]) {
        return turnSpeakerMap.current[turnIdStr];
      }

      // 2. Check if sharedTranscripts (from RTM or Redis) already knows this turn
      const shared = sharedTranscripts[turnIdStr];
      if (shared && shared.speakerName) {
        const isLocalUser = Boolean(
          agoraData.participantName &&
          shared.speakerName.trim().toLowerCase() === agoraData.participantName.trim().toLowerCase()
        );
        const speaker = {
          uid: String(shared.uid),
          name: shared.speakerName,
          role: shared.speakerRole || 'Engineer',
          isLocal: isLocalUser,
        };
        turnSpeakerMap.current[turnIdStr] = speaker;
        return speaker;
      }

      // 3. Check for explicit prefix in transcript text (e.g. "Jonathan: Hello" or "[Jonathan] Hello")
      const rawText = typeof item.text === 'string' ? item.text.trim() : '';
      const prefixMatch = rawText.match(/^([A-Za-z0-9_\s-]{2,25})\s*:\s*([\s\S]*)/);
      if (prefixMatch) {
        const potentialName = prefixMatch[1].trim();
        const rosterMatch = Object.values(roster).find(
          (u) => u.name && u.name.trim().toLowerCase() === potentialName.toLowerCase()
        );
        const isLocalUser = Boolean(
          agoraData.participantName &&
          potentialName.toLowerCase() === agoraData.participantName.trim().toLowerCase()
        );
        const speaker = {
          uid: rosterMatch?.uid || (isLocalUser ? String(client?.uid) : '0'),
          name: rosterMatch?.name || potentialName,
          role: rosterMatch?.role || (isLocalUser ? (agoraData.participantRole || 'Engineer') : 'Engineer'),
          isLocal: isLocalUser,
        };
        turnSpeakerMap.current[turnIdStr] = speaker;
        return speaker;
      }

      // 4. Check if RTC volume diarization detected an active speaker recently (within 4.5s)
      const active = lastActiveSpeakerRef.current;
      if (Date.now() - active.timestamp < 4500 && active.name) {
        const speaker = {
          uid: active.uid,
          name: active.name,
          role: active.role,
          isLocal: active.isLocal,
        };
        turnSpeakerMap.current[turnIdStr] = speaker;
        return speaker;
      }

      // 5. Default fallback:
      // If there are remote participants in the room, do not assume local user unless local mic was active.
      // If only local user is in the room, assume local user.
      const hasRemoteHumans = Object.keys(roster).some(
        (uId) => uId !== String(client?.uid) && uId !== agentUID
      );
      const speaker = {
        uid: hasRemoteHumans ? '0' : String(client?.uid),
        name: hasRemoteHumans ? 'Participant' : (agoraData.participantName || `User ${client?.uid}`),
        role: hasRemoteHumans ? 'Engineer' : (agoraData.participantRole || 'Engineer'),
        isLocal: !hasRemoteHumans,
      };
      turnSpeakerMap.current[turnIdStr] = speaker;
      return speaker;
    },
    [agentUID, sharedTranscripts, agoraData, roster, client?.uid]
  );

  // Synchronize local voice turns to all meeting participants over RTM,
  // and persist completed turns (both human and agent) to Redis.
  useEffect(() => {
    if (!rtmClient || !client?.uid) return;

    rawTranscript.forEach((item) => {
      const turnIdStr = String(item.turn_id);
      if (clearedTurnIdsRef.current.has(turnIdStr)) return;

      const text = typeof item.text === 'string' ? item.text.trim() : '';
      if (!text) return;

      const isAgentTurn =
        String(item.uid) === agentUID || String(item.uid) === String(DEFAULT_AGENT_UID);

      const speakerInfo = resolveTurnSpeaker(item);

      // Commit completed turns to master store so they are NEVER lost when toolkit purges internal buffer
      if (item.status === TurnStatus.END || item.status === TurnStatus.INTERRUPTED) {
        setAccumulatedTurns((prev) => {
          const existing = prev[turnIdStr];
          if (existing && existing.status === item.status && existing.text === text) {
            return prev;
          }
          const resolvedSpeakerName = isAgentTurn
            ? 'IncidentWeave AI'
            : (existing?.speakerName || speakerInfo.name);
          const resolvedSpeakerRole = isAgentTurn
            ? 'AI Incident Commander'
            : (existing?.speakerRole || speakerInfo.role);
          const resolvedUid = isAgentTurn
            ? agentUID
            : (existing?.uid || speakerInfo.uid);

          return {
            ...prev,
            [turnIdStr]: {
              turn_id: item.turn_id,
              uid: resolvedUid,
              text,
              status: item.status,
              createdAt:
                typeof item._time === 'number'
                  ? normalizeTimestampMs(item._time)
                  : existing?.createdAt || Date.now(),
              speakerName: resolvedSpeakerName,
              speakerRole: resolvedSpeakerRole,
              isAgent: isAgentTurn,
            },
          };
        });
      }

      // Only broadcast and save to Redis if this turn was spoken by the local user!
      if (!isAgentTurn && speakerInfo.isLocal) {
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
        // When AI agent turn completes, persist it if it was an active speaking turn
        const wasActivated =
          activatedAgentTurnIds.current.has(turnIdStr) ||
          isAgentSpeechAllowed ||
          agentState === AgentState.SPEAKING;
        if (
          wasActivated &&
          (item.status === TurnStatus.END || item.status === TurnStatus.INTERRUPTED) &&
          !savedTranscriptTurnIds.current.has(turnIdStr)
        ) {
          const cleanText = stripJsonFromText(text);
          if (cleanText) {
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
                  text: normalizeTranscriptSpacing(cleanText),
                  status: item.status,
                  createdAt: normalizeTimestampMs(item._time || Date.now()),
                  isAgent: true,
                },
              }),
            }).catch(() => {});
          }
        }
      }
    });
  }, [rawTranscript, agoraData, client?.uid, rtmClient, incidentId, agentUID, isAgentSpeechAllowed, agentState]);

  // The toolkit uses uid="0" for local user speech — remap to actual RTC UID
  // so the transcript panel renders user messages on the correct side.
  // Also normalize punctuation spacing for display when upstream text arrives compacted.
  const transcript = useMemo(() => {
    return normalizeTranscript(rawTranscript, String(client.uid));
  }, [rawTranscript, client.uid]);

  // Unified participant list ensuring ONLY currently connected people in the meeting are shown:
  // 1. Current local user (agoraData.uid)
  // 2. Active remote users currently present in the RTC channel (remoteUsers, excluding agent)
  // Any stale UIDs from previous sessions are strictly excluded.
  const participantList = useMemo(() => {
    const list: { uid: string; name: string; role: string }[] = [];
    const seenUids = new Set<string>();

    if (agoraData.uid) {
      const selfUid = String(agoraData.uid);
      seenUids.add(selfUid);
      list.push({
        uid: selfUid,
        name: agoraData.participantName || roster[selfUid]?.name || `User ${selfUid}`,
        role: agoraData.participantRole || roster[selfUid]?.role || 'Engineer',
      });
    }

    remoteUsers.forEach((u) => {
      const uUid = String(u.uid);
      if (
        uUid === agentUID ||
        uUid === String(DEFAULT_AGENT_UID) ||
        seenUids.has(uUid)
      ) {
        return;
      }
      seenUids.add(uUid);
      const meta = roster[uUid];
      list.push({
        uid: uUid,
        name: meta?.name || `User ${uUid}`,
        role: meta?.role || 'Engineer',
      });
    });

    return list;
  }, [roster, agoraData, remoteUsers, agentUID]);

  // Unified chronological transcript combining:
  // 1. Master accumulated turns (retains every completed turn permanently until user clicks Clear)
  // 2. Remote human turns received via RTM / hydrated from Redis
  // 3. Live turns from AgoraVoiceAI (including current in-progress stream)
  const unifiedTranscriptMap = useMemo(() => {
    const map = new Map<string, IMessageListItem>();

    // 1. Seed with accumulated completed history (never deleted unless user clicks Clear)
    Object.values(accumulatedTurns).forEach((item) => {
      const turnIdStr = String(item.turn_id);
      if (!clearedTurnIdsRef.current.has(turnIdStr)) {
        map.set(turnIdStr, item);
      }
    });

    // 2. Overlay shared/remote/hydrated transcripts
    Object.values(sharedTranscripts).forEach((item) => {
      const turnIdStr = String(item.turn_id);
      if (clearedTurnIdsRef.current.has(turnIdStr)) return;

      const isAgent =
        String(item.uid) === agentUID ||
        String(item.uid) === String(DEFAULT_AGENT_UID) ||
        Boolean(item.isAgent);
      const cleanSpeaker = (item.speakerName || '').trim().toLowerCase();
      const cleanCurrent = (agoraData.participantName || '').trim().toLowerCase();
      const isCurrentUserName = Boolean(cleanCurrent && cleanSpeaker && cleanSpeaker === cleanCurrent);

      map.set(turnIdStr, {
        ...item,
        isAgent,
        speakerName: isAgent
          ? 'IncidentWeave AI'
          : isCurrentUserName && agoraData.participantName
            ? agoraData.participantName
            : (item.speakerName || `User ${item.uid}`),
        speakerRole: isAgent
          ? 'AI Incident Commander'
          : isCurrentUserName && agoraData.participantRole
            ? agoraData.participantRole
            : (item.speakerRole || 'Engineer'),
      });
    });

    // 3. Overlay live turns from AgoraVoiceAI
    transcript.forEach((item) => {
      const turnIdStr = String(item.turn_id);
      if (clearedTurnIdsRef.current.has(turnIdStr)) return;

      const existing = map.get(turnIdStr);
      const uidStr = String(item.uid);
      const isAgent = uidStr === agentUID || uidStr === String(DEFAULT_AGENT_UID);

      const speakerInfo = resolveTurnSpeaker(item);

      // Do NOT overwrite existing remote speaker names from sharedTranscripts or accumulatedTurns!
      const resolvedSpeakerName = isAgent
        ? 'IncidentWeave AI'
        : (existing?.speakerName || speakerInfo.name);

      const resolvedSpeakerRole = isAgent
        ? 'AI Incident Commander'
        : (existing?.speakerRole || speakerInfo.role);

      const resolvedUid = isAgent
        ? agentUID
        : (existing?.uid || speakerInfo.uid);

      map.set(turnIdStr, {
        turn_id: item.turn_id,
        uid: resolvedUid,
        text: typeof item.text === 'string' ? item.text : '',
        status: item.status,
        createdAt:
          typeof item._time === 'number'
            ? normalizeTimestampMs(item._time)
            : existing?.createdAt || Date.now(),
        speakerName: resolvedSpeakerName,
        speakerRole: resolvedSpeakerRole,
        isAgent,
      });
    });

    return map;
  }, [accumulatedTurns, sharedTranscripts, transcript, client?.uid, agentUID, agoraData, roster, resolveTurnSpeaker]);

  // Completed (END + INTERRUPTED) messages shown as history.
  // 1. Human turns (local and remote) ALWAYS show when anyone speaks.
  // 2. Agent turns ONLY show when the turn_id was explicitly tracked in activatedAgentTurnIds.
  //    Simply enabling speech does NOT retroactively show historical agent turns.
  // When agent is silent, its turns are completely suppressed from the transcript.
  const messageList = useMemo<IMessageListItem[]>(() => {
    const list: IMessageListItem[] = [];
    unifiedTranscriptMap.forEach((item) => {
      if (item.status === TurnStatus.IN_PROGRESS) return;

      const uidStr = String(item.uid);
      const isAgent =
        Boolean(item.isAgent) ||
        uidStr === agentUID ||
        uidStr === String(DEFAULT_AGENT_UID);

      if (isAgent) {
        const wasActivated = activatedAgentTurnIds.current.has(String(item.turn_id));
        if (!wasActivated) {
          return; // Agent turn was silent / not triggered: strictly suppress
        }
        const cleanText = stripJsonFromText(item.text || '');
        if (!cleanText) return;
        list.push({ ...item, text: cleanText });
        return;
      }

      // Human speaker: ALWAYS SHOW in the shared transcript!
      if (item.text?.trim()) {
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
  }, [unifiedTranscriptMap, agentUID, isAgentSpeechAllowed]);

  const currentInProgressMessage = useMemo<IMessageListItem | null>(() => {
    // The live partial turn renders separately from the completed history list.
    const inProgressItems: IMessageListItem[] = [];
    unifiedTranscriptMap.forEach((item) => {
      if (item.status === TurnStatus.IN_PROGRESS && item.text?.trim()) {
        inProgressItems.push(item);
      }
    });

    if (inProgressItems.length === 0) return null;

    const activeItem = inProgressItems.reduce((latest, item) =>
      (item.createdAt ?? 0) >= (latest.createdAt ?? 0) ? item : latest,
    );

    const uidStr = String(activeItem.uid);
    const isAgent =
      Boolean(activeItem.isAgent) ||
      uidStr === agentUID ||
      uidStr === String(DEFAULT_AGENT_UID);

    if (isAgent) {
      // Only show in-progress agent bubble when user explicitly clicked Speak
      if (!isAgentSpeechAllowed) {
        return null;
      }
      const cleanText = stripJsonFromText(activeItem.text || '');
      if (!cleanText) return null;
      if (activeItem.turn_id !== undefined && activeItem.turn_id !== null) {
        activatedAgentTurnIds.current.add(String(activeItem.turn_id));
      }
      return { ...activeItem, text: cleanText };
    }

    // Human speaking turn: ALWAYS SHOW!
    return activeItem;
  }, [unifiedTranscriptMap, agentUID, isAgentSpeechAllowed]);

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
    if (agoraData.uid) {
      fetch(`/api/incident/roster?id=${encodeURIComponent(incidentId)}&uid=${encodeURIComponent(agoraData.uid)}`, {
        method: 'DELETE',
      }).catch(() => {});
    }
    onEndConversation();
  }, [agoraData.uid, incidentId, onEndConversation]);

  useEffect(() => {
    const handleUnload = () => {
      if (agoraData.uid) {
        fetch(`/api/incident/roster?id=${encodeURIComponent(incidentId)}&uid=${encodeURIComponent(agoraData.uid)}`, {
          method: 'DELETE',
          keepalive: true,
        }).catch(() => {});
      }
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => {
      window.removeEventListener('beforeunload', handleUnload);
    };
  }, [incidentId, agoraData.uid]);

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
              {/* Live participant count badge: only shows people currently in the meeting */}
              <span className={`ml-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-bold ${
                isParticipantsOpen ? 'bg-white/20 text-white' : 'bg-emerald-500/20 text-emerald-400'
              }`}>
                {participantList.length}
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
            onClear={handleClearTranscript}
          />
        }
        visualizer={
          <div
            className="relative flex h-full min-h-[20rem] w-full max-w-4xl flex-col items-center justify-center"
            role="region"
            aria-label="AI agent status visualization"
          >
            <AgentVisualizer state={visualizerState} size="lg" />

            {/* AI Agent Speech Controller Banner & Button */}
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5 z-10">
              <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border backdrop-blur-sm transition-colors ${
                isAgentSpeechAllowed
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-white/10 bg-black/40 text-white/60'
              }`}>
                <span className={`w-2 h-2 rounded-full ${
                  isAgentSpeechAllowed ? 'bg-emerald-400 animate-ping' : 'bg-white/30'
                }`} />
                {isAgentSpeechAllowed ? 'AI Voice: Active & Speaking' : 'AI Voice: Silent Observer'}
              </span>

              {!isAgentSpeechAllowed ? (
                <button
                  id="visualizer-ask-agent-speak-btn"
                  onClick={handleTriggerAgentSpeech}
                  disabled={isAgentPrompting}
                  className="flex items-center gap-1.5 rounded-full border border-violet-500/50 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 px-4 py-1.5 text-xs font-semibold text-white shadow-lg shadow-violet-500/25 active:scale-95 disabled:opacity-50 transition-all cursor-pointer"
                  title="Click to command the Agora AI agent to speak an update"
                >
                  <svg className={`w-3.5 h-3.5 ${isAgentPrompting ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                  <span>{isAgentPrompting ? 'Invoking AI...' : 'Ask AI to Speak'}</span>
                </button>
              ) : (
                <button
                  onClick={handleStopAgentSpeech}
                  className="flex items-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/20 hover:bg-red-500/30 px-3.5 py-1.5 text-xs font-semibold text-red-300 transition-colors shadow-sm active:scale-95 cursor-pointer"
                  title="Silence and mute the AI agent"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                    <rect x="6" y="6" width="12" height="12" rx="1.5" />
                  </svg>
                  <span>Silence AI</span>
                </button>
              )}
            </div>

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

            <div className="h-6 w-px bg-white/10" />

            {/* AI Agent Speech Controller in Bottom Dock */}
            {!isAgentSpeechAllowed ? (
              <button
                id="controls-ask-agent-speak-btn"
                onClick={handleTriggerAgentSpeech}
                disabled={isAgentPrompting}
                className="flex items-center gap-2 rounded-full border border-violet-500/40 bg-gradient-to-r from-violet-600/30 to-indigo-600/30 hover:from-violet-600/50 hover:to-indigo-600/50 px-3.5 py-2 text-xs font-semibold text-violet-200 transition-all shadow-md hover:shadow-violet-500/20 active:scale-95 disabled:opacity-50 cursor-pointer"
                title="Only when clicked does the Agora AI agent speak"
              >
                <svg className={`w-3.5 h-3.5 text-violet-300 ${isAgentPrompting ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
                <span>{isAgentPrompting ? 'Invoking AI...' : 'Ask AI to Speak'}</span>
                <span className="rounded bg-violet-500/20 px-1 py-0.5 text-[9px] text-violet-300 font-mono">
                  Silent
                </span>
              </button>
            ) : (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handleTriggerAgentSpeech}
                  disabled={isAgentPrompting}
                  className="flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/20 hover:bg-emerald-500/30 px-3 py-2 text-xs font-semibold text-emerald-300 transition-all animate-pulse cursor-pointer"
                  title="AI Voice is active. Click to request another update"
                >
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  <span>AI Speaking</span>
                </button>
                <button
                  onClick={handleStopAgentSpeech}
                  className="flex items-center justify-center w-8 h-8 rounded-full border border-red-500/40 bg-red-500/15 hover:bg-red-500/30 text-red-300 transition-colors cursor-pointer"
                  title="Silence AI agent voice"
                  aria-label="Silence AI agent voice"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                    <rect x="6" y="6" width="12" height="12" rx="1.5" />
                  </svg>
                </button>
              </div>
            )}
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
                  {participantList.length} in this room
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
                  <span className="text-[10px] text-violet-400/70 font-medium">
                    {isAgentSpeechAllowed ? 'Voice Enabled' : 'Silent Observer'}
                  </span>
                </div>
                <span className={`flex h-5 items-center gap-1 rounded-full px-2 text-[10px] font-semibold ${
                  isAgentSpeechAllowed
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : 'bg-violet-500/15 text-violet-400'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    isAgentSpeechAllowed ? 'bg-emerald-400 animate-pulse' : 'bg-violet-400'
                  }`} />
                  {isAgentSpeechAllowed ? 'Speaking' : 'Silent'}
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
                    <span className="flex h-5 items-center gap-1 rounded-full px-2 text-[10px] font-semibold bg-emerald-500/15 text-emerald-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      Live
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
