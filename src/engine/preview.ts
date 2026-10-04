import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny';
import type { Project, VideoItem } from '../types';
import { canvasSize, projectDuration } from '../lib/layout';
import { getAsset, getBlob, mediaEvents, peekImage, peekObjectUrl } from '../lib/media';
import { fontEvents } from '../lib/text';
import { clamp, isIOS } from '../lib/util';
import { AudioPlayback } from './audio';
import { Compositor } from './gl';
import { buildFrame, TextCache, type FrameProvider, type HitQuad } from './scene';

const MAX_SLOTS = 6;
const PREROLL = 1.5;
const MAX_PIXELS = 1.6e6;
let frameVersion = 0;

/** Decodes frames through WebCodecs when the browser's <video> element cannot play a file. */
class SinkFallback {
  private input: Input | null = null;
  private sink: CanvasSink | null = null;
  private busy = false;
  private want: number | null = null;
  private last = -1;
  private disposed = false;
  readonly ready: Promise<boolean>;

  constructor(
    mediaId: string,
    maxSide: number,
    private onFrame: (c: HTMLCanvasElement | OffscreenCanvas) => void,
  ) {
    this.ready = this.init(mediaId, maxSide);
  }

  private async init(id: string, maxSide: number): Promise<boolean> {
    try {
      const blob = await getBlob(id);
      if (!blob || this.disposed) return false;
      this.input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
      const track = await this.input.getPrimaryVideoTrack();
      if (!track || !(await track.canDecode())) return false;
      const w = await track.getDisplayWidth();
      const h = await track.getDisplayHeight();
      const s = Math.min(1, maxSide / Math.max(w, h, 1));
      this.sink = new CanvasSink(track, {
        width: Math.max(2, Math.round(w * s)),
        height: Math.max(2, Math.round(h * s)),
        fit: 'fill',
        poolSize: 2,
      });
      return !this.disposed;
    } catch (e) {
      console.warn('WebCodecs preview fallback failed', e);
      return false;
    }
  }

  request(t: number) {
    if (Math.abs(t - this.last) < 1e-3) return;
    if (this.busy) {
      this.want = t;
      return;
    }
    void this.fetch(t);
  }

  private async fetch(t: number) {
    this.busy = true;
    try {
      if (!(await this.ready) || !this.sink || this.disposed) return;
      const wc = (await this.sink.getCanvas(t)) ?? (await this.sink.getCanvas(Math.max(0, t - 0.05)));
      this.last = t;
      if (wc && !this.disposed) this.onFrame(wc.canvas);
    } catch (e) {
      console.warn('fallback frame failed', e);
    } finally {
      this.busy = false;
      const w = this.want;
      this.want = null;
      if (w !== null && !this.disposed) this.request(w);
    }
  }

  dispose() {
    this.disposed = true;
    this.input?.dispose();
    this.input = null;
    this.sink = null;
  }
}

interface Slot {
  id: string;
  mediaId: string;
  v: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  version: number;
  hasFrame: boolean;
  drawnAt: number;
  dirty: boolean;
  meta: boolean;
  seeking: boolean;
  pending: number | null;
  target: number;
  lastUsed: number;
  playing: boolean;
  noPlay: boolean;
  lastFix: number;
  sink: SinkFallback | null;
  off: () => void;
}

export interface PreviewOptions {
  canvas: HTMLCanvasElement;
  getProject: () => Project;
  /** Called on every frame while playing (and when playback stops). */
  onTime?: (t: number) => void;
  onPlayState?: (playing: boolean) => void;
  /** Called after each rendered frame (e.g. to redraw selection handles). */
  onRender?: () => void;
}

/**
 * Live preview: renders the project with the WebGL compositor, decoding video through
 * pooled <video> elements, with the audio engine as the master clock.
 */
