'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { RTMClient } from 'agora-rtm';

export interface ChatMessage {
  id: string;
  from: string;        // sender UID
  fromName: string;
  fromRole: string;
  to: 'group' | string; // 'group' or target UID
  text: string;
  timestamp: number;
  isOwn: boolean;
}

interface RosterEntry {
  uid: string;
  name: string;
  role: string;
}

interface MeetingChatProps {
  rtmClient: RTMClient;
  channelName: string;
  myUid: string;
  myName: string;
  myRole: string;
  incidentId: string;
  roster: Record<string, RosterEntry>;   // uid → { name, role }
}

const RTM_CHAT_TYPE = 'incidentweave_chat';

export function MeetingChat({
  rtmClient,
  channelName,
  myUid,
  myName,
  myRole,
  incidentId,
  roster,
}: MeetingChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tab, setTab] = useState<'group' | 'dm'>('group');
  const [dmTarget, setDmTarget] = useState<string>(''); // target UID for DM
  const [input, setInput] = useState('');
  const [unreadGroup, setUnreadGroup] = useState(0);
  const [unreadDm, setUnreadDm] = useState<Record<string, number>>({});
  const bottomRef = useRef<HTMLDivElement>(null);

  // Fetch historical messages on mount
  useEffect(() => {
    fetch(`/api/chat/messages?id=${encodeURIComponent(incidentId)}`)
      .then(r => r.json())
      .then(data => {
        if (data.messages) {
          setMessages(data.messages.map((m: ChatMessage) => ({
            ...m,
            isOwn: m.from === myUid,
          })));
        }
      })
      .catch(() => {});
  }, [incidentId, myUid]);

  // Listen for incoming RTM chat messages
  useEffect(() => {
    const handleMessage = (event: { message: string | Uint8Array; publisher: string }) => {
      let parsed: Record<string, unknown>;
      try {
        const text = typeof event.message === 'string'
          ? event.message
          : new TextDecoder().decode(event.message);
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      if (parsed.type !== RTM_CHAT_TYPE) return;

      const msg: ChatMessage = {
        id: parsed.id as string,
        from: event.publisher,
        fromName: (parsed.fromName as string) || roster[event.publisher]?.name || `UID ${event.publisher}`,
        fromRole: (parsed.fromRole as string) || roster[event.publisher]?.role || '',
        to: parsed.to as 'group' | string,
        text: parsed.text as string,
        timestamp: parsed.timestamp as number,
        isOwn: false,
      };

      setMessages(prev => {
        if (prev.some(m => m.id === msg.id)) return prev;
        return [...prev, msg];
      });

      // Unread badge logic
      if (msg.to === 'group' && tab !== 'group') {
        setUnreadGroup(n => n + 1);
      }
      if (msg.to === myUid && (tab !== 'dm' || dmTarget !== msg.from)) {
        setUnreadDm(prev => ({ ...prev, [msg.from]: (prev[msg.from] ?? 0) + 1 }));
      }
    };

    rtmClient.addEventListener('message', handleMessage);
    return () => rtmClient.removeEventListener('message', handleMessage);
  }, [rtmClient, roster, tab, dmTarget, myUid]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, tab, dmTarget]);

  // Clear unread badge when switching to that tab/dm
  useEffect(() => {
    if (tab === 'group') setUnreadGroup(0);
    if (tab === 'dm' && dmTarget) {
      setUnreadDm(prev => ({ ...prev, [dmTarget]: 0 }));
    }
  }, [tab, dmTarget]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text) return;

    const isGroup = tab === 'group';
    const to = isGroup ? 'group' : dmTarget;
    if (!isGroup && !to) return;

    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      from: myUid,
      fromName: myName,
      fromRole: myRole,
      to,
      text,
      timestamp: Date.now(),
      isOwn: true,
    };

    const payload = JSON.stringify({
      type: RTM_CHAT_TYPE,
      id: msg.id,
      fromName: myName,
      fromRole: myRole,
      to,
      text,
      timestamp: msg.timestamp,
    });

    try {
      if (isGroup) {
        await rtmClient.publish(channelName, payload);
      } else {
        // Direct message to specific UID
        await (rtmClient as RTMClient & {
          publish: (channel: string, msg: string, opts?: { channelType?: string }) => Promise<void>
        }).publish(dmTarget, payload, { channelType: 'USER' });
      }

      // Persist to Redis
      fetch('/api/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ incidentId, message: msg }),
      }).catch(() => {});

      setMessages(prev => [...prev, msg]);
      setInput('');
    } catch (err) {
      console.error('[MeetingChat] send error:', err);
    }
  }, [input, tab, dmTarget, myUid, myName, myRole, rtmClient, channelName, incidentId]);

  // Other participants from roster (excluding self)
  const peers = Object.values(roster).filter(p => p.uid !== myUid);

  // Filter messages for current view
  const visibleMessages = messages.filter(m => {
    if (tab === 'group') return m.to === 'group';
    // DM: messages between me and dmTarget in either direction
    return (
      (m.from === myUid && m.to === dmTarget) ||
      (m.from === dmTarget && m.to === myUid)
    );
  });

  return (
    <div className="flex flex-col h-full bg-[#0d1421] border-l border-white/10">
      {/* Header + Tabs */}
      <div className="flex-shrink-0 border-b border-white/10">
        <div className="px-3 py-2.5 flex items-center gap-2">
          <svg className="w-4 h-4 text-white/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <span className="text-xs font-semibold text-white/60 uppercase tracking-widest">Chat</span>
        </div>
        <div className="flex border-b border-white/10">
          <button
            onClick={() => setTab('group')}
            className={`relative flex-1 py-2 text-xs font-medium border-b-2 transition-colors ${
              tab === 'group'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-white/40 hover:text-white/60'
            }`}
          >
            Group
            {unreadGroup > 0 && (
              <span className="absolute top-1.5 right-2 min-w-[16px] h-4 rounded-full bg-blue-500 text-white text-[9px] font-bold flex items-center justify-center px-1">
                {unreadGroup}
              </span>
            )}
          </button>
          <button
            onClick={() => setTab('dm')}
            className={`relative flex-1 py-2 text-xs font-medium border-b-2 transition-colors ${
              tab === 'dm'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-white/40 hover:text-white/60'
            }`}
          >
            Direct
            {Object.values(unreadDm).some(n => n > 0) && (
              <span className="absolute top-1.5 right-2 min-w-[16px] h-4 rounded-full bg-violet-500 text-white text-[9px] font-bold flex items-center justify-center px-1">
                {Object.values(unreadDm).reduce((a, b) => a + b, 0)}
              </span>
            )}
          </button>
        </div>

        {/* DM target selector */}
        {tab === 'dm' && (
          <div className="px-3 py-2">
            {peers.length === 0 ? (
              <p className="text-xs text-white/30 text-center py-1">No other participants yet</p>
            ) : (
              <select
                value={dmTarget}
                onChange={e => setDmTarget(e.target.value)}
                className="w-full rounded-md border border-white/10 bg-[#1a1f2e] px-2.5 py-1.5 text-xs text-white focus:border-blue-500 focus:outline-none"
              >
                <option value="">Select a participant…</option>
                {peers.map(p => (
                  <option key={p.uid} value={p.uid}>
                    {p.name} ({p.role})
                    {(unreadDm[p.uid] ?? 0) > 0 ? ` · ${unreadDm[p.uid]} new` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2 min-h-0">
        {visibleMessages.length === 0 && (
          <p className="text-xs text-white/25 text-center py-8">
            {tab === 'group'
              ? 'No messages yet — say something!'
              : dmTarget
                ? 'No messages with this person yet'
                : 'Select a participant to start a direct message'}
          </p>
        )}
        {visibleMessages.map(m => (
          <div key={m.id} className={`flex ${m.isOwn ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] ${m.isOwn ? 'items-end' : 'items-start'} flex flex-col gap-0.5`}>
              {!m.isOwn && (
                <div className="flex items-center gap-1.5 px-1">
                  <span className="text-[10px] font-semibold text-white/60">{m.fromName}</span>
                  <span className="text-[9px] text-white/30">{m.fromRole}</span>
                </div>
              )}
              <div
                className={`rounded-xl px-3 py-1.5 text-sm leading-snug break-words ${
                  m.isOwn
                    ? 'bg-blue-600 text-white rounded-tr-sm'
                    : 'bg-white/8 text-white/90 rounded-tl-sm border border-white/10'
                }`}
              >
                {m.text}
              </div>
              <span className="text-[9px] text-white/20 px-1">
                {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex-shrink-0 border-t border-white/10 p-2 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
          placeholder={
            tab === 'group'
              ? 'Message everyone…'
              : dmTarget
                ? `Message ${roster[dmTarget]?.name ?? 'participant'}…`
                : 'Select a participant first'
          }
          disabled={tab === 'dm' && !dmTarget}
          className="flex-1 min-w-0 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white placeholder:text-white/25 focus:border-blue-500 focus:outline-none disabled:opacity-40"
        />
        <button
          onClick={sendMessage}
          disabled={!input.trim() || (tab === 'dm' && !dmTarget)}
          className="flex-shrink-0 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed px-3 py-2 transition-colors"
          aria-label="Send message"
        >
          <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
          </svg>
        </button>
      </div>
    </div>
  );
}
