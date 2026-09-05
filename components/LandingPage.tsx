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

function generateRoomId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 7);
  return `incident-${ts}-${rand}`;
}

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

function ShareLinkRow({ shareUrl }: { shareUrl: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  }
  return (
    <div className="w-full rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3">
      <p className="text-xs font-semibold text-cyan-400 mb-2">Share with teammates</p>
      <div className="flex gap-2">
        <input
          readOnly
          value={shareUrl}
          className="flex-1 min-w-0 rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-xs text-white/70 font-mono truncate cursor-text focus:outline-none"
          onClick={(e) => (e.target as HTMLInputElement).select()}
          aria-label="Shareable room link"
        />
        <button
          onClick={handleCopy}
          className={`flex-shrink-0 rounded-md border px-3 py-1.5 text-xs font-semibold transition-all ${
            copied
              ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400'
              : 'border-white/15 bg-white/8 text-white/70 hover:border-cyan-500/40 hover:bg-cyan-500/15 hover:text-cyan-400'
          }`}
        >
          {copied ? '✓ Copied!' : 'Copy'}
        </button>
      </div>
      <p className="mt-1.5 text-[10px] text-white/30">Anyone with this link joins this incident room</p>
    </div>
  );
}

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
        <label className="block text-xs font-medium text-white/60 mb-1.5">Your Name</label>
        <input
          type="text"
          value={participantName}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="e.g. Arun Kumar"
          autoFocus
          className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white placeholder:text-white/25 focus:border-cyan-500/60 focus:outline-none focus:ring-1 focus:ring-cyan-500/40 transition-colors"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-white/60 mb-1.5">Your Role</label>
        <select
          value={participantRole}
          onChange={(e) => onRoleChange(e.target.value)}
          className="w-full rounded-lg border border-white/10 bg-[#0d1628] px-3 py-2.5 text-sm text-white focus:border-cyan-500/60 focus:outline-none focus:ring-1 focus:ring-cyan-500/40 transition-colors"
        >
          {roles.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>
    </div>
  );
}

