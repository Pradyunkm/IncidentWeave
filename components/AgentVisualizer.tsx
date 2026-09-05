'use client';

import React from 'react';

export type AgentVisualizerState =
  | 'not-joined'
  | 'joining'
  | 'ambient'
  | 'listening'
  | 'analyzing'
  | 'talking'
  | 'disconnected';

export type AgentVisualizerSize = 'sm' | 'md' | 'lg';

export interface AgentVisualizerProps extends React.HTMLAttributes<HTMLDivElement> {
  state: AgentVisualizerState;
  size?: AgentVisualizerSize;
}

const stateConfig: Record<
  AgentVisualizerState,
  {
    title: string;
    subtitle: string;
    glowColor: string;
    coreColor: string;
    ringColor: string;
    pulseSpeed: string;
  }
> = {
  'not-joined': {
    title: 'Standby',
    subtitle: 'Waiting for agent to join',
    glowColor: 'rgba(100, 116, 139, 0.2)',
    coreColor: 'from-slate-700 to-slate-800',
    ringColor: 'border-slate-600/30',
    pulseSpeed: 'animate-pulse duration-1000',
  },
  'joining': {
    title: 'Connecting',
    subtitle: 'Joining incident channel...',
    glowColor: 'rgba(59, 130, 246, 0.4)',
    coreColor: 'from-blue-600 to-indigo-700',
    ringColor: 'border-blue-400/40',
    pulseSpeed: 'animate-spin duration-3000',
  },
  'ambient': {
    title: 'IncidentWeave Active',
    subtitle: 'Monitoring audio stream for facts & contradictions',
    glowColor: 'rgba(99, 102, 241, 0.35)',
    coreColor: 'from-indigo-600 to-violet-800',
    ringColor: 'border-indigo-400/30',
    pulseSpeed: 'animate-pulse duration-2000',
  },
  'listening': {
    title: 'Listening',
    subtitle: 'Capturing participant speech in real-time',
    glowColor: 'rgba(6, 182, 212, 0.5)',
    coreColor: 'from-cyan-500 to-blue-600',
    ringColor: 'border-cyan-400/50',
    pulseSpeed: 'animate-pulse duration-700',
  },
  'analyzing': {
    title: 'Analyzing',
    subtitle: 'Classifying claims & cross-referencing truth graph...',
    glowColor: 'rgba(245, 158, 11, 0.5)',
    coreColor: 'from-amber-500 to-orange-600',
    ringColor: 'border-amber-400/50',
    pulseSpeed: 'animate-spin duration-1500',
  },
  'talking': {
    title: 'IncidentWeave Speaking',
    subtitle: 'Synthesizing voice response...',
    glowColor: 'rgba(16, 185, 129, 0.6)',
    coreColor: 'from-emerald-500 to-teal-600',
    ringColor: 'border-emerald-400/60',
    pulseSpeed: 'animate-ping duration-1000',
  },
  'disconnected': {
    title: 'Disconnected',
    subtitle: 'Agent has left the channel',
    glowColor: 'rgba(239, 68, 68, 0.3)',
    coreColor: 'from-rose-700 to-red-800',
    ringColor: 'border-rose-500/30',
    pulseSpeed: 'animate-none',
  },
};

const sizeClasses: Record<AgentVisualizerSize, { orb: string; container: string }> = {
  sm: { orb: 'w-24 h-24', container: 'w-32 h-32' },
  md: { orb: 'w-36 h-36', container: 'w-48 h-48' },
  lg: { orb: 'w-48 h-48', container: 'w-64 h-64' },
};

