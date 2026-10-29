/**
 * YouTube search and download for the Android app. Browsers block these requests (CORS), so in a
 * browser only watching through YouTube's own player is available.
 *
 * YouTube changes how it serves video from time to time, which can break downloading until the
 * youtubei.js dependency is updated.
 */
import type { Types } from 'youtubei.js/agnostic';
import { anyFetch, isNative } from './native';

export interface YtVideo {
  id: string;
  title: string;
  channel: string;
  /** seconds; 0 when unknown or live */
  duration: number;
  thumbnail: string;
  live?: boolean;
}

export class YouTubeError extends Error {}

export const canUseYouTubeApi = (): boolean => isNative();

type Yt = import('youtubei.js/agnostic').Innertube;
type FormatT = import('youtubei.js/agnostic').Misc.Format;

let ytp: Promise<Yt> | null = null;

function innertube(): Promise<Yt> {
  if (!canUseYouTubeApi()) return Promise.reject(new YouTubeError('Searching and downloading from YouTube works in the Android app.'));
  ytp ??= (async () => {
    const { Innertube, Platform } = await import('youtubei.js/web');
    Platform.shim.eval = (data, env) =>
      sandboxEval(
        `${data.output}\nreturn process(${JSON.stringify(env.n ?? '')}, ${JSON.stringify(env.sp ?? '')}, ${JSON.stringify(env.sig ?? '')});`,
      );
    return Innertube.create({ fetch: anyFetch, retrieve_player: true, generate_session_locally: true });
  })();
  ytp.catch(() => (ytp = null));
  return ytp;
}

// ---------------------------------------------------------------------------
// Running YouTube's player code

let frame: HTMLIFrameElement | null = null;
let frameReady: Promise<HTMLIFrameElement> | null = null;
let seq = 0;

/**
 * Runs YouTube's signature code in a sandboxed frame with no access to the app's storage or
 * pages, and returns what it returns.
 */
function sandboxEval(code: string): Promise<Record<string, unknown>> {
  frameReady ??= new Promise((resolve) => {
    frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden;';
    frame.srcdoc =
      '<script>addEventListener("message",function(e){var d=e.data,r;try{r={id:d.id,ok:true,value:new Function(d.code)()}}catch(x){r={id:d.id,ok:false,error:String(x)}}parent.postMessage(r,"*")});</script>';
    frame.addEventListener('load', () => resolve(frame!), { once: true });
    document.body.appendChild(frame);
  });
  return frameReady.then(
    (f) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => {
          window.removeEventListener('message', onMsg);
          reject(new YouTubeError('YouTube’s player code took too long.'));
        }, 15_000);
        const onMsg = (e: MessageEvent) => {
          if (e.source !== f.contentWindow || e.data?.id !== id) return;
          clearTimeout(timer);
          window.removeEventListener('message', onMsg);
          if (e.data.ok && e.data.value && typeof e.data.value === 'object') resolve(e.data.value);
          else reject(new YouTubeError(`YouTube’s player code failed: ${e.data.error ?? 'no result'}`));
        };
        window.addEventListener('message', onMsg);
        f.contentWindow?.postMessage({ id, code }, '*');
      }),
  );
}

// ---------------------------------------------------------------------------
// Search

interface VideoNodeLike {
  type: string;
  video_id?: string;
  id?: string;
  title?: { toString(): string };
  author?: { name?: string };
  duration?: { seconds?: number };
  thumbnails?: { url: string; width: number }[];
  is_live?: boolean;
}

