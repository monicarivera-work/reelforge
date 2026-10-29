import {
  ArrowLeft,
  ClipboardPaste,
  Crop as CropIcon,
  Download,
  FolderOpen,
  LoaderCircle,
  Music,
  Pause,
  Play,
  Repeat,
  Scissors,
  Search,
  Smartphone,
  X,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { ClipFolder } from '../types';
import { encodeClip, muxStreams, posterFrame } from '../engine/clip';
import {
  aspectRatio,
  checkClipRange,
  CROP_ASPECTS,
  cropForAspect,
  FULL_CROP,
  isDirectMediaUrl,
  isFullCrop,
  moveCrop,
  parseYouTubeId,
  parseYouTubeStart,
  resizeCrop,
  timeStamp,
  type CropAspect,
  type CropRect,
} from '../lib/clip';
import { listClips, listFolders, putClip, putFolder, requestPersistence } from '../lib/db';
import { acquireWakeLock, pickFiles } from '../lib/device';
import { haptic } from '../lib/haptics';
import { probe } from '../lib/media';
import { anyFetch, nativeNet } from '../lib/native';
import { downloadSocial, parseSocialLink, SITE_NAMES, SocialError, type SocialLink } from '../lib/social';
import { goHome } from '../lib/route';
import { clamp, formatBytes, formatClock, formatDuration, parseTime, safeFileName, uid } from '../lib/util';
import { canUseYouTubeApi, downloadYouTube, searchYouTube, youTubeDetails, type YtVideo } from '../lib/youtube';
import { toast } from '../state/store';
import { prettyName } from './actions';
import { loadPrefs, Progress, savePrefs, Segmented } from './common';
import { promptDialog } from './dialog';

const PREFS_KEY = 'rf-studio';
const QUALITIES = [360, 720, 1080] as const;
/** First guess for the clip length, in seconds. */
const SUGGESTED_LENGTH = 10;

interface Prefs {
  quality: number;
  folderId: string | null;
}

/** What's loaded in the player. */
type Source =
  | { type: 'youtube'; id: string; title: string; channel: string; duration: number; start: number }
  | {
      type: 'file';
      blob: Blob;
      url: string;
      title: string;
      duration: number;
      width: number;
      height: number;
      hasVideo: boolean;
      hasAudio: boolean;
      youtubeId?: string;
      /** which download quality made it, so another quality can be fetched */
      quality?: number;
      /** the TikTok or Instagram post it came from */
      sourceUrl?: string;
    };

interface Busy {
  label: string;
  progress: number | null;
  ctl: AbortController;
}

export function Studio() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<YtVideo[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const [times, setTimes] = useState({ start: formatClock(0), end: formatClock(SUGGESTED_LENGTH) });
  const [kind, setKind] = useState<'video' | 'audio'>('video');
  const [aspect, setAspect] = useState<CropAspect>('original');
  const [crop, setCrop] = useState<CropRect>(FULL_CROP);
  const [name, setName] = useState('');
  const [folders, setFolders] = useState<ClipFolder[]>([]);
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs<Prefs>(PREFS_KEY, { quality: 720, folderId: null }));
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ name: string; size: number } | null>(null);
  const playerRef = useRef<PlayerHandle | null>(null);
  const native = canUseYouTubeApi();

  useEffect(() => {
    void listFolders().then(setFolders);
  }, []);

  useEffect(() => savePrefs(PREFS_KEY, prefs), [prefs]);

  // Free the previous file's memory when it's replaced.
  useEffect(() => {
    const url = source?.type === 'file' ? source.url : null;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [source]);

  // Leaving the studio stops any download or save in progress.
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => () => busyRef.current?.ctl.abort(), []);
  const aspectRef = useRef(aspect);
  aspectRef.current = aspect;

  const duration = source?.duration ?? 0;
  const check = duration > 0 ? checkClipRange(times.start, times.end, duration) : null;
  const isFile = source?.type === 'file';
  // A download from YouTube can be fetched again with the other part (picture or sound).
  const canRedownload = isFile && !!source.youtubeId;
  const effectiveKind = isFile && !canRedownload ? (!source.hasVideo ? 'audio' : !source.hasAudio ? 'video' : kind) : kind;
  const fixed = aspectRatio(aspect);

  const resetFor = (dur: number, start = 0) => {
    const s = clamp(start, 0, Math.max(0, dur - 0.1));
    setTimes({ start: formatClock(s), end: formatClock(dur > 0 ? Math.min(dur, s + SUGGESTED_LENGTH) : s + SUGGESTED_LENGTH) });
    setAspect('original');
    setCrop(FULL_CROP);
    setName('');
    setSaved(null);
    setError(null);
  };

  const openYouTube = (v: { id: string; title: string; channel: string; duration: number }, start = 0) => {
    busy?.ctl.abort();
    setSource({ type: 'youtube', ...v, start });
    resetFor(v.duration, start);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (!v.duration) {
      void youTubeDetails(v.id).then((d) => {
        if (!d) return;
        setSource((s) => (s?.type === 'youtube' && s.id === v.id ? { ...s, title: d.title, channel: d.channel, duration: d.duration } : s));
        if (d.duration) resetFor(d.duration, start);
      });
    }
  };

  const openFile = async (
    blob: Blob,
    title: string,
    extra: { youtubeId?: string; quality?: number; sourceUrl?: string; keepTimes?: boolean } = {},
  ) => {
    try {
      const type = blob.type || (/\.(mp3|m4a|aac|wav|ogg|opus|flac)$/i.test(title) ? 'audio/mpeg' : 'video/mp4');
      const asset = await probe(blob, title, type);
      if (asset.kind === 'image') throw new Error('not a video');
      setSource({
        type: 'file',
        blob,
        url: URL.createObjectURL(blob),
        title: prettyName(title),
        duration: asset.duration,
        width: asset.width,
        height: asset.height,
        hasVideo: asset.kind === 'video',
        hasAudio: asset.hasAudio || asset.kind === 'audio',
        ...extra,
      });
      if (extra.keepTimes) {
        setSaved(null);
        setError(null);
        const a = aspectRef.current;
        setCrop(a === 'free' ? { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } : cropForAspect(asset.width, asset.height, aspectRatio(a)));
      } else resetFor(asset.duration);
      if (asset.kind === 'audio') setKind('audio');
    } catch (e) {
      console.error(e);
      setError('This file couldn’t be opened. Try an MP4, MOV, WebM, MP3, M4A or WAV file.');
    }
  };

  const fromDevice = () => {
    // The picker has to open synchronously inside the tap.
    void pickFiles('video/*,audio/*', false).then((files) => {
      const f = files[0];
      if (f) void openFile(f, f.name);
    });
  };

  const submit = async (e?: FormEvent, text = query) => {
    e?.preventDefault();
    const q = text.trim();
    if (!q) return;
    (document.activeElement as HTMLElement | null)?.blur();
    setError(null);
    const id = parseYouTubeId(q);
    if (id) {
      openYouTube({ id, title: 'YouTube video', channel: '', duration: 0 }, parseYouTubeStart(q));
      return;
    }
    const social = parseSocialLink(q);
    if (social) {
      if (!native) {
        setError(`Downloading from ${SITE_NAMES[social.site]} works in the Android app. Browsers block it.`);
        return;
      }
      await downloadLink(social);
      return;
    }
    if (isDirectMediaUrl(q)) {
      await fetchLink(q);
      return;
    }
    if (/^https?:\/\//i.test(q)) {
      setError('That link isn’t a YouTube, TikTok or Instagram video, or a media file. Paste one of those, or a link ending in .mp4, .mp3 and so on.');
      return;
    }
    if (!native) {
      setError('Searching YouTube works in the Android app. Here, paste a YouTube link instead.');
      return;
    }
    setSearching(true);
    try {
      setResults(await searchYouTube(q));
    } catch (err) {
      console.error(err);
      setError('Couldn’t search YouTube. Check your connection and try again.');
    } finally {
      setSearching(false);
    }
  };

  const fetchLink = async (url: string) => {
    const ctl = new AbortController();
    setBusy({ label: 'Downloading', progress: null, ctl });
    try {
      const res = await anyFetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const fileName = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'Linked video');
      await openFile(blob, fileName);
    } catch (err) {
      if (ctl.signal.aborted) return;
      console.error(err);
      setError(
        native
          ? 'Couldn’t download that link. Check it opens in your browser.'
          : 'This site doesn’t let browsers download its files. Save the file to your device first, or use the Android app.',
      );
    } finally {
      setBusy((b) => (b?.ctl === ctl ? null : b));
    }
  };

  /** Downloads a TikTok or Instagram video so it can be clipped. */
  const downloadLink = async (link: SocialLink) => {
    busy?.ctl.abort();
    const ctl = new AbortController();
    setBusy({ label: `Opening the ${SITE_NAMES[link.site]} post`, progress: null, ctl });
    playerRef.current?.pause();
    const lock = await acquireWakeLock();
    try {
      const got = await downloadSocial(link, nativeNet, {
        maxHeight: prefs.quality,
        signal: ctl.signal,
        onProgress: (p, label) => !ctl.signal.aborted && setBusy({ label, progress: p, ctl }),
      });
      if (ctl.signal.aborted) return;
      setResults(null);
      await openFile(got.blob, `${got.title}.mp4`, { sourceUrl: link.url });
      window.scrollTo({ top: 0, behavior: 'smooth' });
      haptic('medium');
    } catch (err) {
      if (ctl.signal.aborted) return;
      console.error(err);
      setError(err instanceof SocialError ? err.message : `Couldn’t download from ${SITE_NAMES[link.site]}. Check your connection and try again.`);
    } finally {
      void lock?.release();
      setBusy((b) => (b?.ctl === ctl ? null : b));
    }
  };

  const paste = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) return toast('Nothing to paste');
      setQuery(text);
      void submit(undefined, text);
    } catch {
      toast('Long-press the search box and tap Paste');
    }
  };

  /** Downloads the YouTube video so it can be cropped and saved. */
  const download = async () => {
    if (source?.type !== 'youtube' && !(source?.type === 'file' && source.youtubeId)) return;
    const id = source.type === 'youtube' ? source.id : source.youtubeId!;
    const title = source.title;
    const want = effectiveKind;
    const ctl = new AbortController();
    setError(null);
    setBusy({ label: 'Connecting to YouTube', progress: null, ctl });
    playerRef.current?.pause();
    const lock = await acquireWakeLock();
    try {
      const got = await downloadYouTube(id, {
        kind: want,
        maxHeight: prefs.quality,
        signal: ctl.signal,
        onProgress: (p, label) => !ctl.signal.aborted && setBusy({ label, progress: p, ctl }),
      });
      let blob: Blob;
      if (got.video && got.audio) {
        setBusy({ label: 'Joining picture and sound', progress: null, ctl });
        blob = await muxStreams(got.video, got.audio, ctl.signal);
      } else blob = (got.video ?? got.audio)!;
      if (ctl.signal.aborted) return;
      const ext = got.video ? 'mp4' : blob.type.includes('webm') ? 'webm' : 'm4a';
      await openFile(blob, `${got.title || title}.${ext}`, { youtubeId: id, quality: got.video ? prefs.quality : undefined, keepTimes: true });
      haptic('medium');
    } catch (err) {
      if (ctl.signal.aborted) return;
      console.error(err);
      setError((err as Error)?.message || 'Downloading failed.');
    } finally {
      void lock?.release();
      setBusy((b) => (b?.ctl === ctl ? null : b));
    }
  };

  const markNow = (field: 'start' | 'end') => {
    const t = playerRef.current?.time() ?? 0;
    setTimes((s) => ({ ...s, [field]: formatClock(Math.round(t * 10) / 10) }));
    haptic('light');
  };

  const pickAspect = (a: CropAspect) => {
    setAspect(a);
    if (source?.type !== 'file') return;
    if (a === 'original') setCrop(FULL_CROP);
    else if (a === 'free') setCrop((c) => (isFullCrop(c) ? { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } : c));
    else setCrop(cropForAspect(source.width, source.height, aspectRatio(a)));
  };

  const chooseFolder = async (value: string) => {
    if (value !== '__new') {
      setPrefs((p) => ({ ...p, folderId: value || null }));
      return;
    }
    const n = (await promptDialog({ title: 'New folder', placeholder: 'Folder name', confirm: 'Create' }))?.trim();
    if (!n) return;
    const f: ClipFolder = { id: uid('f_'), name: n, createdAt: Date.now() };
    await putFolder(f);
    setFolders(await listFolders());
    setPrefs((p) => ({ ...p, folderId: f.id }));
  };

  const defaultName = () => {
    if (!source || !check?.ok) return '';
    return `${safeFileName(source.title, 'Clip')} ${timeStamp(check.start)}-${timeStamp(check.end)}`;
  };

  const save = async () => {
    if (source?.type !== 'file' || !check?.ok || busy) return;
    const ctl = new AbortController();
    setError(null);
    setSaved(null);
    setBusy({ label: effectiveKind === 'audio' ? 'Saving audio clip' : 'Saving video clip', progress: 0, ctl });
    playerRef.current?.pause();
    const lock = await acquireWakeLock();
    try {
      const clipName = safeFileName(name.trim() || defaultName(), 'Clip');
      const res = await encodeClip(source.blob, {
        kind: effectiveKind,
        start: check.start,
        end: check.end,
        crop: effectiveKind === 'video' && aspect !== 'original' ? crop : undefined,
        name: clipName,
        signal: ctl.signal,
        onProgress: (p) =>
          !ctl.signal.aborted && setBusy({ label: effectiveKind === 'audio' ? 'Saving audio clip' : 'Saving video clip', progress: p, ctl }),
      });
      if (ctl.signal.aborted) return;
      const poster = effectiveKind === 'video' ? await posterFrame(res.file, Math.min(0.5, res.duration / 2)) : null;
      const taken = (await listClips()).map((c) => c.meta.name);
      let finalName = clipName;
      for (let i = 2; taken.includes(finalName); i++) finalName = `${clipName} ${i}`;
      await putClip({
        meta: {
          id: uid('c_'),
          name: finalName,
          kind: effectiveKind,
          mime: res.file.type,
          fileName: res.file.name,
          size: res.file.size,
          duration: res.duration,
          width: res.width,
          height: res.height,
          folderId: folders.some((f) => f.id === prefs.folderId) ? prefs.folderId : null,
          source: source.title,
          youtubeId: source.youtubeId,
          sourceUrl: source.sourceUrl,
          start: check.start,
          end: check.end,
          createdAt: Date.now(),
        },
        blob: res.file,
        poster,
      });
      void requestPersistence();
      setSaved({ name: finalName, size: res.file.size });
      setName('');
      haptic('medium');
    } catch (err) {
      if (ctl.signal.aborted) return;
      console.error('Saving the clip failed', err);
      setError(
        (err as Error)?.name === 'QuotaExceededError'
          ? 'The phone is out of space for clips. Delete some and try again.'
          : (err as Error)?.message || 'Saving failed.',
      );
    } finally {
      void lock?.release();
      setBusy((b) => (b?.ctl === ctl ? null : b));
    }
  };

  const needsDownload =
    source?.type === 'youtube' ||
    (canRedownload && ((effectiveKind === 'video' && !source.hasVideo) || (effectiveKind === 'audio' && !source.hasAudio)));
  const fieldError = check && !check.ok ? check : null;

  return (
    <main className="studio">
      <header className="studio-head">
        <button className="icon-btn" aria-label="Back" onClick={goHome}>
          <ArrowLeft size={22} />
        </button>
        <h1>Clip studio</h1>
        <button className="icon-btn" aria-label="Clip a file from this device" onClick={fromDevice}>
          <FolderOpen size={22} />
        </button>
      </header>

      <form className="studio-search" role="search" onSubmit={(e) => void submit(e)}>
        <Search size={18} aria-hidden />
        <input
          className="input"
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          aria-label={native ? 'Search YouTube or paste a YouTube, TikTok or Instagram link' : 'Paste a YouTube or video link'}
          placeholder={native ? 'Search YouTube or paste a TikTok, Instagram link…' : 'Paste a YouTube or video link'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query ? (
          <button type="button" className="icon-btn" aria-label="Clear" onClick={() => setQuery('')}>
            <X size={18} />
          </button>
        ) : (
          <button type="button" className="icon-btn" aria-label="Paste link" onClick={() => void paste()}>
            <ClipboardPaste size={18} />
          </button>
        )}
      </form>

      {!native && !source && (
        <div className="notice" role="note">
          <Smartphone size={20} aria-hidden />
          <div className="body">
            <b>YouTube, TikTok and Instagram downloads need the Android app</b>
            <p>
              Browsers block them. Here you can watch a YouTube link and mark times, or clip any video or audio file from this device with the folder
              button.
            </p>
          </div>
        </div>
      )}

      {source && (
        <section className="studio-stage" aria-label="Player">
          {source.type === 'youtube' ? (
            <YouTubePlayer key={source.id} id={source.id} start={source.start} handle={playerRef} />
          ) : (
            <FilePlayer
              key={source.url}
              src={source}
              crop={effectiveKind === 'video' && aspect !== 'original' ? crop : null}
              ratio={fixed}
              onCrop={setCrop}
              range={check?.ok ? check : null}
              handle={playerRef}
            />
          )}
        </section>
      )}

      {source && (
        <section className="studio-panel" aria-label="Clip">
          <div className="studio-title">
            <b>{source.title}</b>
            <small>
              {source.type === 'youtube'
                ? [source.channel, source.duration ? formatDuration(source.duration) : null].filter(Boolean).join(' · ') || 'YouTube'
                : [
                    formatDuration(source.duration),
                    source.hasVideo ? `${source.width}×${source.height}` : 'Sound only',
                    formatBytes(source.blob.size),
                  ].join(' · ')}
            </small>
          </div>

          <div className="time-fields">
            {(['start', 'end'] as const).map((field) => (
              <div key={field} className="field">
                <span className="field-label">{field === 'start' ? 'Start' : 'End'}</span>
                <div className="time-row">
                  <input
                    className="input tnum"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={field === 'start' ? 'Start time' : 'End time'}
                    aria-invalid={fieldError?.field === field || undefined}
                    value={times[field]}
                    disabled={!!busy}
                    onChange={(e) => setTimes((s) => ({ ...s, [field]: e.target.value }))}
                    onBlur={(e) => {
                      const v = parseTime(e.target.value);
                      if (v !== null) setTimes((s) => ({ ...s, [field]: formatClock(duration ? Math.min(v, duration) : v) }));
                    }}
                  />
                  <button className="chip" disabled={!!busy} onClick={() => markNow(field)}>
                    Now
                  </button>
                </div>
              </div>
            ))}
          </div>
          {fieldError ? (
            <p className="error-text" role="alert">
              {fieldError.error}
            </p>
          ) : (
            <p className="note">
              {check?.ok ? (
                <>
                  Clip length <b>{formatClock(check.end - check.start)}</b>. Tap <b>Now</b> to use the player’s position.
                </>
              ) : (
                'Play the video and tap Now to mark the start and end, or type times like 42.5 or 1:02.5.'
              )}
            </p>
          )}
          {check?.ok && (
            <button className="secondary-btn" disabled={!!busy} onClick={() => playerRef.current?.playRange(check.start, check.end)}>
              <Repeat size={18} aria-hidden />
              Play the clip
            </button>
          )}

          {!(isFile && !canRedownload && !(source.hasVideo && source.hasAudio)) && (
            <Segmented
              label="Save as"
              value={effectiveKind}
              onChange={(k) => setKind(k)}
              options={[
                { value: 'video', label: 'Video clip' },
                { value: 'audio', label: 'Audio clip' },
              ]}
            />
          )}

          {effectiveKind === 'video' && (
            <>
              <h3 className="section-title">
                <CropIcon size={14} aria-hidden /> Crop
              </h3>
              <div className="chips" role="group" aria-label="Crop shape">
                {CROP_ASPECTS.map((a) => (
                  <button key={a.id} className="chip" aria-pressed={aspect === a.id} disabled={!!busy} onClick={() => pickAspect(a.id)}>
                    {a.label}
                  </button>
                ))}
              </div>
              {aspect !== 'original' && (
                <p className="note">
                  {source.type === 'youtube'
                    ? 'You can drag the crop box once the video is downloaded.'
                    : 'Drag the box to move it; drag its corner to resize.'}
                </p>
              )}
            </>
          )}

          {needsDownload ? (
            <>
              {effectiveKind === 'video' && (
                <div className="chips" role="group" aria-label="Download quality">
                  {QUALITIES.map((q) => (
                    <button
                      key={q}
                      className="chip"
                      aria-pressed={prefs.quality === q}
                      disabled={!!busy}
                      onClick={() => setPrefs((p) => ({ ...p, quality: q }))}
                    >
                      {q}p
                    </button>
                  ))}
                </div>
              )}
              <button className="primary-btn block" disabled={!!busy || !native} onClick={() => void download()}>
                <Download size={20} aria-hidden />
                {effectiveKind === 'audio' ? 'Download the sound to clip it' : 'Download to crop and clip'}
              </button>
              <p className="note">
                {native
                  ? 'The whole video is downloaded to this phone once; then you can save as many clips from it as you like. Only clip videos you own or have permission to use.'
                  : 'Downloading from YouTube works in the Android app. In a browser you can still watch and mark the times.'}
              </p>
            </>
          ) : (
            <>
              <label className="field">
                <span className="field-label">Name</span>
                <input
                  className="input"
                  type="text"
                  autoComplete="off"
                  placeholder={defaultName() || 'Clip name'}
                  value={name}
                  disabled={!!busy}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="field">
                <span className="field-label">Folder</span>
                <select
                  className="input"
                  value={folders.some((f) => f.id === prefs.folderId) ? (prefs.folderId ?? '') : ''}
                  disabled={!!busy}
                  onChange={(e) => void chooseFolder(e.target.value)}
                >
                  <option value="">No folder</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                  <option value="__new">New folder…</option>
                </select>
              </label>
              <button className="primary-btn block" disabled={!!busy || !check?.ok} onClick={() => void save()}>
                {effectiveKind === 'audio' ? <Music size={20} aria-hidden /> : <Scissors size={20} aria-hidden />}
                {effectiveKind === 'audio' ? 'Save audio clip' : 'Save video clip'}
              </button>
            </>
          )}

          {busy && (
            <div className="studio-busy" role="status" aria-live="polite">
              <div className="row">
                <LoaderCircle size={18} className="spin" aria-hidden />
                <span>
                  {busy.label}
                  {busy.progress !== null && ` ${Math.floor(busy.progress * 100)}%`}
                </span>
                <button className="text-btn" onClick={() => busy.ctl.abort()}>
                  Cancel
                </button>
              </div>
              <Progress value={busy.progress} label={busy.label} />
            </div>
          )}
          {saved && !busy && (
            <p className="note" role="status">
              Saved <b>{saved.name}</b> ({formatBytes(saved.size)}) to your clips. Find it under Clips on the home screen.
            </p>
          )}
        </section>
      )}

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {!source && busy && (
        <div className="studio-busy" role="status" aria-live="polite">
          <div className="row">
            <LoaderCircle size={18} className="spin" aria-hidden />
            <span>{busy.label}</span>
            <button className="text-btn" onClick={() => busy.ctl.abort()}>
              Cancel
            </button>
          </div>
          <Progress value={busy.progress} label={busy.label} />
        </div>
      )}

      {searching && (
        <p className="note" role="status">
          Searching…
        </p>
      )}
      {results && !searching && (
        <section aria-label="Search results">
          {results.length === 0 ? (
            <p className="note">No videos found.</p>
          ) : (
            <ul className="yt-results" role="list">
              {results.map((v) => (
                <li key={v.id}>
                  <button className="yt-result" aria-current={source?.type === 'youtube' && source.id === v.id} onClick={() => openYouTube(v)}>
                    <span className="thumb">
                      <img src={v.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
                      {v.live ? <small>LIVE</small> : v.duration > 0 && <small>{formatDuration(v.duration)}</small>}
                    </span>
                    <span className="meta">
                      <b>{v.title}</b>
                      <small>{v.channel}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!source && !results && !busy && (
        <div className="empty">
          <Scissors size={32} aria-hidden />
          <b>Make a clip</b>
          <span>
            {native
              ? 'Search YouTube, paste a YouTube, TikTok or Instagram link, or tap the folder button to clip a video or song from this phone.'
              : 'Paste a YouTube link to watch it, or tap the folder button to clip a video or song from this device.'}
          </span>
          <button className="secondary-btn" onClick={fromDevice}>
            <FolderOpen size={18} aria-hidden />
            Choose a file
          </button>
        </div>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Players

interface PlayerHandle {
  time(): number;
  pause(): void;
  playRange(start: number, end: number): void;
}

const YT_ORIGIN = 'https://www.youtube-nocookie.com';

/** YouTube's own embedded player, controlled through its postMessage interface (no extra scripts). */
function YouTubePlayer({ id, start, handle }: { id: string; start: number; handle: { current: PlayerHandle | null } }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const time = useRef(start);
  const stopAt = useRef<number | null>(null);

  useEffect(() => {
    const post = (func: string, args: unknown[] = []) =>
      ref.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), YT_ORIGIN);
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== YT_ORIGIN || e.source !== ref.current?.contentWindow) return;
      let data: { event?: string; info?: { currentTime?: number } } | null = null;
      try {
        data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      const t = data?.info?.currentTime;
      if (data?.event === 'infoDelivery' && typeof t === 'number') {
        time.current = t;
        if (stopAt.current !== null && t >= stopAt.current) {
          stopAt.current = null;
          post('pauseVideo');
        }
      }
    };
    window.addEventListener('message', onMsg);
    handle.current = {
      time: () => time.current,
      pause: () => post('pauseVideo'),
      playRange: (s, end) => {
        stopAt.current = end;
        post('seekTo', [s, true]);
        post('playVideo');
      },
    };
    return () => {
      window.removeEventListener('message', onMsg);
      handle.current = null;
    };
  }, [handle]);

  const listen = () => ref.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), YT_ORIGIN);
  const params = new URLSearchParams({ enablejsapi: '1', playsinline: '1', rel: '0', origin: location.origin, widget_referrer: location.origin });
  if (start > 0) params.set('start', String(Math.floor(start)));

  return (
    <div className="yt-frame">
      <iframe
        ref={ref}
        src={`${YT_ORIGIN}/embed/${id}?${params}`}
        title="YouTube video player"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        onLoad={listen}
      />
    </div>
  );
}

interface FileSrc {
  url: string;
  width: number;
  height: number;
  duration: number;
  hasVideo: boolean;
}

function FilePlayer({
  src,
  crop,
  ratio,
  onCrop,
  range,
  handle,
}: {
  src: FileSrc;
  crop: CropRect | null;
  ratio: number | null;
  onCrop: (c: CropRect) => void;
  range: { start: number; end: number } | null;
  handle: { current: PlayerHandle | null };
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const stopAt = useRef<number | null>(null);
  const drag = useRef<{ mode: 'move' | 'size'; x: number; y: number; from: CropRect; id: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    handle.current = {
      time: () => video.current?.currentTime ?? 0,
      pause: () => video.current?.pause(),
      playRange: (s, end) => {
        const v = video.current;
        if (!v) return;
        stopAt.current = end;
        v.currentTime = s;
        void v.play().catch(() => undefined);
      },
    };
    return () => {
      handle.current = null;
    };
  }, [handle]);

  // Fit the frame inside the stage so the crop box lines up with the picture.
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      const ar = src.hasVideo && src.width && src.height ? src.width / src.height : 16 / 9;
      const w = Math.min(r.width, r.height * ar);
      setBox({ w, h: w / ar });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [src]);

  const onTime = () => {
    const v = video.current;
    if (!v) return;
    setT(v.currentTime);
    if (stopAt.current !== null && v.currentTime >= stopAt.current) {
      stopAt.current = null;
      v.pause();
    }
  };

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    stopAt.current = null;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  };

  const down = (mode: 'move' | 'size') => (e: ReactPointerEvent) => {
    if (!crop) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { mode, x: e.clientX, y: e.clientY, from: crop, id: e.pointerId };
    setDragging(true);
  };
  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !box.w) return;
    const dx = (e.clientX - d.x) / box.w;
    const dy = (e.clientY - d.y) / box.h;
    onCrop(d.mode === 'move' ? moveCrop(d.from, dx, dy) : resizeCrop(d.from, dx, dy, ratio, src.width, src.height));
  };
  const up = (e: ReactPointerEvent) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  const pct = (v: number) => `${v * 100}%`;
  const dur = src.duration || 0;

  return (
    <>
      <div className="file-stage" ref={stage}>
        <div className="file-frame" style={{ width: box.w, height: box.h }}>
          <video
            ref={video}
            src={src.url}
            playsInline
            preload="auto"
            onClick={toggle}
            onTimeUpdate={onTime}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
          {!src.hasVideo && (
            <span className="audio-only" aria-hidden onClick={toggle}>
              <Music size={40} />
            </span>
          )}
          {crop && (
            <div
              className="crop-box"
              data-drag={dragging}
              role="img"
              aria-label="Crop area"
              style={{ left: pct(crop.x), top: pct(crop.y), width: pct(crop.w), height: pct(crop.h) }}
              onPointerDown={down('move')}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
            >
              <span
                className="h br"
                style={{ left: '100%', top: '100%' }}
                onPointerDown={down('size')}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={up}
              />
            </div>
          )}
        </div>
      </div>
      <div className="file-controls">
        <button className="icon-btn" aria-label={playing ? 'Pause' : 'Play'} onClick={toggle}>
          {playing ? <Pause size={22} /> : <Play size={22} />}
        </button>
        <span className="tnum time">{formatClock(t)}</span>
        <div className="scrub">
          {range && dur > 0 && <i className="range" style={{ left: pct(range.start / dur), width: pct((range.end - range.start) / dur) }} />}
          <input
            type="range"
            min={0}
            max={dur || 1}
            step={0.05}
            value={Math.min(t, dur || 1)}
            aria-label="Position"
            onChange={(e) => {
              const v = video.current;
              const nt = Number(e.target.value);
              if (v) v.currentTime = nt;
              setT(nt);
            }}
          />
        </div>
        <span className="tnum time dim">{formatClock(dur)}</span>
      </div>
    </>
  );
}
