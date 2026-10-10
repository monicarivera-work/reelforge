import { Download, Film, ImageDown, LoaderCircle, Share } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  canExport,
  estimateSize,
  exportDims,
  exportVideo,
  renderStill,
  type ExportProgress,
  type ExportQuality,
  type ExportResolution,
  type ExportSettings,
} from '../../engine/export';
import { canEncodeVideo, shareFile } from '../../lib/device';
import { haptic } from '../../lib/haptics';
import { projectDuration } from '../../lib/layout';
import { downloadBlob, formatBytes, formatDuration, formatTime, isAndroid, isIOS, safeFileName } from '../../lib/util';
import { now, pause } from '../../state/runtime';
import { toast, useEditor } from '../../state/store';
import { loadPrefs, Progress, savePrefs, Segmented, Sheet } from '../common';

export const EXPORT_PREFS_KEY = 'rf-export';
export const EXPORT_DEFAULTS: ExportSettings = { resolution: 1080, fps: 30, quality: 'high' };

export function resolutionLabel(r: number): string {
  return r === 1440 ? '2K' : r === 2160 ? '4K' : `${r}p`;
}

const RES_OPTIONS = ([720, 1080, 1440, 2160] as ExportResolution[]).map((r) => ({ value: r, label: resolutionLabel(r) }));
const FPS_OPTIONS = [24, 30, 60].map((f) => ({ value: f, label: String(f) }));
const QUALITY_OPTIONS: { value: ExportQuality; label: string }[] = [
  { value: 'low', label: 'Smaller' },
  { value: 'medium', label: 'Balanced' },
  { value: 'high', label: 'Best' },
];

const PHASES: Record<ExportProgress['phase'], string> = {
  prepare: 'Getting ready…',
  render: 'Saving your video…',
  finalize: 'Finishing up…',
};

const BUSY = 'Your video is still saving — tap Cancel to stop';
/** Above this estimated size, phones may run out of memory (the file is built in memory). */
const BIG_FILE = 500 * 1024 * 1024;

type View =
  | { kind: 'settings' }
  | { kind: 'running'; e: ExportProgress }
  | { kind: 'done'; file: File; url: string; width: number; height: number; duration: number }
  | { kind: 'frame'; file: File; url: string; t: number }
  | { kind: 'error'; message: string };

function formatEta(s: number | null): string {
  if (s === null) return 'Working out the time left…';
  if (s < 10) return 'Almost done';
  if (s < 60) return `About ${Math.round(s / 5) * 5} seconds left`;
  const m = Math.round(s / 60);
  return `About ${m} minute${m === 1 ? '' : 's'} left`;
}

function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/reclaim|background|inactiv/i.test(msg)) return 'Saving stopped because ReelForge went into the background. Keep it open and try again.';
  if (/memory|allocation|quota/i.test(msg)) return 'Your phone ran out of memory. Try a lower resolution or a shorter video.';
  return msg || 'Something went wrong while saving.';
}

/** Shares a finished file, falling back to a download where sharing files isn't supported. Call inside a tap. */
export function shareOrDownload(file: File) {
  shareFile(file, file.name).then(
    (r) => {
      if (r === 'unsupported') downloadBlob(file, file.name);
    },
    () => toast('Couldn’t open sharing. Try Download instead.', 'error'),
  );
}

