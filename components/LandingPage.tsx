'use client';

import { useState, useRef, Suspense, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import type { RTMClient } from 'agora-rtm';
import type {
  AgoraTokenData,
  ClientStartRequest,
  AgentResponse,
  AgoraRenewalTokens,
} from '../types/conversation';
import { ErrorBoundary } from './ErrorBoundary';
import { LoadingSkeleton } from './LoadingSkeleton';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Generates a short, URL-safe unique room ID, e.g. incident-m3kba1-x7f2k */
function generateRoomId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 7);
  return `incident-${ts}-${rand}`;
}

/**
 * Given a raw string from the "Enter a code or link" input, extract the room ID.
 * Accepts:
 *   - A full URL: https://example.com/?room=incident-xxx  → "incident-xxx"
 *   - A bare room code: incident-xxx                      → "incident-xxx"
 */
function extractRoomId(raw: string): string {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    const param = url.searchParams.get('room');
    if (param) return param.trim();
  } catch {
    // Not a URL — treat the whole string as the room code
  }
  return trimmed;
}

// ─────────────────────────────────────────────────────────────────────────────
// App mode — mirrors Google Meet's pre-join states
//   home      → landing: "New meeting" dropdown + "Enter code" input
//   instant   → user chose "Start an instant meeting": show name/role → join
//   later     → user chose "Create for later": show shareable link, don't join
//   join      → user entered a code or opened a shared link: show name/role → join
// ─────────────────────────────────────────────────────────────────────────────
type AppMode = 'home' | 'instant' | 'later' | 'join';

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic imports (browser-only SDKs)
// ─────────────────────────────────────────────────────────────────────────────
const ConversationComponent = dynamic(() => import('./ConversationComponent'), {
  ssr: false,
});

const AgoraProvider = dynamic(
  async () => {
    const { AgoraRTCProvider, default: AgoraRTC } = await import('agora-rtc-react');
    return {
      default: function AgoraProviders({ children }: { children: React.ReactNode }) {
        const clientRef = useRef<ReturnType<typeof AgoraRTC.createClient> | null>(null);
        if (!clientRef.current) {
          clientRef.current = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
        }
        return <AgoraRTCProvider client={clientRef.current}>{children}</AgoraRTCProvider>;
      },
    };
  },
  { ssr: false },
);

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

/** Reusable copy-link row used in both "instant" and "later" modes. */
function ShareLinkRow({ shareUrl }: { shareUrl: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  }
  return (
    <div className="w-full rounded-lg border border-blue-500/25 bg-blue-500/8 p-3">
      <p className="text-xs font-semibold text-blue-400 mb-2">Share with teammates</p>
      <div className="flex gap-2">
        <input
          readOnly
          value={shareUrl}
          className="flex-1 min-w-0 rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-xs text-white/70 font-mono truncate cursor-text focus:outline-none"
          onClick={e => (e.target as HTMLInputElement).select()}
          aria-label="Shareable room link"
        />
        <button
          onClick={handleCopy}
          className={`flex-shrink-0 rounded-md border px-3 py-1.5 text-xs font-semibold transition-all ${
            copied
              ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400'
              : 'border-white/15 bg-white/8 text-white/70 hover:border-blue-500/40 hover:bg-blue-500/15 hover:text-blue-400'
          }`}
        >
          {copied ? '✓ Copied!' : 'Copy'}
        </button>
      </div>
      <p className="mt-1.5 text-[10px] text-white/30">Anyone with this link joins this incident room</p>
    </div>
  );
}

/** Name + Role form shared by "instant" and "join" modes. */
function NameRoleForm({
  participantName,
  onNameChange,
  participantRole,
  onRoleChange,
}: {
  participantName: string;
  onNameChange: (v: string) => void;
  participantRole: string;
  onRoleChange: (v: string) => void;
}) {
  const roles = ['Engineer', 'SRE', 'Product', 'Business', 'Other'];
  return (
    <div className="w-full space-y-3">
      <div>
        <label className="block text-xs font-medium text-white/60 mb-1">Your Name</label>
        <input
          type="text"
          value={participantName}
          onChange={e => onNameChange(e.target.value)}
          placeholder="e.g. Arun Kumar"
          autoFocus
          className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-white/60 mb-1">Your Role</label>
        <select
          value={participantRole}
          onChange={e => onRoleChange(e.target.value)}
          className="w-full rounded-lg border border-white/10 bg-[#1a1a1a] px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          {roles.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>
    </div>
  );
}

