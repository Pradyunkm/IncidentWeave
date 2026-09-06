'use client';

import { useEffect, useMemo, useRef } from 'react';

export type TranscriptMessage = {
  turn_id?: string | number;
  uid: number | string;
  text?: string;
  createdAt?: number;
  speakerName?: string;
  speakerRole?: string;
  isAgent?: boolean;
  status?: unknown;
};

type QuickstartTranscriptPanelProps = {
  messageList: TranscriptMessage[];
  currentInProgressMessage: TranscriptMessage | null;
  agentUID: string;
  /** The local user's own RTC UID — used to label their turns as "You" */
  localUID?: string;
  /** Live room roster for resolving names and roles */
  roster?: Record<string, { uid: string; name: string; role: string }>;
  /** Current participant's display name */
  currentUserName?: string;
};

function formatMessageTime(createdAt?: number) {
  if (!createdAt) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(createdAt));
}

function getInitials(name: string): string {
  return (name || '')
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || 'U';
}

export function QuickstartTranscriptPanel({
  messageList,
  currentInProgressMessage,
  agentUID,
  localUID,
  roster = {},
  currentUserName,
}: QuickstartTranscriptPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = useMemo(
    () =>
      currentInProgressMessage
        ? [...messageList, currentInProgressMessage]
        : messageList,
    [currentInProgressMessage, messageList],
  );

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages]);

  return (
    <section
      className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-2xl border border-border bg-card/20"
      aria-label="Transcription panel"
    >
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">Transcript</h2>
            <span className="flex h-2 w-2 rounded-full bg-emerald-400 animate-pulse" title="Live sync" />
          </div>
          <p className="text-[11px] text-muted-foreground">Shared live voice turns for all participants</p>
        </div>
        <span className="rounded-full bg-white/5 border border-white/10 px-2 py-0.5 text-[10px] font-medium text-white/50">
          {messages.length} {messages.length === 1 ? 'turn' : 'turns'}
        </span>
      </div>

      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 py-4"
      >
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground gap-2">
            <svg className="w-8 h-8 text-white/20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 100-6 3 3 0 000 6z" />
            </svg>
            <p>Start speaking to see the live shared transcript here.</p>
            <p className="text-xs text-white/30">Turns are broadcast to everyone in the room with speaker names.</p>
          </div>
        ) : (
          messages.map((message, index) => {
            const uidStr = String(message.uid);
            const isAgent =
              Boolean(message.isAgent) ||
              uidStr === agentUID ||
              uidStr === '100';
            const isLocal = !isAgent && Boolean(localUID && uidStr === localUID);

            // Resolve speaker name:
            // 1. Explicit speakerName attached to message
            // 2. Roster entry lookup by UID
            // 3. Local user's currentUserName if local
            // 4. Fallback to User <UID>
            const resolvedName =
              message.speakerName ||
              roster[uidStr]?.name ||
              (isLocal && currentUserName ? currentUserName : undefined) ||
              (isAgent ? 'IncidentWeave AI' : `User ${uidStr}`);

            const resolvedRole =
              message.speakerRole ||
              roster[uidStr]?.role ||
              (isAgent ? 'AI Incident Commander' : '');

            const displayName = isAgent
              ? 'IncidentWeave AI'
              : isLocal
                ? `${resolvedName} (You)`
                : resolvedName;

            const text = message.text?.trim();
            const time = formatMessageTime(message.createdAt);
            const isPartial = message === currentInProgressMessage;
            const initials = isAgent ? 'AI' : getInitials(resolvedName);

            return (
              <article
                key={`${message.turn_id ?? message.uid}-${index}`}
                className={`flex flex-col ${isAgent ? 'items-start' : isLocal ? 'items-end' : 'items-start'}`}
              >
                {/* Speaker Header */}
                <div
                  className={`mb-1 flex items-center gap-1.5 px-1 text-xs ${
                    isLocal ? 'flex-row-reverse' : 'flex-row'
                  }`}
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white shadow-sm ${
                      isAgent
                        ? 'bg-gradient-to-br from-violet-500 to-indigo-600'
                        : isLocal
                          ? 'bg-gradient-to-br from-cyan-500 to-blue-600'
                          : 'bg-gradient-to-br from-indigo-500 to-purple-600'
                    }`}
                  >
                    {initials}
                  </span>
                  <span className={`font-semibold ${isAgent ? 'text-violet-300' : isLocal ? 'text-cyan-300' : 'text-indigo-300'}`}>
                    {displayName}
                  </span>
                  {resolvedRole && (
                    <span className="rounded bg-white/5 px-1 py-0.2 text-[9px] font-medium text-white/40 border border-white/5">
                      {resolvedRole}
                    </span>
                  )}
                  {time && <span className="text-[10px] text-muted-foreground font-normal">{time}</span>}
                  {isPartial && (
                    <span className="flex items-center gap-1 text-[10px] font-medium text-amber-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping" />
                      speaking…
                    </span>
                  )}
                </div>

                {/* Message Bubble */}
                <div
                  className={`max-w-[90%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed border shadow-sm transition-all ${
                    isAgent
                      ? 'border-violet-500/20 bg-[#171626] text-slate-100 rounded-tl-sm'
                      : isLocal
                        ? 'border-cyan-500/30 bg-cyan-950/30 text-white rounded-tr-sm shadow-cyan-950/20'
                        : 'border-indigo-500/25 bg-indigo-950/25 text-slate-100 rounded-tl-sm'
                  } ${isPartial ? 'ring-1 ring-amber-400/40' : ''}`}
                >
                  {text || '...'}
                </div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