export async function searchYouTube(query: string): Promise<YtVideo[]> {
  const yt = await innertube();
  const res = await yt.search(query, { type: 'video' });
  const out: YtVideo[] = [];
  for (const node of res.results as unknown as VideoNodeLike[]) {
    if (node.type !== 'Video') continue;
    const id = node.video_id ?? node.id;
    if (!id) continue;
    const thumbs = [...(node.thumbnails ?? [])].sort((a, b) => a.width - b.width);
    out.push({
      id,
      title: node.title?.toString() ?? 'Untitled',
      channel: node.author?.name ?? '',
      duration: node.duration?.seconds ?? 0,
      thumbnail: (thumbs.find((t) => t.width >= 320) ?? thumbs[thumbs.length - 1])?.url ?? `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
      live: node.is_live,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Download

/** Clients tried in order; YouTube serves usable links to different ones at different times. */
const CLIENTS: Types.InnerTubeClient[] = ['ANDROID_VR', 'IOS', 'TV', 'MWEB', 'WEB_EMBEDDED', 'WEB'];
const CHUNK = 8 * 1024 * 1024;

export interface DownloadOptions {
  kind: 'video' | 'audio';
  /** largest picture height to download */
  maxHeight: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number, label: string) => void;
}

export interface Downloaded {
  /** a picture-only file, a sound-only file, or one file with both */
  video: Blob | null;
  audio: Blob | null;
  title: string;
  channel: string;
  duration: number;
}

interface Pick {
  video: FormatT | null;
  audio: FormatT | null;
  /** the picture file already has sound */
  muxed: boolean;
}

function pickFormats(adaptive: FormatT[], muxed: FormatT[], o: DownloadOptions): Pick | null {
  const audios = adaptive
    .filter((f) => f.has_audio && !f.has_video)
    .sort((a, b) => Number(b.mime_type.startsWith('audio/mp4')) - Number(a.mime_type.startsWith('audio/mp4')) || b.bitrate - a.bitrate);
  const audio = audios[0] ?? null;
  if (o.kind === 'audio') {
    if (audio) return { video: null, audio, muxed: false };
    const m = muxed.find((f) => f.mime_type.startsWith('video/mp4'));
    return m ? { video: m, audio: null, muxed: true } : null;
  }
  const videos = adaptive
    .filter((f) => f.has_video && !f.has_audio && f.mime_type.startsWith('video/mp4') && /avc1/.test(f.mime_type))
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bitrate - a.bitrate);
  const video = videos.find((f) => (f.height ?? 0) <= o.maxHeight) ?? videos[videos.length - 1];
  if (video && audio && audio.mime_type.startsWith('audio/mp4')) return { video, audio, muxed: false };
  const m = muxed.filter((f) => f.mime_type.startsWith('video/mp4')).sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
  return m ? { video: m, audio: null, muxed: true } : null;
}

async function probeUrl(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const r = await anyFetch(`${url}&range=0-1023`, { signal });
    return r.ok && (await r.arrayBuffer()).byteLength > 0;
  } catch {
    return false;
  }
}

async function fetchStream(url: string, total: number | undefined, mime: string, o: DownloadOptions, step: (got: number) => void): Promise<Blob> {
  const parts: Blob[] = [];
  let got = 0;
  for (;;) {
    if (o.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const end = total ? Math.min(total, got + CHUNK) - 1 : got + CHUNK - 1;
    let res: Response | null = null;
    for (let attempt = 0; attempt < 3 && !res?.ok; attempt++) {
      try {
        res = await anyFetch(`${url}&range=${got}-${end}`, { signal: o.signal });
      } catch (e) {
        if (o.signal?.aborted) throw e;
        res = null;
      }
    }
    if (!res?.ok) throw new YouTubeError(`YouTube refused the download (${res?.status ?? 'no connection'}).`);
    const buf = await res.arrayBuffer();
    if (!buf.byteLength) break;
    parts.push(new Blob([buf]));
    got += buf.byteLength;
    step(got);
    if (total ? got >= total : buf.byteLength < CHUNK) break;
  }
  if (!got) throw new YouTubeError('YouTube sent an empty file.');
  return new Blob(parts, { type: mime.split(';')[0] });
}

/** Downloads a YouTube video (or just its sound) at up to `maxHeight` lines. */
export async function downloadYouTube(id: string, o: DownloadOptions): Promise<Downloaded> {
  const yt = await innertube();
  let lastError: unknown = null;
  for (const client of CLIENTS) {
    if (o.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    try {
      const info = await yt.getBasicInfo(id, { client });
      const status = info.playability_status?.status;
      if (status && status !== 'OK') {
        lastError = new YouTubeError(info.playability_status?.reason || 'YouTube won’t play this video here.');
        if (status === 'LOGIN_REQUIRED' || status === 'UNPLAYABLE' || status === 'ERROR') continue;
      }
      const sd = info.streaming_data;
      if (!sd) continue;
      const pick = pickFormats(sd.adaptive_formats ?? [], sd.formats ?? [], o);
      if (!pick) continue;
      const player = yt.session.player;
      const vUrl = pick.video ? await pick.video.decipher(player) : null;
      const aUrl = pick.audio ? await pick.audio.decipher(player) : null;
      const first = vUrl ?? aUrl;
      if (!first || !(await probeUrl(first, o.signal))) continue;

      const vLen = pick.video?.content_length;
      const aLen = pick.audio?.content_length;
      const total = (vLen ?? 0) + (aLen ?? 0);
      let base = 0;
      const step = (label: string) => (got: number) => o.onProgress?.(total ? Math.min(1, (base + got) / total) : 0, label);
      const label = o.kind === 'audio' ? 'Downloading sound' : `Downloading ${pick.video?.quality_label ?? 'video'}`;
      const video = vUrl && pick.video ? await fetchStream(vUrl, vLen, pick.video.mime_type, o, step(label)) : null;
      base += vLen ?? 0;
      const audio = aUrl && pick.audio ? await fetchStream(aUrl, aLen, pick.audio.mime_type, o, step(label)) : null;
      return {
        video,
        audio,
        title: info.basic_info.title ?? 'YouTube video',
        channel: info.basic_info.author ?? '',
        duration: info.basic_info.duration ?? 0,
      };
    } catch (e) {
      if (o.signal?.aborted || (e as Error)?.name === 'AbortError') throw e;
      console.warn(`YouTube client ${client} failed`, e);
      lastError = e;
    }
  }
  throw lastError instanceof YouTubeError
    ? lastError
    : new YouTubeError('Couldn’t download this video from YouTube. It may be private, age-restricted, or YouTube changed something.');
}

/** Video title and length without downloading, for links opened in the app. */
export async function youTubeDetails(id: string): Promise<YtVideo | null> {
  if (!canUseYouTubeApi()) return null;
  try {
    const yt = await innertube();
    const info = await yt.getBasicInfo(id);
    return {
      id,
      title: info.basic_info.title ?? 'YouTube video',
      channel: info.basic_info.author ?? '',
      duration: info.basic_info.duration ?? 0,
      thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    };
  } catch (e) {
    console.warn('Could not read video details', e);
    return null;
  }
}
