import type { AnimType, MainItem, MediaAsset, OverlayItem, Project, TextItem, VideoItem, VisualItem } from '../types';
import { activeMain, itemEnd, sampleKeyframes, sourceTime } from '../lib/layout';
import { computeFx } from '../lib/filters';
import { isFontReady, renderTextCanvas, textCharCount } from '../lib/text';
import { backOut, clamp, easeInOut, easeOut, hexToRgb, lerp } from '../lib/util';
import type { DrawLayer, FrameSpec, Page, TexRef } from './gl';

const EPS = 1e-6;
const DEG = Math.PI / 180;

export interface FrameSource {
  source: TexImageSource;
  version: number | string;
}

export interface FrameProvider {
  /** Decoded frame of a video item at the given source time (seconds), or null if not ready. */
  video(item: VideoItem, sourceTime: number): FrameSource | null;
  image(mediaId: string): TexImageSource | null;
}

export interface SceneContext {
  W: number;
  H: number;
  asset(id: string): MediaAsset | undefined;
  provider: FrameProvider;
  texts: TextCache;
  seed: number;
}

export interface HitQuad {
  id: string;
  kind: 'main' | 'overlays' | 'texts';
  /** frame pixels */
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** radians, clockwise */
  rot: number;
}

export interface Pose {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  /** typewriter: number of visible characters */
  chars: number | null;
}

function applyAnim(p: Pose, item: VisualItem, type: AnimType, u: number, entering: boolean) {
  const e = easeOut(u);
  const dir = entering ? 1 : -1;
  switch (type) {
    case 'fade':
      p.opacity *= u;
      break;
    case 'zoomIn':
      p.scale *= entering ? lerp(0.5, 1, e) : lerp(1.5, 1, e);
      p.opacity *= e;
      break;
    case 'zoomOut':
      p.scale *= entering ? lerp(1.5, 1, e) : lerp(0.5, 1, e);
      p.opacity *= e;
      break;
    case 'slideUp':
      p.y += (1 - e) * 0.3 * dir;
      p.opacity *= clamp(u * 2, 0, 1);
      break;
    case 'slideDown':
      p.y -= (1 - e) * 0.3 * dir;
      p.opacity *= clamp(u * 2, 0, 1);
      break;
    case 'slideLeft':
      p.x += (1 - e) * 0.4 * dir;
      p.opacity *= clamp(u * 2, 0, 1);
      break;
    case 'slideRight':
      p.x -= (1 - e) * 0.4 * dir;
      p.opacity *= clamp(u * 2, 0, 1);
      break;
    case 'pop':
      p.scale *= Math.max(0, backOut(u));
      p.opacity *= clamp(u * 3, 0, 1);
      break;
    case 'spin':
      p.rotation += (1 - e) * 360 * (entering ? -1 : 1);
      p.scale *= lerp(0.2, 1, e);
      p.opacity *= e;
      break;
    case 'typewriter':
      if (item.type === 'text') {
        const n = Math.floor(u * textCharCount(item.text));
        p.chars = p.chars === null ? n : Math.min(p.chars, n);
      } else {
        p.opacity *= u;
      }
      break;
    default:
      break;
  }
}

/** Keyframed transform plus slow motion, without in/out animations. Selection boxes follow this. */
export function restPose(item: VisualItem, t: number): Pose {
  const local = t - item.start;
  const kv = sampleKeyframes(item.keyframes, local);
  const tr = item.transform;
  const pose: Pose = kv
    ? { ...kv, chars: null }
    : { x: tr.x, y: tr.y, scale: tr.scale, rotation: tr.rotation, opacity: item.opacity, chars: null };
  if (item.motion !== 'none') {
    const u = clamp(local / Math.max(item.duration, EPS), 0, 1);
    switch (item.motion) {
      case 'zoomIn':
        pose.scale *= lerp(1, 1.2, u);
        break;
      case 'zoomOut':
        pose.scale *= lerp(1.2, 1, u);
        break;
      case 'panLeft':
        pose.scale *= 1.2;
        pose.x += lerp(0.08, -0.08, u);
        break;
      case 'panRight':
        pose.scale *= 1.2;
        pose.x += lerp(-0.08, 0.08, u);
        break;
      case 'panUp':
        pose.scale *= 1.2;
        pose.y += lerp(0.08, -0.08, u);
        break;
      case 'panDown':
        pose.scale *= 1.2;
        pose.y += lerp(-0.08, 0.08, u);
        break;
    }
  }
  return pose;
}

