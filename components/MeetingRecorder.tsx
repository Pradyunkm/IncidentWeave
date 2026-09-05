'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import type { ILocalAudioTrack, IAgoraRTCRemoteUser } from 'agora-rtc-react';

interface MeetingRecorderProps {
  localMicrophoneTrack: ILocalAudioTrack | null | undefined;
  remoteUsers: IAgoraRTCRemoteUser[];
  incidentId: string;
}

export function MeetingRecorder({
  localMicrophoneTrack,
  remoteUsers,
  incidentId,
}: MeetingRecorderProps) {
  const [recordingState, setRecordingState] = useState<'idle' | 'recording' | 'paused'>('idle');
  const [duration, setDuration] = useState(0);
  const [lastDownloadUrl, setLastDownloadUrl] = useState<string | null>(null);
  const [lastDownloadName, setLastDownloadName] = useState<string | null>(null);
  const [downloadSuccessToast, setDownloadSuccessToast] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const destinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const connectedTracksRef = useRef<Set<string>>(new Set());
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Helper to connect a MediaStreamTrack to the mixer AudioContext
  const connectTrackToMixer = useCallback((track: MediaStreamTrack) => {
    if (!audioContextRef.current || !destinationRef.current) return;
    if (connectedTracksRef.current.has(track.id)) return;

    try {
      const stream = new MediaStream([track]);
      const source = audioContextRef.current.createMediaStreamSource(stream);
      source.connect(destinationRef.current);
      connectedTracksRef.current.add(track.id);

      track.onended = () => {
        connectedTracksRef.current.delete(track.id);
      };
    } catch (err) {
      console.warn('[MeetingRecorder] Could not connect track to mixer:', err);
    }
  }, []);

  // Dynamically connect any newly active remote audio tracks while recording
  useEffect(() => {
    if (recordingState === 'idle') return;

    remoteUsers.forEach(user => {
      if (user.hasAudio && user.audioTrack) {
        const msTrack = user.audioTrack.getMediaStreamTrack();
        if (msTrack) {
          connectTrackToMixer(msTrack);
        }
      }
    });
  }, [remoteUsers, recordingState, connectTrackToMixer]);

  // Duration timer
  useEffect(() => {
    if (recordingState === 'recording') {
      timerRef.current = setInterval(() => {
        setDuration(d => d + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [recordingState]);

  // Start recording
  const startRecording = useCallback(async () => {
    try {
      // 1. Create Web Audio context & destination node
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
      audioContextRef.current = ctx;
      const destination = ctx.createMediaStreamDestination();
      destinationRef.current = destination;
      connectedTracksRef.current.clear();
      chunksRef.current = [];

      // 2. Connect local microphone
      if (localMicrophoneTrack) {
        const localTrack = localMicrophoneTrack.getMediaStreamTrack();
        if (localTrack) {
          connectTrackToMixer(localTrack);
        }
      }

      // 3. Connect all current remote users
      remoteUsers.forEach(user => {
        if (user.hasAudio && user.audioTrack) {
          const remoteTrack = user.audioTrack.getMediaStreamTrack();
          if (remoteTrack) {
            connectTrackToMixer(remoteTrack);
          }
        }
      });

      // 4. Select supported mime type
      let mimeType = 'audio/webm;codecs=opus';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/webm';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = 'audio/mp4';
          if (!MediaRecorder.isTypeSupported(mimeType)) {
            mimeType = '';
          }
        }
      }

      const recorder = mimeType
        ? new MediaRecorder(destination.stream, { mimeType })
        : new MediaRecorder(destination.stream);

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' });
        const url = URL.createObjectURL(blob);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `IncidentWeave-${incidentId}-${timestamp}.webm`;

        setLastDownloadUrl(url);
        setLastDownloadName(filename);

        // Auto trigger download
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        setDownloadSuccessToast(true);
        setTimeout(() => setDownloadSuccessToast(false), 5000);

        // Cleanup audio context
        try {
          if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
            audioContextRef.current.close();
          }
        } catch {}
      };

      recorder.start(1000); // chunk every 1 second
      mediaRecorderRef.current = recorder;
      setDuration(0);
      setRecordingState('recording');
    } catch (err) {
      console.error('[MeetingRecorder] Failed to start recording:', err);
      alert('Could not start audio recording. Please check browser permissions.');
    }
  }, [localMicrophoneTrack, remoteUsers, incidentId, connectTrackToMixer]);

  // Pause / Resume
  const togglePause = useCallback(() => {
    if (!mediaRecorderRef.current) return;
    if (recordingState === 'recording') {
      mediaRecorderRef.current.pause();
      setRecordingState('paused');
    } else if (recordingState === 'paused') {
      mediaRecorderRef.current.resume();
      setRecordingState('recording');
    }
  }, [recordingState]);

  // Stop recording
  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setRecordingState('idle');
  }, []);

  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const remaining = secs % 60;
    return `${mins.toString().padStart(2, '0')}:${remaining.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex items-center gap-2">
      {recordingState === 'idle' ? (
        <button
          onClick={startRecording}
          className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-400 hover:bg-red-500/20 hover:border-red-500/60 transition-all shadow-sm"
          title="Record meeting audio"
          aria-label="Start recording meeting"
        >
          <span className="h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse" />
          <span>Record</span>
        </button>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-950/40 px-2.5 py-1 text-xs text-white backdrop-blur-sm shadow-md animate-in fade-in">
          <div className="flex items-center gap-1.5 font-mono font-medium text-red-400">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                recordingState === 'recording' ? 'bg-red-500 animate-ping' : 'bg-amber-400'
              }`}
            />
            <span>{formatTime(duration)}</span>
            {recordingState === 'paused' && (
              <span className="text-[10px] uppercase text-amber-400 font-sans tracking-wide">
                (PAUSED)
              </span>
            )}
          </div>

          <div className="h-3 w-px bg-white/20 mx-0.5" />

          {/* Pause / Resume */}
          <button
            onClick={togglePause}
            className="p-1 rounded text-white/70 hover:text-white hover:bg-white/10 transition-colors"
            title={recordingState === 'recording' ? 'Pause recording' : 'Resume recording'}
            aria-label={recordingState === 'recording' ? 'Pause recording' : 'Resume recording'}
          >
            {recordingState === 'recording' ? (
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          {/* Stop & Save */}
          <button
            onClick={stopRecording}
            className="flex items-center gap-1 rounded bg-red-600 hover:bg-red-500 px-2 py-0.5 text-[11px] font-semibold text-white transition-colors"
            title="Stop and save recording"
            aria-label="Stop and save recording"
          >
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="6" width="12" height="12" rx="1" />
            </svg>
            <span>Stop & Save</span>
          </button>
        </div>
      )}

      {/* Download toast / direct link */}
      {lastDownloadUrl && recordingState === 'idle' && (
        <a
          href={lastDownloadUrl}
          download={lastDownloadName ?? 'incident-recording.webm'}
          className="flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] text-white/70 hover:text-white hover:border-white/30 transition-colors"
          title="Download latest saved recording"
        >
          <svg className="w-3.5 h-3.5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          <span>Recording Saved</span>
        </a>
      )}

      {downloadSuccessToast && (
        <span className="text-[11px] font-medium text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded px-2 py-0.5 animate-in fade-in">
          ✓ Downloaded!
        </span>
      )}
    </div>
  );
}
