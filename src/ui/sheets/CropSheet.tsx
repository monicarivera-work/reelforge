import { LoaderCircle, RotateCcw } from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { ASPECTS, type Crop, type ImageItem, type VideoItem } from '../../types';
import { captureFrame, getAsset, getObjectUrl } from '../../lib/media';
import { clamp } from '../../lib/util';
import { now } from '../../state/runtime';
import { useEditor } from '../../state/store';
import { Sheet, updateItem } from '../common';

type Media = VideoItem | ImageItem;

export interface Still {
  /** the media the still was taken from */
  mediaId: string;
  url: string;
  w: number;
  h: number;
}

/** Source time to show for a clip: the frame under the playhead when it's over the clip, else its first frame. */
export function stillTime(item: Media): number {
  if (item.type !== 'video') return 0;
  const t = now();
  const a = getAsset(item.mediaId);
  const srcEnd = Math.min(item.in + item.duration * item.speed, a?.duration ?? Infinity);
  const st = t >= item.start && t < item.start + item.duration ? item.in + (t - item.start) * item.speed : item.in;
  return clamp(st, item.in, Math.max(item.in, srcEnd - 0.05));
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image failed to load'));
    img.src = url;
  });
}

/**
 * A full-resolution still of the clip's source (for video, the frame under the playhead when the sheet
 * opened). Null while loading, false if it couldn't be loaded. Nothing loads until `active`.
 */
export function useSourceStill(item: Media, active = true): Still | null | false {
  const mediaId = item.mediaId;
  const video = item.type === 'video';
  const [t] = useState(() => stillTime(item));
  const [still, setStill] = useState<Still | null | false>(null);
  const owned = useRef<string[]>([]);
  const ready = still === false || (still !== null && still.mediaId === mediaId);

  useEffect(() => {
    if (!active || ready) return;
    let alive = true;
    void (async () => {
      const a = getAsset(mediaId);
      if (!a) throw new Error('Missing media');
      let url: string | null;
      if (video) {
        url = URL.createObjectURL(await captureFrame(a, t));
        owned.current.push(url);
      } else {
        url = await getObjectUrl(mediaId);
      }
      if (!url) throw new Error('Missing media');
      const img = await loadImage(url);
      if (alive) setStill({ mediaId, url, w: img.naturalWidth || a.width, h: img.naturalHeight || a.height });
    })().catch((e) => {
      console.warn('Could not load a still', e);
      if (alive) setStill(false);
    });
    return () => {
      alive = false;
    };
  }, [active, ready, mediaId, video, t]);

  useEffect(
    () => () => {
      for (const u of owned.current) URL.revokeObjectURL(u);
    },
    [],
  );

  if (still === false) return false;
  return still && still.mediaId === mediaId ? still : null;
}

/** Average color (hex) of a 5×5 patch at fractional position (fx, fy) of a loaded image. */
export function pickColor(img: HTMLImageElement, fx: number, fy: number): string {
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = 5;
  c.height = 5;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx || !W || !H) return '#00ff00';
  const sx = clamp(Math.round(fx * W) - 2, 0, Math.max(0, W - 5));
  const sy = clamp(Math.round(fy * H) - 2, 0, Math.max(0, H - 5));
  ctx.drawImage(img, sx, sy, Math.min(5, W), Math.min(5, H), 0, 0, 5, 5);
  const d = ctx.getImageData(0, 0, 5, 5).data;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < d.length; i += 4) {
    r += d[i];
    g += d[i + 1];
    b += d[i + 2];
  }
  const n = d.length / 4;
  const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// ---------------------------------------------------------------------------
// Crop geometry (fractions of the source cut away from each side)

type Corner = 'tl' | 'tr' | 'bl' | 'br';
const CORNERS: Corner[] = ['tl', 'tr', 'bl', 'br'];
const MIN = 0.05;
/** room around the image so the corner handles stay inside the stage */
const INSET = 24;