const animating = (item: VisualItem, local: number) =>
  (item.animIn.type !== 'none' && local < Math.min(item.animIn.duration, item.duration)) ||
  (item.animOut.type !== 'none' && local > item.duration - Math.min(item.animOut.duration, item.duration));

/** Animated transform of a visual item at timeline time t. */
export function itemPose(item: VisualItem, t: number): Pose {
  const local = t - item.start;
  const pose = restPose(item, t);
  const dIn = Math.min(item.animIn.duration, item.duration);
  const dOut = Math.min(item.animOut.duration, item.duration);
  if (item.animIn.type !== 'none' && dIn > 0 && local < dIn) {
    applyAnim(pose, item, item.animIn.type, clamp(local / dIn, 0, 1), true);
  }
  if (item.animOut.type !== 'none' && dOut > 0 && local > item.duration - dOut) {
    applyAnim(pose, item, item.animOut.type, clamp((item.duration - local) / dOut, 0, 1), false);
  }
  return pose;
}

// ---------------------------------------------------------------------------
// Text textures

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
let textVersion = 0;

function renderScaleFor(item: TextItem): number {
  let s = Math.abs(item.transform.scale);
  for (const k of item.keyframes) s = Math.max(s, Math.abs(k.scale));
  const zoomy = (a: AnimType) => a === 'zoomIn' || a === 'zoomOut' || a === 'pop';
  if (zoomy(item.animIn.type) || zoomy(item.animOut.type)) s *= 1.5;
  if (item.motion !== 'none') s *= 1.2;
  const q = Math.pow(2, Math.round(Math.log2(Math.max(s, 1e-3)) * 4) / 4);
  return clamp(q, 0.25, 6);
}

/** Rasterizes text items into canvases, re-rendering only when their appearance changes. */
export class TextCache {
  private map = new Map<string, { canvas: AnyCanvas; sig: string; version: number; upscale: number; rs: number; used: number }>();
  private tick = 0;

  constructor(private create: () => AnyCanvas = () => document.createElement('canvas')) {}

  get(item: TextItem, W: number, H: number, activeWord: number, chars: number | null) {
    const rs = renderScaleFor(item);
    const ready = isFontReady(item.style.font, item.style.weight, item.style.italic);
    const sig = JSON.stringify([item.text, item.style, W, H, rs, activeWord, chars, ready, item.words?.length ?? 0]);
    let e = this.map.get(item.id);
    if (!e) {
      e = { canvas: this.create(), sig: '', version: 0, upscale: 1, rs, used: 0 };
      this.map.set(item.id, e);
    }
    if (e.sig !== sig) {
      e.upscale = renderTextCanvas(e.canvas, {
        text: item.text,
        style: item.style,
        fontPx: item.style.size * Math.min(W, H) * rs,
        wrapPx: item.style.maxWidth * W * rs,
        words: item.words,
        activeWord,
        visibleChars: chars ?? undefined,
      });
      e.sig = sig;
      e.rs = rs;
      e.version = ++textVersion;
    }
    e.used = this.tick;
    const ref: TexRef = { key: 'txt:' + item.id, source: e.canvas, version: e.version };
    return { ref, w: (e.canvas.width * e.upscale) / rs, h: (e.canvas.height * e.upscale) / rs };
  }

  sweep() {
    this.tick++;
    if (this.tick % 300 !== 0) return;
    for (const [k, e] of this.map) if (this.tick - e.used > 300) this.map.delete(k);
  }

  clear() {
    this.map.clear();
  }
}

// ---------------------------------------------------------------------------
// Frame building

interface Base {
  w: number;
  h: number;
  uv: [number, number, number, number];
}

