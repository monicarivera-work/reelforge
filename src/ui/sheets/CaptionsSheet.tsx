import { Captions, FileText, Trash } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AudioItem, Project, TextStyle, VideoItem } from '../../types';
import {
  buildCaptions,
  CAPTION_LANGUAGES,
  CAPTION_MODELS,
  DEFAULT_CAPTION_OPTIONS,
  toSrt,
  transcribe,
  type CaptionOptions,
  type CaptionProgress,
} from '../../engine/captions';
import { projectMediaIds } from '../../lib/db';
import { acquireWakeLock, shareFile } from '../../lib/device';
import { haptic } from '../../lib/haptics';
import { getAsset, loadAssets } from '../../lib/media';
import { CAPTION_PRESETS } from '../../lib/text';
import { downloadBlob, formatBytes, safeFileName } from '../../lib/util';
import { pause } from '../../state/runtime';
import { toast, useEditor } from '../../state/store';
import { loadPrefs, Progress, savePrefs, Segmented, Sheet, Toggle } from '../common';
import { confirmDialog } from '../dialog';
import { CAPTION_PREFS_KEY, PresetTiles, presetStyle, type Preset } from './TextSheets';

const SRC_CLIPS = 1;
const SRC_VOICE = 2;
const SRC_MUSIC = 4;

/** Which kinds of audible sound the project has, as a bitmask. Clips whose media isn't loaded yet count as having sound. */
function soundSources(p: Project | null): number {
  if (!p) return 0;
  const audible = (it: VideoItem | AudioItem) => !it.muted && it.volume > 0.001;
  let m = 0;
  for (const it of [...p.main, ...p.overlays]) {
    if (it.type === 'video' && audible(it) && getAsset(it.mediaId)?.hasAudio !== false) m |= SRC_CLIPS;
  }
  for (const a of p.audios) {
    if (!audible(a) || a.role === 'sfx') continue;
    m |= a.role === 'music' ? SRC_MUSIC : SRC_VOICE;
  }
  return m;
}

const WORD_OPTIONS = [1, 2, 3, 4, 6].map((n) => ({ value: n, label: String(n) }));
const MODEL_OPTIONS = CAPTION_MODELS.map((m) => ({ value: m.id, label: m.name }));

const PHASES: Record<CaptionProgress['phase'], string> = {
  audio: 'Preparing the audio…',
  download: 'Downloading the speech model…',
  transcribe: 'Listening for speech…',
};

const BUSY = 'Captions are still being made — tap Cancel to stop';

type Run = { kind: 'idle' } | { kind: 'running'; e: CaptionProgress | null } | { kind: 'error'; message: string };

