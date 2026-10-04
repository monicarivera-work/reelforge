import { ALL_FORMATS, AudioBufferSink, BlobSource, CanvasSink, Input } from 'mediabunny';
import type { MediaAsset, MediaKind } from '../types';
import { getMedia, getPeaks, getThumbs, putMedia, putPeaks, putThumbs, type PeakRecord } from './db';
import { clamp, uid } from './util';

/** Fires `update` with `detail = assetId` whenever thumbnails or waveforms become available. */
export const mediaEvents = new EventTarget();

const assets = new Map<string, MediaAsset>();
const blobs = new Map<string, Blob>();
const urls = new Map<string, string>();

export function registerAsset(asset: MediaAsset, blob?: Blob) {
  assets.set(asset.id, asset);
  if (blob) blobs.set(asset.id, blob);
}

export function getAsset(id: string): MediaAsset | undefined {
  return assets.get(id);
}

export async function loadAssets(ids: string[]): Promise<Record<string, MediaAsset>> {
  const out: Record<string, MediaAsset> = {};
  for (const id of ids) {
    let a = assets.get(id);
    if (!a) {
      const rec = await getMedia(id);
      if (rec) {
        registerAsset(rec.asset, rec.blob);
        a = rec.asset;
      }
    }
    if (a) out[id] = a;
  }
  return out;
}

export async function getBlob(id: string): Promise<Blob | null> {
  const b = blobs.get(id);
  if (b) return b;
  const rec = await getMedia(id);
  if (!rec) return null;
  registerAsset(rec.asset, rec.blob);
  return rec.blob;
}

export async function getObjectUrl(id: string): Promise<string | null> {
  const u = urls.get(id);
  if (u) return u;
  const b = await getBlob(id);
  if (!b) return null;
  const existing = urls.get(id);
  if (existing) return existing;
  const url = URL.createObjectURL(b);
  urls.set(id, url);
  return url;
}

/** Synchronous variant: returns null (and starts loading) when the blob is not in memory yet. */
export function peekObjectUrl(id: string): string | null {
  const u = urls.get(id);
  if (u) return u;
  const b = blobs.get(id);
  if (!b) {
    void getObjectUrl(id).then((url) => {
      if (url) mediaEvents.dispatchEvent(new CustomEvent('update', { detail: id }));
    });
    return null;
  }
  const url = URL.createObjectURL(b);
  urls.set(id, url);
  return url;
}

export function kindOf(type: string, name: string): MediaKind | null {
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['mp4', 'mov', 'm4v', 'webm', 'mkv', '3gp', 'ts', 'mts', 'avi'].includes(ext)) return 'video';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'bmp'].includes(ext)) return 'image';
  if (['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'caf', 'weba'].includes(ext)) return 'audio';
  return null;
}

interface ProbeInfo {
  duration: number;
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
  canDecodeVideo: boolean;
  canDecodeAudio: boolean;
}

async function probeMediabunny(blob: Blob): Promise<ProbeInfo> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const v = await input.getPrimaryVideoTrack();
    const a = await input.getPrimaryAudioTrack();
    if (!v && !a) throw new Error('no tracks');
    const duration = await input.computeDuration();
    return {
      duration,
      width: v ? await v.getDisplayWidth() : 0,
      height: v ? await v.getDisplayHeight() : 0,
      hasVideo: !!v,
      hasAudio: !!a,
      canDecodeVideo: v ? await v.canDecode().catch(() => false) : false,
      canDecodeAudio: a ? await a.canDecode().catch(() => false) : false,
    };
  } finally {
    input.dispose();
  }
}

function probeElement(blob: Blob, kind: MediaKind): Promise<ProbeInfo> {
  return new Promise((resolve, reject) => {
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video') as HTMLVideoElement;
    const url = URL.createObjectURL(blob);
    el.preload = 'metadata';
    el.muted = true;
    const done = () => URL.revokeObjectURL(url);
    el.onloadedmetadata = () => {
      const duration = el.duration;
      resolve({
        duration: Number.isFinite(duration) ? duration : 0,
        width: el.videoWidth || 0,
        height: el.videoHeight || 0,
        hasVideo: kind === 'video' && el.videoWidth > 0,
        hasAudio: true,
        canDecodeVideo: false,
        canDecodeAudio: false,
      });
      done();
    };
    el.onerror = () => {
      done();
      reject(new Error('This file format is not supported on this device'));
    };
    el.src = url;
  });
}