export function ExportSheet({ onClose, autoStart }: { onClose: () => void; autoStart: boolean }) {
  const [settings, setSettings] = useState<ExportSettings>(() => loadPrefs(EXPORT_PREFS_KEY, EXPORT_DEFAULTS));
  const [view, setView] = useState<View>({ kind: 'settings' });
  const [supported, setSupported] = useState<boolean | null>(null);
  const [stillBusy, setStillBusy] = useState(false);
  const project = useEditor((s) => s.project);
  const runId = useRef(0);
  const ctl = useRef<AbortController | null>(null);
  const alive = useRef(false);

  const total = project ? projectDuration(project) : 0;
  const aspect = project?.aspect;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      runId.current++;
      ctl.current?.abort();
    };
  }, []);

  // Object URLs for the finished video / frame are released when the view changes.
  useEffect(() => {
    if (view.kind !== 'done' && view.kind !== 'frame') return;
    const url = view.url;
    return () => URL.revokeObjectURL(url);
  }, [view]);

  useEffect(() => {
    const p = useEditor.getState().project;
    if (!p) return;
    let live = true;
    setSupported(null);
    canExport(p, settings).then(
      (ok) => live && setSupported(ok),
      () => live && setSupported(false),
    );
    return () => {
      live = false;
    };
  }, [settings, aspect]);

  const change = (patch: Partial<ExportSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    savePrefs(EXPORT_PREFS_KEY, next);
  };

  const start = async () => {
    const p = useEditor.getState().project;
    if (!p || projectDuration(p) <= 0 || ctl.current) return;
    pause();
    const id = ++runId.current;
    const ac = new AbortController();
    ctl.current = ac;
    setView({ kind: 'running', e: { phase: 'prepare', progress: 0, eta: null } });
    try {
      const r = await exportVideo(p, settings, {
        signal: ac.signal,
        onProgress: (e) => {
          if (runId.current === id) setView({ kind: 'running', e });
        },
      });
      if (runId.current !== id) return;
      ctl.current = null;
      const file = new File([r.blob], r.fileName, { type: 'video/mp4' });
      setView({ kind: 'done', file, url: URL.createObjectURL(file), width: r.width, height: r.height, duration: r.duration });
      haptic('medium');
    } catch (e) {
      if (runId.current !== id) return;
      ctl.current = null;
      if ((e as Error)?.name === 'AbortError') setView({ kind: 'settings' });
      else setView({ kind: 'error', message: friendlyError(e) });
    }
  };

  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    // Only on open: the Save button opens the sheet with autoStart.
    if (autoStart && total > 0) void startRef.current();
  }, []);

  const cancel = () => {
    runId.current++;
    ctl.current?.abort();
    ctl.current = null;
    setView({ kind: 'settings' });
  };

  const saveFrame = async () => {
    const p = useEditor.getState().project;
    if (!p || stillBusy || projectDuration(p) <= 0) return;
    pause();
    const t = now();
    setStillBusy(true);
    try {
      const blob = await renderStill(p, t, settings.resolution, 'image/jpeg');
      if (!alive.current) return;
      const name = `${safeFileName(p.name)} ${formatTime(t).replace(':', 'm')}s.jpg`;
      const file = new File([blob], name, { type: 'image/jpeg' });
      setView({ kind: 'frame', file, url: URL.createObjectURL(file), t });
    } catch {
      toast('Couldn’t save that frame', 'error');
    } finally {
      if (alive.current) setStillBusy(false);
    }
  };

  // ------------------------------------------------------------------ running
  if (view.kind === 'running') {
    const { e } = view;
    return (
      <Sheet title="Save video" onClose={onClose} tall busy={BUSY} closeIcon="x">
        <div className="run-view">
          <p className="run-title" role="status">
            {PHASES[e.phase]}
          </p>
          <div className="big-value" aria-hidden>
            {Math.floor(e.progress * 100)}%
          </div>
          <Progress value={e.phase === 'prepare' ? null : e.progress} label="Saving progress" />
          <p className="note tnum">{e.phase === 'render' ? formatEta(e.eta) : '\u00a0'}</p>
          <p className="note">Keep ReelForge open with the screen on until it’s done.</p>
          <button className="secondary-btn block" onClick={cancel}>
            Cancel
          </button>
        </div>
      </Sheet>
    );
  }

  // ------------------------------------------------------------------ done
  if (view.kind === 'done') {
    const { file } = view;
    return (
      <Sheet title="Video saved" onClose={onClose} tall closeIcon="x">
        <div className="export-done">
          <video src={view.url} controls playsInline loop preload="metadata" aria-label="Your finished video" />
          <p className="stat-row">
            <span>
              {view.width} × {view.height} · {formatDuration(view.duration)}
            </span>
            <span>{formatBytes(file.size)}</span>
          </p>
        </div>
        <button className="primary-btn block" onClick={() => shareOrDownload(file)}>
          <Share size={20} aria-hidden />
          Share
        </button>
        <button className="secondary-btn block" onClick={() => downloadBlob(file, file.name)}>
          <Download size={20} aria-hidden />
          Download
        </button>
        <p className="note">
          {isIOS
            ? 'To keep it in Photos, tap Share, then Save Video. You can post straight to TikTok, Instagram or YouTube from there too.'
            : isAndroid
              ? 'Share posts it straight to TikTok, Instagram or YouTube. Download keeps a copy in your Downloads folder.'
              : 'Download saves an MP4 file you can upload anywhere.'}
        </p>
        <button className="text-btn" onClick={() => setView({ kind: 'settings' })}>
          Change settings and save again
        </button>
      </Sheet>
    );
  }

  // ------------------------------------------------------------------ frame
  if (view.kind === 'frame') {
    const { file } = view;
    return (
      <Sheet title="Save frame" onClose={onClose} tall closeIcon="x">
        <div className="export-done">
          <img className="still-preview" src={view.url} alt={`Frame at ${formatTime(view.t)}`} />
        </div>
        <div className="btn-row">
          <button className="primary-btn" onClick={() => shareOrDownload(file)}>
            <Share size={20} aria-hidden />
            Share
          </button>
          <button className="secondary-btn" onClick={() => downloadBlob(file, file.name)}>
            <Download size={20} aria-hidden />
            Download
          </button>
        </div>
        <p className="note">
          Use it as a cover or thumbnail.{isIOS ? ' To keep it in Photos, tap Share, then Save Image.' : ''}
        </p>
        <button className="text-btn" onClick={() => setView({ kind: 'settings' })}>
          Back
        </button>
      </Sheet>
    );
  }

  // ------------------------------------------------------------------ settings / error
  const dims = project ? exportDims(project, settings) : null;
  const est = project ? estimateSize(project, settings) : 0;
  const empty = total <= 0;

  return (
    <Sheet title="Save video" onClose={onClose} tall closeIcon="x">
      {view.kind === 'error' && (
        <div className="run-view">
          <p className="run-title">Couldn’t save the video</p>
          <p className="error-text" role="alert">
            {view.message}
          </p>
        </div>
      )}

      <div className="field">
        <span className="field-label">Resolution</span>
        <Segmented label="Resolution" value={settings.resolution} options={RES_OPTIONS} onChange={(v) => change({ resolution: v })} />
      </div>
      <div className="field">
        <span className="field-label">Frame rate</span>
        <Segmented label="Frame rate" value={settings.fps} options={FPS_OPTIONS} onChange={(v) => change({ fps: v })} />
      </div>
      <div className="field">
        <span className="field-label">Quality</span>
        <Segmented label="Quality" value={settings.quality} options={QUALITY_OPTIONS} onChange={(v) => change({ quality: v })} />
      </div>

      {!empty && dims && (
        <div className="stats">
          <p className="stat-row">
            <span>Size</span>
            <span>
              {dims.w} × {dims.h}
            </span>
          </p>
          <p className="stat-row">
            <span>Length</span>
            <span>{formatDuration(total)}</span>
          </p>
          <p className="stat-row">
            <span>File size</span>
            <span>≈ {formatBytes(est)}</span>
          </p>
        </div>
      )}

      {empty ? (
        <p className="note">There’s nothing to save yet. Add a clip or photo first.</p>
      ) : supported === false ? (
        <p className="error-text">
          {canEncodeVideo()
            ? `This phone can’t save ${resolutionLabel(settings.resolution)} video at ${settings.fps} fps. Try a lower resolution or frame rate.`
            : 'This browser can’t save videos. Update your phone’s software, or use Chrome on Android.'}
        </p>
      ) : est > BIG_FILE ? (
        <p className="note">This is a big file. If saving fails, try a lower resolution or the Smaller quality.</p>
      ) : null}

      <button className="primary-btn block" disabled={empty || supported === false} onClick={() => void start()}>
        <Film size={20} aria-hidden />
        {view.kind === 'error' ? 'Try again' : 'Save video'}
      </button>
      <button className="secondary-btn block" disabled={empty || stillBusy} onClick={() => void saveFrame()}>
        {stillBusy ? <LoaderCircle size={20} className="spin" aria-hidden /> : <ImageDown size={20} aria-hidden />}
        {stillBusy ? 'Saving frame…' : 'Save current frame'}
      </button>
    </Sheet>
  );
}
