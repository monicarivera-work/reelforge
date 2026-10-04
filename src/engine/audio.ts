import { ALL_FORMATS, AudioBufferSink, BlobSource, Input, type WrappedAudioBuffer } from 'mediabunny';
import type { AudioItem, Project, VideoItem } from '../types';
import { itemEnd, projectDuration, transitionOverlap } from '../lib/layout';
import { decodeWholeAudio, getAsset, getBlob, loadAssets } from '../lib/media';

/** PCM covering a source-time range. `start` is the source time of sample 0. */
interface Pcm {
  rate: number;
  start: number;
  channels: Float32Array[];
}

interface Reader {
  read(t0: number, t1: number): Promise<Pcm | null>;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Whole-file decode fallback (used when WebCodecs cannot decode the audio track)

const wholeCache = new Map<string, Promise<AudioBuffer>>();

function wholeBuffer(mediaId: string): Promise<AudioBuffer> {
  let p = wholeCache.get(mediaId);
  if (p) {
    wholeCache.delete(mediaId);
    wholeCache.set(mediaId, p);
    return p;
  }
  p = (async () => {
    const blob = await getBlob(mediaId);
    if (!blob) throw new Error('Missing media');
    return decodeWholeAudio(blob);
  })();
  p.catch(() => wholeCache.delete(mediaId));
  wholeCache.set(mediaId, p);
  while (wholeCache.size > 4) wholeCache.delete(wholeCache.keys().next().value!);
  return p;
}

class WholeReader implements Reader {
  constructor(private mediaId: string) {}
  async read(t0: number): Promise<Pcm | null> {
    const buf = await wholeBuffer(this.mediaId);
    const rate = buf.sampleRate;
    const i0 = Math.max(0, Math.floor(t0 * rate));
    const channels: Float32Array[] = [];
    for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) channels.push(buf.getChannelData(c).subarray(i0));
    return { rate, start: i0 / rate, channels };
  }
  dispose() {}
}

// ---------------------------------------------------------------------------
// Streaming WebCodecs reader: decodes sequentially, restarting only on seeks.

class SinkReader implements Reader {
  private input: Input;
  private sink: Promise<AudioBufferSink | null>;
  private iter: AsyncGenerator<WrappedAudioBuffer, void, unknown> | null = null;
  private chunks: { t: number; buf: AudioBuffer }[] = [];
  private validFrom = 0;
  private done = false;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(blob: Blob) {
    this.input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
    this.sink = this.input.getPrimaryAudioTrack().then((t) => (t ? new AudioBufferSink(t) : null));
  }

  read(t0: number, t1: number): Promise<Pcm | null> {
    const run = this.lock.then(() => this.readImpl(t0, t1));
    this.lock = run.catch(() => undefined);
    return run;
  }

  private lastEnd() {
    const l = this.chunks[this.chunks.length - 1];
    return l ? l.t + l.buf.duration : this.validFrom;
  }

  private async readImpl(t0: number, t1: number): Promise<Pcm | null> {
    const sink = await this.sink;
    if (!sink) return null;
    let iter = this.iter;
    if (!iter || t0 < this.validFrom - 1e-3 || t0 > this.lastEnd() + 2) {
      void this.iter?.return();
      iter = this.iter = sink.buffers(Math.max(0, t0 - 0.02));
      this.chunks = [];
      this.validFrom = Math.max(0, t0 - 0.02);
      this.done = false;
    }
    while (!this.done && this.lastEnd() < t1) {
      const r = await iter.next();
      if (r.done) this.done = true;
      else this.chunks.push({ t: r.value.timestamp, buf: r.value.buffer });
    }
    let drop = 0;
    while (drop < this.chunks.length - 1 && this.chunks[drop].t + this.chunks[drop].buf.duration < t0 - 0.5) drop++;
    if (drop) {
      this.chunks.splice(0, drop);
      this.validFrom = this.chunks[0].t;
    }
    if (!this.chunks.length) return null;
    const rate = this.chunks[0].buf.sampleRate;
    const nch = Math.min(2, Math.max(...this.chunks.map((c) => c.buf.numberOfChannels)));
    const n = Math.max(1, Math.ceil((t1 - t0) * rate) + 2);
    const channels = Array.from({ length: nch }, () => new Float32Array(n));
    for (const c of this.chunks) {
      const end = c.t + c.buf.duration;
      if (end < t0 || c.t > t1 + 0.05) continue;
      const off = Math.round((c.t - t0) * rate);
      for (let ch = 0; ch < nch; ch++) {
        const src = c.buf.getChannelData(Math.min(ch, c.buf.numberOfChannels - 1));
        const from = Math.max(0, -off);
        const to = Math.min(src.length, n - off);
        if (to > from) channels[ch].set(src.subarray(from, to), off + from);
      }
    }
    return { rate, start: t0, channels };
  }