export async function probe(blob: Blob, name: string, type: string): Promise<MediaAsset> {
  const kind = kindOf(type, name);
  if (!kind) throw new Error('Unsupported file type');
  const base = { id: uid('m_'), name, mime: type, size: blob.size, createdAt: Date.now() };
  if (kind === 'image') {
    const bmp = await createImageBitmap(blob).catch(() => {
      throw new Error('This image format is not supported on this device');
    });
    const asset: MediaAsset = {
      ...base,
      kind,
      duration: 0,
      width: bmp.width,
      height: bmp.height,
      hasAudio: false,
      canDecodeVideo: false,
      canDecodeAudio: false,
    };
    bmp.close();
    return asset;
  }
  let info: ProbeInfo;
  try {
    info = await probeMediabunny(blob);
  } catch {
    info = await probeElement(blob, kind);
  }
  if (!(info.duration > 0)) throw new Error('Could not read the media duration');
  const finalKind: MediaKind = info.hasVideo ? 'video' : 'audio';
  if (kind === 'video' && !info.hasVideo && !info.hasAudio) throw new Error('No playable tracks found');
  return {
    ...base,
    kind: finalKind,
    duration: info.duration,
    width: info.width,
    height: info.height,
    hasAudio: info.hasAudio,
    canDecodeVideo: info.canDecodeVideo,
    canDecodeAudio: info.canDecodeAudio,
  };
}

export async function importFiles(
  files: File[] | Blob[],
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<{ assets: MediaAsset[]; errors: string[] }> {
  const out: MediaAsset[] = [];
  const errors: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const name = (f as File).name ?? `media-${i + 1}`;
    onProgress?.(i, files.length, name);
    try {
      const asset = await probe(f, name, f.type);
      await putMedia(asset, f);
      registerAsset(asset, f);
      out.push(asset);
      void ensureThumbs(asset.id);
      if (asset.hasAudio) void ensurePeaks(asset.id);
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  }
  onProgress?.(files.length, files.length, '');
  return { assets: out, errors };
}

// ---------------------------------------------------------------------------
// Background work queue (one decode job at a time keeps phones responsive)

let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// Canvas helpers

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function canvasToBlob(c: HTMLCanvasElement | OffscreenCanvas, type = 'image/jpeg', q = 0.75): Promise<Blob> {
  if ('convertToBlob' in c) return c.convertToBlob({ type, quality: q });
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), type, q));
}

function drawCover(ctx: CanvasRenderingContext2D, src: CanvasImageSource, sw: number, sh: number, size: number) {
  const s = Math.max(size / sw, size / sh);
  const w = sw * s;
  const h = sh * s;
  ctx.drawImage(src, (size - w) / 2, (size - h) / 2, w, h);
}

export function loadVideoElement(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    const timer = setTimeout(() => resolve(v), 8000);
    v.onloadeddata = () => {
      clearTimeout(timer);
      resolve(v);
    };
    v.onloadedmetadata = () => {
      if (v.readyState < 2) {
        v.play()
          .then(() => v.pause())
          .catch(() => undefined);
      }
    };
    v.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Video failed to load'));
    };
    v.src = url;
    v.load();
  });
}

export function seekElement(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2) return resolve();
    const timer = setTimeout(finish, 3000);
    function finish() {
      clearTimeout(timer);
      v.removeEventListener('seeked', finish);
      resolve();
    }
    v.addEventListener('seeked', finish);
    v.currentTime = t;
  });
}

// ---------------------------------------------------------------------------
// Images

type DecodedImage = ImageBitmap | HTMLCanvasElement;
const imageCache = new Map<string, Promise<DecodedImage>>();
const imageValues = new Map<string, DecodedImage>();
const MAX_IMAGE = 4096;

