import type {
  Aspect,
  AudioItem,
  Item,
  Keyframe,
  MainItem,
  MediaAsset,
  Project,
  TextItem,
  TrackKind,
  VideoItem,
} from '../types';
import { ASPECTS, isVisual } from '../types';
import { clamp, easeInOut, even, lerp, uid } from './util';

export const MIN_DUR = 0.1;
const EPS = 1e-6;
export const FREE_TRACKS = ['overlays', 'texts', 'audios'] as const;
export const ALL_TRACKS: TrackKind[] = ['main', 'overlays', 'texts', 'audios'];

export const itemEnd = (it: { start: number; duration: number }) => it.start + it.duration;

export function clonePlain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function canvasSize(aspect: Aspect, shortSide: number): { w: number; h: number } {
  const a = ASPECTS.find((x) => x.id === aspect) ?? ASPECTS[0];
  if (a.w >= a.h) return { w: even((shortSide * a.w) / a.h), h: even(shortSide) };
  return { w: even(shortSide), h: even((shortSide * a.h) / a.w) };
}

export function transitionOverlap(prev: MainItem, cur: MainItem): number {
  const tr = cur.transition;
  if (!tr || tr.type === 'none') return 0;
  return Math.max(0, Math.min(tr.duration, prev.duration / 2, cur.duration / 2));
}

/** Magnetic layout of the main track: clips follow each other, overlapping by transition length. */
export function layoutMain(main: MainItem[]): void {
  let t = 0;
  for (let i = 0; i < main.length; i++) {
    const it = main[i];
    if (i === 0 && it.transition) delete it.transition;
    if (i > 0) t -= transitionOverlap(main[i - 1], it);
    it.start = Math.max(0, t);
    it.lane = 0;
    t = it.start + it.duration;
  }
}

export function compactLanes(items: Item[]): void {
  const used = [...new Set(items.map((i) => i.lane))].sort((a, b) => a - b);
  const map = new Map(used.map((l, i) => [l, i]));
  for (const it of items) it.lane = map.get(it.lane) ?? 0;
}

export function normalize(p: Project): void {
  layoutMain(p.main);
  for (const k of FREE_TRACKS) {
    for (const it of p[k]) {
      if (it.start < 0) it.start = 0;
      if (it.duration < MIN_DUR) it.duration = MIN_DUR;
    }
    compactLanes(p[k]);
  }
}

export function mainEnd(p: Project): number {
  const l = p.main[p.main.length - 1];
  return l ? itemEnd(l) : 0;
}

export function projectDuration(p: Project): number {
  let d = mainEnd(p);
  for (const k of FREE_TRACKS) for (const it of p[k]) d = Math.max(d, itemEnd(it));
  return d;
}

export function allItems(p: Project): Item[] {
  return [...p.main, ...p.overlays, ...p.texts, ...p.audios];
}

export function findItem(
  p: Project,
  id: string | null | undefined,
): { item: Item; kind: TrackKind; index: number } | null {
  if (!id) return null;
  for (const kind of ALL_TRACKS) {
    const arr = p[kind] as Item[];
    const index = arr.findIndex((i) => i.id === id);
    if (index >= 0) return { item: arr[index], kind, index };
  }
  return null;
}

export function maxDuration(item: Item, asset?: MediaAsset): number {
  if (item.type === 'video' || item.type === 'audio') {
    if (!asset) return item.duration;
    return Math.max(MIN_DUR, (asset.duration - item.in) / item.speed);
  }
  return 3600;
}

export function sourceTime(item: VideoItem | AudioItem, t: number): number {
  return item.in + (t - item.start) * item.speed;
}

export function laneFree(items: Item[], lane: number, start: number, end: number, excludeId?: string): boolean {
  return !items.some(
    (o) => o.id !== excludeId && o.lane === lane && o.start < end - EPS && itemEnd(o) > start + EPS,
  );
}

export function pickLane(items: Item[], start: number, end: number, excludeId?: string, preferred = 0): number {
  if (laneFree(items, preferred, start, end, excludeId)) return preferred;
  for (let l = 0; l < 64; l++) if (laneFree(items, l, start, end, excludeId)) return l;
  return 64;
}

export function laneCount(items: Item[]): number {
  let n = 0;
  for (const it of items) n = Math.max(n, it.lane + 1);
  return n;
}

export interface ActiveMain {
  a: MainItem;
  b: MainItem | null;
  /** transition progress from a to b (0..1) */
  progress: number;
}