  dispose() {
    void this.iter?.return();
    this.iter = null;
    this.chunks = [];
    this.input.dispose();
  }
}

async function createReader(mediaId: string): Promise<Reader> {
  const asset = getAsset(mediaId) ?? (await loadAssets([mediaId]))[mediaId];
  if (asset?.canDecodeAudio) {
    const blob = await getBlob(mediaId);
    if (blob) {
      const r = new SinkReader(blob);
      try {
        await r.read(0, 0.01);
        return r;
      } catch (e) {
        console.warn('WebCodecs audio failed, decoding whole file', e);
        r.dispose();
      }
    }
  }
  return new WholeReader(mediaId);
}

// ---------------------------------------------------------------------------
// Mixer

interface MixSource {
  item: VideoItem | AudioItem;
  ovIn: number;
  ovOut: number;
}

export interface MixOptions {
  excludeRoles?: AudioItem['role'][];
}

export class AudioMixer {
  private readers = new Map<string, { reader: Promise<Reader>; mediaId: string; used: number }>();
  private calls = 0;

  constructor(
    private getProject: () => Project,
    readonly sampleRate: number,
    readonly channels: number,
    private opts: MixOptions = {},
  ) {}

  private sources(p: Project, t0: number, t1: number): MixSource[] {
    const out: MixSource[] = [];
    const hit = (it: { start: number; duration: number }) => it.start < t1 && itemEnd(it) > t0;
    const audible = (it: VideoItem | AudioItem) => !it.muted && it.volume > 0.001;
    p.main.forEach((it, i) => {
      if (it.type !== 'video' || !hit(it) || !audible(it)) return;
      const a = getAsset(it.mediaId);
      if (a && !a.hasAudio) return;
      const ovIn = i > 0 ? transitionOverlap(p.main[i - 1], it) : 0;
      const ovOut = i < p.main.length - 1 ? transitionOverlap(it, p.main[i + 1]) : 0;
      out.push({ item: it, ovIn, ovOut });
    });
    for (const it of p.overlays) {
      if (it.type !== 'video' || !hit(it) || !audible(it)) continue;
      const a = getAsset(it.mediaId);
      if (a && !a.hasAudio) continue;
      out.push({ item: it, ovIn: 0, ovOut: 0 });
    }
    for (const it of p.audios) {
      if (!hit(it) || !audible(it) || this.opts.excludeRoles?.includes(it.role)) continue;
      out.push({ item: it, ovIn: 0, ovOut: 0 });
    }
    return out;
  }

  private reader(it: VideoItem | AudioItem): Promise<Reader> {
    let e = this.readers.get(it.id);
    if (e && e.mediaId !== it.mediaId) {
      void e.reader.then((r) => r.dispose());
      e = undefined;
    }
    if (!e) {
      e = { reader: createReader(it.mediaId), mediaId: it.mediaId, used: 0 };
      this.readers.set(it.id, e);
    }
    e.used = this.calls;
    return e.reader;
  }