/** Glassmorphism card shell */
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="relative mx-auto flex w-full max-w-[530px] animate-fade-up flex-col items-stretch rounded-2xl p-7 sm:p-8"
      style={{
        background: 'rgba(13, 20, 40, 0.82)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 0 0 1px rgba(56,189,248,0.06), 0 0 80px rgba(56,189,248,0.05), 0 24px 64px rgba(0,0,0,0.50)',
      }}
    >
      {/* Card top accent line */}
      <div
        className="absolute top-0 left-8 right-8 h-px"
        style={{ background: 'linear-gradient(90deg, transparent, rgba(56,189,248,0.4), transparent)' }}
      />

      {/* Brand header */}
      <div className="flex items-center gap-3 mb-2">
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold text-white shadow-lg"
          style={{ background: 'linear-gradient(135deg, #3b82f6, #7c3aed)' }}
        >
          IW
        </div>
        <div>
          <div className="text-lg font-bold tracking-tight text-white" style={{ letterSpacing: '-0.01em' }}>
            IncidentWeave
          </div>
          <div className="text-[10px] font-semibold text-cyan-400/70 tracking-widest uppercase">
            AI Incident Command
          </div>
        </div>
      </div>

      <div className="w-full mb-6 h-px bg-white/5" />
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
  const rtmClientRef = useRef<RTMClient | null>(null);
  const [agentJoinError, setAgentJoinError] = useState(false);

  useEffect(() => {
    return () => {
      if (rtmClientRef.current) {
        rtmClientRef.current.logout().catch(() => {});
        rtmClientRef.current = null;
      }
    };
  }, []);

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

  // ── Preload heavy SDK modules ──────────────────────────────────────────────
  useEffect(() => {
    import('agora-rtc-react').catch(() => {});
    import('agora-rtm').catch(() => {});
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // Meeting creation handlers
  // ─────────────────────────────────────────────────────────────────────────
  function prepareNewRoom(): string {
    const id = generateRoomId();
    const url = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(id)}`;
    setRoomId(id);
    setShareUrl(url);
    setIsHost(true);
    window.history.replaceState({}, '', `?room=${encodeURIComponent(id)}`);
    return id;
  }

  function handleInstantMeeting() {
    prepareNewRoom();
    setMode('instant');
    setDropdownOpen(false);
  }

  function handleCreateForLater() {
    prepareNewRoom();
    setMode('later');
    setDropdownOpen(false);
  }

  function handleStartFromLater() {
    setMode('instant');
  }

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

  function handleBackToHome() {
    setMode('home');
    setRoomId('');
    setShareUrl('');
    setCodeInput('');
    window.history.replaceState({}, '', window.location.pathname);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Agora session bootstrap
  // ─────────────────────────────────────────────────────────────────────────
  const handleStartConversation = async () => {
    if (!participantName.trim()) return;
    setIsLoading(true);
    setError(null);
    setAgentJoinError(false);

    const effectiveRoomId = roomId.trim() || generateRoomId();
    const effectiveName = participantName.trim();

    try {
      const agoraResponse = await fetch(
        `/api/generate-agora-token?channel=${encodeURIComponent(effectiveRoomId)}`
      );
      const responseData = await agoraResponse.json();

      if (!agoraResponse.ok) {
        const msg = responseData?.error || responseData?.details || JSON.stringify(responseData);
        throw new Error(`Token error: ${msg}`);
      }

      fetch('/api/incident/roster', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incidentId: effectiveRoomId,
          uid: String(responseData.uid),
          name: effectiveName || `User ${responseData.uid}`,
          role: participantRole || 'Engineer',
        }),
      }).catch(() => {});

      const [agentData, rtm] = await Promise.all([
        fetch('/api/invite-agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requester_ids: [responseData.uid],
            channel_name: responseData.channel,
          } as ClientStartRequest),
        })
          .then(async (res) => {
            const data = await res.json();
            if (!res.ok) {
              console.error('[invite-agent] error:', data);
              setAgentJoinError(true);
              return null;
            }
            return data as AgentResponse;
          })
          .catch((err) => {
            console.error('Failed to start conversation with agent:', err);
            setAgentJoinError(true);
            return null;
          }),

        (async () => {
          const { default: AgoraRTM } = await import('agora-rtm');
          const appId = (process.env.NEXT_PUBLIC_AGORA_APP_ID || '').trim().replace(/[\r\n]/g, '').replace(/\\r|\\n/g, '');
          // If a previous instance is alive, cleanly logout first to avoid instance duplication & mutual kick
          if (rtmClientRef.current) {
            try {
              await rtmClientRef.current.logout();
            } catch {}
            rtmClientRef.current = null;
          }
          const rtm: RTMClient = new AgoraRTM.RTM(appId, responseData.uid);
          await rtm.login({ token: responseData.token });
          await rtm.subscribe(responseData.channel);
          rtmClientRef.current = rtm;
          return rtm;
        })(),
      ]);

      setRtmClient(rtm);
      setAgoraData({
        ...responseData,
        agentId: agentData?.agent_id,
        incidentId: effectiveRoomId,
        participantName: effectiveName || `User ${responseData.uid}`,
        participantRole: participantRole || 'Engineer',
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
    if (rtmClientRef.current) {
      try {
        await rtmClientRef.current.logout();
      } catch (err) {
        console.error('RTM logout error:', err);
      }
      rtmClientRef.current = null;
    } else if (rtmClient) {
      rtmClient.logout().catch((err) => console.error('RTM logout error:', err));
    }
    setRtmClient(null);
    setShowConversation(false);
    handleBackToHome();
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Pre-join screens
  // ─────────────────────────────────────────────────────────────────────────

  function HomeScreen() {
    return (
      <Card>
        <p className="text-sm text-white/50 mb-5 leading-relaxed text-left">
          AI-powered real-time incident command — voice-driven claim extraction, contradiction detection, and human-approved action dispatch.
        </p>

        {/* ── New meeting dropdown + Join row ── */}
        <div className="w-full flex flex-col sm:flex-row items-stretch gap-2.5 mb-5">
          <div className="relative flex-shrink-0" ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen((o) => !o)}
              className="h-10 w-full sm:w-auto flex items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold text-white transition-all hover:brightness-110 active:scale-[0.98] whitespace-nowrap shadow-md shadow-blue-500/10"
              style={{ background: 'linear-gradient(135deg, #2563eb, #7c3aed)' }}
              aria-haspopup="listbox"
              aria-expanded={dropdownOpen}
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
              </svg>
              <span>New Incident</span>
              <svg className={`w-3.5 h-3.5 transition-transform flex-shrink-0 ${dropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {dropdownOpen && (
              <div
                className="absolute left-0 top-full mt-2 z-50 min-w-[240px] rounded-xl overflow-hidden shadow-2xl"
                style={{
                  background: 'rgba(13,20,40,0.96)',
                  backdropFilter: 'blur(20px)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
                }}
                role="listbox"
              >
                <button
                  role="option"
                  onClick={handleInstantMeeting}
                  className="flex items-start gap-3 w-full px-4 py-3.5 hover:bg-white/5 transition-colors text-left"
                >
                  <span className="mt-0.5 flex-shrink-0 w-7 h-7 rounded-full bg-cyan-500/15 flex items-center justify-center">
                    <svg className="w-3.5 h-3.5 text-cyan-400" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-8.707l-3-3a1 1 0 00-1.414 1.414L10.586 9H7a1 1 0 100 2h3.586l-1.293 1.293a1 1 0 101.414 1.414l3-3a1 1 0 000-1.414z" clipRule="evenodd" />
                    </svg>
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-white">Start an instant meeting</p>
                    <p className="text-xs text-white/40 mt-0.5">Create a new room and join now</p>
                  </div>
                </button>

                <button
                  role="option"
                  onClick={handleCreateForLater}
                  className="flex items-start gap-3 w-full px-4 py-3.5 hover:bg-white/5 transition-colors text-left border-t border-white/5"
                >
                  <span className="mt-0.5 flex-shrink-0 w-7 h-7 rounded-full bg-violet-500/15 flex items-center justify-center">
                    <svg className="w-3.5 h-3.5 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.1-1.1m-.758-4.9a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-white">Create a meeting for later</p>
                    <p className="text-xs text-white/40 mt-0.5">Get a link to share — you won&apos;t join yet</p>
                  </div>
                </button>
              </div>
            )}
          </div>

          {/* ── Enter code or link + Join ── */}
          <div className="flex flex-1 min-w-0 items-center gap-2">
            <input
              type="text"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && codeInput.trim() && handleJoinByCode()}
              placeholder="Enter a code or link"
              className="h-10 flex-1 min-w-0 rounded-xl border border-white/10 bg-white/5 px-3.5 text-sm text-white placeholder:text-white/25 focus:border-cyan-500/50 focus:bg-white/[0.07] focus:outline-none focus:ring-1 focus:ring-cyan-500/30 transition-all"
              aria-label="Room code or link"
            />
            <button
              onClick={handleJoinByCode}
              disabled={!codeInput.trim()}
              className={`h-10 flex-shrink-0 px-4 rounded-xl text-sm font-semibold transition-all whitespace-nowrap border ${
                codeInput.trim()
                  ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25 active:scale-[0.98]'
                  : 'border-white/10 bg-transparent text-white/25 cursor-not-allowed'
              }`}
            >
              Join
            </button>
          </div>
        </div>

        {/* Feature pills */}
        <div className="w-full grid grid-cols-2 gap-2">
          {[
            { icon: '🎙️', label: 'Real-time voice' },
            { icon: '🕸️', label: 'Truth Graph' },
            { icon: '⚡', label: 'Conflict detection' },
            { icon: '✅', label: 'Human approval' },
          ].map(({ icon, label }) => (
            <div
              key={label}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-white/40"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
            >
              <span>{icon}</span>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </Card>
    );
  }

  function CreateForLaterScreen() {
    return (
      <Card>
        <p className="text-sm text-white/60 mb-1">Your incident room is ready</p>
        <p className="text-xs text-white/35 mb-5">
          Share this link with your team. You can join when the incident starts.
        </p>

        <div className="w-full mb-3">
          <label className="block text-xs font-medium text-white/40 mb-1.5">Room ID</label>
          <div className="flex items-center gap-2 rounded-lg border border-white/8 bg-white/4 px-3 py-2">
            <span className="text-sm text-white/70 font-mono truncate flex-1">{roomId}</span>
          </div>
        </div>

        <ShareLinkRow shareUrl={shareUrl} />

        <div className="mt-5 w-full flex gap-3">
          <button
            onClick={handleBackToHome}
            className="flex-1 h-10 rounded-xl border border-white/12 text-sm font-medium text-white/60 hover:text-white hover:border-white/25 transition-colors"
          >
            Back
          </button>
          <button
            onClick={handleStartFromLater}
            className="flex-1 h-10 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110"
            style={{ background: 'linear-gradient(135deg, #2563eb, #7c3aed)' }}
          >
            Start now
          </button>
        </div>
      </Card>
    );
  }

  function JoinFormScreen() {
    return (
      <Card>
        <div className="w-full mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-medium text-white/40">Room</label>
            {!isHost && (
              <span className="text-[10px] font-semibold text-cyan-400 border border-cyan-500/30 bg-cyan-500/10 rounded px-1.5 py-0.5">
                Via Link
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-white/8 bg-white/4 px-3 py-2">
            <span className="text-sm text-white/70 font-mono truncate flex-1">{roomId}</span>
          </div>
        </div>

        {isHost && shareUrl && (
          <div className="w-full mb-4">
            <ShareLinkRow shareUrl={shareUrl} />
          </div>
        )}

        <NameRoleForm
          participantName={participantName}
          onNameChange={setParticipantName}
          participantRole={participantRole}
          onRoleChange={setParticipantRole}
        />

        <button
          onClick={handleStartConversation}
          disabled={isLoading || !participantName.trim()}
          className="mt-5 h-11 w-full rounded-xl text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:brightness-110"
          style={{ background: 'linear-gradient(135deg, #2563eb, #7c3aed)' }}
        >
          {isLoading
            ? (isHost ? 'Creating...' : 'Joining...')
            : (isHost ? 'Create Incident Room' : 'Join Incident Room')}
        </button>
        {!participantName.trim() && !isLoading && (
          <p className="mt-2 text-[10px] text-white/30 text-center">Enter your name to continue</p>
        )}
        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

        <button
          onClick={handleBackToHome}
          className="mt-3 text-xs text-white/30 hover:text-white/60 transition-colors w-full text-center"
        >
          ← Back
        </button>
      </Card>
    );
  }

  function PreCallContent() {
    if (mode === 'home') return <HomeScreen />;
    if (mode === 'later') return <CreateForLaterScreen />;
    return <JoinFormScreen />;
  }

  return (
    <div className="relative flex h-dvh min-h-screen flex-col overflow-hidden text-white" style={{ background: '#07111f' }}>
      {/* Ambient glow background — only on pre-call screens */}
      {!showConversation && (
        <>
          <div className="iw-glow-a" />
          <div className="iw-glow-b" />
          <div className="iw-glow-c" />
        </>
      )}

      <div
        className={`relative z-10 flex min-h-0 flex-1 flex-col ${
          showConversation ? 'h-full w-full items-stretch justify-start' : 'items-center justify-center px-4 py-8'
        }`}
      >
        {/* Landing tagline — only on home screen */}
        {!showConversation && mode === 'home' && (
          <div className="mb-6 w-full flex justify-center animate-fade-up">
            <p className="text-[11px] font-semibold tracking-[0.28em] text-cyan-400/70 uppercase">
              Listen · Understand · Detect · Coordinate · Act
            </p>
          </div>
        )}

        {!showConversation ? (
          <PreCallContent />
        ) : agoraData && rtmClient ? (
          <div className="h-full w-full max-w-none items-stretch gap-0 px-0 text-left flex flex-col flex-1 min-h-0">
            {agentJoinError && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-md text-red-400 text-sm max-w-sm m-2">
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
          </div>
        ) : (
          <p className="text-sm text-white/40">Failed to load conversation data.</p>
        )}
      </div>

      {/* Attribution footer */}
      <footer className="fixed bottom-0 right-0 z-40 py-4 pr-4 md:py-6 md:pr-6">
        <div className="flex items-center justify-end gap-2 text-white/30">
          <span className="text-xs font-medium tracking-wide uppercase">Powered by</span>
          <a
            href="https://agora.io/en/"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:opacity-70 transition-opacity"
            aria-label="Visit Agora's website"
          >
            <Image
              src="/agora-logo-rgb-blue.svg"
              alt="Agora"
              width={86}
              height={24}
              priority
              className="h-6 w-auto translate-y-1 opacity-50 hover:opacity-70 transition-opacity"
            />
            <span className="sr-only">Agora</span>
          </a>
        </div>
      </footer>
    </div>
  );
}