export function activeMain(main: MainItem[], t: number): ActiveMain | null {
  let a: MainItem | null = null;
  let b: MainItem | null = null;
  for (const it of main) {
    if (it.start > t + EPS) break;
    if (t >= it.start - EPS && t < itemEnd(it) - EPS) {
      if (!a) a = it;
      else {
        b = it;
        break;
      }
    }
  }
  if (!a) return null;
  if (b) {
    const ov = itemEnd(a) - b.start;
    return { a, b, progress: ov > 0 ? clamp((t - b.start) / ov, 0, 1) : 1 };
  }
  return { a, b: null, progress: 0 };
}

/** Index of the main clip under time t (the later one while two overlap), or -1. */
export function mainIndexAt(main: MainItem[], t: number): number {
  let idx = -1;
  for (let i = 0; i < main.length; i++) {
    if (main[i].start <= t + EPS && t < itemEnd(main[i]) - EPS) idx = i;
  }
  return idx;
}

/** Index at which newly imported main clips should be inserted (nearest clip boundary). */
export function mainInsertIndex(main: MainItem[], t: number): number {
  for (let i = 0; i < main.length; i++) {
    const it = main[i];
    if (t < it.start + it.duration / 2) return i;
  }
  return main.length;
}

export function snapPoints(p: Project, excludeId?: string): number[] {
  const pts = [0];
  for (const it of allItems(p)) {
    if (it.id === excludeId) continue;
    pts.push(it.start, itemEnd(it));
    if (isVisual(it)) for (const k of it.keyframes) pts.push(it.start + k.t);
  }
  return pts;
}

export type KeyValues = Omit<Keyframe, 't'>;

export function sampleKeyframes(kfs: Keyframe[], t: number): KeyValues | null {
  if (!kfs.length) return null;
  const pick = (k: Keyframe): KeyValues => ({
    x: k.x,
    y: k.y,
    scale: k.scale,
    rotation: k.rotation,
    opacity: k.opacity,
  });
  if (t <= kfs[0].t) return pick(kfs[0]);
  const last = kfs[kfs.length - 1];
  if (t >= last.t) return pick(last);
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (t >= a.t && t <= b.t) {
      const u = easeInOut((t - a.t) / Math.max(1e-6, b.t - a.t));
      return {
        x: lerp(a.x, b.x, u),
        y: lerp(a.y, b.y, u),
        scale: lerp(a.scale, b.scale, u),
        rotation: lerp(a.rotation, b.rotation, u),
        opacity: lerp(a.opacity, b.opacity, u),
      };
    }
  }
  return pick(last);
}

const idPrefix = (it: Item) =>
  ({ video: 'v_', image: 'i_', color: 'c_', text: 't_', audio: 'a_' })[it.type];

function splitWords(a: TextItem, b: TextItem, local: number) {
  if (!a.words?.length) return;
  const wa = a.words.filter((w) => w.start < local);
  const wb = a.words.filter((w) => w.start >= local).map((w) => ({ ...w, start: w.start - local, end: w.end - local }));
  a.words = wa;
  b.words = wb;
  if (a.caption) {
    a.text = wa.map((w) => w.text).join(' ');
    b.text = wb.map((w) => w.text).join(' ');
  }
}

/** Splits an item at timeline time t. Returns the id of the new right-hand part. */
export function splitItem(p: Project, id: string, t: number): string | null {
  const f = findItem(p, id);
  if (!f) return null;
  const it = f.item;
  const local = t - it.start;
  if (local < MIN_DUR - EPS || it.duration - local < MIN_DUR - EPS) return null;
  const b = clonePlain(it);
  b.id = uid(idPrefix(it));
  b.start = t;
  b.duration = it.duration - local;
  it.duration = local;
  if ((b.type === 'video' || b.type === 'audio') && (it.type === 'video' || it.type === 'audio')) {
    b.in = it.in + local * it.speed;
    it.fadeOut = 0;
    b.fadeIn = 0;
  }
  if ('transition' in b) delete b.transition;
  if (isVisual(it) && isVisual(b)) {
    it.animOut = { ...it.animOut, type: 'none' };
    b.animIn = { ...b.animIn, type: 'none' };
    if (it.keyframes.length) {
      const mid = sampleKeyframes(it.keyframes, local)!;
      const ka = it.keyframes.filter((k) => k.t < local - EPS).map((k) => ({ ...k }));
      ka.push({ t: local, ...mid });
      const kb = b.keyframes.filter((k) => k.t > local + EPS).map((k) => ({ ...k, t: k.t - local }));
      kb.unshift({ t: 0, ...mid });
      it.keyframes = ka;
      b.keyframes = kb;
    }
  }
  if (it.type === 'text' && b.type === 'text') splitWords(it, b, local);
  (p[f.kind] as Item[]).splice(f.index + 1, 0, b);
  normalize(p);
  return b.id;
}

