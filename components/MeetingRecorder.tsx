'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import type { ILocalAudioTrack, IAgoraRTCRemoteUser } from 'agora-rtc-react';

interface MeetingRecorderProps {
  localMicrophoneTrack: ILocalAudioTrack | null | undefined;
  remoteUsers: IAgoraRTCRemoteUser[];
  incidentId: string;
  /** Parent assigns a stop function here so it can auto-stop before ending the call */
  onStopRef?: React.MutableRefObject<(() => void) | null>;
}

export function MeetingRecorder({
  localMicrophoneTrack,
  remoteUsers,
  incidentId,
  onStopRef,
}: MeetingRecorderProps) {
  const [recordingState, setRecordingState] = useState<'idle' | 'recording' | 'paused'>('idle');
  const [duration, setDuration] = useState(0);
  const [savedRecordings, setSavedRecordings] = useState<{ url: string; name: string }[]>([]);
  const [downloadSuccessToast, setDownloadSuccessToast] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mimeTypeRef = useRef<string>('audio/webm');
  const audioContextRef = useRef<AudioContext | null>(null);
  const destinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  // Track id → AudioSourceNode so we can disconnect cleanly on unmount
  const connectedTracksRef = useRef<Map<string, MediaStreamAudioSourceNode>>(new Map());
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const blobUrlsRef = useRef<string[]>([]);

  // Revoke all object URLs when component unmounts to prevent memory leaks
  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  // Connect a MediaStreamTrack to the shared mixer AudioContext.
  // Uses a Map so we can properly disconnect nodes on cleanup.
  const connectTrackToMixer = useCallback((track: MediaStreamTrack, label = 'track') => {
    if (!audioContextRef.current || !destinationRef.current) return;
    if (connectedTracksRef.current.has(track.id)) return;
    if (track.readyState === 'ended') return;

    try {
      const stream = new MediaStream([track]);
      const source = audioContextRef.current.createMediaStreamSource(stream);
      source.connect(destinationRef.current);
      connectedTracksRef.current.set(track.id, source);
      console.log(`[MeetingRecorder] Connected ${label} (${track.id})`);

      // Auto-disconnect when the track ends (participant leaves)
      track.addEventListener('ended', () => {
        const node = connectedTracksRef.current.get(track.id);
        if (node) {
          try { node.disconnect(); } catch {}
          connectedTracksRef.current.delete(track.id);
        }
      }, { once: true });
    } catch (err) {
      console.warn('[MeetingRecorder] Could not connect track to mixer:', err);
    }
  }, []);

  // Dynamically connect late-joining remote audio tracks (including AI agent) while recording
  useEffect(() => {
    if (recordingState === 'idle') return;
    remoteUsers.forEach((user) => {
      if (user.hasAudio && user.audioTrack) {
        const msTrack = user.audioTrack.getMediaStreamTrack();
        if (msTrack) connectTrackToMixer(msTrack, `remote-${user.uid}`);
      }
    });
  }, [remoteUsers, recordingState, connectTrackToMixer]);

  // Reconnect local track if mic device switches mid-call
  useEffect(() => {
    if (recordingState === 'idle' || !localMicrophoneTrack) return;
    const msTrack = localMicrophoneTrack.getMediaStreamTrack();
    if (msTrack) connectTrackToMixer(msTrack, 'local');
  }, [localMicrophoneTrack, recordingState, connectTrackToMixer]);

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

  // Core save logic — builds blob, triggers download, tracks URL for cleanup
  const saveRecording = useCallback(() => {
    if (chunksRef.current.length === 0) return;
    const mimeType = mimeTypeRef.current;
    const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' });
    const url = URL.createObjectURL(blob);
    blobUrlsRef.current.push(url); // tracked for cleanup on unmount
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const filename = `IncidentWeave-${incidentId}-${timestamp}.${ext}`;

    setSavedRecordings((prev) => [...prev, { url, name: filename }]);

    // Auto-trigger download
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    setDownloadSuccessToast(true);
    setTimeout(() => setDownloadSuccessToast(false), 5000);

    // Cleanup AudioContext
    try {
      if (audioContextRef.current?.state !== 'closed') {
        audioContextRef.current?.close();
      }
    } catch {}
    audioContextRef.current = null;
    destinationRef.current = null;
    connectedTracksRef.current.clear();
  }, [incidentId]);

  // Internal stop — used by button AND onStopRef (auto-stop on call end)
  const stopRecordingInternal = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    recorder.addEventListener('stop', saveRecording, { once: true });
    recorder.stop();
    setRecordingState('idle');
  }, [saveRecording]);

  // Start recording — mixes local mic + all current and future remote tracks
  const startRecording = useCallback(async () => {
    try {
      // 1. Create AudioContext + mixer destination
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') await ctx.resume();
      audioContextRef.current = ctx;

      const destination = ctx.createMediaStreamDestination();
      destinationRef.current = destination;
      connectedTracksRef.current.clear();
      chunksRef.current = [];

      // 2. Connect local microphone
      if (localMicrophoneTrack) {
        const localTrack = localMicrophoneTrack.getMediaStreamTrack();
        if (localTrack) connectTrackToMixer(localTrack, 'local');
      }

      // 3. Connect all current remote users (includes AI agent audio)
      remoteUsers.forEach((user) => {
        if (user.hasAudio && user.audioTrack) {
          const remoteTrack = user.audioTrack.getMediaStreamTrack();
          if (remoteTrack) connectTrackToMixer(remoteTrack, `remote-${user.uid}`);
        }
      });

      // 4. Pick best supported mime type
      const mimeType = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        '',
      ].find((m) => !m || MediaRecorder.isTypeSupported(m)) ?? '';
      mimeTypeRef.current = mimeType;

      const recorder = mimeType
        ? new MediaRecorder(destination.stream, { mimeType })
        : new MediaRecorder(destination.stream);

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data?.size > 0) chunksRef.current.push(event.data);
      };

      // Expose stop handle to parent for auto-stop on call end
      if (onStopRef) onStopRef.current = stopRecordingInternal;

      recorder.start(1000); // 1-second chunks for reliability
      mediaRecorderRef.current = recorder;
      setDuration(0);
      setRecordingState('recording');
    } catch (err) {
      console.error('[MeetingRecorder] Failed to start recording:', err);
      alert('Could not start audio recording. Please allow microphone access and try again.');
    }
  }, [localMicrophoneTrack, remoteUsers, connectTrackToMixer, onStopRef, stopRecordingInternal]);

  // Pause / Resume
  const togglePause = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    if (recordingState === 'recording') {
      recorder.pause();
      setRecordingState('paused');
    } else if (recordingState === 'paused') {
      recorder.resume();
      setRecordingState('recording');
    }
  }, [recordingState]);

  // Public stop (from button)
  const stopRecording = useCallback(() => {
    stopRecordingInternal();
  }, [stopRecordingInternal]);

  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const remaining = secs % 60;
    return `${mins.toString().padStart(2, '0')}:${remaining.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {recordingState === 'idle' ? (
        <button
          onClick={startRecording}
          className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-400 hover:bg-red-500/20 hover:border-red-500/60 transition-all shadow-sm"
          title="Record all speakers + AI agent audio"
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
            <span>Stop &amp; Save</span>
          </button>
        </div>
      )}

      {/* Download links for all saved recordings */}
      {savedRecordings.length > 0 && recordingState === 'idle' && (
        <div className="flex items-center gap-1">
          {savedRecordings.slice(-2).map((rec, i) => (
            <a
              key={i}
              href={rec.url}
              download={rec.name}
              className="flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] text-white/70 hover:text-white hover:border-white/30 transition-colors"
              title={`Download: ${rec.name}`}
            >
              <svg className="w-3.5 h-3.5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              <span>
                {savedRecordings.length > 1
                  ? `Rec #${savedRecordings.indexOf(rec) + 1}`
                  : 'Recording Saved'}
              </span>
            </a>
          ))}
        </div>
      )}

      {downloadSuccessToast && (
        <span className="text-[11px] font-medium text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded px-2 py-0.5 animate-in fade-in">
          ✓ Downloaded!
        </span>
      )}
    </div>
  );
}