  /** Mixes `frames` samples starting at timeline time t0. Returns null when silent. */
  async mix(t0: number, frames: number): Promise<Float32Array[] | null> {
    const p = this.getProject();
    const sr = this.sampleRate;
    const t1 = t0 + frames / sr;
    this.calls++;
    const srcs = this.sources(p, t0, t1);
    if (!srcs.length) {
      this.gc();
      return null;
    }
    const out = Array.from({ length: this.channels }, () => new Float32Array(frames));
    let any = false;
    for (const s of srcs) {
      const it = s.item;
      const a = Math.max(t0, it.start);
      const b = Math.min(t1, itemEnd(it));
      if (b <= a) continue;
      const s0 = it.in + (a - it.start) * it.speed;
      const s1 = it.in + (b - it.start) * it.speed;
      let pcm: Pcm | null = null;
      try {
        pcm = await (await this.reader(it)).read(Math.max(0, s0 - 0.01), s1 + 0.01);
      } catch (e) {
        console.warn('audio read failed', e);
      }
      if (!pcm || !pcm.channels.length) continue;
      any = true;
      const j0 = Math.max(0, Math.round((a - t0) * sr));
      const j1 = Math.min(frames, Math.round((b - t0) * sr));
      const step = (it.speed * pcm.rate) / sr;
      const box = step > 1.5;
      const half = step / 2;
      const nsrc = pcm.channels.length;
      const len = pcm.channels[0].length;
      for (let j = j0; j < j1; j++) {
        const t = t0 + j / sr;
        const local = t - it.start;
        let g = it.volume;
        if (it.fadeIn > 0 && local < it.fadeIn) g *= local / it.fadeIn;
        const rem = it.duration - local;
        if (it.fadeOut > 0 && rem < it.fadeOut) g *= Math.max(0, rem) / it.fadeOut;
        if (s.ovIn > 0 && local < s.ovIn) g *= Math.sin((Math.max(0, local) / s.ovIn) * Math.PI * 0.5);
        if (s.ovOut > 0 && rem < s.ovOut) g *= Math.sin((Math.max(0, rem) / s.ovOut) * Math.PI * 0.5);
        if (g <= 0) continue;
        const pos = (it.in + local * it.speed - pcm.start) * pcm.rate;
        for (let c = 0; c < nsrc; c++) {
          const d = pcm.channels[c];
          let v: number;
          if (box) {
            const i0 = Math.max(0, Math.floor(pos - half));
            const i1 = Math.min(len - 1, Math.floor(pos + half));
            let sum = 0;
            for (let i = i0; i <= i1; i++) sum += d[i];
            v = i1 >= i0 ? sum / (i1 - i0 + 1) : 0;
          } else {
            const i = Math.floor(pos);
            if (i < 0 || i >= len) continue;
            const f = pos - i;
            v = d[i] * (1 - f) + (i + 1 < len ? d[i + 1] : d[i]) * f;
          }
          v *= g;
          if (this.channels === 1) out[0][j] += v / nsrc;
          else if (nsrc === 1) for (let oc = 0; oc < this.channels; oc++) out[oc][j] += v;
          else if (c < this.channels) out[c][j] += v;
        }
      }
    }
    this.gc();
    if (!any) return null;
    for (const ch of out) for (let i = 0; i < ch.length; i++) ch[i] = ch[i] > 1 ? 1 : ch[i] < -1 ? -1 : ch[i];
    return out;
  }

  private gc() {
    for (const [id, e] of this.readers) {
      if (this.calls - e.used > 40) {
        void e.reader.then((r) => r.dispose());
        this.readers.delete(id);
      }
    }
  }

  dispose() {
    for (const e of this.readers.values()) void e.reader.then((r) => r.dispose());
    this.readers.clear();
  }
}