export function deleteItem(p: Project, id: string): boolean {
  const f = findItem(p, id);
  if (!f) return false;
  (p[f.kind] as Item[]).splice(f.index, 1);
  normalize(p);
  return true;
}

export function duplicateItem(p: Project, id: string): string | null {
  const f = findItem(p, id);
  if (!f) return null;
  const c = clonePlain(f.item);
  c.id = uid(idPrefix(c));
  if (f.kind === 'main') {
    if ('transition' in c) delete c.transition;
    p.main.splice(f.index + 1, 0, c as MainItem);
  } else {
    const arr = p[f.kind] as Item[];
    c.start = itemEnd(f.item);
    c.lane = pickLane(arr, c.start, itemEnd(c), undefined, f.item.lane);
    arr.push(c);
  }
  normalize(p);
  return c.id;
}

export function moveMainItem(p: Project, id: string, toIndex: number): void {
  const i = p.main.findIndex((m) => m.id === id);
  if (i < 0) return;
  const [it] = p.main.splice(i, 1);
  p.main.splice(clamp(toIndex, 0, p.main.length), 0, it);
  normalize(p);
}

export function moveFreeItem(p: Project, id: string, start: number, lane: number): void {
  const f = findItem(p, id);
  if (!f || f.kind === 'main') return;
  const arr = p[f.kind] as Item[];
  const it = f.item;
  it.start = Math.max(0, start);
  it.lane = pickLane(arr, it.start, itemEnd(it), it.id, Math.max(0, lane));
  normalize(p);
}

/**
 * Applies a trim relative to the item's state when the gesture began, so repeated
 * pointer moves never accumulate rounding errors.
 */
export function applyTrim(
  p: Project,
  id: string,
  orig: Item,
  edge: 'start' | 'end',
  delta: number,
  asset?: MediaAsset,
): void {
  const f = findItem(p, id);
  if (!f) return;
  const it = f.item;
  const timed = orig.type === 'video' || orig.type === 'audio';
  if (edge === 'end') {
    it.duration = clamp(orig.duration + delta, MIN_DUR, Math.max(MIN_DUR, maxDuration(orig, asset)));
  } else {
    let d = Math.min(delta, orig.duration - MIN_DUR);
    if (timed) d = Math.max(d, -(orig as VideoItem).in / (orig as VideoItem).speed);
    if (f.kind !== 'main') d = Math.max(d, -orig.start);
    it.duration = orig.duration - d;
    if (timed && (it.type === 'video' || it.type === 'audio')) {
      it.in = (orig as VideoItem).in + d * (orig as VideoItem).speed;
    }
    if (f.kind !== 'main') it.start = orig.start + d;
    if (isVisual(it) && isVisual(orig)) it.keyframes = orig.keyframes.map((k) => ({ ...k, t: k.t - d }));
    if (it.type === 'text' && orig.type === 'text' && orig.words) {
      it.words = orig.words.map((w) => ({ ...w, start: w.start - d, end: w.end - d }));
    }
  }
  normalize(p);
}

export function setSpeed(p: Project, id: string, speed: number, asset?: MediaAsset): void {
  const f = findItem(p, id);
  if (!f) return;
  const it = f.item;
  if (it.type !== 'video' && it.type !== 'audio') return;
  const ratio = it.speed / speed;
  const srcLen = it.duration * it.speed;
  it.speed = speed;
  let dur = srcLen / speed;
  if (asset) dur = Math.min(dur, (asset.duration - it.in) / speed);
  it.duration = Math.max(MIN_DUR, dur);
  if (it.type === 'video') it.keyframes = it.keyframes.map((k) => ({ ...k, t: k.t * ratio }));
  normalize(p);
}

/** Sets a keyframe at item-local time t (replacing one within half a frame). */
export function upsertKeyframe(kfs: Keyframe[], k: Keyframe, tolerance = 1 / 60): Keyframe[] {
  const out = kfs.filter((x) => Math.abs(x.t - k.t) > tolerance);
  out.push(k);
  out.sort((a, b) => a.t - b.t);
  return out;
}
