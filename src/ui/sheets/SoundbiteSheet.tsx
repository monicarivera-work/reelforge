import { Download, LoaderCircle, Plus, Share } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { checkSoundbite, encodeSoundbite, NoSoundError, suggestSoundbite, tidyTime } from '../../engine/soundbite';
import { haptic } from '../../lib/haptics';
import { getAsset } from '../../lib/media';
import { downloadBlob, formatBytes, formatClock, isAndroid, isIOS, safeFileName } from '../../lib/util';
import { now, pause } from '../../state/runtime';
import type { VideoItem } from '../../types';
import { addSoundbite, prettyName } from '../actions';
import { Sheet } from '../common';
import { shareOrDownload } from './ExportSheet';

type Field = 'start' | 'end';

const FIELDS: { field: Field; label: string }[] = [
  { field: 'start', label: 'Start' },
  { field: 'end', label: 'End' },
];

/** "8.5s" or "8.75s"; minutes and seconds from a minute up. */
function lengthLabel(s: number): string {
  if (s >= 60) return formatClock(s);
  const cs = Math.round(s * 100);
  return `${(cs / 100).toFixed(cs % 10 ? 2 : 1)}s`;
}

/** "00m42.5s", like saved frames. */
const stamp = (t: number) => `${formatClock(t).replace(':', 'm')}s`;

function saveError(e: unknown): string {
  if (e instanceof NoSoundError) return e.message;
  const msg = e instanceof Error ? e.message : String(e);
  if (/memory|allocation|quota/i.test(msg)) return 'Your phone ran out of memory. Try a shorter soundbite.';
  return 'Couldn’t save the soundbite. Try again.';
}

