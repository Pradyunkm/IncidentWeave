'use client';

import { useState, useEffect } from 'react';

interface MeetingInviteModalProps {
  roomId: string;
  isOpen: boolean;
  onClose: () => void;
}

export function MeetingInviteModal({ roomId, isOpen, onClose }: MeetingInviteModalProps) {
  const [networkIp, setNetworkIp] = useState<string | null>(null);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedLink, setCopiedLink] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/network-info')
      .then(res => res.json())
      .then(data => {
        if (data.primaryIp && data.primaryIp !== 'localhost') {
          setNetworkIp(data.primaryIp);
        }
        if (data.publicUrl) {
          setPublicUrl(data.publicUrl);
        }
      })
      .catch(() => {});
  }, []);

  if (!isOpen) return null;

  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const currentPort = typeof window !== 'undefined' ? (window.location.port ? `:${window.location.port}` : '') : ':3000';
  
  // Best links
  const lanUrl = networkIp ? `http://${networkIp}${currentPort}?room=${encodeURIComponent(roomId)}` : null;
  const webUrl = publicUrl ? `${publicUrl}?room=${encodeURIComponent(roomId)}` : `${currentOrigin}?room=${encodeURIComponent(roomId)}`;

  const copyToClipboard = (text: string, type: string) => {
    navigator.clipboard.writeText(text).then(() => {
      if (type === 'code') {
        setCopiedCode(true);
        setTimeout(() => setCopiedCode(false), 2500);
      } else {
        setCopiedLink(type);
        setTimeout(() => setCopiedLink(null), 2500);
      }
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in">
      <div className="relative w-full max-w-md rounded-2xl border border-white/10 bg-[#121722] p-6 shadow-2xl">
        <div className="flex items-center justify-between pb-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-blue-500/20 text-blue-400 flex items-center justify-center text-xs font-bold">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
              </svg>
            </div>
            <h3 className="text-sm font-semibold text-white">Invite Others to Incident Room</h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-white/40 hover:text-white hover:bg-white/5 transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="mt-4 space-y-4">
          {/* 1. ROOM CODE (Easiest way to join) */}
          <div className="rounded-xl border border-blue-500/30 bg-blue-500/10 p-3.5">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-semibold text-blue-400">Option 1: Join by Room Code</span>
              <span className="text-[10px] text-blue-300/70">Recommended</span>
            </div>
            <p className="text-[11px] text-white/50 mb-2">
              Teammates can open the IncidentWeave website and paste this code:
            </p>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={roomId}
                className="flex-1 min-w-0 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs text-white font-mono font-bold tracking-wide select-all focus:outline-none"
              />
              <button
                onClick={() => copyToClipboard(roomId, 'code')}
                className={`rounded-lg px-3 py-2 text-xs font-semibold transition-all ${
                  copiedCode
                    ? 'bg-emerald-500 text-white'
                    : 'bg-blue-600 hover:bg-blue-500 text-white'
                }`}
              >
                {copiedCode ? '✓ Copied' : 'Copy Code'}
              </button>
            </div>
          </div>

          {/* 2. WI-FI / LOCAL NETWORK LINK */}
          {lanUrl && (
            <div className="rounded-xl border border-white/10 bg-white/5 p-3.5">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-semibold text-white/80">Option 2: Teammates on Same Wi-Fi</span>
                <span className="text-[10px] text-white/40">LAN IP</span>
              </div>
              <p className="text-[11px] text-white/50 mb-2">
                Works on phones and laptops connected to the same Wi-Fi network:
              </p>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={lanUrl}
                  className="flex-1 min-w-0 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs text-white/70 font-mono truncate select-all focus:outline-none"
                />
                <button
                  onClick={() => copyToClipboard(lanUrl, 'lan')}
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold transition-all ${
                    copiedLink === 'lan'
                      ? 'border-emerald-500 bg-emerald-500/20 text-emerald-400'
                      : 'border-white/20 bg-white/10 hover:bg-white/20 text-white'
                  }`}
                >
                  {copiedLink === 'lan' ? '✓ Copied' : 'Copy Link'}
                </button>
              </div>
            </div>
          )}

          {/* 3. DIRECT / BROWSER LINK */}
          <div className="rounded-xl border border-white/10 bg-white/5 p-3.5">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-semibold text-white/80">Option 3: Direct Web Link</span>
              <span className="text-[10px] text-white/40">URL</span>
            </div>
            <p className="text-[11px] text-white/50 mb-2">
              {currentOrigin.includes('localhost')
                ? 'For testing in another browser tab or incognito window:'
                : 'Share this URL with your team:'}
            </p>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={webUrl}
                className="flex-1 min-w-0 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs text-white/70 font-mono truncate select-all focus:outline-none"
              />
              <button
                onClick={() => copyToClipboard(webUrl, 'web')}
                className={`rounded-lg border px-3 py-2 text-xs font-semibold transition-all ${
                  copiedLink === 'web'
                    ? 'border-emerald-500 bg-emerald-500/20 text-emerald-400'
                    : 'border-white/20 bg-white/10 hover:bg-white/20 text-white'
                }`}
              >
                {copiedLink === 'web' ? '✓ Copied' : 'Copy Link'}
              </button>
            </div>
          </div>
        </div>

        <div className="mt-5 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-lg bg-white/10 hover:bg-white/15 px-4 py-2 text-xs font-medium text-white transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