export function CaptionsSheet({ onClose }: { onClose: () => void }) {
  const [o, setO] = useState<CaptionOptions>(() => loadPrefs(CAPTION_PREFS_KEY, DEFAULT_CAPTION_OPTIONS));
  const [run, setRun] = useState<Run>({ kind: 'idle' });
  const [, setAssetsLoaded] = useState(0);
  const sources = useEditor((s) => soundSources(s.project));
  const count = useEditor((s) => s.project?.texts.reduce((n, t) => n + (t.caption ? 1 : 0), 0) ?? 0);
  const ctl = useRef<AbortController | null>(null);
  const alive = useRef(false);

  useEffect(() => {
    alive.current = true;
    // Asset info (does a clip have sound?) may not be cached yet.
    const p = useEditor.getState().project;
    if (p) {
      loadAssets(projectMediaIds(p)).then(
        () => alive.current && setAssetsLoaded((n) => n + 1),
        () => undefined,
      );
    }
    return () => {
      alive.current = false;
      ctl.current?.abort();
      ctl.current = null;
    };
  }, []);

  const update = (patch: Partial<CaptionOptions>) => {
    const next = { ...o, ...patch };
    setO(next);
    savePrefs(CAPTION_PREFS_KEY, next);
  };

  const pickPreset = (p: Preset) => {
    update({ presetId: p.id });
    if (!count) return;
    useEditor.getState().apply((d) => {
      for (const t of d.texts) if (t.caption) t.style = presetStyle(t.style as TextStyle, p);
    });
  };

  const hasMusic = (sources & SRC_MUSIC) !== 0;
  const canRun = (sources & (SRC_CLIPS | SRC_VOICE)) !== 0 || (o.includeMusic && hasMusic);

  const generate = async () => {
    const p = useEditor.getState().project;
    if (!p || !canRun || ctl.current) return;
    pause();
    const opts = o;
    const ac = new AbortController();
    ctl.current = ac;
    setRun({ kind: 'running', e: null });
    const wake = await acquireWakeLock();
    try {
      const words = await transcribe(p, opts, {
        signal: ac.signal,
        onProgress: (e) => {
          if (ctl.current === ac) setRun({ kind: 'running', e });
        },
      });
      if (ctl.current !== ac) return;
      ctl.current = null;
      if (!words.length) {
        setRun({ kind: 'idle' });
        toast('No speech was found', 'error');
        return;
      }
      let added = 0;
      useEditor.getState().apply((d) => {
        const proj = d as Project;
        // Regenerated captions keep the look and position of the ones they replace.
        const prev = opts.replace ? proj.texts.find((t) => t.caption) : undefined;
        const keep = prev ? { style: { ...prev.style }, transform: { ...prev.transform } } : null;
        if (opts.replace) proj.texts = proj.texts.filter((t) => !t.caption);
        const items = buildCaptions(words, opts, proj.texts);
        if (keep) {
          for (const it of items) {
            it.style = { ...keep.style };
            it.transform = { ...keep.transform };
          }
        }
        proj.texts.push(...items);
        added = items.length;
      });
      haptic('medium');
      toast(`Added ${added} caption${added === 1 ? '' : 's'}`, 'success');
      if (alive.current) onClose();
    } catch (e) {
      if (ctl.current !== ac) return;
      ctl.current = null;
      if ((e as Error)?.name === 'AbortError') setRun({ kind: 'idle' });
      else setRun({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      void wake?.release().catch(() => undefined);
    }
  };

  const cancel = () => {
    ctl.current?.abort();
    ctl.current = null;
    setRun({ kind: 'idle' });
  };

  const exportSrt = () => {
    const p = useEditor.getState().project;
    if (!p) return;
    const name = `${safeFileName(p.name)}.srt`;
    const file = new File([toSrt(p)], name, { type: 'text/plain' });
    // Called inside the tap so the share sheet is allowed to open.
    shareFile(file, name).then(
      (r) => r === 'unsupported' && downloadBlob(file, name),
      () => downloadBlob(file, name),
    );
  };

  const removeAll = async () => {
    const ok = await confirmDialog({
      title: `Delete ${count} caption${count === 1 ? '' : 's'}?`,
      message: 'Text you added yourself is kept. You can undo this.',
      confirm: 'Delete',
      danger: true,
    });
    if (!ok) return;
    useEditor.getState().apply((d) => {
      d.texts = d.texts.filter((t) => !t.caption);
    });
    toast('Captions deleted');
  };

  if (run.kind === 'running') {
    const e = run.e;
    const phase = e?.phase ?? 'audio';
    // Short videos are transcribed in one go, so there's nothing to measure until it's done.
    const value = !e || (e.phase === 'transcribe' && e.progress <= 0) ? null : e.progress;
    const detail =
      e?.phase === 'download' && e.total
        ? `${formatBytes(e.loaded ?? 0)} of ${formatBytes(e.total)} · only needed once`
        : e?.phase === 'transcribe'
          ? 'Longer videos can take a minute or two.'
          : null;
    return (
      <Sheet title="Auto captions" onClose={onClose} tall busy={BUSY} closeIcon="x">
        <div className="run-view">
          <p className="run-title" role="status">
            {PHASES[phase]}
          </p>
          <Progress value={value} label={PHASES[phase]} />
          {detail && <p className="note tnum">{detail}</p>}
          <p className="note">Keep ReelForge open until this finishes.</p>
          <button className="secondary-btn block" onClick={cancel}>
            Cancel
          </button>
        </div>
      </Sheet>
    );
  }

  if (run.kind === 'error') {
    return (
      <Sheet title="Auto captions" onClose={onClose} tall closeIcon="x">
        <div className="run-view">
          <p className="run-title">Couldn’t make captions</p>
          <p className="error-text" role="alert">
            {run.message}
          </p>
          <div className="btn-row">
            <button className="secondary-btn" onClick={() => setRun({ kind: 'idle' })}>
              Back
            </button>
            <button className="primary-btn" onClick={() => void generate()}>
              Try again
            </button>
          </div>
        </div>
      </Sheet>
    );
  }

  const listens: string[] = [];
  if (sources & SRC_CLIPS) listens.push('video sound');
  if (sources & SRC_VOICE) listens.push('voiceovers');
  if (o.includeMusic && hasMusic) listens.push('music');
  const model = CAPTION_MODELS.find((m) => m.id === o.model) ?? CAPTION_MODELS[0];
  const replacing = count > 0 && o.replace;

  return (
    <Sheet title="Auto captions" onClose={onClose} tall closeIcon="x">
      <PresetTiles
        presets={CAPTION_PRESETS}
        isActive={(p) => p.id === o.presetId}
        onPick={pickPreset}
        label={count ? 'Caption style (changes all captions)' : 'Caption style'}
      />

      <button className="primary-btn block" disabled={!canRun} onClick={() => void generate()}>
        <Captions size={20} aria-hidden />
        {replacing ? 'Redo captions' : 'Make captions'}
      </button>
      {canRun ? (
        <p className="note">Listens to {listens.join(', ')}.</p>
      ) : (
        <p className="note">
          {hasMusic
            ? 'Only music was found. Turn on “Include music” to caption song lyrics.'
            : 'There’s nothing to listen to yet. Add a video with sound or record a voiceover.'}
        </p>
      )}

      {count > 0 && (
        <div className="field">
          <span className="field-label">
            Captions in this video <b>{count}</b>
          </span>
          <div className="btn-row">
            <button className="secondary-btn" onClick={exportSrt}>
              <FileText size={18} aria-hidden />
              Export .srt
            </button>
            <button className="secondary-btn" onClick={() => void removeAll()}>
              <Trash size={18} aria-hidden />
              Delete all
            </button>
          </div>
          <p className="note">To fix a word, double-tap the caption in the preview.</p>
        </div>
      )}

      <h3 className="section-title">Options</h3>
      <div className="field">
        <span className="field-label">Words per caption</span>
        <Segmented label="Words per caption" value={o.maxWords} options={WORD_OPTIONS} onChange={(v) => update({ maxWords: v })} />
      </div>
      <label className="field">
        <span className="field-label">Spoken language</span>
        <select className="input" value={o.language} onChange={(e) => update({ language: e.target.value })}>
          {CAPTION_LANGUAGES.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {o.language !== 'en' && (
        <Toggle
          checked={o.translate}
          onChange={(v) => update({ translate: v })}
          label="Translate to English"
          hint="English captions, whatever language is spoken"
        />
      )}
      <div className="field">
        <span className="field-label">Speech model</span>
        <Segmented label="Speech model" value={o.model} options={MODEL_OPTIONS} onChange={(v) => update({ model: v })} />
        <p className="note">
          {o.model === 'tiny' ? 'Quickest. Best for clear speech.' : 'Better with accents and background noise, but slower.'} {model.note}.
        </p>
      </div>
      {hasMusic && (
        <Toggle
          checked={o.includeMusic}
          onChange={(v) => update({ includeMusic: v })}
          label="Include music"
          hint="Caption song lyrics too"
        />
      )}
      {count > 0 && (
        <Toggle
          checked={o.replace}
          onChange={(v) => update({ replace: v })}
          label="Replace current captions"
          hint="Off adds a second set of captions"
        />
      )}
      <p className="note">Captions are made on your phone. Your audio is never uploaded.</p>
    </Sheet>
  );
}