function baseSize(item: MainItem | OverlayItem, ctx: SceneContext): Base {
  const { W, H } = ctx;
  const c = item.crop;
  let aw = W;
  let ah = H;
  if (item.type !== 'color') {
    const a = ctx.asset(item.mediaId);
    if (a && a.width > 0 && a.height > 0) {
      aw = a.width;
      ah = a.height;
    }
  }
  const sw = aw * clamp(1 - c.l - c.r, 0.02, 1);
  const sh = ah * clamp(1 - c.t - c.b, 0.02, 1);
  const s = item.fit === 'fill' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
  let x0 = c.l;
  let x1 = 1 - c.r;
  let y0 = c.t;
  let y1 = 1 - c.b;
  if (item.flipH) [x0, x1] = [x1, x0];
  if (item.flipV) [y0, y1] = [y1, y0];
  return { w: sw * s, h: sh * s, uv: [x0, y0, x1, y1] };
}

/** undefined = media not ready yet; null = solid color */
function itemTexture(item: MainItem | OverlayItem, t: number, ctx: SceneContext): TexRef | null | undefined {
  if (item.type === 'color') return null;
  if (item.type === 'image') {
    const src = ctx.provider.image(item.mediaId);
    return src ? { key: 'img:' + item.mediaId, source: src, version: 1, mip: true } : undefined;
  }
  const a = ctx.asset(item.mediaId);
  let st = sourceTime(item, t);
  if (a) st = clamp(st, 0, Math.max(0, a.duration - 0.001));
  const f = ctx.provider.video(item, st);
  return f ? { key: 'vid:' + item.id, source: f.source, version: f.version } : undefined;
}

function makeLayer(item: MainItem | OverlayItem, pose: Pose, base: Base, ctx: SceneContext, tex: TexRef | null, overlay: boolean): DrawLayer {
  return {
    tex,
    color: item.type === 'color' ? hexToRgb(item.color) : [0, 0, 0],
    cx: ctx.W / 2 + pose.x * ctx.W,
    cy: ctx.H / 2 + pose.y * ctx.H,
    w: base.w * pose.scale,
    h: base.h * pose.scale,
    rot: pose.rotation * DEG,
    uv: base.uv,
    opacity: clamp(pose.opacity, 0, 1),
    blend: overlay ? item.blend : 'normal',
    fx: computeFx(item),
    mask: item.mask.shape !== 'none' ? { ...item.mask } : null,
    chroma:
      item.chroma.enabled && item.type !== 'color'
        ? { color: hexToRgb(item.chroma.color), similarity: item.chroma.similarity, smoothness: item.chroma.smoothness }
        : null,
  };
}

function covers(L: DrawLayer, W: number, H: number): boolean {
  const deg = (((L.rot / DEG) % 360) + 360) % 360;
  if (deg > 0.01 && deg < 359.99) return false;
  if (L.opacity < 0.999 || L.mask || L.chroma) return false;
  const hw = Math.abs(L.w) / 2;
  const hh = Math.abs(L.h) / 2;
  return L.cx - hw <= 0.5 && L.cx + hw >= W - 0.5 && L.cy - hh <= 0.5 && L.cy + hh >= H - 0.5;
}

function quadOf(id: string, kind: HitQuad['kind'], L: Pick<DrawLayer, 'cx' | 'cy' | 'w' | 'h' | 'rot'>): HitQuad {
  return { id, kind, cx: L.cx, cy: L.cy, w: Math.abs(L.w), h: Math.abs(L.h), rot: L.rot };
}

/**
 * Hit/selection quad at the item's rest pose, so an item stays visible and grabbable while an
 * in/out animation (pop, zoom, spin…) has it scaled down or off to the side.
 */
function restQuad(
  id: string,
  kind: HitQuad['kind'],
  item: VisualItem,
  t: number,
  L: DrawLayer,
  baseW: number,
  baseH: number,
  ctx: SceneContext,
): HitQuad {
  if (!animating(item, t - item.start)) return quadOf(id, kind, L);
  const r = restPose(item, t);
  return quadOf(id, kind, {
    cx: ctx.W / 2 + r.x * ctx.W,
    cy: ctx.H / 2 + r.y * ctx.H,
    w: baseW * r.scale,
    h: baseH * r.scale,
    rot: r.rotation * DEG,
  });
}