/** Takes part of a video clip's sound, from a start and end time in the clip's original video. */
export function SoundbiteSheet({ item, onClose }: { item: VideoItem; onClose: () => void }) {
  const asset = getAsset(item.mediaId);
  const duration = asset?.duration ?? 0;
  const [times, setTimes] = useState<Record<Field, string>>(() => {
    const s = suggestSoundbite(item, now(), duration);
    return { start: formatClock(s.start), end: formatClock(s.end) };
  });
  // A field you tap into starts empty, with the time it replaces as its placeholder.
  const [draft, setDraft] = useState<{ field: Field; text: string } | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ file: File; url: string; length: number } | null>(null);
  const startRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLInputElement>(null);
  const ctl = useRef<AbortController | null>(null);
  const noteId = useId();

  useEffect(() => () => ctl.current?.abort(), []);

  useEffect(() => {
    if (!saved) return;
    const { url } = saved;
    return () => URL.revokeObjectURL(url);
  }, [saved]);

  if (!asset?.hasAudio) {
    return (
      <Sheet title="Soundbite" onClose={onClose} closeIcon="x">
        <p className="note">{asset ? 'This clip has no sound.' : 'This clip’s video is missing.'}</p>
      </Sheet>
    );
  }

  // ------------------------------------------------------------------ ready
  if (saved) {
    const { file } = saved;
    return (
      <Sheet title="Soundbite ready" onClose={onClose} closeIcon="x">
        <div className="export-done">
          <audio src={saved.url} controls preload="metadata" aria-label="Your soundbite" />
          <p className="stat-row">
            <span>
              {lengthLabel(saved.length)} · {file.name.endsWith('.wav') ? 'WAV' : 'M4A'} audio
            </span>
            <span>{formatBytes(file.size)}</span>
          </p>
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
          {isIOS
            ? 'To keep it on your iPhone, tap Share, then Save to Files.'
            : isAndroid
              ? 'Share sends it to another app. Download keeps a copy in your Downloads folder.'
              : 'Download saves an audio file you can use anywhere.'}
        </p>
        <button className="text-btn" onClick={() => setSaved(null)}>
          Back
        </button>
      </Sheet>
    );
  }

  // ------------------------------------------------------------------ form
  const refs = { start: startRef, end: endRef };
  const typed = draft?.text.trim() ? draft : null;
  const committed = checkSoundbite(times.start, times.end, duration);
  const check = typed ? checkSoundbite(typed.field === 'start' ? typed.text : times.start, typed.field === 'end' ? typed.text : times.end, duration) : committed;
  // A new mistake shows once you leave its field; one already showing stays while you fix the other field.
  const error = !check.ok && (attempted || (draft?.field !== check.field && (!typed || !committed.ok))) ? check : null;
  const busy = progress !== null;

  const leave = (field: Field) => {
    if (draft?.field !== field) return;
    if (draft.text.trim()) setTimes((t) => ({ ...t, [field]: tidyTime(draft.text, duration) }));
    setDraft(null);
  };

  /** The checked times, or null after pointing at the field to fix. */
  const valid = () => {
    if (check.ok) return check;
    setAttempted(true);
    refs[check.field].current?.focus();
    return null;
  };

  const add = () => {
    const c = valid();
    if (!c) return;
    addSoundbite(item, c.start, c.end);
    onClose();
  };

  const save = async () => {
    const c = valid();
    if (!c || busy) return;
    pause();
    const ac = new AbortController();
    ctl.current = ac;
    setFailed(null);
    setProgress(0);
    try {
      const name = `${safeFileName(prettyName(asset.name), 'Soundbite')} ${stamp(c.start)}-${stamp(c.end)}`;
      const file = await encodeSoundbite(asset, c.start, c.end, {
        name,
        signal: ac.signal,
        onProgress: (f) => {
          if (!ac.signal.aborted) setProgress(f);
        },
      });
      if (ac.signal.aborted) return;
      setSaved({ file, url: URL.createObjectURL(file), length: c.end - c.start });
      haptic('medium');
    } catch (e) {
      if (ac.signal.aborted) return;
      console.error('Saving the soundbite failed', e);
      setFailed(saveError(e));
    } finally {
      if (ctl.current === ac) ctl.current = null;
      if (!ac.signal.aborted) setProgress(null);
    }
  };

  return (
    <Sheet title="Soundbite" onClose={onClose} closeIcon="x">
      <div className="time-fields">
        {FIELDS.map(({ field, label }) => (
          <label key={field} className="field">
            <span className="field-label">{label}</span>
            <input
              ref={refs[field]}
              className="input tnum"
              type="text"
              inputMode="decimal"
              enterKeyHint={field === 'start' ? 'next' : 'done'}
              autoComplete="off"
              spellCheck={false}
              value={draft?.field === field ? draft.text : times[field]}
              placeholder={times[field]}
              disabled={busy}
              aria-invalid={error?.field === field || undefined}
              aria-describedby={noteId}
              onFocus={() => setDraft({ field, text: '' })}
              onChange={(e) => {
                setDraft({ field, text: e.target.value });
                setFailed(null);
              }}
              onBlur={() => leave(field)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (field === 'start') endRef.current?.focus();
                else e.currentTarget.blur();
              }}
            />
          </label>
        ))}
      </div>
      {error || failed ? (
        <p id={noteId} className="error-text" role="alert">
          {error ? error.error : failed}
        </p>
      ) : (
        <p id={noteId} className="note">
          {check.ok && (
            <>
              Length <b>{lengthLabel(check.end - check.start)}</b>.{' '}
            </>
          )}
          Times are from the clip’s original video, which is <b>{formatClock(duration)}</b> long.
          {duration >= 60 && ' Type 102.5 for 1:02.5.'}
        </p>
      )}
      <button className="primary-btn block" disabled={busy} onClick={add}>
        <Plus size={20} aria-hidden />
        Add to audio track
      </button>
      <button className="secondary-btn block" disabled={busy} onClick={() => void save()}>
        {busy ? <LoaderCircle size={20} className="spin" aria-hidden /> : <Download size={20} aria-hidden />}
        {busy ? `Saving… ${Math.floor((progress ?? 0) * 100)}%` : 'Save audio file'}
      </button>
    </Sheet>
  );
}