export const AgentVisualizer = React.forwardRef<HTMLDivElement, AgentVisualizerProps>(
  ({ state, size = 'lg', className = '', ...props }, ref) => {
    const config = stateConfig[state] || stateConfig['ambient'];
    const dims = sizeClasses[size] || sizeClasses.lg;

    return (
      <div
        ref={ref}
        className={`flex flex-col items-center justify-center select-none ${className}`}
        {...props}
      >
        {/* Visualizer Sphere */}
        <div className={`relative flex items-center justify-center ${dims.container}`}>
          {/* Ambient Glow Aura */}
          <div
            className="absolute inset-0 rounded-full blur-2xl transition-all duration-700"
            style={{ backgroundColor: config.glowColor }}
          />

          {/* Outer Ripple Ring 1 */}
          <div
            className={`absolute inset-2 rounded-full border border-dashed ${config.ringColor} ${
              state === 'talking' || state === 'listening' ? 'animate-ping opacity-30 duration-1500' : ''
            }`}
          />

          {/* Outer Rotating/Pulsing Ring 2 */}
          <div
            className={`absolute inset-5 rounded-full border-2 ${config.ringColor} ${
              state === 'analyzing' || state === 'joining'
                ? 'animate-spin border-t-transparent'
                : 'animate-pulse'
            }`}
          />

          {/* Central Glowing Core Orb */}
          <div
            className={`relative ${dims.orb} rounded-full bg-gradient-to-tr ${config.coreColor} shadow-2xl flex items-center justify-center overflow-hidden transition-all duration-500`}
            style={{
              boxShadow: `0 0 45px ${config.glowColor}, inset 0 0 25px rgba(255,255,255,0.25)`,
            }}
          >
            {/* Inner Light Reflection */}
            <div className="absolute top-2 left-4 w-8 h-4 bg-white/20 rounded-full blur-[2px] transform -rotate-45" />

            {/* State-specific Animated Icon / Waveform */}
            {state === 'listening' && (
              <div className="flex items-center gap-1">
                <span className="w-1.5 h-6 bg-white/90 rounded-full animate-pulse delay-75" />
                <span className="w-1.5 h-10 bg-white/90 rounded-full animate-pulse delay-150" />
                <span className="w-1.5 h-14 bg-white rounded-full animate-pulse delay-300" />
                <span className="w-1.5 h-10 bg-white/90 rounded-full animate-pulse delay-150" />
                <span className="w-1.5 h-6 bg-white/90 rounded-full animate-pulse delay-75" />
              </div>
            )}

            {state === 'talking' && (
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-8 bg-white rounded-full animate-bounce delay-100" />
                <span className="w-1.5 h-14 bg-white rounded-full animate-bounce delay-200" />
                <span className="w-1.5 h-10 bg-white rounded-full animate-bounce delay-300" />
                <span className="w-1.5 h-16 bg-white rounded-full animate-bounce delay-150" />
                <span className="w-1.5 h-8 bg-white rounded-full animate-bounce delay-75" />
              </div>
            )}

            {state === 'analyzing' && (
              <div className="w-12 h-12 rounded-full border-2 border-white/80 border-t-transparent animate-spin" />
            )}

            {state === 'joining' && (
              <div className="w-10 h-10 rounded-full border-2 border-white/60 border-b-transparent animate-spin" />
            )}

            {state === 'ambient' && (
              <div className="flex items-center justify-center">
                <div className="w-6 h-6 rounded-full bg-white/40 animate-ping duration-2000" />
                <div className="absolute w-4 h-4 rounded-full bg-white/80 shadow-lg" />
              </div>
            )}

            {state === 'not-joined' && (
              <div className="w-4 h-4 rounded-full bg-slate-400/50" />
            )}

            {state === 'disconnected' && (
              <div className="w-5 h-5 rounded-sm bg-red-400/80 rotate-45" />
            )}
          </div>
        </div>

        {/* State Label & Subtitle */}
        <div className="mt-4 text-center">
          <div className="flex items-center justify-center gap-2">
            <span
              className="w-2 h-2 rounded-full animate-pulse"
              style={{ backgroundColor: state === 'disconnected' ? '#ef4444' : '#10b981' }}
            />
            <h3 className="text-sm font-semibold tracking-wide text-foreground uppercase">
              {config.title}
            </h3>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 max-w-xs">
            {config.subtitle}
          </p>
        </div>
      </div>
    );
  }
);

AgentVisualizer.displayName = 'AgentVisualizer';
