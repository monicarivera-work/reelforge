import { ImagePlus, Pencil, RotateCw, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Project, VisualItem } from '../types';
import { ASPECTS } from '../types';
import { PreviewEngine } from '../engine/preview';
import { hitTest, type HitQuad } from '../engine/scene';
import { newProject } from '../lib/defaults';
import { pickFiles, primeKeyboard } from '../lib/device';
import { haptic } from '../lib/haptics';
import { findItem, type KeyValues } from '../lib/layout';
import { clamp } from '../lib/util';
import { now, pause, setEngine, togglePlay } from '../state/runtime';
import { useEditor, useTime } from '../state/store';
import { currentPose, deleteSelected, importAndInsert, writePose } from './actions';

/** Stand-in while the editor is closing (the store clears before the engine is disposed). */
const EMPTY: Project = newProject('');
const HANDLE_INSET = 13;
const SNAP_PX = 6;
const ROT_SNAP_DEG = 4;
const DRAG_SLOP = 6;

interface Gesture {
  mode: 'pending' | 'move' | 'pinch' | 'handle' | 'done';
  pointers: Map<number, { x: number; y: number }>;
  began: boolean;
  id: string | null;
  base: VisualItem | null;
  pose: KeyValues;
  local: number;
  fps: number;
  /** item center at gesture start, CSS px relative to the frame */
  qcx: number;
  qcy: number;
  /** first pointer's start (client px) */
  sx: number;
  sy: number;
  /** pinch / handle reference distance, angle and center (client px) */
  d0: number;
  a0: number;
  c0x: number;
  c0y: number;
  snapV: boolean;
  snapH: boolean;
  snapR: boolean;
}

