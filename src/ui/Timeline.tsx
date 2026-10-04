import { Plus } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { AudioItem, ImageItem, Item, MainItem, MediaAsset, Project, TextItem, TrackKind, VideoItem } from '../types';
import { isTimedMedia, isVisual } from '../types';
import { pickFiles } from '../lib/device';
import { haptic } from '../lib/haptics';
import { applyTrim, findItem, itemEnd, laneCount, moveFreeItem, moveMainItem, snapPoints, transitionOverlap } from '../lib/layout';
import { ensurePeaks, ensureThumbs, getAsset, getPeaksSync, getThumbStrip, mediaEvents } from '../lib/media';
import { clamp, formatTime } from '../lib/util';
import { duration, getEngine, now, pause, seek } from '../state/runtime';
import { useEditor, useTime } from '../state/store';
import { addText, importAndInsert } from './actions';

const RULER_H = 24;
const MAIN_TOP = 30;
const MAIN_H = 56;
const LANES_TOP = 96;
const LANE_H = 30;
const GAP = 4;
const HANDLE_W = 14;
const SNAP_PX = 8;
const SLOP = 6;
const LONG_PRESS_MS = 400;
const EDGE_PX = 40;
const AUTOSCROLL_PX_S = 700;
const MARKER = 20;
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const MINOR: Record<number, number> = { 1: 4, 2: 4, 5: 5, 10: 5, 15: 3, 30: 3, 60: 4, 120: 4, 300: 5, 600: 4 };

const ACCENT = '#ff3d6e';
const DIM = '#9a9aa8';
const RAISED = '#1d1d26';
const FONT = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const TEXT_TINT = { fill: '#3a2a12', ink: '#ffd89a' };
const AUDIO_TINT: Record<AudioItem['role'], { fill: string; ink: string; wave: string }> = {
  music: { fill: '#12304a', ink: '#a9d8ff', wave: '#3f9cff' },
  voice: { fill: '#0f3a2b', ink: '#9ff0c8', wave: '#33c98a' },
  sfx: { fill: '#33204a', ink: '#dcc2ff', wave: '#a67cff' },
  extracted: { fill: '#2c2c3a', ink: '#d0d0e0', wave: '#8d8da3' },
};

type FreeKind = 'overlays' | 'texts' | 'audios';
interface Row {
  kind: FreeKind;
  lane: number;
  /** content y (before vertical scroll) */
  y: number;
  hint?: 'text' | 'audio';
}
interface Span {
  it: MainItem;
  /** visual start/end: transition overlaps are split between neighbors */
  s: number;
  e: number;
  shift: number;
}
type Hit =
  | { type: 'marker'; id: string }
  | { type: 'hint'; hint: 'text' | 'audio' }
  | { type: 'item'; id: string; zone: 'body' | 'start' | 'end' }
  | null;

type Mode = 'pending' | 'scrub' | 'vscroll' | 'trim' | 'move' | 'reorder' | 'pinch' | 'done';
interface Gesture {
  mode: Mode;
  pointers: Map<number, { x: number; y: number }>;
  x0: number;
  y0: number;
  x: number;
  y: number;
  time0: number;
  vs0: number;
  samples: { x: number; t: number }[];
  timer: number;
  down: Hit;
  began: boolean;
  id: string;
  kind: TrackKind;
  edge: 'start' | 'end';
  orig: Item | null;
  asset?: MediaAsset;
  t0: number;
  edge0: number;
  snaps: number[];
  snapped: number | null;
  lo: number;
  hi: number;
  shiftFrom: number;
  shift: number;
  toIndex: number;
  d0: number;
  z0: number;
}

function buildRows(p: Project): { rows: Row[]; bottom: number } {
  const rows: Row[] = [];
  let y = LANES_TOP;
  const push = (kind: FreeKind, lane: number, hint?: Row['hint']) => {
    rows.push({ kind, lane, y, hint });
    y += LANE_H + GAP;
  };
  for (let l = 0; l < laneCount(p.overlays); l++) push('overlays', l);
  const nt = laneCount(p.texts);
  if (nt) for (let l = 0; l < nt; l++) push('texts', l);
  else push('texts', 0, 'text');
  const na = laneCount(p.audios);
  if (na) for (let l = 0; l < na; l++) push('audios', l);
  else push('audios', 0, 'audio');
  return { rows, bottom: y - GAP + 10 };
}

function mainSpans(main: MainItem[], shiftFrom = Infinity, shift = 0): Span[] {
  const out: Span[] = [];
  for (let i = 0; i < main.length; i++) {
    const it = main[i];
    const ovIn = i > 0 ? transitionOverlap(main[i - 1], it) / 2 : 0;
    const ovOut = i < main.length - 1 ? transitionOverlap(it, main[i + 1]) / 2 : 0;
    const sh = i >= shiftFrom ? shift : 0;
    out.push({ it, s: it.start + ovIn + sh, e: itemEnd(it) - ovOut + sh, shift: sh });
  }
  return out;
}