/** The crop as seen on screen when the clip is flipped. Mirroring is its own inverse, so this converts both ways. */
function mirror(c: Crop, flipH: boolean, flipV: boolean): Crop {
  return {
    l: flipH ? c.r : c.l,
    r: flipH ? c.l : c.r,
    t: flipV ? c.b : c.t,
    b: flipV ? c.t : c.b,
  };
}

const q = (v: number) => Math.round(clamp(v, 0, 1) * 10000) / 10000;
const tidy = (c: Crop): Crop => ({ l: q(c.l), t: q(c.t), r: q(c.r), b: q(c.b) });
const sameCrop = (a: Crop, b: Crop) => a.l === b.l && a.t === b.t && a.r === b.r && a.b === b.b;

function moveBy(c: Crop, dx: number, dy: number): Crop {
  const sx = c.l + c.r;
  const sy = c.t + c.b;
  const l = clamp(c.l + dx, 0, sx);
  const t = clamp(c.t + dy, 0, sy);
  return { l, r: sx - l, t, b: sy - t };
}

/** Drags one corner, keeping the opposite corner fixed (and the pixel aspect `ratio` when set). */
function resize(c: Crop, corner: Corner, dx: number, dy: number, ratio: number | null, W: number, H: number): Crop {
  const sx = corner === 'tr' || corner === 'br' ? 1 : -1;
  const sy = corner === 'bl' || corner === 'br' ? 1 : -1;
  const ax = sx > 0 ? c.l : 1 - c.r;
  const ay = sy > 0 ? c.t : 1 - c.b;
  const mx = sx > 0 ? 1 - c.r : c.l;
  const my = sy > 0 ? 1 - c.b : c.t;
  const maxW = sx > 0 ? 1 - ax : ax;
  const maxH = sy > 0 ? 1 - ay : ay;
  let w = sx * (mx + dx - ax);
  let h = sy * (my + dy - ay);
  if (ratio) {
    // height (as a fraction) per unit of width that keeps the ratio
    const k = W / (ratio * H);
    if (w * k >= h) h = w * k;
    else w = h / k;
    if (w < MIN) [w, h] = [MIN, MIN * k];
    if (h < MIN) [w, h] = [MIN / k, MIN];
    if (w > maxW) [w, h] = [maxW, maxW * k];
    if (h > maxH) [w, h] = [maxH / k, maxH];
  } else {
    w = clamp(w, MIN, maxW);
    h = clamp(h, MIN, maxH);
  }
  const l = sx > 0 ? ax : ax - w;
  const t = sy > 0 ? ay : ay - h;
  return { l, t, r: 1 - l - w, b: 1 - t - h };
}

/** The largest box with the given pixel aspect, centered where the current crop is. */
function fitRatio(c: Crop, ratio: number, W: number, H: number): Crop {
  let w = 1;
  let h = W / (ratio * H);
  if (h > 1) {
    h = 1;
    w = (ratio * H) / W;
  }
  const cx = (c.l + 1 - c.r) / 2;
  const cy = (c.t + 1 - c.b) / 2;
  const l = clamp(cx - w / 2, 0, 1 - w);
  const t = clamp(cy - h / 2, 0, 1 - h);
  return { l, t, r: 1 - l - w, b: 1 - t - h };
}

const RATIOS: { id: string; label: string; value: (W: number, H: number) => number | null }[] = [
  { id: 'free', label: 'Free', value: () => null },
  { id: 'original', label: 'Original', value: (W, H) => W / H },
  ...ASPECTS.map((a) => ({ id: a.id, label: a.id, value: () => a.w / a.h })),
];

