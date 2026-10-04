import { Circle, LoaderCircle, Mic, Music, Plus, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { VideoItem } from '../../types';
import { encodeWav } from '../../engine/audio';
import { importSfx, renderSfx, SFX } from '../../engine/sfx';
import { pickFiles } from '../../lib/device';
import { haptic } from '../../lib/haptics';
import { decodeWholeAudio, importFiles } from '../../lib/media';
import { formatTime, isIOS } from '../../lib/util';
import { duration, getEngine, now, pause } from '../../state/runtime';
import { toast, useEditor, useTime } from '../../state/store';
import { addAudio, prettyName } from '../actions';
import { Segmented, Sheet, Toggle } from '../common';

type Tab = 'music' | 'sfx' | 'record';
let lastTab: Tab = 'music';

const TABS: { value: Tab; label: string }[] = [
  { value: 'music', label: 'Music' },
  { value: 'sfx', label: 'Sound effects' },
  { value: 'record', label: 'Record' },
];

type AudioSessionNav = Navigator & { audioSession?: { type: string } };
function setSessionType(type: string) {
  try {
    const nav = navigator as AudioSessionNav;
    if (nav.audioSession) nav.audioSession.type = type;
  } catch {
    /* not supported */
  }
}

/** Start time for new audio: the playhead, or the beginning when the playhead is at the very end. */
function startAt(): number {
  const t = now();
  return t >= duration() - 0.1 ? 0 : t;
}

function useAlive() {
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}

export function AudioSheet({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>(lastTab);
  const [busy, setBusy] = useState<string | null>(null);

  const change = (t: Tab) => {
    if (busy) return toast(busy);
    lastTab = t;
    setTab(t);
  };

  return (
    <Sheet title="Audio" onClose={onClose} busy={busy} closeIcon={tab === 'record' ? 'check' : 'x'}>
      <Segmented label="Audio type" value={tab} options={TABS} onChange={change} />
      {tab === 'music' && <MusicPane onClose={onClose} />}
      {tab === 'sfx' && <SfxPane onClose={onClose} />}
      {tab === 'record' && <RecordPane onBusy={setBusy} />}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------

function MusicPane({ onClose }: { onClose: () => void }) {
  const alive = useAlive();
  const original = useEditor((s) => {
    const vids = (s.project?.main ?? []).filter((m): m is VideoItem => m.type === 'video');
    if (!vids.length) return -1;
    return vids.some((v) => !v.muted) ? 1 : 0;
  });

  const choose = () => {
    // The picker must open inside the tap.
    void pickFiles('audio/*,video/*', false).then(async (files) => {
      const f = files[0];
      if (!f) return;
      const s = useEditor.getState();
      s.setTask({ label: 'Adding music…', progress: null });
      try {
        const { assets, errors } = await importFiles([f]);
        const a = assets[0];
        if (!a) return toast(errors[0] ? `Couldn't add ${errors[0]}` : "Couldn't add that file", 'error');
        if (a.kind === 'image') return toast('Choose a song or a video with sound', 'error');
        if (!a.hasAudio) return toast('That file has no sound', 'error');
        if (!useEditor.getState().project) return;
        addAudio(a, 'music', startAt(), a.kind === 'video' ? `${prettyName(a.name)} sound` : undefined, true);
        haptic('light');
        if (alive.current) onClose();
      } finally {
        useEditor.getState().setTask(null);
      }
    });
  };

  const setOriginal = (on: boolean) =>
    useEditor.getState().apply((d) => {
      for (const m of d.main) if (m.type === 'video') m.muted = !on;
    });

  return (
    <>
      <button className="primary-btn block" onClick={choose}>
        <Music size={20} aria-hidden />
        Add music from device
      </button>
      <p className="note">
        Pick a song, or a video to use its sound.
        {isIOS && ' On iPhone, save songs to the Files app first — Apple Music downloads can’t be used.'}
      </p>
      {original >= 0 && (
        <Toggle checked={original === 1} onChange={setOriginal} label="Original sound" hint="Sound recorded with your video clips" />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function SfxPane({ onClose }: { onClose: () => void }) {
  const alive = useAlive();
  const adding = useRef(false);

  const add = (id: string, name: string) => {
    if (adding.current) return;
    adding.current = true;
    const t = now();
    pause();
    importSfx(id)
      .then((asset) => {
        if (!useEditor.getState().project) return;
        addAudio(asset, 'sfx', t, name, true);
        haptic('light');
        if (alive.current) onClose();
      })
      .catch(() => toast("Couldn't add that sound", 'error'))
      .finally(() => {
        adding.current = false;
      });
  };

  return (
    <>
      <p className="note">Tap a sound to hear it. Added sounds start at the playhead.</p>
      <div className="sfx-grid">
        {SFX.map((s) => (
          <div key={s.id} className="sfx">
            <button className="name" aria-label={`Play ${s.name}`} onClick={() => void getEngine()?.audio.preview(renderSfx(s.id))}>
              <span aria-hidden>{s.emoji}</span>
              <span>
                {s.name} <small className="tnum">{s.duration.toFixed(1)}s</small>
              </span>
            </button>
            <button className="icon-btn" aria-label={`Add ${s.name}`} onClick={() => add(s.id, s.name)}>
              <Plus size={20} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Voiceover. Two taps: the first turns the mic on (a permission prompt breaks the
// tap on iOS), the second records while the video plays from the playhead.

type Phase = 'idle' | 'enabling' | 'ready' | 'recording' | 'saving';

function pickMime(): string {
  const list = isIOS
    ? ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
    : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return list.find((m) => MediaRecorder.isTypeSupported?.(m)) ?? '';
}

interface RecState {
  alive: boolean;
  ctx: AudioContext | null;
  stream: MediaStream | null;
  rec: MediaRecorder | null;
  chunks: Blob[];
  discard: boolean;
  raf: number;
  timer: number;
  level: number;
  startT: number;
  startedPlayback: boolean;
  unsub: (() => void) | null;
}

function RecordPane({ onBusy }: { onBusy: (msg: string | null) => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [hear, setHear] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const meter = useRef<HTMLElement>(null);
  const r = useRef<RecState>({
    alive: false,
    ctx: null,
    stream: null,
    rec: null,
    chunks: [],
    discard: false,
    raf: 0,
    timer: 0,
    level: 0,
    startT: 0,
    startedPlayback: false,
    unsub: null,
  });

  useEffect(() => {
    onBusy(phase === 'recording' ? 'Stop recording first' : phase === 'saving' ? 'Saving your recording…' : null);
  }, [phase, onBusy]);

  useEffect(() => {
    const s = r.current;
    s.alive = true;
    return () => {
      s.alive = false;
      s.discard = true;
      s.unsub?.();
      clearInterval(s.timer);
      cancelAnimationFrame(s.raf);
      if (s.rec && s.rec.state !== 'inactive') {
        try {
          s.rec.stop();
        } catch {
          /* already stopped */
        }
        if (s.startedPlayback) pause();
      }
      s.stream?.getTracks().forEach((t) => t.stop());
      void s.ctx?.close().catch(() => undefined);
      getEngine()?.audio.setMuted(false);
      setSessionType('playback');
      onBusy(null);
    };
  }, [onBusy]);

  const enable = () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('This browser can’t record audio.');
      return;
    }
    const s = r.current;
    // The meter's audio context has to be created and resumed inside the tap on iOS.
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext();
      void ctx.resume().catch(() => undefined);
    } catch {
      ctx = null;
    }
    setSessionType('play-and-record');
    setPhase('enabling');
    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then(
        (stream) => {
          if (!s.alive) {
            stream.getTracks().forEach((t) => t.stop());
            void ctx?.close().catch(() => undefined);
            return;
          }
          s.stream = stream;
          s.ctx = ctx;
          if (ctx) startMeter(ctx, stream);
          setPhase('ready');
        },
        (e: unknown) => {
          void ctx?.close().catch(() => undefined);
          setSessionType('playback');
          if (!s.alive) return;
          const name = (e as DOMException)?.name;
          setPhase('idle');
          setError(
            name === 'NotAllowedError'
              ? 'Microphone access is blocked. Allow it for this site in your browser settings, then try again.'
              : name === 'NotFoundError'
                ? 'No microphone was found.'
                : 'Couldn’t turn on the microphone.',
          );
        },
      );
  };

  const startMeter = (ctx: AudioContext, stream: MediaStream) => {
    const s = r.current;
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    // Routed to a silent output so every browser keeps the analyzer running.
    ctx.createMediaStreamSource(stream).connect(an).connect(mute).connect(ctx.destination);
    const buf = new Uint8Array(an.fftSize);
    const tick = () => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const raw = Math.min(1, Math.sqrt(sum / buf.length) * 4);
      s.level = Math.max(raw, s.level * 0.85);
      if (meter.current) meter.current.style.width = `${Math.round(s.level * 100)}%`;
      s.raf = requestAnimationFrame(tick);
    };
    s.raf = requestAnimationFrame(tick);
  };

  const record = () => {
    const s = r.current;
    if (!s.stream) return;
    setError(null);
    pause();
    s.startT = now();
    const mime = pickMime();
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(s.stream, mime ? { mimeType: mime, audioBitsPerSecond: 128_000 } : { audioBitsPerSecond: 128_000 });
    } catch {
      try {
        rec = new MediaRecorder(s.stream);
      } catch {
        setError('Couldn’t start recording.');
        return;
      }
    }
    s.chunks = [];
    s.discard = false;
    rec.ondataavailable = (e) => {
      if (e.data.size) s.chunks.push(e.data);
    };
    rec.onstop = () => void save(rec.mimeType || mime || 'audio/webm');
    rec.start(250);
    s.rec = rec;

    // Play the video so you can talk over it (muted unless you want to hear it).
    const eng = getEngine();
    eng?.audio.setMuted(!hear);
    s.startedPlayback = false;
    if (eng && s.startT < duration() - 0.05) {
      eng.play();
      s.startedPlayback = eng.playing;
    }
    if (s.startedPlayback) {
      // Stops when the video ends or is paused.
      s.unsub = useTime.subscribe((st) => {
        if (!st.playing) stop();
      });
    }
    const t0 = performance.now();
    setElapsed(0);
    s.timer = window.setInterval(() => setElapsed((performance.now() - t0) / 1000), 200);
    setPhase('recording');
    haptic('medium');
  };

  const stop = () => {
    const s = r.current;
    if (!s.rec || s.rec.state === 'inactive') return;
    s.unsub?.();
    s.unsub = null;
    clearInterval(s.timer);
    if (s.startedPlayback) pause();
    getEngine()?.audio.setMuted(false);
    setPhase('saving');
    s.rec.stop();
  };

  const save = async (mime: string) => {
    const s = r.current;
    const chunks = s.chunks;
    s.chunks = [];
    s.rec = null;
    if (s.discard) return;
    const done = (msg?: string) => {
      if (msg) toast(msg, 'error');
      if (s.alive) setPhase(s.stream ? 'ready' : 'idle');
    };
    const blob = new Blob(chunks, { type: mime });
    if (blob.size < 1000) return done('That recording was too short');
    try {
      const buf = await decodeWholeAudio(blob);
      if (buf.duration < 0.2) return done('That recording was too short');
      const mono = new Float32Array(buf.length);
      const n = buf.numberOfChannels;
      for (let c = 0; c < n; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < d.length; i++) mono[i] += d[i] / n;
      }
      const p = useEditor.getState().project;
      if (!p) return;
      const name = `Voiceover ${p.audios.filter((a) => a.role === 'voice').length + 1}`;
      const file = new File([encodeWav([mono], buf.sampleRate)], `${name}.wav`, { type: 'audio/wav' });
      const { assets, errors } = await importFiles([file]);
      const a = assets[0];
      if (!a) throw new Error(errors[0] ?? 'import failed');
      if (!useEditor.getState().project) return;
      addAudio(a, 'voice', s.startT, name, true);
      haptic('light');
      toast(`${name} added`, 'success');
      done();
    } catch {
      done('Couldn’t save the recording. Try again.');
    }
  };

  const toggleHear = (v: boolean) => {
    setHear(v);
    if (phase === 'recording') getEngine()?.audio.setMuted(!v);
  };

  const live = phase === 'ready' || phase === 'recording';
  const caption =
    phase === 'idle'
      ? 'Turn on the microphone to record a voiceover'
      : phase === 'enabling'
        ? 'Waiting for the microphone…'
        : phase === 'ready'
          ? 'Tap to record. The video plays from the playhead while you talk.'
          : phase === 'recording'
            ? 'Recording — tap to stop'
            : 'Saving…';

  return (
    <>
      <div className="rec">
        {live && (
          <div className="big-value" aria-live="off">
            {formatTime(phase === 'recording' ? elapsed : 0, true)}
          </div>
        )}
        {live && (
          <div className="meter" aria-hidden>
            <i ref={meter} style={{ width: '0%' }} />
          </div>
        )}
        {phase === 'idle' && (
          <button className="rec-btn" aria-label="Turn on microphone" onClick={enable}>
            <Mic size={30} />
          </button>
        )}
        {phase === 'ready' && (
          <button className="rec-btn" aria-label="Start recording" onClick={record}>
            <Circle size={28} fill="currentColor" />
          </button>
        )}
        {phase === 'recording' && (
          <button className="rec-btn recording" aria-label="Stop recording" onClick={stop}>
            <Square size={26} fill="currentColor" />
          </button>
        )}
        {(phase === 'enabling' || phase === 'saving') && (
          <button className="rec-btn" aria-label={caption} disabled>
            <LoaderCircle size={28} className="spin" />
          </button>
        )}
        <p className="note" role="status">
          {caption}
        </p>
      </div>
      {error && <p className="error-text">{error}</p>}
      <Toggle checked={hear} onChange={toggleHear} label="Hear video while recording" hint="Use headphones so the mic doesn’t pick it up" />
    </>
  );
}