export function Preview({ focus }: { focus: boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const delRef = useRef<HTMLButtonElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const scaleRef = useRef<HTMLDivElement>(null);
  const vGuideRef = useRef<HTMLDivElement>(null);
  const hGuideRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PreviewEngine | null>(null);
  const gRef = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);

  const aspect = useEditor((s) => s.project?.aspect ?? '9:16');
  const isEmpty = useEditor((s) => {
    const p = s.project;
    return !!p && !p.main.length && !p.overlays.length && !p.texts.length && !p.audios.length;
  });
  const busy = useEditor((s) => !!s.task);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);

  const size = useMemo(() => {
    if (!box) return null;
    const a = ASPECTS.find((x) => x.id === aspect) ?? ASPECTS[0];
    const r = a.w / a.h;
    const m = focus ? 0 : 16;
    const W = Math.max(1, box.w - m);
    const H = Math.max(1, box.h - m);
    return W / H > r ? { w: Math.round(H * r), h: Math.round(H) } : { w: Math.round(W), h: Math.round(W / r) };
  }, [box, aspect, focus]);

  const live = useRef({ size, focus });
  live.current = { size, focus };

  // ---------------------------------------------------------------- selection overlay (imperative, per frame)

  const drawSel = () => {
    const layer = layerRef.current;
    if (!layer) return;
    const eng = engineRef.current;
    const { size: sz, focus: f } = live.current;
    const id = useEditor.getState().selectedId;
    const q = eng && sz && id && !f && !eng.playing ? eng.quads.find((x) => x.id === id) : undefined;
    if (!q || !sz || !eng) {
      layer.style.display = 'none';
      return;
    }
    layer.style.display = '';
    const k = sz.w / eng.frameW;
    const w = q.w * k;
    const h = q.h * k;
    const cx = q.cx * k;
    const cy = q.cy * k;
    const b = boxRef.current!;
    b.style.width = `${w}px`;
    b.style.height = `${h}px`;
    b.style.transform = `translate(${cx - w / 2}px, ${cy - h / 2}px) rotate(${q.rot}rad)`;
    const c = Math.cos(q.rot);
    const s = Math.sin(q.rot);
    const place = (el: HTMLElement | null, show: boolean, sx: number, sy: number) => {
      if (!el) return;
      el.style.display = show ? '' : 'none';
      if (!show) return;
      const dx = (sx * w) / 2;
      const dy = (sy * h) / 2;
      const x = clamp(cx + dx * c - dy * s, HANDLE_INSET, sz.w - HANDLE_INSET);
      const y = clamp(cy + dx * s + dy * c, HANDLE_INSET, sz.h - HANDLE_INSET);
      el.style.transform = `translate(${x}px, ${y}px)`;
    };
    place(delRef.current, q.kind !== 'main', -1, -1);
    place(editRef.current, q.kind === 'texts', 1, -1);
    place(scaleRef.current, true, 1, 1);
  };

  const showGuides = (v: boolean, h: boolean) => {
    if (vGuideRef.current) vGuideRef.current.style.display = v ? '' : 'none';
    if (hGuideRef.current) hGuideRef.current.style.display = h ? '' : 'none';
  };

  // ---------------------------------------------------------------- engine lifecycle

  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBox((b) => (b && b.w === r.width && b.h === r.height ? b : { w: r.width, h: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const eng = new PreviewEngine({
      canvas: canvasRef.current!,
      getProject: () => useEditor.getState().project ?? EMPTY,
      onTime: (t) => useTime.setState({ time: t }),
      onPlayState: (playing) => {
        useTime.setState({ playing });
        drawSel();
      },
      onRender: drawSel,
    });
    engineRef.current = eng;
    setEngine(eng);
    eng.seek(useTime.getState().time);
    const unsub = useEditor.subscribe((s, prev) => {
      if (s.project !== prev.project) eng.projectChanged();
      else if (s.selectedId !== prev.selectedId) drawSel();
    });
    return () => {
      unsub();
      setEngine(null);
      eng.dispose();
      engineRef.current = null;
    };
    // drawSel only reads refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (size) engineRef.current?.setViewport(size.w, size.h);
    drawSel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, focus]);

  // ---------------------------------------------------------------- gestures

  const frameRect = () => frameRef.current!.getBoundingClientRect();

  /** Topmost quad under a client point; the selected item wins when it is under the point. */
  const pickTarget = (clientX: number, clientY: number, allowMain: boolean): HitQuad | null => {
    const eng = engineRef.current;
    const sz = live.current.size;
    if (!eng || !sz) return null;
    const r = frameRect();
    const k = sz.w / eng.frameW;
    const px = (clientX - r.left) / k;
    const py = (clientY - r.top) / k;
    const sel = useEditor.getState().selectedId;
    const selQ = sel ? eng.quads.find((q) => q.id === sel) : undefined;
    if (selQ && hitTest(selQ, px, py, 10 / k)) return selQ;
    for (let i = eng.quads.length - 1; i >= 0; i--) {
      const q = eng.quads[i];
      if (q.kind !== 'main' && hitTest(q, px, py, 4 / k)) return q;
    }
    if (!allowMain) return null;
    for (let i = eng.quads.length - 1; i >= 0; i--) {
      const q = eng.quads[i];
      if (q.kind === 'main' && hitTest(q, px, py)) return q;
    }
    return null;
  };

  /** Captures the item's state so every move is computed from the gesture start (one undo step). */
  const prepare = (id: string): boolean => {
    const gs = gRef.current!;
    const s = useEditor.getState();
    const f = s.project ? findItem(s.project, id) : null;
    const eng = engineRef.current;
    const sz = live.current.size;
    const q = eng?.quads.find((x) => x.id === id);
    if (!f || f.item.type === 'audio' || !eng || !sz || !q) return false;
    pause();
    if (!gs.began) {
      s.beginGesture();
      gs.began = true;
    }
    if (s.selectedId !== id) s.select(id);
    const it = f.item as VisualItem;
    gs.id = id;
    gs.base = it;
    gs.local = now() - it.start;
    gs.pose = currentPose(it, gs.local);
    gs.fps = s.project!.fps;
    const k = sz.w / eng.frameW;
    gs.qcx = q.cx * k;
    gs.qcy = q.cy * k;
    return true;
  };

  const write = (v: KeyValues) => {
    const gs = gRef.current;
    if (!gs?.id || !gs.base) return;
    const { id, base, local, fps } = gs;
    useEditor.getState().apply((d) => {
      const f = findItem(d as Project, id);
      if (f) writePose(f.item as VisualItem, base, local, v, fps);
    });
  };

  const snapRotation = (deg: number): number => {
    const gs = gRef.current!;
    const m = Math.round(deg / 90) * 90;
    const snap = Math.abs(deg - m) < ROT_SNAP_DEG;
    if (snap && !gs.snapR) haptic('light');
    gs.snapR = snap;
    return snap ? m : deg;
  };

  const moveTo = (clientX: number, clientY: number) => {
    const gs = gRef.current!;
    const sz = live.current.size!;
    const dx = clientX - gs.sx;
    const dy = clientY - gs.sy;
    const ncx = gs.qcx + dx;
    const ncy = gs.qcy + dy;
    const snapV = Math.abs(ncx - sz.w / 2) < SNAP_PX;
    const snapH = Math.abs(ncy - sz.h / 2) < SNAP_PX;
    if ((snapV && !gs.snapV) || (snapH && !gs.snapH)) haptic('light');
    gs.snapV = snapV;
    gs.snapH = snapH;
    showGuides(snapV, snapH);
    const ox = snapV ? sz.w / 2 - ncx : 0;
    const oy = snapH ? sz.h / 2 - ncy : 0;
    write({ ...gs.pose, x: gs.pose.x + (dx + ox) / sz.w, y: gs.pose.y + (dy + oy) / sz.h });
  };

  const pinchTo = () => {
    const gs = gRef.current!;
    const sz = live.current.size!;
    const [p1, p2] = [...gs.pointers.values()];
    if (!p1 || !p2) return;
    const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const a = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    const cx = (p1.x + p2.x) / 2;
    const cy = (p1.y + p2.y) / 2;
    write({
      ...gs.pose,
      x: gs.pose.x + (cx - gs.c0x) / sz.w,
      y: gs.pose.y + (cy - gs.c0y) / sz.h,
      scale: clamp((gs.pose.scale * d) / gs.d0, 0.05, 20),
      rotation: snapRotation(gs.pose.rotation + ((a - gs.a0) * 180) / Math.PI),
    });
  };

  const handleTo = (clientX: number, clientY: number) => {
    const gs = gRef.current!;
    const vx = clientX - gs.c0x;
    const vy = clientY - gs.c0y;
    write({
      ...gs.pose,
      scale: clamp((gs.pose.scale * Math.hypot(vx, vy)) / gs.d0, 0.05, 20),
      rotation: snapRotation(gs.pose.rotation + ((Math.atan2(vy, vx) - gs.a0) * 180) / Math.PI),
    });
  };

  const beginPinch = () => {
    const gs = gRef.current!;
    const [p1, p2] = [...gs.pointers.values()];
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    let id = gs.id;
    if (!id) {
      const eng = engineRef.current;
      const sel = useEditor.getState().selectedId;
      const q = (sel && eng?.quads.find((x) => x.id === sel)) || pickTarget(mx, my, true);
      id = q ? q.id : null;
    }
    showGuides(false, false);
    if (!id || !prepare(id)) {
      gs.mode = 'done';
      return;
    }
    gs.mode = 'pinch';
    gs.d0 = Math.max(10, Math.hypot(p2.x - p1.x, p2.y - p1.y));
    gs.a0 = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    gs.c0x = mx;
    gs.c0y = my;
    suppressClick.current = true;
  };

  const beginHandle = (clientX: number, clientY: number) => {
    const gs = gRef.current!;
    const id = useEditor.getState().selectedId;
    if (!id || !prepare(id)) {
      gs.mode = 'done';
      return;
    }
    gs.mode = 'handle';
    suppressClick.current = true;
    const r = frameRect();
    gs.c0x = r.left + gs.qcx;
    gs.c0y = r.top + gs.qcy;
    gs.d0 = Math.max(8, Math.hypot(clientX - gs.c0x, clientY - gs.c0y));
    gs.a0 = Math.atan2(clientY - gs.c0y, clientX - gs.c0x);
  };

  const finish = () => {
    const gs = gRef.current;
    if (gs?.began) {
      gs.began = false;
      useEditor.getState().endGesture();
    }
    showGuides(false, false);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button > 0 || live.current.focus) return;
    const target = e.target as Element;
    if (target.closest('button')) return;
    let gs = gRef.current;
    if (!gs) {
      gs = gRef.current = {
        mode: 'pending',
        pointers: new Map(),
        began: false,
        id: null,
        base: null,
        pose: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        local: 0,
        fps: 30,
        qcx: 0,
        qcy: 0,
        sx: e.clientX,
        sy: e.clientY,
        d0: 1,
        a0: 0,
        c0x: 0,
        c0y: 0,
        snapV: false,
        snapH: false,
        snapR: false,
      };
      suppressClick.current = false;
    }
    gs.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (gs.pointers.size === 1) {
      if (target.closest('[data-handle="scale"]')) beginHandle(e.clientX, e.clientY);
      return;
    }
    if (gs.pointers.size === 2 && (gs.mode === 'pending' || gs.mode === 'move')) beginPinch();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const gs = gRef.current;
    if (!gs || !gs.pointers.has(e.pointerId)) return;
    gs.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    switch (gs.mode) {
      case 'pending': {
        if (Math.hypot(e.clientX - gs.sx, e.clientY - gs.sy) < DRAG_SLOP) return;
        suppressClick.current = true;
        const q = pickTarget(gs.sx, gs.sy, false);
        if (!q || !prepare(q.id)) {
          gs.mode = 'done';
          return;
        }
        gs.mode = 'move';
        moveTo(e.clientX, e.clientY);
        return;
      }
      case 'move':
        moveTo(e.clientX, e.clientY);
        return;
      case 'pinch':
        pinchTo();
        return;
      case 'handle':
        handleTo(e.clientX, e.clientY);
        return;
    }
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const gs = gRef.current;
    if (!gs || !gs.pointers.delete(e.pointerId)) return;
    if (gs.mode === 'pinch' && gs.pointers.size === 1) {
      finish();
      gs.mode = 'done';
      return;
    }
    if (gs.pointers.size === 0) {
      finish();
      gRef.current = null;
    }
  };

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if ((e.target as Element).closest('button')) return;
    // Taps that start playback must call play() synchronously (iOS).
    if (live.current.focus || useTime.getState().playing) {
      togglePlay();
      return;
    }
    const eng = engineRef.current;
    const sz = live.current.size;
    if (!eng || !sz) return;
    const s = useEditor.getState();
    const hit = pickTarget(e.clientX, e.clientY, true);
    if (!hit) {
      s.select(null);
      return;
    }
    if (hit.id === s.selectedId) {
      if (hit.kind === 'texts') {
        primeKeyboard();
        s.openSheet('textEdit', hit.id);
      } else if (hit.kind === 'main') s.select(null);
      return;
    }
    s.select(hit.id);
  };

  const editText = () => {
    const id = useEditor.getState().selectedId;
    if (!id) return;
    primeKeyboard();
    pause();
    useEditor.getState().openSheet('textEdit', id);
  };

  const addMedia = () => {
    void pickFiles('video/*,image/*').then((files) => importAndInsert(files, 'main', { autoAspect: true }));
  };

  return (
    <div
      ref={wrapRef}
      className="preview"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onClick={onClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div ref={frameRef} className="frame" style={{ width: size?.w ?? 0, height: size?.h ?? 0 }}>
        <canvas ref={canvasRef} role="img" aria-label="Video preview" />
        <div ref={vGuideRef} className="guide v" style={{ display: 'none' }} />
        <div ref={hGuideRef} className="guide h" style={{ display: 'none' }} />
        <div ref={layerRef} className="sel-layer" style={{ display: 'none' }}>
          <div ref={boxRef} className="sel-box" />
          <button ref={delRef} className="sel-handle light" style={{ left: 0, top: 0 }} aria-label="Delete" onClick={deleteSelected}>
            <X size={15} strokeWidth={2.5} />
          </button>
          <button ref={editRef} className="sel-handle light" style={{ left: 0, top: 0 }} aria-label="Edit text" onClick={editText}>
            <Pencil size={13} strokeWidth={2.5} />
          </button>
          <div ref={scaleRef} className="sel-handle" data-handle="scale" style={{ left: 0, top: 0 }} aria-hidden>
            <RotateCw size={14} strokeWidth={2.5} />
          </div>
        </div>
        {isEmpty && !busy && (
          <div className="frame-empty">
            <span>Add videos or photos to start editing</span>
            <button className="primary-btn" onClick={addMedia}>
              <ImagePlus size={20} aria-hidden />
              Add media
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