/** Shared card shell with IW logo. */
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mx-auto flex w-[min(92vw,30rem)] animate-fade-up flex-col items-start rounded-[20px] border border-[#2b2b2b] px-8 py-8 shadow-[0_10px_24px_rgba(0,0,0,0.28)]"
      style={{
        backgroundImage:
          'linear-gradient(164.988deg, rgba(54,54,54,0.2) 1.0596%, rgba(0,0,0,0) 96.089%), linear-gradient(90deg, rgb(16,16,16) 0%, rgb(16,16,16) 100%)',
      }}
    >
      <div className="flex items-center gap-2 mb-5">
        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center text-xs font-bold text-white">
          IW
        </div>
        <span className="text-lg font-semibold text-white">IncidentWeave</span>
      </div>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────
export default function LandingPage() {
  const [showConversation, setShowConversation] = useState(false);

  // ── meeting state ──────────────────────────────────────────────────────────
  const [mode, setMode] = useState<AppMode>('home');
  const [roomId, setRoomId] = useState('');
  const [shareUrl, setShareUrl] = useState('');
  const [isHost, setIsHost] = useState(true);

  // ── participant identity ───────────────────────────────────────────────────
  const [participantName, setParticipantName] = useState('');
  const [participantRole, setParticipantRole] = useState('Engineer');

  // ── "Enter a code or link" input on the home screen ───────────────────────
  const [codeInput, setCodeInput] = useState('');

  // ── "New meeting" dropdown open/closed ────────────────────────────────────
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // ── Agora session state ────────────────────────────────────────────────────
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agoraData, setAgoraData] = useState<AgoraTokenData | null>(null);
  const [rtmClient, setRtmClient] = useState<RTMClient | null>(null);
  const [agentJoinError, setAgentJoinError] = useState(false);

  // ── On mount: if ?room= is in the URL, skip straight to join mode ──────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) {
      const id = roomParam.trim();
      setRoomId(id);
      setIsHost(false);
      setShareUrl(`${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(id)}`);
      setMode('join');
    }
    // If no ?room= param → stay in 'home' mode; room is generated on demand
  }, []);

  // ── Close dropdown when clicking outside ──────────────────────────────────
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // ── Preload heavy SDK modules so they're ready when the user clicks join ───
  useEffect(() => {
    import('agora-rtc-react').catch(() => {});
    import('agora-rtm').catch(() => {});
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // Meeting creation handlers
  // ─────────────────────────────────────────────────────────────────────────

  /** Helper: build + persist a fresh room ID in URL and state */
  function prepareNewRoom(): string {
    const id = generateRoomId();
    const url = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(id)}`;
    setRoomId(id);
    setShareUrl(url);
    setIsHost(true);
    // Update address bar — now the URL itself is the shareable link
    window.history.replaceState({}, '', `?room=${encodeURIComponent(id)}`);
    return id;
  }

  /** "New meeting → Start an instant meeting" */
  function handleInstantMeeting() {
    prepareNewRoom();
    setMode('instant');
    setDropdownOpen(false);
  }

  /** "New meeting → Create a meeting for later" */
  function handleCreateForLater() {
    prepareNewRoom();
    setMode('later');
    setDropdownOpen(false);
  }

  /**
   * "Start now" button on the "create for later" screen.
   * The room is already set — just move to the name/role form.
   */
  function handleStartFromLater() {
    setMode('instant');
  }

  /**
   * "Join" button next to the code/link input.
   * Accepts a full URL or a bare room code.
   */
  function handleJoinByCode() {
    const id = extractRoomId(codeInput);
    if (!id) return;
    const url = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(id)}`;
    setRoomId(id);
    setShareUrl(url);
    setIsHost(false);
    window.history.replaceState({}, '', `?room=${encodeURIComponent(id)}`);
    setMode('join');
    setCodeInput('');
  }

  /** Back to home screen, clears the URL param */
  function handleBackToHome() {
    setMode('home');
    setRoomId('');
    setShareUrl('');
    setCodeInput('');
    window.history.replaceState({}, '', window.location.pathname);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Agora session bootstrap (unchanged from original)
  // ─────────────────────────────────────────────────────────────────────────
  const handleStartConversation = async () => {
    if (!participantName.trim()) return;
    setIsLoading(true);
    setError(null);
    setAgentJoinError(false);

    const effectiveRoomId = roomId.trim() || generateRoomId();
    const effectiveName = participantName.trim();

    try {
      // Step 1: Generate Agora RTC + RTM token
      const agoraResponse = await fetch(
        `/api/generate-agora-token?channel=${encodeURIComponent(effectiveRoomId)}`
      );
      const responseData = await agoraResponse.json();

      if (!agoraResponse.ok) {
        const msg = responseData?.error || responseData?.details || JSON.stringify(responseData);
        throw new Error(`Token error: ${msg}`);
      }

      // Step 2: Register participant in roster (fire-and-forget)
      fetch('/api/incident/roster', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incidentId: effectiveRoomId,
          uid: responseData.uid,
          name: effectiveName,
          role: participantRole,
        }),
      }).catch(() => {});

      // Step 3: Start agent + RTM login in parallel
      const [agentData, rtm] = await Promise.all([
        // Agent start — non-fatal if it fails (agentJoinError flag)
        fetch('/api/invite-agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requester_ids: [responseData.uid],
            channel_name: responseData.channel,
          } as ClientStartRequest),
        })
          .then(async res => {
            const data = await res.json();
            if (!res.ok) {
              console.error('[invite-agent] error:', data);
              setAgentJoinError(true);
              return null;
            }
            return data as AgentResponse;
          })
          .catch(err => {
            console.error('Failed to start conversation with agent:', err);
            setAgentJoinError(true);
            return null;
          }),

        // RTM login — fatal if it fails
        (async () => {
          const { default: AgoraRTM } = await import('agora-rtm');
          const rtm: RTMClient = new AgoraRTM.RTM(
            process.env.NEXT_PUBLIC_AGORA_APP_ID!,
            responseData.uid,
          );
          await rtm.login({ token: responseData.token });
          await rtm.subscribe(responseData.channel);
          return rtm;
        })(),
      ]);

      setRtmClient(rtm);
      setAgoraData({
        ...responseData,
        agentId: agentData?.agent_id,
        incidentId: effectiveRoomId,
        participantName: effectiveName,
        participantRole,
      });
      setShowConversation(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Failed to start conversation: ${message}`);
      console.error('Error starting conversation:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleTokenWillExpire = useCallback(
    async (uid: string): Promise<AgoraRenewalTokens> => {
      try {
        const channel = agoraData?.channel;
        if (!channel) throw new Error('Missing channel for token renewal');
        const [rtcResponse, rtmResponse] = await Promise.all([
          fetch(`/api/generate-agora-token?channel=${channel}&uid=${uid}`),
          fetch(`/api/generate-agora-token?channel=${channel}&uid=${agoraData.uid}`),
        ]);
        const [rtcData, rtmData] = await Promise.all([rtcResponse.json(), rtmResponse.json()]);
        if (!rtcResponse.ok || !rtmResponse.ok) throw new Error('Failed to generate renewal tokens');
        return { rtcToken: rtcData.token, rtmToken: rtmData.token };
      } catch (error) {
        console.error('Error renewing token:', error);
        throw error;
      }
    },
    [agoraData],
  );

  const handleEndConversation = async () => {
    if (agoraData?.agentId) {
      try {
        const response = await fetch('/api/stop-conversation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: agoraData.agentId }),
        });
        if (!response.ok) console.error('Failed to stop agent:', await response.text());
      } catch (error) {
        console.error('Error stopping agent:', error);
      }
    }
    rtmClient?.logout().catch(err => console.error('RTM logout error:', err));
    setRtmClient(null);
    setShowConversation(false);
    // Return to home; clear the URL so a fresh room can be created
    handleBackToHome();
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Pre-join screens
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * HOME — "New meeting" dropdown + "Enter a code or link" input
   */
  function HomeScreen() {
    return (
      <Card>
        <p className="text-sm text-white/50 mb-6">
          AI-powered incident command room — real-time claim extraction, contradiction detection, and action approvals.
        </p>

        {/* ── New meeting dropdown ── */}
        <div className="w-full flex flex-col sm:flex-row gap-3">
          <div className="relative flex-shrink-0" ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen(o => !o)}
              className="flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-500 px-4 py-2.5 text-sm font-semibold text-white transition-colors"
              aria-haspopup="listbox"
              aria-expanded={dropdownOpen}
            >
              {/* video icon */}
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
              </svg>
              New meeting
              {/* chevron */}
              <svg className={`w-3.5 h-3.5 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {dropdownOpen && (
              <div
                className="absolute left-0 top-full mt-1.5 z-50 min-w-[220px] rounded-xl border border-white/10 bg-[#1a1f2e] shadow-2xl overflow-hidden"
                role="listbox"
              >
                {/* Option 1: Start instant meeting */}
                <button
                  role="option"
                  onClick={handleInstantMeeting}
                  className="flex items-start gap-3 w-full px-4 py-3 hover:bg-white/5 transition-colors text-left"
                >
                  <span className="mt-0.5 flex-shrink-0 w-6 h-6 rounded-full bg-blue-500/20 flex items-center justify-center">
                    <svg className="w-3 h-3 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-8.707l-3-3a1 1 0 00-1.414 1.414L10.586 9H7a1 1 0 100 2h3.586l-1.293 1.293a1 1 0 101.414 1.414l3-3a1 1 0 000-1.414z" clipRule="evenodd" />
                    </svg>
                  </span>
                  <div>
                    <p className="text-sm font-medium text-white">Start an instant meeting</p>
                    <p className="text-xs text-white/40 mt-0.5">Create a new room and join now</p>
                  </div>
                </button>

                {/* Option 2: Create for later */}
                <button
                  role="option"
                  onClick={handleCreateForLater}
                  className="flex items-start gap-3 w-full px-4 py-3 hover:bg-white/5 transition-colors text-left border-t border-white/5"
                >
                  <span className="mt-0.5 flex-shrink-0 w-6 h-6 rounded-full bg-violet-500/20 flex items-center justify-center">
                    <svg className="w-3 h-3 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.1-1.1m-.758-4.9a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                  </span>
                  <div>
                    <p className="text-sm font-medium text-white">Create a meeting for later</p>
                    <p className="text-xs text-white/40 mt-0.5">Get a link to share — you won&apos;t join yet</p>
                  </div>
                </button>
              </div>
            )}
          </div>

          {/* ── Enter code or link ── */}
          <div className="flex flex-1 gap-2">
            <input
              type="text"
              value={codeInput}
              onChange={e => setCodeInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && codeInput.trim() && handleJoinByCode()}
              placeholder="Enter a code or link"
              className="flex-1 min-w-0 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              aria-label="Room code or link"
            />
            <button
              onClick={handleJoinByCode}
              disabled={!codeInput.trim()}
              className="px-4 py-2 rounded-lg text-sm font-medium text-blue-400 hover:bg-blue-500/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Join
            </button>
          </div>
        </div>
      </Card>
    );
  }

  /**
   * CREATE FOR LATER — shows the shareable link, no join form
   */
  function CreateForLaterScreen() {
    return (
      <Card>
        <p className="text-sm text-white/60 mb-1">Your meeting link is ready</p>
        <p className="text-xs text-white/35 mb-5">
          Share this link with your team. You can join when the incident starts.
        </p>

        {/* Room ID display */}
        <div className="w-full mb-3">
          <label className="block text-xs font-medium text-white/40 mb-1">Room ID</label>
          <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2">
            <span className="text-sm text-white/70 font-mono truncate flex-1">{roomId}</span>
          </div>
        </div>

        <ShareLinkRow shareUrl={shareUrl} />

        <div className="mt-5 w-full flex gap-3">
          <button
            onClick={handleBackToHome}
            className="flex-1 h-10 rounded-lg border border-white/15 text-sm font-medium text-white/60 hover:text-white hover:border-white/30 transition-colors"
          >
            Back
          </button>
          <button
            onClick={handleStartFromLater}
            className="flex-1 h-10 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm font-semibold text-white transition-colors"
          >
            Start now
          </button>
        </div>
      </Card>
    );
  }

  /**
   * INSTANT / JOIN — name + role form, then enters the room
   * Used for both "instant meeting" (isHost=true) and "join via link/code" (isHost=false).
   */
  function JoinFormScreen() {
    return (
      <Card>
        {/* Room context */}
        <div className="w-full mb-4">
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs font-medium text-white/40">Room</label>
            {!isHost && (
              <span className="text-[10px] font-semibold text-blue-400 border border-blue-500/30 bg-blue-500/10 rounded px-1.5 py-0.5">
                Via Link
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2">
            <span className="text-sm text-white/70 font-mono truncate flex-1">{roomId}</span>
          </div>
        </div>

        {/* Share link — only for host (instant meeting creator) */}
        {isHost && shareUrl && (
          <div className="w-full mb-4">
            <ShareLinkRow shareUrl={shareUrl} />
          </div>
        )}

        {/* Name + Role */}
        <NameRoleForm
          participantName={participantName}
          onNameChange={setParticipantName}
          participantRole={participantRole}
          onRoleChange={setParticipantRole}
        />

        <button
          onClick={handleStartConversation}
          disabled={isLoading || !participantName.trim()}
          className="mt-5 h-10 w-full rounded-lg bg-blue-600 hover:bg-blue-500 text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isLoading
            ? (isHost ? 'Creating...' : 'Joining...')
            : (isHost ? 'Create Incident Room' : 'Join Incident Room')}
        </button>
        {!participantName.trim() && !isLoading && (
          <p className="mt-2 text-[10px] text-white/30 text-center">Enter your name to continue</p>
        )}
        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

        <button
          onClick={handleBackToHome}
          className="mt-3 text-xs text-white/30 hover:text-white/60 transition-colors w-full text-center"
        >
          ← Back
        </button>
      </Card>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  function PreCallContent() {
    if (mode === 'home')    return <HomeScreen />;
    if (mode === 'later')   return <CreateForLaterScreen />;
    // 'instant' and 'join' both use the name/role form
    return <JoinFormScreen />;
  }

  return (
    <div className="relative flex h-dvh min-h-screen flex-col overflow-hidden bg-background text-foreground">
      <div
        className={`flex min-h-0 flex-1 flex-col ${
          showConversation ? 'items-stretch justify-start' : 'items-center justify-center'
        }`}
      >
        <div
          className={`z-10 flex min-h-0 flex-1 flex-col ${
            showConversation
              ? 'h-full w-full max-w-none items-stretch gap-0 px-0 text-left'
              : 'w-full max-w-none items-center justify-center px-4 text-center'
          }`}
        >
          {!showConversation ? (
            <PreCallContent />
          ) : agoraData && rtmClient ? (
            <>
              {agentJoinError && (
                <div className="p-3 bg-destructive/10 rounded-md text-destructive text-sm max-w-sm">
                  Failed to connect with AI agent. The conversation may not work as expected.
                </div>
              )}
              <Suspense fallback={<LoadingSkeleton />}>
                <ErrorBoundary>
                  <AgoraProvider>
                    <ConversationComponent
                      agoraData={agoraData}
                      rtmClient={rtmClient}
                      onTokenWillExpire={handleTokenWillExpire}
                      onEndConversation={handleEndConversation}
                    />
                  </AgoraProvider>
                </ErrorBoundary>
              </Suspense>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Failed to load conversation data.</p>
          )}
        </div>
      </div>

      {/* Attribution footer */}
      <footer className="fixed bottom-0 right-0 z-40 py-4 pr-4 md:py-6 md:pr-6">
        <div className="flex items-center justify-end gap-2 text-muted-foreground">
          <span className="text-xs font-medium tracking-wide uppercase">Powered by</span>
          <a
            href="https://agora.io/en/"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-primary transition-colors"
            aria-label="Visit Agora's website"
          >
            <Image
              src="/agora-logo-rgb-blue.svg"
              alt="Agora"
              width={86}
              height={24}
              priority
              className="h-6 w-auto hover:opacity-80 transition-opacity translate-y-1"
            />
            <span className="sr-only">Agora</span>
          </a>
        </div>
      </footer>
    </div>
  );
}
