'use client';

import type { ReactNode } from 'react';
import Image from 'next/image';
import { Button } from '@/components/ui/button';

type QuickstartConversationLayoutProps = {
  statusPanel: ReactNode;
  pipelineMetrics: ReactNode;
  transcriptPanel: ReactNode;
  visualizer: ReactNode;
  controls: ReactNode;
  headerActions?: ReactNode;
  chatPanel?: ReactNode;
  isChatOpen?: boolean;
  participantsPanel?: ReactNode;
  isParticipantsOpen?: boolean;
  onEndConversation: () => void;
  participantName?: string;
  participantRole?: string;
};

export function QuickstartConversationLayout({
  statusPanel,
  pipelineMetrics,
  transcriptPanel,
  visualizer,
  controls,
  headerActions,
  chatPanel,
  isChatOpen = false,
  participantsPanel,
  isParticipantsOpen = false,
  onEndConversation,
  participantName,
  participantRole,
}: QuickstartConversationLayoutProps) {
  const initials = participantName
    ? participantName
        .split(' ')
        .map((w) => w[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : '?';
  return (
    <div className="flex min-h-0 flex-1 flex-col text-left bg-background text-foreground h-full overflow-hidden">
      <header className="flex shrink-0 flex-col gap-4 border-b border-border px-4 py-3 md:h-[76px] md:flex-row md:items-center md:justify-between md:px-6 md:py-0">
        <div className="flex min-w-0 items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center text-xs font-bold text-white shadow-md shrink-0">
            IW
          </div>
          <div className="flex min-w-0 flex-col justify-center gap-1">
            <span className="truncate text-base md:text-lg font-semibold leading-none tracking-[-0.025em] text-foreground">
              IncidentWeave
            </span>
            {pipelineMetrics}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 md:pr-1">
          {/* Participant identity badge */}
          {participantName && (
            <div
              className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5"
              title={participantRole ? `${participantName} · ${participantRole}` : participantName}
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-violet-600 text-[10px] font-bold text-white shrink-0">
                {initials}
              </span>
              <span className="hidden sm:block text-xs font-semibold text-white/80 truncate max-w-[10rem]">
                {participantName}
              </span>
              {participantRole && (
                <span className="hidden md:block text-[10px] text-white/40 font-medium border-l border-white/10 pl-2">
                  {participantRole}
                </span>
              )}
            </div>
          )}
          {headerActions}
          {statusPanel}
          <Button
            variant="destructive"
            size="sm"
            className="h-8 rounded-md border border-destructive bg-transparent px-3 text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors"
            onClick={onEndConversation}
            aria-label="End conversation"
            title="Leave incident room"
          >
            Leave
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 w-full flex-1 flex-col lg:flex-row overflow-hidden">
        {/* Left: Transcript */}
        <aside className="order-2 h-64 min-h-0 w-full shrink-0 lg:order-1 lg:h-full lg:w-[22rem] xl:w-[25rem] border-t lg:border-t-0 lg:border-r border-border/80">
          {transcriptPanel}
        </aside>

        {/* Center: Visualizer + Controls */}
        <main className="order-1 flex min-h-0 flex-1 flex-col lg:order-2 overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col pb-2 pt-3 md:pb-6 px-4 md:px-6">
            <div className="flex min-h-0 flex-1 items-center justify-center relative">
              {visualizer}
            </div>
            <div className="shrink-0 pt-3">{controls}</div>
          </div>
        </main>

        {/* Right: Participants Panel (when open) */}
        {isParticipantsOpen && participantsPanel && (
          <aside className="order-3 h-72 min-h-0 w-full shrink-0 lg:h-full lg:w-[22rem] xl:w-[25rem] border-t lg:border-t-0 lg:border-l border-border/80 z-20 flex flex-col animate-in slide-in-from-right-4 duration-200">
            {participantsPanel}
          </aside>
        )}

        {/* Right: Chat Panel (when open) */}
        {isChatOpen && chatPanel && (
          <aside className="order-3 h-72 min-h-0 w-full shrink-0 lg:h-full lg:w-[22rem] xl:w-[25rem] border-t lg:border-t-0 lg:border-l border-border/80 z-20 flex flex-col animate-in slide-in-from-right-4 duration-200">
            {chatPanel}
          </aside>
        )}
      </div>
    </div>
  );
}