/** Renders the project mix (or a part of it) into one Float32Array per channel. */
export async function renderMix(
  p: Project,
  sampleRate: number,
  channels: number,
  opts: MixOptions & { from?: number; to?: number; onProgress?: (f: number) => void; signal?: AbortSignal } = {},
): Promise<Float32Array[]> {
  const from = opts.from ?? 0;
  const to = opts.to ?? projectDuration(p);
  const total = Math.max(0, Math.round((to - from) * sampleRate));
  const out = Array.from({ length: channels }, () => new Float32Array(total));
  const mixer = new AudioMixer(() => p, sampleRate, channels, opts);
  try {
    const win = sampleRate * 10;
    for (let off = 0; off < total; off += win) {
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const n = Math.min(win, total - off);
      const data = await mixer.mix(from + off / sampleRate, n);
      if (data) for (let c = 0; c < channels; c++) out[c].set(data[c], off);
      opts.onProgress?.(Math.min(1, (off + n) / Math.max(1, total)));
    }
  } finally {
    mixer.dispose();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Live playback. The AudioContext clock drives the preview so picture follows sound.

type AudioSessionNav = Navigator & { audioSession?: { type: string } };

export class AudioPlayback {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private mixer: AudioMixer | null = null;
  private nodes = new Set<AudioBufferSourceNode>();
  private gen = 0;
  private base = 0;
  private anchor = 0;
  private perfAnchor = 0;
  private ctxClock = false;
  private running = false;
  private nextT = 0;
  private pumping = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private invalidateTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCt = -1;
  private lastPn = 0;
  private lastNow = 0;
  private silenced = false;

  constructor(private getProject: () => Project) {}

  /** Silences timeline audio without stopping the clock (e.g. while recording a voiceover). */
  setMuted(muted: boolean) {
    this.silenced = muted;
    if (this.master) this.master.gain.value = muted ? 0 : 1;
  }

  private ensureCtx(): AudioContext {
    if (this.ctx && this.ctx.state !== 'closed') return this.ctx;
    const nav = navigator as AudioSessionNav;
    try {
      // Plays through the silent switch on iOS; keep the mic session while a voiceover is armed.
      if (nav.audioSession && nav.audioSession.type !== 'play-and-record') nav.audioSession.type = 'playback';
    } catch {
      /* not supported */
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor({ latencyHint: 'playback' });
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.silenced ? 0 : 1;
    this.master.connect(ctx.destination);
    this.mixer?.dispose();
    this.mixer = new AudioMixer(this.getProject, ctx.sampleRate, 2);
    return ctx;
  }

  get isRunning() {
    return this.running;
  }

  private latency(): number {
    const c = this.ctx as (AudioContext & { outputLatency?: number }) | null;
    if (!c) return 0;
    const l = (c.outputLatency || 0) + (c.baseLatency || 0);
    return Number.isFinite(l) ? Math.min(0.5, l) : 0;
  }

  private ctxNow(): number {
    const ct = this.ctx!.currentTime;
    const pn = performance.now();
    if (ct !== this.lastCt) {
      this.lastCt = ct;
      this.lastPn = pn;
      return ct;
    }
    return ct + Math.min(0.05, (pn - this.lastPn) / 1000);
  }

  /** Current playback position on the timeline. */
  now(): number {
    if (!this.running) return this.base;
    let t: number;
    if (this.ctxClock && this.ctx) t = this.base + Math.max(0, this.ctxNow() - this.anchor - this.latency());
    else t = this.base + Math.max(0, (performance.now() - this.perfAnchor) / 1000);
    if (t < this.lastNow && this.lastNow - t < 0.06) t = this.lastNow;
    this.lastNow = t;
    return t;
  }

  /** Must be called from a user gesture handler so the AudioContext may start. */
  start(t: number) {
    this.stop();
    const ctx = this.ensureCtx();
    if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
    try {
      const b = ctx.createBuffer(1, 1, ctx.sampleRate);
      const n = ctx.createBufferSource();
      n.buffer = b;
      n.connect(ctx.destination);
      n.start();
    } catch {
      /* ignore */
    }
    const gen = ++this.gen;
    this.running = true;
    this.base = t;
    this.lastNow = t;
    this.nextT = t;
    this.perfAnchor = performance.now() + 120;
    this.ctxClock = ctx.state === 'running';
    this.anchor = ctx.currentTime + 0.12;
    if (!this.ctxClock) {
      const onState = () => {
        if (gen !== this.gen || ctx.state !== 'running') return;
        ctx.removeEventListener('statechange', onState);
        const now = this.now();
        this.base = now;
        this.nextT = now;
        this.anchor = ctx.currentTime + 0.12;
        this.ctxClock = true;
        void this.pump(gen);
      };
      ctx.addEventListener('statechange', onState);
    }
    this.timer = setInterval(() => void this.pump(this.gen), 90);
    void this.pump(gen);
  }

  stop() {
    if (this.running) this.base = this.now();
    this.running = false;
    this.gen++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.invalidateTimer) clearTimeout(this.invalidateTimer);
    this.invalidateTimer = null;
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
    }
    this.nodes.clear();
  }

  /** The project changed while playing: re-mix upcoming audio without moving the clock. */
  invalidate() {
    if (!this.running || this.invalidateTimer) return;
    this.invalidateTimer = setTimeout(() => {
      this.invalidateTimer = null;
      if (!this.running || !this.ctx) return;
      const gen = ++this.gen;
      const resume = this.now() + 0.1;
      const cut = this.anchor + (resume - this.base);
      for (const n of this.nodes) {
        try {
          n.stop(Math.max(this.ctx.currentTime, cut));
        } catch {
          /* ignore */
        }
      }
      this.nextT = resume;
      void this.pump(gen);
    }, 120);
  }

  private async pump(gen: number) {
    if (this.pumping || gen !== this.gen || !this.running || !this.mixer || !this.ctx) return;
    this.pumping = true;
    const ctx = this.ctx;
    const mixer = this.mixer;
    const sr = mixer.sampleRate;
    try {
      const dur = projectDuration(this.getProject());
      while (gen === this.gen && this.running && this.nextT < this.now() + 1.2 && this.nextT < dur) {
        const t0 = this.nextT;
        const frames = Math.max(1, Math.round(Math.min(0.5, dur - t0) * sr));
        this.nextT = t0 + frames / sr;
        const data = await mixer.mix(t0, frames);
        if (gen !== this.gen) return;
        if (!data || !this.ctxClock) continue;
        const buf = ctx.createBuffer(2, frames, sr);
        buf.copyToChannel(data[0] as Float32Array<ArrayBuffer>, 0);
        buf.copyToChannel(data[1] as Float32Array<ArrayBuffer>, 1);
        const node = ctx.createBufferSource();
        node.buffer = buf;
        node.connect(this.master!);
        const when = this.anchor + (t0 - this.base);
        const now = ctx.currentTime;
        if (when >= now) node.start(when);
        else {
          const off = now - when;
          if (off >= buf.duration) continue;
          node.start(now, off);
        }
        this.nodes.add(node);
        node.onended = () => this.nodes.delete(node);
      }
    } catch (e) {
      console.warn('audio pump failed', e);
    } finally {
      this.pumping = false;
    }
  }

  /** Plays a short clip immediately (used for SFX previews). Call from the tap so iOS unlocks audio. */
  async preview(blob: Blob | Promise<Blob>) {
    const ctx = this.ensureCtx();
    const resumed = ctx.state !== 'running' ? ctx.resume().catch(() => undefined) : null;
    const data = await (await blob).arrayBuffer();
    if (resumed) await resumed;
    const buf = await ctx.decodeAudioData(data);
    const n = ctx.createBufferSource();
    n.buffer = buf;
    n.connect(this.master!);
    n.start();
  }

  dispose() {
    this.stop();
    this.mixer?.dispose();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}

// ---------------------------------------------------------------------------

export function encodeWav(channels: Float32Array[], sampleRate: number): Blob {
  const nch = channels.length;
  const len = channels[0]?.length ?? 0;
  const bytes = len * nch * 2;
  const buf = new ArrayBuffer(44 + bytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + bytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * nch * 2, true);
  v.setUint16(32, nch * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, bytes, true);
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