export class PreviewEngine {
  readonly audio: AudioPlayback;
  readonly comp: Compositor;
  private texts = new TextCache();
  private slots = new Map<string, Slot>();
  private wants = new Map<string, { item: VideoItem; st: number }>();
  private box: HTMLDivElement;
  private raf = 0;
  private frameNo = 0;
  private short = 720;
  private t = 0;
  private isPlaying = false;
  private peekT: number | null = null;
  private disposed = false;
  private provider: FrameProvider;
  /** Hit-test quads of the last rendered frame (frame pixel space, topmost last). */
  quads: HitQuad[] = [];
  frameW = 2;
  frameH = 2;
  /** Timeline time of the last rendered frame. */
  renderedAt = 0;

  constructor(private opts: PreviewOptions) {
    this.comp = new Compositor(opts.canvas);
    this.comp.onRestored = () => this.requestRender();
    this.audio = new AudioPlayback(opts.getProject);
    this.box = document.createElement('div');
    this.box.setAttribute('aria-hidden', 'true');
    this.box.style.cssText =
      'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1;';
    document.body.appendChild(this.box);
    this.provider = {
      video: (item, st) => this.videoFrame(item, st),
      image: (id) => peekImage(id),
    };
    mediaEvents.addEventListener('update', this.onExternal);
    fontEvents.addEventListener('loaded', this.onExternal);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.requestRender();
  }

  // -------------------------------------------------------------------------
  // Public API

  get playing() {
    return this.isPlaying;
  }

  get time() {
    return this.isPlaying ? this.audio.now() : this.t;
  }

  /** CSS size of the on-screen canvas; determines the internal render resolution. */
  setViewport(cssW: number, cssH: number, dpr = window.devicePixelRatio || 1) {
    const s = clamp(Math.round(Math.min(cssW, cssH) * Math.min(dpr, 3)), 180, 1080);
    if (s !== this.short) {
      this.short = s;
      this.requestRender();
    }
  }

  /** Call whenever the project changes. */
  projectChanged() {
    if (this.isPlaying) this.audio.invalidate();
    this.requestRender();
  }

  /** Moves the playhead. While playing, playback continues from the new position. */
  seek(t: number) {
    t = Math.max(0, t);
    if (this.isPlaying) {
      if (Math.abs(t - this.audio.now()) < 0.1) return;
      this.audio.start(t);
      for (const s of this.slots.values()) s.lastFix = 0;
      this.kick();
      return;
    }
    if (t === this.t) return;
    this.t = t;
    this.requestRender();
  }

  /** Shows a different time without moving the playhead (e.g. while trimming); null to clear. */
  setPeek(t: number | null) {
    if (t === this.peekT) return;
    this.peekT = t;
    this.requestRender();
  }

  /** Must be called directly from a user gesture (tap) so audio and video can start on iOS. */
  play() {
    if (this.isPlaying || this.disposed) return;
    const dur = projectDuration(this.opts.getProject());
    if (dur <= 0.01) return;
    let t = this.t;
    if (t >= dur - 0.05) t = 0;
    this.t = t;
    this.peekT = null;
    this.isPlaying = true;
    this.audio.start(t);
    for (const s of this.slots.values()) s.lastFix = 0;
    // Render synchronously so active videos call play() inside the gesture.
    this.renderNow();
    if (isIOS) {
      for (const s of this.slots.values()) {
        if (s.playing || s.noPlay || !s.meta) continue;
        const v = s.v;
        void v
          .play()
          .then(() => {
            if (!s.playing) v.pause();
          })
          .catch(() => undefined);
      }
    }
    this.opts.onPlayState?.(true);
    this.kick();
  }

  pause() {
    if (!this.isPlaying) return;
    const dur = projectDuration(this.opts.getProject());
    this.t = clamp(this.audio.now(), 0, dur);
    this.audio.stop();
    this.isPlaying = false;
    for (const s of this.slots.values()) this.stopSlot(s);
    this.opts.onTime?.(this.t);
    this.opts.onPlayState?.(false);
    this.requestRender();
  }