export function getImage(id: string): Promise<DecodedImage> {
  let p = imageCache.get(id);
  if (!p) {
    p = (async () => {
      const blob = await getBlob(id);
      if (!blob) throw new Error('Missing image');
      // WebGL ignores UNPACK_PREMULTIPLY_ALPHA for ImageBitmaps, so request premultiplied pixels up front.
      const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'premultiply' }).catch(() => createImageBitmap(blob));
      const big = Math.max(bmp.width, bmp.height);
      let out: DecodedImage = bmp;
      if (big > MAX_IMAGE) {
        const s = MAX_IMAGE / big;
        const c = makeCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
        c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
        bmp.close();
        out = c;
      }
      imageValues.set(id, out);
      mediaEvents.dispatchEvent(new CustomEvent('update', { detail: id }));
      return out;
    })();
    imageCache.set(id, p);
    p.catch(() => imageCache.delete(id));
  }
  return p;
}

/** Returns the decoded image if ready, otherwise starts loading it and returns null. */
export function peekImage(id: string): DecodedImage | null {
  const v = imageValues.get(id);
  if (v) return v;
  void getImage(id).catch(() => undefined);
  return null;
}

// ---------------------------------------------------------------------------
// Thumbnails

export interface ThumbStrip {
  interval: number;
  images: (ImageBitmap | null)[];
}

const THUMB = 96;
const thumbMem = new Map<string, ThumbStrip>();
const thumbJobs = new Map<string, Promise<void>>();

export function getThumbStrip(id: string): ThumbStrip | null {
  return thumbMem.get(id) ?? null;
}

export function ensureThumbs(id: string): Promise<void> {
  let job = thumbJobs.get(id);
  if (!job) {
    job = (async () => {
      let rec = await getThumbs(id);
      if (!rec) {
        const asset = assets.get(id) ?? (await loadAssets([id]))[id];
        const blob = await getBlob(id);
        if (!asset || !blob || asset.kind === 'audio') return;
        rec = await enqueue(() => generateThumbs(asset, blob));
        await putThumbs(rec);
      }
      const images = await Promise.all(rec.blobs.map((b) => createImageBitmap(b).catch(() => null)));
      thumbMem.set(id, { interval: rec.interval, images });
      mediaEvents.dispatchEvent(new CustomEvent('update', { detail: id }));
    })().catch((e) => console.warn('thumbs failed', e));
    thumbJobs.set(id, job);
  }
  return job;
}

async function generateThumbs(asset: MediaAsset, blob: Blob) {
  const c = makeCanvas(THUMB, THUMB);
  const ctx = c.getContext('2d')!;
  if (asset.kind === 'image') {
    const bmp = await createImageBitmap(blob);
    drawCover(ctx, bmp, bmp.width, bmp.height, THUMB);
    bmp.close();
    return { id: asset.id, interval: 1e9, blobs: [await canvasToBlob(c)] };
  }
  const interval = clamp(asset.duration / 120, 0.5, 5);
  const n = Math.max(1, Math.ceil(asset.duration / interval));
  const times = Array.from({ length: n }, (_, i) => Math.min(Math.max(0, asset.duration - 0.05), i * interval + 0.02));
  const out: Blob[] = [];
  if (asset.canDecodeVideo) {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error('no video');
      const sink = new CanvasSink(track, { width: THUMB, height: THUMB, fit: 'cover', poolSize: 2 });
      let last: Blob | null = null;
      for await (const wc of sink.canvasesAtTimestamps(times)) {
        if (wc) last = await canvasToBlob(wc.canvas);
        if (last) out.push(last);
      }
      if (out.length) return { id: asset.id, interval, blobs: out };
    } catch (e) {
      console.warn('WebCodecs thumbnails failed, using <video>', e);
    } finally {
      input.dispose();
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const v = await loadVideoElement(url);
    for (const t of times) {
      await seekElement(v, t);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, THUMB, THUMB);
      drawCover(ctx, v, v.videoWidth || THUMB, v.videoHeight || THUMB, THUMB);
      out.push(await canvasToBlob(c));
    }
    v.removeAttribute('src');
    v.load();
  } finally {
    URL.revokeObjectURL(url);
  }
  return { id: asset.id, interval, blobs: out };
}

