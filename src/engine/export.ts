import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  canEncodeAudio,
  getFirstEncodableVideoCodec,
  type AudioCodec,
  type VideoCodec,
  type WrappedCanvas,
} from 'mediabunny';
import type { Project, VideoItem } from '../types';
import { acquireWakeLock } from '../lib/device';
import { canvasSize, projectDuration } from '../lib/layout';
import { getAsset, getBlob, getImage, getObjectUrl, loadAssets, loadVideoElement, makeCanvas, peekImage, seekElement } from '../lib/media';
import { ensureFont } from '../lib/text';
import { clamp, safeFileName } from '../lib/util';
import { AudioMixer, canEncodeAac } from './audio';
import { Compositor } from './gl';
import { buildFrame, TextCache, type FrameProvider, type FrameSource } from './scene';

export type ExportResolution = 720 | 1080 | 1440 | 2160;
export type ExportQuality = 'low' | 'medium' | 'high';

export interface ExportSettings {
  resolution: ExportResolution;
  fps: number;
  quality: ExportQuality;
}

export interface ExportProgress {
  phase: 'prepare' | 'render' | 'finalize';
  /** 0..1 */
  progress: number;
  /** seconds remaining, when known */
  eta: number | null;
}

export interface ExportResult {
  blob: Blob;
  width: number;
  height: number;
  duration: number;
  codec: string;
  fileName: string;
}

const BPP: Record<ExportQuality, number> = { low: 0.06, medium: 0.11, high: 0.18 };
const AUDIO_BITRATE = 192_000;
const SAMPLE_RATE = 48_000;

export function exportDims(p: Project, s: Pick<ExportSettings, 'resolution'>) {
  return canvasSize(p.aspect, s.resolution);
}

export function videoBitrate(p: Project, s: ExportSettings): number {
  const { w, h } = exportDims(p, s);
  return Math.round(clamp(w * h * s.fps * BPP[s.quality], 1_000_000, 80_000_000));
}

/** Approximate output size in bytes. */
export function estimateSize(p: Project, s: ExportSettings): number {
  return ((videoBitrate(p, s) + AUDIO_BITRATE) / 8) * projectDuration(p);
}

// ---------------------------------------------------------------------------
// Sequential frame sources (exact frames, decoded in order)

interface SeqSource {
  frameAt(st: number): Promise<FrameSource | null>;
  dispose(): void;
}

let exportVersion = 0;

class SinkFrames implements SeqSource {
  private input: Input | null = null;
  private sink: CanvasSink | null = null;
  private iter: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
  private cur: WrappedCanvas | null = null;
  private next: WrappedCanvas | null = null;
  private done = false;
  private version = 0;

  constructor(
    private blob: Blob,
    private maxSide: number,
  ) {}

  private async open() {
    this.input = new Input({ formats: ALL_FORMATS, source: new BlobSource(this.blob) });
    const track = await this.input.getPrimaryVideoTrack();
    if (!track) throw new Error('No video track');
    const w = await track.getDisplayWidth();
    const h = await track.getDisplayHeight();
    const k = Math.min(1, this.maxSide / Math.max(w, h, 1));
    this.sink = new CanvasSink(track, {
      width: Math.max(2, Math.round(w * k)),
      height: Math.max(2, Math.round(h * k)),
      fit: 'fill',
      poolSize: 4,
    });
  }

  private async restart(st: number) {
    if (!this.sink) await this.open();
    await this.iter?.return();
    this.iter = this.sink!.canvases(st);
    this.cur = null;
    this.next = null;
    this.done = false;
    const r = await this.iter.next();
    if (!r.done) {
      this.cur = r.value;
      this.version = ++exportVersion;
    } else this.done = true;
  }

  async frameAt(st: number): Promise<FrameSource | null> {
    if (!this.iter || (this.cur && st < this.cur.timestamp - 1e-3) || (this.cur && st > this.cur.timestamp + 3)) {
      await this.restart(st);
    }
    while (!this.done) {
      if (!this.next) {
        const r = await this.iter!.next();
        if (r.done) {
          this.done = true;
          break;
        }
        this.next = r.value;
      }
      if (this.next.timestamp <= st + 1e-4 || !this.cur) {
        this.cur = this.next;
        this.next = null;
        this.version = ++exportVersion;
      } else break;
    }
    return this.cur ? { source: this.cur.canvas, version: this.version } : null;
  }

  dispose() {
    void this.iter?.return().catch(() => undefined);
    this.iter = null;
    this.input?.dispose();
    this.input = null;
    this.sink = null;
  }
}

/** Fallback for codecs WebCodecs cannot decode: seek a <video> element frame by frame. */
class ElementFrames implements SeqSource {
  private v: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private version = 0;
  private last = -1;

  constructor(
    private mediaId: string,
    private maxSide: number,
  ) {}