export function CropSheet({ item, onClose }: { item: Media; onClose: () => void }) {
  const id = item.id;
  const still = useSourceStill(item);
  const asset = getAsset(item.mediaId);
  const W = still ? still.w : asset?.width || 1;
  const H = still ? still.h : asset?.height || 1;
  const [ratioId, setRatioId] = useState('free');
  const ratio = (RATIOS.find((r) => r.id === ratioId) ?? RATIOS[0]).value(W, H);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; mode: Corner | 'move'; x0: number; y0: number; c0: Crop } | null>(null);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setStage((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const c = mirror(item.crop, item.flipH, item.flipV);
  const scale = stage.w > 0 ? Math.max(0, Math.min((stage.w - 2 * INSET) / W, (stage.h - 2 * INSET) / H)) : 0;
  const dw = W * scale;
  const dh = H * scale;
  const cropped = c.l + c.t + c.r + c.b > 1e-4;
  const outW = Math.round((asset?.width || W) * (1 - c.l - c.r));
  const outH = Math.round((asset?.height || H) * (1 - c.t - c.b));

  const write = (next: Crop, merge?: string) =>
    updateItem<Media>(
      id,
      (it) => {
        const src = tidy(mirror(next, it.flipH, it.flipV));
        if (!sameCrop(src, it.crop)) it.crop = src;
      },
      merge,
    );

  const down = (mode: Corner | 'move') => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button > 0 || drag.current || !dw) return;
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    useEditor.getState().beginGesture();
    drag.current = { id: e.pointerId, mode, x0: e.clientX, y0: e.clientY, c0: c };
    setDragging(true);
  };

  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = (e.clientX - d.x0) / dw;
    const dy = (e.clientY - d.y0) / dh;
    write(d.mode === 'move' ? moveBy(d.c0, dx, dy) : resize(d.c0, d.mode, dx, dy, ratio, W, H));
  };

  const up = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    useEditor.getState().endGesture();
  };

  const onKey = (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    e.stopPropagation();
    write(moveBy(c, dx, dy), `crop:${id}`);
  };

  const pickRatio = (rid: string) => {
    setRatioId(rid);
    const r = (RATIOS.find((x) => x.id === rid) ?? RATIOS[0]).value(W, H);
    if (r) write(fitRatio(c, r, W, H));
  };

  const reset = () => {
    setRatioId('free');
    write({ l: 0, t: 0, r: 0, b: 0 });
  };

  const flip = item.flipH || item.flipV ? { transform: `scale(${item.flipH ? -1 : 1}, ${item.flipV ? -1 : 1})` } : undefined;

  return (
    <Sheet
      title="Crop"
      tall
      onClose={onClose}
      actions={
        <button className="icon-btn" aria-label="Reset crop" disabled={!cropped} onClick={reset}>
          <RotateCcw size={20} />
        </button>
      }
    >
      <div className="crop-stage" ref={stageRef}>
        {still === false ? (
          <p className="note">Couldn’t load this clip.</p>
        ) : still && dw > 0 ? (
          <div className="crop-img" style={{ width: dw, height: dh }}>
            <img src={still.url} alt="" draggable={false} style={flip} />
            <div
              className="crop-box"
              role="group"
              tabIndex={0}
              aria-label="Crop area. Drag inside to move it, drag a corner to resize, or use the arrow keys."
              data-drag={dragging}
              style={{ left: `${c.l * 100}%`, top: `${c.t * 100}%`, right: `${c.r * 100}%`, bottom: `${c.b * 100}%` }}
              onPointerDown={down('move')}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
              onKeyDown={onKey}
            >
              {CORNERS.map((k) => (
                <span
                  key={k}
                  className={`h ${k}`}
                  aria-hidden
                  style={{ left: k[1] === 'l' ? 0 : '100%', top: k[0] === 't' ? 0 : '100%' }}
                  onPointerDown={down(k)}
                />
              ))}
            </div>
          </div>
        ) : (
          <LoaderCircle className="spin" size={28} aria-label="Loading" />
        )}
      </div>
      <div className="chips" role="group" aria-label="Aspect ratio">
        {RATIOS.map((r) => (
          <button key={r.id} className="chip" aria-pressed={ratioId === r.id} onClick={() => pickRatio(r.id)}>
            {r.label}
          </button>
        ))}
      </div>
      <p className="note tnum">
        {outW} × {outH} px. Drag a corner to crop, or drag inside the box to move it.
      </p>
    </Sheet>
  );
}