// ---------------------------------------------------------------------------
// Waveform peaks

export const PEAK_RATE = 50;
const peakMem = new Map<string, PeakRecord>();
const peakJobs = new Map<string, Promise<void>>();

export function getPeaksSync(id: string): PeakRecord | null {
  return peakMem.get(id) ?? null;
}

export function ensurePeaks(id: string): Promise<void> {
  let job = peakJobs.get(id);
  if (!job) {
    job = (async () => {
      let rec = await getPeaks(id);
      if (!rec) {
        const asset = assets.get(id) ?? (await loadAssets([id]))[id];
        const blob = await getBlob(id);
        if (!asset || !blob || !asset.hasAudio) return;
        rec = await enqueue(() => generatePeaks(asset, blob));
        await putPeaks(rec);
      }
      peakMem.set(id, rec);
      mediaEvents.dispatchEvent(new CustomEvent('update', { detail: id }));
    })().catch((e) => console.warn('peaks failed', e));
    peakJobs.set(id, job);
  }
  return job;
}

function accumulate(data: Float32Array, buf: AudioBuffer, timestamp: number) {
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const base = timestamp * PEAK_RATE;
  const step = PEAK_RATE / buf.sampleRate;
  for (let i = 0; i < ch0.length; i += 3) {
    let v = Math.abs(ch0[i]);
    if (ch1) v = Math.max(v, Math.abs(ch1[i]));
    const k = Math.floor(base + i * step);
    if (k >= 0 && k < data.length && v > data[k]) data[k] = v;
  }
}

async function generatePeaks(asset: MediaAsset, blob: Blob): Promise<PeakRecord> {
  const data = new Float32Array(Math.ceil(asset.duration * PEAK_RATE) + 1);
  let ok = false;
  if (asset.canDecodeAudio) {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
    try {
      const track = await input.getPrimaryAudioTrack();
      if (track) {
        const sink = new AudioBufferSink(track);
        for await (const { buffer, timestamp } of sink.buffers()) accumulate(data, buffer, timestamp);
        ok = true;
      }
    } catch (e) {
      console.warn('WebCodecs audio decode failed, falling back', e);
    } finally {
      input.dispose();
    }
  }
  if (!ok) {
    const buf = await decodeWholeAudio(blob);
    accumulate(data, buf, 0);
  }
  let max = 0;
  for (const v of data) max = Math.max(max, v);
  const norm = max > 0 ? 1 / max : 1;
  const u8 = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) u8[i] = Math.round(Math.sqrt(data[i] * norm) * 255);
  return { id: asset.id, rate: PEAK_RATE, data: u8 };
}

export async function decodeWholeAudio(blob: Blob): Promise<AudioBuffer> {
  const ab = await blob.arrayBuffer();
  const Ctx = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const ctx = new Ctx(2, 1, 48000);
  return await new Promise<AudioBuffer>((resolve, reject) => {
    const p = ctx.decodeAudioData(ab, resolve, reject);
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

// ---------------------------------------------------------------------------
// Frame capture (freeze frame / save still)

export async function captureFrame(asset: MediaAsset, t: number): Promise<Blob> {
  const blob = await getBlob(asset.id);
  if (!blob) throw new Error('Missing media');
  if (asset.canDecodeVideo) {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (track) {
        const sink = new CanvasSink(track);
        const wc = (await sink.getCanvas(t)) ?? (await sink.getCanvas(Math.max(0, t - 0.1)));
        if (wc) return await canvasToBlob(wc.canvas, 'image/jpeg', 0.92);
      }
    } finally {
      input.dispose();
    }
  }
  const url = await getObjectUrl(asset.id);
  const v = await loadVideoElement(url!);
  await seekElement(v, t);
  const c = makeCanvas(v.videoWidth, v.videoHeight);
  c.getContext('2d')!.drawImage(v, 0, 0);
  return canvasToBlob(c, 'image/jpeg', 0.92);
}