  async frameAt(st: number): Promise<FrameSource | null> {
    if (!this.v) {
      const url = await getObjectUrl(this.mediaId);
      if (!url) return null;
      this.v = await loadVideoElement(url);
    }
    const v = this.v;
    if (Math.abs(st - this.last) > 1e-4 || !this.canvas) {
      await seekElement(v, st);
      const vw = v.videoWidth || 2;
      const vh = v.videoHeight || 2;
      const k = Math.min(1, this.maxSide / Math.max(vw, vh));
      const w = Math.max(2, Math.round(vw * k));
      const h = Math.max(2, Math.round(vh * k));
      if (!this.canvas) this.canvas = makeCanvas(w, h);
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      this.canvas.getContext('2d')!.drawImage(v, 0, 0, w, h);
      this.last = st;
      this.version = ++exportVersion;
    }
    return { source: this.canvas, version: this.version };
  }

  dispose() {
    if (this.v) {
      this.v.removeAttribute('src');
      this.v.load();
    }
    this.v = null;
  }
}

/** Provides exact frames for an offline render pass. Call `prepare(t)` before `buildFrame(t)`. */
class OfflineFrames implements FrameProvider {
  private sources = new Map<string, SeqSource>();
  private ready = new Map<string, FrameSource | null>();
  private requests = new Map<string, { item: VideoItem; st: number }>();
  private recording = false;

  constructor(private maxSide: number) {}

  video(item: VideoItem, st: number): FrameSource | null {
    if (this.recording) this.requests.set(item.id, { item, st });
    return this.ready.get(item.id) ?? null;
  }

  image(mediaId: string) {
    return peekImage(mediaId);
  }

  private async source(item: VideoItem): Promise<SeqSource> {
    let s = this.sources.get(item.id);
    if (s) return s;
    const asset = getAsset(item.mediaId);
    const blob = await getBlob(item.mediaId);
    if (asset?.canDecodeVideo && blob) s = new SinkFrames(blob, this.maxSide);
    else s = new ElementFrames(item.mediaId, this.maxSide);
    this.sources.set(item.id, s);
    return s;
  }

  /** Dry-run the scene to learn which frames are needed, then decode them. */
  async prepare(p: Project, t: number, W: number, H: number, texts: TextCache) {
    this.requests.clear();
    this.recording = true;
    try {
      buildFrame(p, t, { W, H, asset: getAsset, provider: this, texts, seed: 0 });
    } finally {
      this.recording = false;
    }
    for (const { item, st } of this.requests.values()) {
      let src = await this.source(item);
      let f: FrameSource | null;
      try {
        f = await src.frameAt(st);
      } catch (e) {
        if (!(src instanceof SinkFrames)) throw e;
        console.warn('WebCodecs decode failed during export, using <video> fallback', e);
        src.dispose();
        src = new ElementFrames(item.mediaId, this.maxSide);
        this.sources.set(item.id, src);
        f = await src.frameAt(st);
      }
      this.ready.set(item.id, f);
    }
    // Release decoders of clips that are finished.
    for (const [id, s] of this.sources) {
      if (this.requests.has(id)) continue;
      const it = [...p.main, ...p.overlays].find((x) => x.id === id);
      if (!it || it.start + it.duration <= t) {
        s.dispose();
        this.sources.delete(id);
        this.ready.delete(id);
      }
    }
  }

  dispose() {
    for (const s of this.sources.values()) s.dispose();
    this.sources.clear();
    this.ready.clear();
  }
}

async function preloadResources(p: Project) {
  const ids = new Set<string>();
  for (const it of [...p.main, ...p.overlays, ...p.audios]) if ('mediaId' in it) ids.add(it.mediaId);
  await loadAssets([...ids]);
  const images = [...p.main, ...p.overlays].filter((i) => i.type === 'image');
  await Promise.all(images.map((i) => (i.type === 'image' ? getImage(i.mediaId).catch(() => null) : null)));
  await Promise.all(p.texts.map((t) => ensureFont(t.style.font, t.style.weight, t.style.italic).catch(() => undefined)));
}

// ---------------------------------------------------------------------------
// Encoders

async function pickAudioCodec(): Promise<AudioCodec | null> {
  const opts = { numberOfChannels: 2, sampleRate: SAMPLE_RATE, bitrate: AUDIO_BITRATE };
  if (await canEncodeAac(opts)) return 'aac';
  if (await canEncodeAudio('opus', opts).catch(() => false)) return 'opus';
  return null;
}

async function pickVideoCodec(w: number, h: number, fps: number, bitrate: number): Promise<VideoCodec | null> {
  return getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: w, height: h, frameRate: fps, bitrate });
}

/** Checks whether this device can export the given settings (resolution / frame rate). */
export async function canExport(p: Project, s: ExportSettings): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false;
  const { w, h } = exportDims(p, s);
  return (await pickVideoCodec(w, h, s.fps, videoBitrate(p, s)).catch(() => null)) !== null;
}

function abortError() {
  return new DOMException('Export cancelled', 'AbortError');
}