function mainPage(item: MainItem, t: number, p: Project, ctx: SceneContext, quads: HitQuad[]): Page {
  const pose = itemPose(item, t);
  const base = baseSize(item, ctx);
  const tex = itemTexture(item, t, ctx);
  const layer = makeLayer(item, pose, base, ctx, tex ?? null, false);
  quads.push(restQuad(item.id, 'main', item, t, layer, base.w, base.h, ctx));
  if (tex === undefined) return { background: null, layers: [] };
  let background: Page['background'] = null;
  if (p.background.mode === 'blur' && tex && !covers(layer, ctx.W, ctx.H)) {
    const s = Math.max(ctx.W / base.w, ctx.H / base.h);
    background = {
      blur: p.background.blur,
      layer: {
        ...layer,
        cx: ctx.W / 2,
        cy: ctx.H / 2,
        w: base.w * s,
        h: base.h * s,
        rot: 0,
        mask: null,
        chroma: null,
      },
    };
  }
  return { background, layers: [layer] };
}

function activeSorted<T extends { start: number; duration: number; lane: number }>(items: T[], t: number): T[] {
  return items.filter((it) => t >= it.start - EPS && t < itemEnd(it) - EPS).sort((a, b) => a.lane - b.lane);
}

function textLayer(item: TextItem, t: number, ctx: SceneContext, quads: HitQuad[]): DrawLayer | null {
  const pose = itemPose(item, t);
  const local = t - item.start;
  let activeWord = -1;
  if (item.words?.length && item.style.highlightOn) {
    for (let i = 0; i < item.words.length; i++) {
      if (item.words[i].start <= local + EPS) activeWord = i;
      else break;
    }
  }
  const r = ctx.texts.get(item, ctx.W, ctx.H, activeWord, pose.chars);
  const L: DrawLayer = {
    tex: r.ref,
    color: [0, 0, 0],
    cx: ctx.W / 2 + pose.x * ctx.W,
    cy: ctx.H / 2 + pose.y * ctx.H,
    w: r.w * pose.scale,
    h: r.h * pose.scale,
    rot: pose.rotation * DEG,
    uv: [item.flipH ? 1 : 0, item.flipV ? 1 : 0, item.flipH ? 0 : 1, item.flipV ? 0 : 1],
    opacity: clamp(pose.opacity, 0, 1),
    blend: item.blend,
    fx: null,
    mask: null,
    chroma: null,
  };
  quads.push(restQuad(item.id, 'texts', item, t, L, r.w, r.h, ctx));
  return L;
}

export function buildFrame(p: Project, t: number, ctx: SceneContext): { spec: FrameSpec; quads: HitQuad[] } {
  const quads: HitQuad[] = [];
  const pages: Page[] = [];
  let transition: FrameSpec['transition'] = null;
  const am = activeMain(p.main, t);
  if (am) {
    const tr = am.b?.transition;
    if (am.b && tr && tr.type !== 'none') {
      pages.push(mainPage(am.a, t, p, ctx, quads), mainPage(am.b, t, p, ctx, quads));
      transition = { type: tr.type, progress: easeInOut(am.progress) };
    } else {
      pages.push(mainPage(am.b ?? am.a, t, p, ctx, quads));
    }
  }
  const layers: DrawLayer[] = [];
  for (const it of activeSorted(p.overlays, t)) {
    const pose = itemPose(it, t);
    const base = baseSize(it, ctx);
    const tex = itemTexture(it, t, ctx);
    const L = makeLayer(it, pose, base, ctx, tex ?? null, true);
    quads.push(restQuad(it.id, 'overlays', it, t, L, base.w, base.h, ctx));
    if (tex !== undefined) layers.push(L);
  }
  for (const it of activeSorted(p.texts, t)) {
    const L = textLayer(it, t, ctx, quads);
    if (L) layers.push(L);
  }
  ctx.texts.sweep();
  const clear = p.background.mode === 'color' ? hexToRgb(p.background.color) : ([0, 0, 0] as [number, number, number]);
  return {
    spec: { width: ctx.W, height: ctx.H, clear, pages, transition, layers, seed: ctx.seed },
    quads,
  };
}

/** Whether point (px, py) in frame pixels lies inside a hit quad (with optional padding). */
export function hitTest(q: HitQuad, px: number, py: number, pad = 0): boolean {
  const c = Math.cos(-q.rot);
  const s = Math.sin(-q.rot);
  const dx = px - q.cx;
  const dy = py - q.cy;
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;
  return Math.abs(lx) <= q.w / 2 + pad && Math.abs(ly) <= q.h / 2 + pad;
}