/** Transition buttons between main clips wide enough on screen (hidden next to the selected clip's handles). */
function markers(spans: Span[], X: (t: number) => number, sel: string | null) {
  const out: { id: string; x: number; on: boolean }[] = [];
  for (let i = 1; i < spans.length; i++) {
    const a = spans[i - 1];
    const b = spans[i];
    if ((a.e - a.s) * (X(1) - X(0)) < 24 || (b.e - b.s) * (X(1) - X(0)) < 24) continue;
    if (sel && (a.it.id === sel || b.it.id === sel)) continue;
    out.push({ id: b.it.id, x: X(b.s), on: !!b.it.transition && b.it.transition.type !== 'none' });
  }
  return out;
}

function snapList(p: Project, kind: TrackKind, index: number, id: string, time: number): number[] {
  if (kind === 'main') {
    // Clips after the trimmed one move with its edge, so they are not snap targets.
    const pts = [time];
    for (let i = 0; i < index; i++) pts.push(p.main[i].start, itemEnd(p.main[i]));
    for (const k of ['overlays', 'texts', 'audios'] as const) for (const it of p[k]) pts.push(it.start, itemEnd(it));
    return pts;
  }
  return [time, ...snapPoints(p, id)];
}

export function Timeline() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const rowsRef = useRef<Row[]>([]);
  const vScroll = useRef(0);
  const maxV = useRef(0);
  const gRef = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const rafRef = useRef(0);
  const inertiaRef = useRef(0);
  const autoRef = useRef(0);
  const ariaRef = useRef('');

  const requestDraw = () => {
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        draw();
      });
    }
  };

  const tAt = (x: number) => useTime.getState().time + (x - sizeRef.current.w / 2) / useEditor.getState().zoom;

  // ---------------------------------------------------------------- drawing

  const draw = () => {
    const cv = canvasRef.current;
    const { w: W, h: H, dpr } = sizeRef.current;
    if (!cv || W < 1 || H < 1) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const s = useEditor.getState();
    const p = s.project;
    if (!p) return;
    const time = useTime.getState().time;
    const zoom = s.zoom;
    const X = (t: number) => W / 2 + (t - time) * zoom;
    const g = gRef.current;
    const sel = s.selectedId;
    const { rows, bottom } = buildRows(p);
    rowsRef.current = rows;
    maxV.current = Math.max(0, bottom - H);
    vScroll.current = clamp(vScroll.current, 0, maxV.current);
    const vs = vScroll.current;
    ctx.textBaseline = 'middle';

    const label = `${formatTime(time)} of ${formatTime(duration())}`;
    if (label !== ariaRef.current) {
      ariaRef.current = label;
      cv.setAttribute('aria-valuetext', label);
      cv.setAttribute('aria-valuenow', String(Math.round(time)));
      cv.setAttribute('aria-valuemax', String(Math.ceil(duration())));
    }

    // ---- free lanes (scroll under the pinned ruler and main track)
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, MAIN_TOP + MAIN_H + 3, W, H);
    ctx.clip();
    let selFree: { it: Item; l: number; r: number; y: number } | null = null;
    for (const row of rows) {
      const y = row.y - vs;
      if (y > H || y + LANE_H < MAIN_TOP + MAIN_H) continue;
      if (row.hint) {
        drawHint(ctx, W / 2 + 10, y, row.hint === 'text' ? 'Add text' : 'Add audio');
        continue;
      }
      for (const it of p[row.kind] as Item[]) {
        if (it.lane !== row.lane) continue;
        const x0 = X(it.start);
        const x1 = X(itemEnd(it));
        if (x1 < -HANDLE_W || x0 > W + HANDLE_W) continue;
        drawFree(ctx, it, x0, x1, y, W, time, zoom);
        if (it.id === sel) selFree = { it, l: x0, r: x1, y };
      }
    }
    if (selFree) {
      drawSelection(ctx, selFree.l + 1, selFree.r - 1, selFree.y, LANE_H);
      if (isVisual(selFree.it)) drawKeyframes(ctx, selFree.it.keyframes, selFree.it.start, selFree.y + LANE_H / 2, X, time, p.fps);
    }
    ctx.restore();

    // ---- ruler
    drawRuler(ctx, W, time, zoom, X);

    // ---- main track
    const trimming = g?.mode === 'trim' && g.kind === 'main';
    const spans = mainSpans(p.main, trimming ? g.shiftFrom : Infinity, trimming ? g.shift : 0);
    const reorderId = g?.mode === 'reorder' ? g.id : null;
    let selMain: Span | null = null;
    for (const sp of spans) {
      const x0 = X(sp.s);
      const x1 = X(sp.e);
      if (sp.it.id === sel) selMain = sp;
      if (x1 < -HANDLE_W || x0 > W + HANDLE_W) continue;
      if (sp.it.id === reorderId) ctx.globalAlpha = 0.3;
      drawMainClip(ctx, sp, x0, x1, W, zoom, X);
      ctx.globalAlpha = 1;
    }
    if (!reorderId) for (const m of markers(spans, X, sel)) drawMarker(ctx, m.x, m.on);
    if (selMain && !reorderId) {
      const l = X(selMain.s) + 1;
      const r = X(selMain.e) - 1;
      drawSelection(ctx, l, r, MAIN_TOP, MAIN_H);
      drawKeyframes(ctx, selMain.it.keyframes, selMain.it.start + selMain.shift, MAIN_TOP + MAIN_H - 9, X, time, p.fps);
    }
    if (reorderId && g) drawReorder(ctx, spans, g, X);

    // ---- playhead
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(W / 2 - 2, 0, 4, H);
    ctx.fillStyle = '#fff';
    ctx.fillRect(W / 2 - 1, 0, 2, H);
  };

  // ---------------------------------------------------------------- hit testing

  const hitTest = (x: number, y: number, forTap: boolean): Hit => {
    const s = useEditor.getState();
    const p = s.project;
    if (!p) return null;
    const W = sizeRef.current.w;
    const time = useTime.getState().time;
    const X = (t: number) => W / 2 + (t - time) * s.zoom;
    const sel = s.selectedId;
    if (y >= MAIN_TOP - 6 && y <= MAIN_TOP + MAIN_H + 4) {
      const spans = mainSpans(p.main);
      if (forTap) {
        for (const m of markers(spans, X, sel)) {
          if (Math.abs(x - m.x) <= 15 && Math.abs(y - (MAIN_TOP + MAIN_H / 2)) <= 20) return { type: 'marker', id: m.id };
        }
      }
      const sp = sel ? spans.find((q) => q.it.id === sel) : undefined;
      if (sp) {
        const x0 = X(sp.s);
        const x1 = X(sp.e);
        if (x >= x0 - HANDLE_W - 8 && x < x0 + 6) return { type: 'item', id: sp.it.id, zone: 'start' };
        if (x > x1 - 6 && x <= x1 + HANDLE_W + 8) return { type: 'item', id: sp.it.id, zone: 'end' };
      }
      for (const q of spans) if (x >= X(q.s) && x < X(q.e)) return { type: 'item', id: q.it.id, zone: 'body' };
      return null;
    }
    if (y < MAIN_TOP + MAIN_H + 4) return null;
    const vy = y + vScroll.current;
    for (const row of rowsRef.current) {
      if (vy < row.y - GAP / 2 || vy >= row.y + LANE_H + GAP / 2) continue;
      if (row.hint) {
        if (forTap && x >= W / 2 && x <= W / 2 + 10 + hintWidth(row.hint) + 8) return { type: 'hint', hint: row.hint };
        return null;
      }
      const items = (p[row.kind] as Item[]).filter((it) => it.lane === row.lane);
      const selIt = items.find((it) => it.id === sel);
      if (selIt) {
        const x0 = X(selIt.start);
        const x1 = X(itemEnd(selIt));
        if (x >= x0 - HANDLE_W - 8 && x < x0 + 6) return { type: 'item', id: selIt.id, zone: 'start' };
        if (x > x1 - 6 && x <= x1 + HANDLE_W + 8) return { type: 'item', id: selIt.id, zone: 'end' };
      }
      for (const it of items) if (x >= X(it.start) && x < X(itemEnd(it))) return { type: 'item', id: it.id, zone: 'body' };
      return null;
    }
    return null;
  };

  // ---------------------------------------------------------------- inertia & autoscroll

  const stopInertia = () => {
    cancelAnimationFrame(inertiaRef.current);
    inertiaRef.current = 0;
  };

  const startInertia = (v: number) => {
    if (Math.abs(v) < 0.2) return;
    let last = performance.now();
    const step = (ts: number) => {
      const dt = Math.min(48, ts - last);
      last = ts;
      const t = useTime.getState().time - (v * dt) / useEditor.getState().zoom;
      const end = duration();
      if (t <= 0 || t >= end) {
        seek(clamp(t, 0, end));
        inertiaRef.current = 0;
        return;
      }
      seek(t);
      v *= Math.pow(0.94, dt / 16);
      if (Math.abs(v) < 0.03) {
        inertiaRef.current = 0;
        return;
      }
      inertiaRef.current = requestAnimationFrame(step);
    };
    inertiaRef.current = requestAnimationFrame(step);
  };

  const startAutoScroll = () => {
    if (autoRef.current) return;
    let last = performance.now();
    const step = (ts: number) => {
      const g = gRef.current;
      if (!g || (g.mode !== 'trim' && g.mode !== 'move' && g.mode !== 'reorder')) {
        autoRef.current = 0;
        return;
      }
      const dt = Math.min(48, ts - last) / 1000;
      last = ts;
      const W = sizeRef.current.w;
      let k = 0;
      if (g.x < EDGE_PX) k = -(EDGE_PX - g.x) / EDGE_PX;
      else if (g.x > W - EDGE_PX) k = (g.x - (W - EDGE_PX)) / EDGE_PX;
      if (k) {
        const before = useTime.getState().time;
        seek(before + (clamp(k, -1, 1) * AUTOSCROLL_PX_S * dt) / useEditor.getState().zoom);
        if (useTime.getState().time !== before) dragTo(g.x, g.y);
      }
      autoRef.current = requestAnimationFrame(step);
    };
    autoRef.current = requestAnimationFrame(step);
  };

  // ---------------------------------------------------------------- item gestures

  const startTrim = (id: string, edge: 'start' | 'end', x: number) => {
    const g = gRef.current!;
    const s = useEditor.getState();
    const p = s.project;
    const f = p ? findItem(p, id) : null;
    if (!p || !f) return;
    clearTimeout(g.timer);
    pause();
    s.beginGesture();
    g.began = true;
    g.mode = 'trim';
    suppressClick.current = true;
    g.id = id;
    g.kind = f.kind;
    g.edge = edge;
    g.orig = f.item;
    g.asset = isTimedMedia(f.item) ? getAsset(f.item.mediaId) : undefined;
    g.t0 = tAt(x);
    g.edge0 = edge === 'start' ? f.item.start : itemEnd(f.item);
    g.snaps = snapList(p, f.kind, f.index, id, useTime.getState().time);
    g.snapped = null;
    g.lo = -Infinity;
    g.hi = Infinity;
    if (f.kind !== 'main') {
      for (const o of p[f.kind] as Item[]) {
        if (o.id === id || o.lane !== f.item.lane) continue;
        if (itemEnd(o) <= f.item.start + 1e-6) g.lo = Math.max(g.lo, itemEnd(o));
        else if (o.start >= itemEnd(f.item) - 1e-6) g.hi = Math.min(g.hi, o.start);
      }
    }
    g.shiftFrom = f.kind === 'main' && edge === 'start' ? f.index : Infinity;
    g.shift = 0;
    haptic('light');
    startAutoScroll();
    requestDraw();
  };

  const trimTo = (x: number) => {
    const g = gRef.current!;
    const s = useEditor.getState();
    const orig = g.orig!;
    let d = tAt(x) - g.t0;
    if (g.kind !== 'main') d = g.edge === 'end' ? Math.min(d, g.hi - g.edge0) : Math.max(d, g.lo - g.edge0);
    const e = g.edge0 + d;
    let best: number | null = null;
    for (const sp of g.snaps) {
      if (Math.abs(sp - e) * s.zoom < SNAP_PX && (best === null || Math.abs(sp - e) < Math.abs(best - e))) best = sp;
    }
    if (best !== null) d = best - g.edge0;
    if (best !== null && best !== g.snapped) haptic('light');
    g.snapped = best;
    const { id, edge, asset } = g;
    s.apply((dr) => applyTrim(dr as Project, id, orig, edge, d, asset));
    const p = useEditor.getState().project!;
    const it = findItem(p, id)?.item;
    if (!it) return;
    if (g.shiftFrom !== Infinity) g.shift = orig.duration - it.duration;
    getEngine()?.setPeek(edge === 'start' ? it.start + 0.001 : Math.max(it.start, itemEnd(it) - 1 / p.fps));
    requestDraw();
  };

  const endTrim = () => {
    const g = gRef.current!;
    getEngine()?.setPeek(null);
    if (g.began) useEditor.getState().endGesture();
    g.began = false;
    if (g.shiftFrom !== Infinity && g.shift && g.orig) {
      // Keep the same frame under the playhead once the main track closes the gap.
      const T = useTime.getState().time;
      if (T >= g.orig.start + g.shift) seek(Math.max(0, T - g.shift));
    }
  };

  const onLongPress = () => {
    const g = gRef.current;
    if (!g || g.mode !== 'pending' || g.down?.type !== 'item') return;
    const s = useEditor.getState();
    const p = s.project;
    const f = p ? findItem(p, g.down.id) : null;
    if (!p || !f) return;
    pause();
    suppressClick.current = true;
    haptic('medium');
    if (s.selectedId !== f.item.id) s.select(f.item.id);
    g.id = f.item.id;
    g.kind = f.kind;
    g.orig = f.item;
    g.t0 = tAt(g.x);
    g.snapped = null;
    if (f.kind === 'main') {
      g.mode = 'reorder';
      g.toIndex = f.index;
    } else {
      g.mode = 'move';
      s.beginGesture();
      g.began = true;
      g.snaps = [useTime.getState().time, ...snapPoints(p, f.item.id)];
    }
    startAutoScroll();
    requestDraw();
  };

  const laneAtY = (kind: TrackKind, y: number): number => {
    const rows = rowsRef.current.filter((r) => r.kind === kind && !r.hint);
    if (!rows.length) return 0;
    const vy = y + vScroll.current;
    return clamp(Math.floor((vy - rows[0].y + GAP / 2) / (LANE_H + GAP)), 0, rows.length);
  };

  const moveTo = (x: number, y: number) => {
    const g = gRef.current!;
    const s = useEditor.getState();
    const orig = g.orig!;
    let ns = orig.start + (tAt(x) - g.t0);
    let best: number | null = null;
    let bestD = Infinity;
    for (const sp of g.snaps) {
      const d1 = Math.abs(sp - ns);
      const d2 = Math.abs(sp - (ns + orig.duration));
      if (d1 * s.zoom < SNAP_PX && d1 < bestD) {
        best = sp;
        bestD = d1;
      }
      if (d2 * s.zoom < SNAP_PX && d2 < bestD) {
        best = sp - orig.duration;
        bestD = d2;
      }
    }
    if (best !== null) ns = best;
    if (best !== null && best !== g.snapped) haptic('light');
    g.snapped = best;
    const lane = laneAtY(g.kind, y);
    const id = g.id;
    s.apply((dr) => moveFreeItem(dr as Project, id, Math.max(0, ns), lane));
    requestDraw();
  };

  const reorderTo = (x: number) => {
    const g = gRef.current!;
    const p = useEditor.getState().project;
    if (!p) return;
    const tp = tAt(x);
    let k = 0;
    for (const sp of mainSpans(p.main)) {
      if (sp.it.id !== g.id && (sp.s + sp.e) / 2 < tp) k++;
    }
    g.toIndex = k;
    requestDraw();
  };

  const endReorder = () => {
    const g = gRef.current!;
    const s = useEditor.getState();
    const p = s.project;
    if (!p) return;
    const cur = p.main.findIndex((m) => m.id === g.id);
    if (cur < 0 || cur === g.toIndex) return;
    const { id, toIndex } = g;
    s.apply((dr) => moveMainItem(dr as Project, id, toIndex));
    const m = useEditor.getState().project?.main.find((q) => q.id === id);
    if (m) seek(m.start);
    haptic('light');
  };

  const dragTo = (x: number, y: number) => {
    const g = gRef.current;
    if (!g) return;
    if (g.mode === 'trim') trimTo(x);
    else if (g.mode === 'move') moveTo(x, y);
    else if (g.mode === 'reorder') reorderTo(x);
  };

  // ---------------------------------------------------------------- pointer handlers

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button > 0) return;
    stopInertia();
    const { x, y } = local(e);
    let g = gRef.current;
    if (!g) {
      g = gRef.current = {
        mode: 'pending',
        pointers: new Map(),
        x0: x,
        y0: y,
        x,
        y,
        time0: useTime.getState().time,
        vs0: vScroll.current,
        samples: [],
        timer: 0,
        down: null,
        began: false,
        id: '',
        kind: 'main',
        edge: 'end',
        orig: null,
        t0: 0,
        edge0: 0,
        snaps: [],
        snapped: null,
        lo: -Infinity,
        hi: Infinity,
        shiftFrom: Infinity,
        shift: 0,
        toIndex: 0,
        d0: 1,
        z0: 1,
      };
      suppressClick.current = false;
    }
    g.pointers.set(e.pointerId, { x, y });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (g.pointers.size === 2) {
      if (g.mode === 'pending' || g.mode === 'scrub' || g.mode === 'vscroll') {
        clearTimeout(g.timer);
        const [a, b] = [...g.pointers.values()];
        g.mode = 'pinch';
        g.d0 = Math.max(10, Math.hypot(b.x - a.x, b.y - a.y));
        g.z0 = useEditor.getState().zoom;
        suppressClick.current = true;
      }
      return;
    }
    if (g.pointers.size > 1) return;
    const h = hitTest(x, y, false);
    g.down = h;
    if (h?.type === 'item' && h.zone !== 'body') {
      startTrim(h.id, h.zone, x);
      return;
    }
    if (h?.type === 'item') g.timer = window.setTimeout(onLongPress, LONG_PRESS_MS);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gRef.current;
    if (!g || !g.pointers.has(e.pointerId)) return;
    const { x, y } = local(e);
    g.pointers.set(e.pointerId, { x, y });
    if (g.pointers.size >= 2) {
      if (g.mode === 'pinch') {
        const [a, b] = [...g.pointers.values()];
        useEditor.getState().setZoom((g.z0 * Math.hypot(b.x - a.x, b.y - a.y)) / g.d0);
      }
      return;
    }
    g.x = x;
    g.y = y;
    switch (g.mode) {
      case 'pending': {
        if (Math.hypot(x - g.x0, y - g.y0) < SLOP) return;
        clearTimeout(g.timer);
        suppressClick.current = true;
        if (Math.abs(y - g.y0) > Math.abs(x - g.x0) && g.y0 > MAIN_TOP + MAIN_H && maxV.current > 0) {
          g.mode = 'vscroll';
          g.vs0 = vScroll.current;
          g.y0 = y;
        } else {
          g.mode = 'scrub';
          pause();
          g.time0 = useTime.getState().time;
          g.x0 = x;
        }
        return;
      }
      case 'scrub': {
        seek(g.time0 - (x - g.x0) / useEditor.getState().zoom);
        const t = performance.now();
        g.samples.push({ x, t });
        while (g.samples.length > 1 && t - g.samples[0].t > 100) g.samples.shift();
        return;
      }
      case 'vscroll':
        vScroll.current = clamp(g.vs0 - (y - g.y0), 0, maxV.current);
        requestDraw();
        return;
      default:
        dragTo(x, y);
    }
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gRef.current;
    if (!g || !g.pointers.delete(e.pointerId)) return;
    if (g.mode === 'pinch') {
      if (g.pointers.size < 2) g.mode = 'done';
      if (g.pointers.size === 0) gRef.current = null;
      return;
    }
    if (g.pointers.size > 0) return;
    clearTimeout(g.timer);
    const ok = e.type === 'pointerup';
    switch (g.mode) {
      case 'scrub': {
        const smp = g.samples;
        const t = performance.now();
        if (ok && smp.length > 1 && t - smp[smp.length - 1].t < 60) {
          const a = smp[0];
          const b = smp[smp.length - 1];
          if (b.t > a.t) startInertia((b.x - a.x) / (b.t - a.t));
        }
        break;
      }
      case 'trim':
        endTrim();
        break;
      case 'move':
        if (g.began) useEditor.getState().endGesture();
        g.began = false;
        break;
      case 'reorder':
        if (ok) endReorder();
        break;
    }
    cancelAnimationFrame(autoRef.current);
    autoRef.current = 0;
    gRef.current = null;
    requestDraw();
  };

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    const { x, y } = local(e);
    const h = hitTest(x, y, true);
    const s = useEditor.getState();
    if (!h) {
      s.select(null);
      return;
    }
    if (h.type === 'marker') {
      pause();
      s.openSheet('transition', h.id);
      return;
    }
    if (h.type === 'hint') {
      // addText opens the keyboard, so it must run inside the tap.
      if (h.hint === 'text') addText();
      else {
        pause();
        s.openSheet('audio');
      }
      return;
    }
    if (h.zone !== 'body') return;
    pause();
    s.select(s.selectedId === h.id ? null : h.id);
  };

  const addClips = () => {
    void pickFiles('video/*,image/*').then((files) => importAndInsert(files, 'main', { at: 'end' }));
  };

  // ---------------------------------------------------------------- lifecycle

  useEffect(() => {
    const wrap = wrapRef.current!;
    const cv = canvasRef.current!;
    const resize = () => {
      const r = wrap.getBoundingClientRect();
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      sizeRef.current = { w: r.width, h: r.height, dpr };
      const pw = Math.max(1, Math.round(r.width * dpr));
      const ph = Math.max(1, Math.round(r.height * dpr));
      if (cv.width !== pw) cv.width = pw;
      if (cv.height !== ph) cv.height = ph;
      draw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();
    const unsubT = useTime.subscribe(requestDraw);
    const unsubE = useEditor.subscribe((s, prev) => {
      if (s.project !== prev.project || s.selectedId !== prev.selectedId || s.zoom !== prev.zoom) requestDraw();
    });
    const onMedia = () => requestDraw();
    mediaEvents.addEventListener('update', onMedia);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      stopInertia();
      const s = useEditor.getState();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      if (e.ctrlKey || e.metaKey) {
        s.setZoom(s.zoom * Math.exp(-dy * 0.01));
        return;
      }
      if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
        pause();
        seek(now() + (e.shiftKey && !dx ? dy : dx) / s.zoom);
        return;
      }
      if (maxV.current > 0) {
        vScroll.current = clamp(vScroll.current + dy, 0, maxV.current);
        requestDraw();
        return;
      }
      pause();
      seek(now() + dy / s.zoom);
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      unsubT();
      unsubE();
      mediaEvents.removeEventListener('update', onMedia);
      cv.removeEventListener('wheel', onWheel);
      cancelAnimationFrame(rafRef.current);
      cancelAnimationFrame(inertiaRef.current);
      cancelAnimationFrame(autoRef.current);
      const g = gRef.current;
      if (g) {
        clearTimeout(g.timer);
        if (g.began) useEditor.getState().endGesture();
      }
      getEngine()?.setPeek(null);
    };
    // Handlers only read refs and stores.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={wrapRef} className="timeline">
      <canvas
        ref={canvasRef}
        role="slider"
        tabIndex={0}
        aria-label="Timeline. Drag to scrub, tap a clip to select it, long-press to move it"
        aria-valuemin={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClick={onClick}
        onContextMenu={(e) => e.preventDefault()}
      />
      <button className="tl-add" style={{ top: MAIN_TOP + (MAIN_H - 44) / 2 }} aria-label="Add clips at the end" onClick={addClips}>
        <span>
          <Plus size={20} strokeWidth={2.5} />
        </span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drawing helpers

function fitText(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (max <= 8) return '';
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo ? text.slice(0, lo) + '…' : '';
}

function hintWidth(hint: 'text' | 'audio') {
  return hint === 'text' ? 104 : 112;
}

function drawHint(ctx: CanvasRenderingContext2D, x: number, y: number, label: string) {
  const w = label === 'Add text' ? hintWidth('text') : hintWidth('audio');
  ctx.fillStyle = RAISED;
  ctx.beginPath();
  ctx.roundRect(x, y, w, LANE_H, 6);
  ctx.fill();
  ctx.fillStyle = DIM;
  const cx = x + 16;
  const cy = y + LANE_H / 2;
  ctx.fillRect(cx - 6, cy - 1, 12, 2);
  ctx.fillRect(cx - 1, cy - 6, 2, 12);
  ctx.font = `600 12px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(label, x + 30, cy + 0.5);
}

function drawRuler(ctx: CanvasRenderingContext2D, W: number, time: number, zoom: number, X: (t: number) => number) {
  const step = STEPS.find((s) => s * zoom >= 64) ?? STEPS[STEPS.length - 1];
  const n = MINOR[step];
  const minor = step / n;
  const tL = time - W / 2 / zoom;
  const tR = time + W / 2 / zoom;
  const cy = RULER_H / 2;
  if (minor * zoom >= 8) {
    ctx.fillStyle = '#4a4a58';
    for (let i = Math.max(0, Math.ceil(tL / minor)); i * minor <= tR; i++) {
      if (i % n === 0) continue;
      ctx.fillRect(Math.round(X(i * minor)) - 1, cy - 1, 2, 2);
    }
  }
  ctx.fillStyle = DIM;
  ctx.font = `500 10px ${FONT}`;
  ctx.textAlign = 'center';
  for (let i = Math.max(0, Math.floor(tL / step)); i * step <= tR + step; i++) {
    ctx.fillText(formatTime(i * step), X(i * step), cy + 0.5);
  }
}

function nearestThumb(images: (ImageBitmap | null)[], idx: number): ImageBitmap | null {
  for (let d = 0; d < images.length; d++) {
    const a = images[idx - d];
    if (a) return a;
    const b = images[idx + d];
    if (b) return b;
  }
  return null;
}

/** Square thumbnails tiled from the clip's (shifted) start; the clip path must already be clipped. */
function drawThumbs(
  ctx: CanvasRenderingContext2D,
  it: VideoItem | ImageItem,
  startX: number,
  l: number,
  r: number,
  y: number,
  size: number,
  W: number,
  zoom: number,
) {
  const strip = getThumbStrip(it.mediaId);
  if (!strip) {
    ensureThumbs(it.mediaId).catch(() => {});
    return;
  }
  const n = strip.images.length;
  if (!n) return;
  const from = Math.max(l, 0);
  const to = Math.min(r, W);
  for (let k = Math.max(0, Math.floor((from - startX) / size)); ; k++) {
    const tx = startX + k * size;
    if (tx > to) break;
    let idx = 0;
    if (it.type === 'video') {
      const src = it.in + ((k + 0.5) * size * it.speed) / zoom;
      idx = clamp(Math.floor(src / strip.interval), 0, n - 1);
    }
    const img = nearestThumb(strip.images, idx);
    if (img) ctx.drawImage(img, tx, y, size, size);
  }
}

function drawMainClip(ctx: CanvasRenderingContext2D, sp: Span, x0: number, x1: number, W: number, zoom: number, X: (t: number) => number) {
  const it = sp.it;
  const l = x0 + 1;
  const r = x1 - 1;
  const w = r - l;
  if (w <= 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(l, MAIN_TOP, w, MAIN_H, 6);
  ctx.clip();
  ctx.fillStyle = it.type === 'color' ? it.color : RAISED;
  ctx.fillRect(l, MAIN_TOP, w, MAIN_H);
  if (it.type !== 'color') drawThumbs(ctx, it, X(it.start + sp.shift), l, r, MAIN_TOP, MAIN_H, W, zoom);
  if (w > 44) {
    let txt = `${it.duration < 10 ? it.duration.toFixed(1) : Math.round(it.duration)}s`;
    if (it.type === 'video' && it.speed !== 1) txt += ` · ${+it.speed.toFixed(2)}×`;
    if (it.type === 'video' && it.muted) txt += ' · Muted';
    ctx.font = `600 10px ${FONT}`;
    txt = fitText(ctx, txt, w - 16);
    if (txt) {
      const tw = ctx.measureText(txt).width;
      const px = Math.max(l, 0) + 4;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.beginPath();
      ctx.roundRect(px, MAIN_TOP + 4, tw + 8, 16, 4);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.fillText(txt, px + 4, MAIN_TOP + 12.5);
    }
  }
  ctx.restore();
}

function drawFree(ctx: CanvasRenderingContext2D, it: Item, x0: number, x1: number, y: number, W: number, time: number, zoom: number) {
  const l = x0 + 1;
  const r = x1 - 1;
  const w = r - l;
  if (w <= 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(l, y, w, LANE_H, 5);
  ctx.clip();
  const labelX = Math.max(l, 0) + 6;
  const room = r - labelX - 4;
  ctx.textAlign = 'left';
  if (it.type === 'text') {
    drawTextClip(ctx, it, l, w, y, labelX, room);
  } else if (it.type === 'audio') {
    const tint = AUDIO_TINT[it.role];
    ctx.fillStyle = tint.fill;
    ctx.fillRect(l, y, w, LANE_H);
    drawWave(ctx, it, l, r, y, W, time, zoom, tint.wave);
    ctx.fillStyle = tint.ink;
    ctx.font = `600 10px ${FONT}`;
    const name = it.muted ? `${it.name} · Muted` : it.name;
    ctx.fillText(fitText(ctx, name, room), labelX, y + 8);
  } else {
    ctx.fillStyle = it.type === 'color' ? it.color : RAISED;
    ctx.fillRect(l, y, w, LANE_H);
    if (it.type !== 'color') drawThumbs(ctx, it, x0, l, r, y, LANE_H, W, zoom);
  }
  ctx.restore();
}

function drawTextClip(ctx: CanvasRenderingContext2D, it: TextItem, l: number, w: number, y: number, labelX: number, room: number) {
  ctx.fillStyle = TEXT_TINT.fill;
  ctx.fillRect(l, y, w, LANE_H);
  ctx.fillStyle = TEXT_TINT.ink;
  let x = labelX;
  if (it.caption && room > 26) {
    ctx.strokeStyle = TEXT_TINT.ink;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y + 8.5, 20, 13, 3);
    ctx.stroke();
    ctx.font = `700 8px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('CC', x + 10.5, y + 15.5);
    ctx.textAlign = 'left';
    x += 26;
    room -= 26;
  }
  ctx.font = `600 11px ${FONT}`;
  ctx.fillText(fitText(ctx, it.text.replace(/\s+/g, ' ').trim(), room), x, y + LANE_H / 2 + 0.5);
}

function drawWave(
  ctx: CanvasRenderingContext2D,
  it: AudioItem,
  l: number,
  r: number,
  y: number,
  W: number,
  time: number,
  zoom: number,
  color: string,
) {
  const pk = getPeaksSync(it.mediaId);
  if (!pk) {
    ensurePeaks(it.mediaId).catch(() => {});
    return;
  }
  const data = pk.data;
  const maxH = LANE_H - 15;
  const base = y + LANE_H - 2;
  ctx.fillStyle = color;
  const from = Math.max(Math.floor(l), 0);
  const to = Math.min(r, W);
  const vol = it.muted ? 0 : Math.min(1, it.volume);
  for (let x = from; x < to; x += 2) {
    const t0 = time + (x - W / 2) / zoom;
    const lt = t0 - it.start;
    const s0 = it.in + lt * it.speed;
    const s1 = s0 + (2 / zoom) * it.speed;
    const i0 = Math.max(0, Math.floor(s0 * pk.rate));
    const i1 = Math.min(data.length, Math.max(i0 + 1, Math.floor(s1 * pk.rate)));
    let m = 0;
    for (let i = i0; i < i1; i++) if (data[i] > m) m = data[i];
    let gain = vol;
    if (it.fadeIn > 0 && lt < it.fadeIn) gain *= Math.max(0, lt / it.fadeIn);
    const rem = it.duration - lt;
    if (it.fadeOut > 0 && rem < it.fadeOut) gain *= Math.max(0, rem / it.fadeOut);
    const h = Math.max(1, (m / 255) * gain * maxH);
    ctx.fillRect(x, base - h, 1.5, h);
  }
}

function drawSelection(ctx: CanvasRenderingContext2D, l: number, r: number, y: number, h: number) {
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(l, y - 1, Math.max(0, r - l), h + 2, 5);
  ctx.stroke();
  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  ctx.roundRect(l - HANDLE_W, y - 2, HANDLE_W, h + 4, [6, 0, 0, 6]);
  ctx.roundRect(r, y - 2, HANDLE_W, h + 4, [0, 6, 6, 0]);
  ctx.fill();
  ctx.fillStyle = '#fff';
  const gh = Math.min(16, h * 0.5);
  ctx.beginPath();
  ctx.roundRect(l - HANDLE_W / 2 - 1, y + h / 2 - gh / 2, 2, gh, 1);
  ctx.roundRect(r + HANDLE_W / 2 - 1, y + h / 2 - gh / 2, 2, gh, 1);
  ctx.fill();
}

function drawKeyframes(
  ctx: CanvasRenderingContext2D,
  kfs: { t: number }[],
  start: number,
  cy: number,
  X: (t: number) => number,
  time: number,
  fps: number,
) {
  for (const k of kfs) {
    const x = X(start + k.t);
    const on = Math.abs(start + k.t - time) < 0.5 / fps;
    ctx.beginPath();
    ctx.moveTo(x, cy - 5);
    ctx.lineTo(x + 5, cy);
    ctx.lineTo(x, cy + 5);
    ctx.lineTo(x - 5, cy);
    ctx.closePath();
    ctx.fillStyle = on ? ACCENT : '#fff';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();
  }
}

function drawMarker(ctx: CanvasRenderingContext2D, x: number, on: boolean) {
  const cy = MAIN_TOP + MAIN_H / 2;
  const h = MARKER / 2;
  ctx.beginPath();
  ctx.roundRect(x - h, cy - h, MARKER, MARKER, 5);
  ctx.fillStyle = on ? '#fff' : '#262632';
  ctx.fill();
  ctx.strokeStyle = on ? '#fff' : '#4a4a58';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = on ? '#16161d' : '#fff';
  if (on) {
    // bow-tie: a transition is set
    ctx.beginPath();
    ctx.moveTo(x - 5, cy - 4);
    ctx.lineTo(x, cy);
    ctx.lineTo(x - 5, cy + 4);
    ctx.closePath();
    ctx.moveTo(x + 5, cy - 4);
    ctx.lineTo(x, cy);
    ctx.lineTo(x + 5, cy + 4);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.fillRect(x - 1, cy - 5, 2, 10);
  }
}

function drawReorder(ctx: CanvasRenderingContext2D, spans: Span[], g: Gesture, X: (t: number) => number) {
  const cur = spans.findIndex((sp) => sp.it.id === g.id);
  if (cur < 0) return;
  const others = spans.filter((sp) => sp.it.id !== g.id);
  let lx: number;
  if (g.toIndex === cur || !others.length) lx = X(spans[cur].s);
  else if (g.toIndex >= others.length) lx = X(others[others.length - 1].e);
  else lx = X(others[g.toIndex].s);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.roundRect(lx - 1.5, MAIN_TOP - 6, 3, MAIN_H + 12, 1.5);
  ctx.fill();

  const it = spans[cur].it;
  const w = 64;
  const gx = g.x - w / 2;
  const gy = MAIN_TOP - 8;
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.roundRect(gx, gy, w, MAIN_H, 8);
  ctx.fillStyle = it.type === 'color' ? it.color : RAISED;
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(gx, gy, w, MAIN_H, 8);
  ctx.clip();
  if (it.type !== 'color') {
    const strip = getThumbStrip(it.mediaId);
    const img = strip ? nearestThumb(strip.images, 0) : null;
    if (img) ctx.drawImage(img, gx + (w - MAIN_H) / 2, gy, MAIN_H, MAIN_H);
  }
  ctx.restore();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(gx, gy, w, MAIN_H, 8);
  ctx.stroke();
}