export async function exportVideo(
  project: Project,
  settings: ExportSettings,
  opts: { signal?: AbortSignal; onProgress?: (e: ExportProgress) => void } = {},
): Promise<ExportResult> {
  const { signal, onProgress } = opts;
  const p = JSON.parse(JSON.stringify(project)) as Project;
  const duration = projectDuration(p);
  if (duration <= 0) throw new Error('Add some media to the timeline first');
  if (typeof VideoEncoder === 'undefined') throw new Error('This browser cannot encode video (WebCodecs is unavailable)');
  onProgress?.({ phase: 'prepare', progress: 0, eta: null });

  const { w: W, h: H } = exportDims(p, settings);
  const fps = settings.fps;
  const bitrate = videoBitrate(p, settings);
  const vcodec = await pickVideoCodec(W, H, fps, bitrate);
  if (!vcodec) throw new Error(`This device cannot encode ${W}×${H} video at ${fps} fps. Try a lower resolution or frame rate.`);
  const acodec = await pickAudioCodec();
  await preloadResources(p);
  if (signal?.aborted) throw abortError();

  const wake = await acquireWakeLock();
  const canvas = makeCanvas(W, H);
  const comp = new Compositor(canvas, { preserve: true });
  const texts = new TextCache();
  const frames = new OfflineFrames(Math.max(W, H));
  const mixer = acodec ? new AudioMixer(() => p, SAMPLE_RATE, 2) : null;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const video = new CanvasSource(canvas, {
    codec: vcodec,
    quality: new Quality({ bitrate }),
    keyFrameInterval: 2,
    latencyMode: 'quality',
  });
  output.addVideoTrack(video, { frameRate: fps });
  const audio = acodec ? new AudioBufferSource({ codec: acodec, quality: new Quality({ bitrate: AUDIO_BITRATE }) }) : null;
  if (audio) output.addAudioTrack(audio);

  let audioT = 0;
  const pushAudio = async (until: number) => {
    if (!audio || !mixer) return;
    while (audioT < until && audioT < duration) {
      const len = Math.max(1, Math.round(Math.min(1, duration - audioT) * SAMPLE_RATE));
      const data = await mixer.mix(audioT, len);
      const buf = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate: SAMPLE_RATE });
      if (data) {
        buf.copyToChannel(data[0] as Float32Array<ArrayBuffer>, 0);
        buf.copyToChannel(data[1] as Float32Array<ArrayBuffer>, 1);
      }
      await audio.add(buf);
      audioT += len / SAMPLE_RATE;
    }
  };

  let finished = false;
  try {
    await output.start();
    const total = Math.max(1, Math.round(duration * fps));
    const t0 = performance.now();
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw abortError();
      const t = Math.min(i / fps, duration - 0.001);
      await pushAudio(t + 1);
      await frames.prepare(p, t, W, H, texts);
      const { spec } = buildFrame(p, t, {
        W,
        H,
        asset: getAsset,
        provider: frames,
        texts,
        seed: Math.floor(t * p.fps),
      });
      comp.render(spec);
      if (comp.lost) throw new Error('The graphics context was lost during export. Please try again.');
      await video.add(i / fps, 1 / fps);
      if (i % 3 === 0 || i === total - 1) {
        const done = (i + 1) / total;
        const el = (performance.now() - t0) / 1000;
        onProgress?.({ phase: 'render', progress: done * 0.98, eta: i > 10 ? (el / done) * (1 - done) : null });
      }
    }
    await pushAudio(duration);
    onProgress?.({ phase: 'finalize', progress: 0.99, eta: 0 });
    video.close();
    audio?.close();
    await output.finalize();
    finished = true;
    const buffer = output.target.buffer;
    if (!buffer) throw new Error('Export produced no data');
    onProgress?.({ phase: 'finalize', progress: 1, eta: 0 });
    const safe = safeFileName(p.name, 'ReelForge');
    return {
      blob: new Blob([buffer], { type: 'video/mp4' }),
      width: W,
      height: H,
      duration,
      codec: `${vcodec}${acodec ? ' + ' + acodec : ''}`,
      fileName: `${safe}.mp4`,
    };
  } finally {
    if (!finished) await output.cancel().catch(() => undefined);
    frames.dispose();
    mixer?.dispose();
    texts.clear();
    comp.dispose();
    canvas.width = canvas.height = 1;
    void wake?.release().catch(() => undefined);
  }
}

/** Renders a single composited frame to an image (Save frame / thumbnails). */
export async function renderStill(project: Project, t: number, shortSide = 1080, type = 'image/png'): Promise<Blob> {
  const p = JSON.parse(JSON.stringify(project)) as Project;
  const { w: W, h: H } = canvasSize(p.aspect, shortSide);
  await preloadResources(p);
  const canvas = makeCanvas(W, H);
  const comp = new Compositor(canvas, { preserve: true });
  const texts = new TextCache();
  const frames = new OfflineFrames(Math.max(W, H));
  try {
    const dur = projectDuration(p);
    const tt = clamp(t, 0, Math.max(0, dur - 0.001));
    await frames.prepare(p, tt, W, H, texts);
    const { spec } = buildFrame(p, tt, { W, H, asset: getAsset, provider: frames, texts, seed: Math.floor(tt * p.fps) });
    comp.render(spec);
    return await new Promise<Blob>((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode image'))), type, 0.95),
    );
  } finally {
    frames.dispose();
    texts.clear();
    comp.dispose();
  }
}