  toggle() {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  requestRender() {
    if (this.disposed || this.raf) return;
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Renders the current frame immediately (used before reading pixels). */
  renderNow() {
    if (this.disposed) return;
    const p = this.opts.getProject();
    const dur = projectDuration(p);
    let t = this.peekT !== null && !this.isPlaying ? this.peekT : this.isPlaying ? this.audio.now() : this.t;
    t = clamp(t, 0, Math.max(0, dur - 0.001));
    for (const s of this.slots.values()) this.maybeDraw(s);
    const { w, h } = this.frameSize(p);
    this.wants.clear();
    const { spec, quads } = buildFrame(p, t, {
      W: w,
      H: h,
      asset: getAsset,
      provider: this.provider,
      texts: this.texts,
      seed: Math.floor(t * p.fps),
    });
    this.comp.render(spec);
    this.quads = quads;
    this.frameW = w;
    this.frameH = h;
    this.renderedAt = t;
    this.frameNo++;
    this.syncSlots(p, t);
    this.opts.onRender?.();
  }

  dispose() {
    if (this.disposed) return;
    this.pause();
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    mediaEvents.removeEventListener('update', this.onExternal);
    fontEvents.removeEventListener('loaded', this.onExternal);
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const s of [...this.slots.values()]) this.destroySlot(s);
    this.box.remove();
    this.audio.dispose();
    this.texts.clear();
    this.comp.dispose();
  }

  // -------------------------------------------------------------------------
  // Loop

  private onExternal = () => this.requestRender();

  private onVisibility = () => {
    if (document.visibilityState === 'hidden') this.pause();
  };

  private kick() {
    if (!this.raf && !this.disposed) this.raf = requestAnimationFrame(this.loop);
  }

  private loop = () => {
    this.raf = 0;
    if (this.disposed) return;
    if (this.isPlaying) {
      const dur = projectDuration(this.opts.getProject());
      const now = this.audio.now();
      if (now >= dur) {
        this.t = dur;
        this.audio.stop();
        this.isPlaying = false;
        for (const s of this.slots.values()) this.stopSlot(s);
        this.opts.onTime?.(dur);
        this.opts.onPlayState?.(false);
        this.renderNow();
        return;
      }
      this.opts.onTime?.(now);
      this.raf = requestAnimationFrame(this.loop);
    }
    this.renderNow();
  };

  private frameSize(p: Project) {
    let { w, h } = canvasSize(p.aspect, this.short);
    if (w * h > MAX_PIXELS) {
      const s = Math.sqrt(MAX_PIXELS / (w * h));
      ({ w, h } = canvasSize(p.aspect, Math.round(this.short * s)));
    }
    return { w, h };
  }

  // -------------------------------------------------------------------------
  // Video slots

  private videoFrame(item: VideoItem, st: number) {
    this.wants.set(item.id, { item, st });
    let s = this.slots.get(item.id);
    if (!s || s.mediaId !== item.mediaId || !s.hasFrame) {
      // Show any other decoded frame of the same media while this slot warms up (e.g. right after a split).
      s = undefined;
      for (const o of this.slots.values()) {
        if (o.mediaId === item.mediaId && o.hasFrame && (!s || Math.abs(o.drawnAt - st) < Math.abs(s.drawnAt - st))) s = o;
      }
      if (!s) return null;
    }
    return { source: s.canvas, version: s.version };
  }

  private maxSide() {
    return Math.max(this.frameW, this.frameH, 640);
  }

  private maybeDraw(s: Slot) {
    if (s.sink) return;
    const v = s.v;
    if (s.seeking || v.readyState < 2) return;
    if (this.isPlaying ? !s.dirty && v.currentTime === s.drawnAt : !s.dirty) return;
    this.drawFrom(s, v, v.videoWidth, v.videoHeight);
    s.drawnAt = v.currentTime;
  }

  private drawFrom(s: Slot, src: CanvasImageSource, sw: number, sh: number) {
    if (!sw || !sh) return;
    const k = Math.min(1, this.maxSide() / Math.max(sw, sh));
    const cw = Math.max(2, Math.round(sw * k));
    const ch = Math.max(2, Math.round(sh * k));
    if (s.canvas.width !== cw || s.canvas.height !== ch) {
      s.canvas.width = cw;
      s.canvas.height = ch;
    }
    if (!s.ctx) return;
    try {
      s.ctx.drawImage(src, 0, 0, cw, ch);
    } catch {
      return;
    }
    s.version = ++frameVersion;
    s.hasFrame = true;
    s.dirty = false;
  }

  private createSlot(id: string, mediaId: string, url: string): Slot {
    const v = document.createElement('video');
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.setAttribute('muted', '');
    v.preload = 'auto';
    v.disableRemotePlayback = true;
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const s: Slot = {
      id,
      mediaId,
      v,
      canvas,
      ctx: canvas.getContext('2d', { alpha: false }),
      version: 0,
      hasFrame: false,
      drawnAt: -1,
      dirty: false,
      meta: false,
      seeking: false,
      pending: null,
      target: -1,
      lastUsed: this.frameNo,
      playing: false,
      noPlay: false,
      lastFix: 0,
      sink: null,
      off: () => undefined,
    };
    const onMeta = () => {
      s.meta = true;
      const t = s.pending ?? s.target;
      s.pending = null;
      if (t >= 0 && !s.playing) this.seekSlot(s, t, true);
      else if (isIOS && v.readyState < 2 && !s.playing) {
        // iOS may not fetch frame data until playback is attempted.
        void v
          .play()
          .then(() => {
            if (!s.playing) v.pause();
          })
          .catch(() => undefined);
      }
    };
    const onData = () => {
      s.dirty = true;
      this.requestRender();
    };
    const onSeeked = () => {
      s.seeking = false;
      s.dirty = true;
      const p = s.pending;
      s.pending = null;
      if (p !== null && Math.abs(p - v.currentTime) > 0.002) this.seekSlot(s, p, true);
      this.requestRender();
    };
    const onError = () => {
      if (s.sink) return;
      const asset = getAsset(mediaId);
      console.warn('Video element cannot play this file; trying WebCodecs', asset?.name, v.error);
      if (asset && !asset.canDecodeVideo) return;
      s.sink = new SinkFallback(mediaId, this.maxSide(), (c) => {
        this.drawFrom(s, c, c.width, c.height);
        this.requestRender();
      });
      if (s.target >= 0) s.sink.request(s.target);
    };
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('loadeddata', onData);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('error', onError);
    s.off = () => {
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('loadeddata', onData);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('error', onError);
    };
    this.box.appendChild(v);
    v.src = url;
    v.load();
    this.slots.set(id, s);
    return s;
  }

  private destroySlot(s: Slot) {
    s.off();
    s.sink?.dispose();
    try {
      s.v.pause();
      s.v.removeAttribute('src');
      s.v.load();
    } catch {
      /* ignore */
    }
    s.v.remove();
    s.canvas.width = s.canvas.height = 1;
    this.slots.delete(s.id);
    this.comp.releaseTexture('vid:' + s.id);
  }

  private ensureSlot(item: VideoItem, inProject: () => Set<string>): Slot | null {
    let s = this.slots.get(item.id);
    if (s && s.mediaId !== item.mediaId) {
      this.destroySlot(s);
      s = undefined;
    }
    if (s) return s;
    // Adopt an idle slot showing the same media (split parts, duplicates, deleted items): its decoder
    // is warm and, across a split point, already positioned at the right frame.
    let best: Slot | undefined;
    for (const o of this.slots.values()) {
      if (o.mediaId !== item.mediaId || this.wants.has(o.id)) continue;
      if (!best) best = o;
      else {
        const oGone = !inProject().has(o.id);
        const bGone = !inProject().has(best.id);
        if ((oGone && !bGone) || (oGone === bGone && o.lastUsed > best.lastUsed)) best = o;
      }
    }
    if (best) {
      this.slots.delete(best.id);
      this.comp.releaseTexture('vid:' + best.id);
      best.id = item.id;
      best.lastFix = 0;
      this.slots.set(item.id, best);
      return best;
    }
    const url = peekObjectUrl(item.mediaId);
    if (!url) return null;
    return this.createSlot(item.id, item.mediaId, url);
  }

  private seekSlot(s: Slot, t: number, force = false) {
    s.target = t;
    if (s.sink) {
      s.sink.request(t);
      return;
    }
    if (!s.meta) {
      s.pending = t;
      return;
    }
    if (s.seeking) {
      s.pending = t;
      return;
    }
    if (!force && s.hasFrame && Math.abs(s.v.currentTime - t) < 0.004) return;
    s.seeking = true;
    s.pending = null;
    try {
      s.v.currentTime = t;
    } catch {
      s.seeking = false;
    }
  }

  private stopSlot(s: Slot) {
    if (!s.playing) return;
    s.playing = false;
    s.v.pause();
  }

  private syncSlots(p: Project, t: number) {
    const live = this.isPlaying && this.peekT === null;
    const now = performance.now();
    let inProject: Set<string> | null = null;
    const ids = () => (inProject ??= new Set([...p.main, ...p.overlays].map((i) => i.id)));
    for (const { item, st } of this.wants.values()) {
      const s = this.ensureSlot(item, ids);
      if (!s) continue;
      s.lastUsed = this.frameNo;
      if (live) this.syncPlaying(s, item, st, now);
      else {
        this.stopSlot(s);
        if (Math.abs(s.target - st) > 0.002 || !s.hasFrame) this.seekSlot(s, st);
      }
    }
    for (const s of this.slots.values()) if (!this.wants.has(s.id)) this.stopSlot(s);
    if (live) this.preroll(p, t, ids);
    this.evict();
  }

  private syncPlaying(s: Slot, item: VideoItem, st: number, now: number) {
    const v = s.v;
    s.target = st;
    const rate = item.speed;
    const nearEnd = Number.isFinite(v.duration) && st >= v.duration - 0.08;
    if (s.sink || s.noPlay || rate < 0.0625 || rate > 4 || nearEnd || !s.meta) {
      // Step through frames by seeking.
      this.stopSlot(s);
      if (Math.abs(v.currentTime - st) > 0.03 || !s.hasFrame) this.seekSlot(s, st);
      return;
    }
    if (!s.playing || v.paused) {
      if (v.ended || Math.abs(v.currentTime - st) > 0.05) this.seekSlot(s, st, true);
      if (v.playbackRate !== rate) v.playbackRate = rate;
      s.playing = true;
      s.lastFix = now;
      const pr = v.play();
      pr?.catch((e: DOMException) => {
        s.playing = false;
        if (e?.name === 'NotAllowedError') s.noPlay = true;
      });
      return;
    }
    if (s.seeking) return;
    const diff = v.currentTime - st;
    if (Math.abs(diff) > 0.3 && now - s.lastFix > 700) {
      s.lastFix = now;
      s.seeking = true;
      v.currentTime = st + 0.06 * rate;
      if (v.playbackRate !== rate) v.playbackRate = rate;
      return;
    }
    let r = rate;
    if (diff > 0.05) r = rate * 0.94;
    else if (diff < -0.05) r = rate * 1.06;
    else if (Math.abs(diff) > 0.015) r = v.playbackRate;
    if (Math.abs(v.playbackRate - r) > 1e-3) v.playbackRate = r;
  }

  private preroll(p: Project, t: number, inProject: () => Set<string>) {
    const busyMedia = new Set([...this.wants.values()].map((w) => w.item.mediaId));
    for (const it of [...p.main, ...p.overlays]) {
      // Clips sharing media with a playing clip (e.g. split parts) adopt its slot when they start.
      if (it.type !== 'video' || it.start <= t || it.start > t + PREROLL || busyMedia.has(it.mediaId)) continue;
      const s = this.ensureSlot(it, inProject);
      if (!s) continue;
      s.lastUsed = this.frameNo;
      this.wants.set(it.id, { item: it, st: it.in });
      busyMedia.add(it.mediaId);
      if (!s.playing && Math.abs(s.target - it.in) > 0.002) this.seekSlot(s, it.in);
    }
  }

  private evict() {
    if (this.slots.size <= MAX_SLOTS) return;
    const idle = [...this.slots.values()]
      .filter((s) => s.lastUsed < this.frameNo && !this.wants.has(s.id))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.slots.size > MAX_SLOTS && idle.length) this.destroySlot(idle.shift()!);
  }
}
