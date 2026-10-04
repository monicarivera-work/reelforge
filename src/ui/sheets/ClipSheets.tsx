/**
 * Sheets that edit one clip: speed, volume, animation, filters, adjust, motion, mask, opacity,
 * green screen, color and transitions.
 */
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Ban,
  Blend,
  ChevronsDown,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUp,
  Circle,
  Droplets,
  Keyboard,
  LoaderCircle,
  Moon,
  Pipette,
  RotateCcw,
  RotateCw,
  Sparkles,
  SquareRoundCorner,
  Sun,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type {
  Adjust,
  AnimType,
  AudioItem,
  AudioProps,
  BlendMode,
  ColorItem,
  ImageItem,
  Item,
  MainItem,
  MaskShape,
  Motion,
  Project,
  TransitionType,
  VideoItem,
  Visual,
  VisualItem,
} from '../../types';
import { Compositor, type DrawLayer } from '../../engine/gl';
import { DEFAULT_ADJUST } from '../../lib/defaults';
import { ADJUST_DEFS, computeFx, FILTERS } from '../../lib/filters';
import { haptic } from '../../lib/haptics';
import { findItem, itemEnd, pickLane, setSpeed, transitionOverlap } from '../../lib/layout';
import { ensureThumbs, getAsset, getImage, getThumbStrip, makeCanvas } from '../../lib/media';
import { clamp, formatDuration, nextFrame } from '../../lib/util';
import { duration, getEngine, now, pause, seek } from '../../state/runtime';
import { toast, useEditor, useTime } from '../../state/store';
import { currentPose, writePose } from '../actions';
import { gesture, Segmented, Sheet, Slider, Swatches, Toggle, updateItem } from '../common';
import { pickColor, stillTime, useSourceStill } from './CropSheet';

type Media = VideoItem | ImageItem;

const ed = () => useEditor.getState();

/** The item as it is in the store right now. */
function liveItem<T extends Item>(id: string): T | null {
  const p = ed().project;
  return p ? ((findItem(p, id)?.item as T | undefined) ?? null) : null;
}

function useIsMain(id: string): boolean {
  return useEditor((s) => !!s.project?.main.some((m) => m.id === id));
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const secs = (v: number) => `${v.toFixed(1)}s`;
const off = (f: (v: number) => string) => (v: number) => (v <= 0 ? 'Off' : f(v));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Runs fn on every main-track clip in one undoable edit; fn returns whether it changed the clip. */
function forMain(fn: (m: MainItem, index: number) => boolean): number {
  let n = 0;
  ed().apply((d) => {
    (d as Project).main.forEach((m, i) => {
      if (fn(m, i)) n++;
    });
  });
  return n;
}

function appliedToast(n: number, what: string, noun = 'clip') {
  if (n) toast(`${what} applied to ${plural(n, `other ${noun}`)}`, 'success');
  else toast(`Every ${noun} already matches`);
}

// ---------------------------------------------------------------------------
// Previews: play the part of the timeline an edit affects, then park the playhead.

let stopPreview: (() => void) | null = null;

/** Plays [from, to] once, then pauses at `rest`. Call straight from a tap so playback can start on iOS. */
function previewRange(from: number, to: number, rest = to) {
  stopPreview?.();
  const eng = getEngine();
  if (!eng) return;
  from = Math.max(0, from);
  to = Math.min(to, duration());
  if (to - from < 0.05) return;
  pause();
  seek(from);
  eng.play();
  if (!eng.playing) return;
  let unsub: (() => void) | null = null;
  const stop = () => {
    unsub?.();
    unsub = null;
    if (stopPreview === stop) stopPreview = null;
  };
  stopPreview = stop;
  unsub = useTime.subscribe((s) => {
    // Paused or moved elsewhere by the user: leave playback alone.
    if (!s.playing || s.time < from - 0.25 || s.time > to + 0.3) stop();
    else if (s.time >= to) {
      stop();
      pause();
      seek(rest);
    }
  });
}

// ---------------------------------------------------------------------------
// Shared bits

interface TileOption<T extends string> {
  id: T;
  name: string;
  Icon: LucideIcon;
}

/** Scrolls the pressed option of a horizontal list into view when the sheet opens. */
function useRevealPressed() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, []);
  return ref;
}

function OptionTiles<T extends string>({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: TileOption<T>[];
  value: T;
  onPick: (v: T) => void;
}) {
  const ref = useRevealPressed();
  return (
    <div className="tiles row" role="group" aria-label={label} ref={ref}>
      {options.map((o) => (
        <button key={o.id} className="tile" aria-pressed={o.id === value} onClick={() => onPick(o.id)}>
          <o.Icon size={22} aria-hidden />
          {o.name}
        </button>
      ))}
    </div>
  );
}

function Changed({ on, text = 'changed' }: { on: boolean; text?: string }) {
  if (!on) return null;
  return (
    <>
      <i className="dot" aria-hidden />
      <span className="sr-only">, {text}</span>
    </>
  );
}

// ---------------------------------------------------------------------------
// Speed

const SPEED_CHIPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
const fmtSpeed = (v: number) => `${Number(v.toFixed(2))}×`;

export function SpeedSheet({ item, onClose }: { item: VideoItem | AudioItem; onClose: () => void }) {
  const id = item.id;
  const sound = item.type === 'audio' || getAsset(item.mediaId)?.hasAudio !== false;

  const set = (v: number) => {
    const s = ed();
    const cur = liveItem<VideoItem | AudioItem>(id);
    if (!cur || (!s.gestureBase && Math.abs(cur.speed - v) < 1e-6)) return;
    // During a drag every step starts from the clip as it was, so its length doesn't drift.
    const base = s.gestureBase ? (findItem(s.gestureBase, id)?.item as VideoItem | AudioItem | undefined) : undefined;
    s.apply((d) => {
      const p = d as Project;
      const f = findItem(p, id);
      if (!f || (f.item.type !== 'video' && f.item.type !== 'audio')) return;
      const it = f.item;
      if (base) {
        it.speed = base.speed;
        it.duration = base.duration;
        if (it.type === 'video' && base.type === 'video') it.keyframes = base.keyframes.map((k) => ({ ...k }));
      }
      setSpeed(p, id, v, getAsset(it.mediaId));
      if (f.kind !== 'main') {
        // A longer clip may now run into the next one on its row.
        it.lane = pickLane(p[f.kind] as Item[], it.start, itemEnd(it), id, base?.lane ?? it.lane);
      }
    });
  };

  return (
    <Sheet title="Speed" onClose={onClose}>
      <div className="big-value" aria-hidden>
        {fmtSpeed(item.speed)}
      </div>
      <Slider
        label="Speed"
        hideLabel
        value={item.speed}
        min={0.1}
        max={10}
        step={0.01}
        scale="log"
        snaps={[0.25, 0.5, 1, 2, 4]}
        format={fmtSpeed}
        onChange={set}
        {...gesture}
      />
      <div className="chips" role="group" aria-label="Speed presets">
        {SPEED_CHIPS.map((v) => (
          <button key={v} className="chip" aria-pressed={Math.abs(item.speed - v) < 0.005} onClick={() => set(v)}>
            {fmtSpeed(v)}
          </button>
        ))}
      </div>
      <div className="stat-row">
        <span>Clip length</span>
        <span>{formatDuration(item.duration)}</span>
      </div>
      {sound && <p className="note">Faster sound plays higher and slower sound plays lower.</p>}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Volume

export function VolumeSheet({ item, onClose }: { item: VideoItem | AudioItem; onClose: () => void }) {
  const id = item.id;
  const isMain = useIsMain(id);

  if (item.type === 'video' && getAsset(item.mediaId)?.hasAudio === false) {
    return (
      <Sheet title="Volume" onClose={onClose}>
        <p className="note">This clip has no sound.</p>
      </Sheet>
    );
  }

  const set = (patch: Partial<AudioProps>) =>
    updateItem<VideoItem | AudioItem>(id, (it) => {
      Object.assign(it, patch);
    });
  const maxFade = Math.max(0.1, Math.min(5, item.duration / 2));

  const applyAll = () => {
    const { volume, muted } = item;
    const n = forMain((m) => {
      if (m.type !== 'video' || m.id === id || (m.volume === volume && m.muted === muted)) return false;
      m.volume = volume;
      m.muted = muted;
      return true;
    });
    appliedToast(n, 'Volume');
  };

  return (
    <Sheet title="Volume" onClose={onClose}>
      <Toggle label="Mute" checked={item.muted} onChange={(muted) => set({ muted })} />
      <Slider
        label="Volume"
        value={item.muted ? 0 : item.volume}
        min={0}
        max={2}
        step={0.01}
        snaps={[1]}
        format={(v) => (v <= 0 ? 'Muted' : pct(v))}
        onChange={(v) => set({ volume: v, muted: false })}
        {...gesture}
      />
      <Slider
        label="Fade in"
        value={Math.min(item.fadeIn, maxFade)}
        min={0}
        max={maxFade}
        step={0.1}
        format={off(secs)}
        onChange={(v) => set({ fadeIn: v })}
        {...gesture}
      />
      <Slider
        label="Fade out"
        value={Math.min(item.fadeOut, maxFade)}
        min={0}
        max={maxFade}
        step={0.1}
        format={off(secs)}
        onChange={(v) => set({ fadeOut: v })}
        {...gesture}
      />
      {isMain && item.type === 'video' && (
        <button className="secondary-btn block" onClick={applyAll}>
          Apply volume to all clips
        </button>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Animation

let animSide: 'in' | 'out' = 'in';
let animAllCaptions = true;

const ANIMS: TileOption<AnimType>[] = [
  { id: 'none', name: 'None', Icon: Ban },
  { id: 'fade', name: 'Fade', Icon: Blend },
  { id: 'zoomIn', name: 'Zoom in', Icon: ZoomIn },
  { id: 'zoomOut', name: 'Zoom out', Icon: ZoomOut },
  { id: 'slideUp', name: 'Slide up', Icon: ArrowUp },
  { id: 'slideDown', name: 'Slide down', Icon: ArrowDown },
  { id: 'slideLeft', name: 'Slide left', Icon: ArrowLeft },
  { id: 'slideRight', name: 'Slide right', Icon: ArrowRight },
  { id: 'pop', name: 'Pop', Icon: Sparkles },
  { id: 'spin', name: 'Spin', Icon: RotateCw },
  { id: 'typewriter', name: 'Typewriter', Icon: Keyboard },
];

const animMax = (it: { duration: number }) => Math.max(0.2, Math.min(3, it.duration));

export function AnimationSheet({ item, onClose }: { item: VisualItem; onClose: () => void }) {
  const id = item.id;
  const caption = item.type === 'text' && !!item.caption;
  const [side, setSideState] = useState(animSide);
  const [all, setAllState] = useState(animAllCaptions);
  const every = caption && all;
  const key = side === 'in' ? 'animIn' : 'animOut';
  const anim = item[key];
  const max = animMax(item);
  const options = item.type === 'text' ? ANIMS : ANIMS.filter((a) => a.id !== 'typewriter');

  const setSide = (s: 'in' | 'out') => {
    animSide = s;
    setSideState(s);
  };
  const setAll = (v: boolean) => {
    animAllCaptions = v;
    setAllState(v);
  };

  const targets = (p: Project): VisualItem[] => {
    if (every) return p.texts.filter((t) => t.caption);
    const f = findItem(p, id);
    return f && f.item.type !== 'audio' ? [f.item] : [];
  };

  const preview = () => {
    const it = liveItem<VisualItem>(id);
    if (!it) return;
    const end = itemEnd(it);
    const a = it[key];
    const d = a.type === 'none' ? 0 : Math.min(a.duration, it.duration);
    if (side === 'in') previewRange(it.start, Math.min(end, it.start + d + 0.4));
    else {
      const from = Math.max(it.start, end - d - 0.6);
      previewRange(from, end - 0.02, from);
    }
  };

  const pick = (type: AnimType) => {
    ed().apply((d) => {
      for (const t of targets(d as Project)) {
        const cur = t[key];
        if (cur.type === type) continue;
        const m = animMax(t);
        let dur: number;
        if (type === 'typewriter' && t.type === 'text') dur = clamp([...t.text].length * 0.05, 0.3, m);
        else if (cur.type === 'none' || cur.type === 'typewriter') dur = Math.min(0.5, m);
        else dur = clamp(cur.duration, 0.1, m);
        t[key] = { type, duration: dur };
      }
    });
    if (type !== 'none') preview();
  };

  const setDur = (v: number) =>
    ed().apply((d) => {
      for (const t of targets(d as Project)) {
        const cur = t[key];
        const dur = Math.min(v, animMax(t));
        if (cur.type !== 'none' && cur.duration !== dur) t[key] = { ...cur, duration: dur };
      }
    });

  return (
    <Sheet title={every ? 'Caption animation' : 'Animation'} onClose={onClose}>
      <Segmented
        label="Animation"
        value={side}
        onChange={setSide}
        options={[
          {
            value: 'in',
            label: (
              <>
                In
                <Changed on={item.animIn.type !== 'none'} text="on" />
              </>
            ),
          },
          {
            value: 'out',
            label: (
              <>
                Out
                <Changed on={item.animOut.type !== 'none'} text="on" />
              </>
            ),
          },
        ]}
      />
      <OptionTiles key={side} label={side === 'in' ? 'In animation' : 'Out animation'} options={options} value={anim.type} onPick={pick} />
      <Slider
        label="Duration"
        value={clamp(anim.duration, 0.1, max)}
        min={0.1}
        max={max}
        step={0.1}
        format={secs}
        disabled={anim.type === 'none'}
        onChange={setDur}
        onStart={gesture.onStart}
        onEnd={() => {
          gesture.onEnd();
          preview();
        }}
      />
      {caption && <Toggle label="Apply to all captions" checked={all} onChange={setAll} />}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Filters

const FILTER_PX = 120;
/** filter previews per media frame (mediaId@second) */
const filterCache = new Map<string, Record<string, string>>();

/** A small square frame of the clip to render the filter previews from. */
async function filterSource(item: Media, srcT: number): Promise<HTMLCanvasElement | null> {
  let src: CanvasImageSource | null = null;
  let sw = 0;
  let sh = 0;
  if (item.type === 'image') {
    const img = await getImage(item.mediaId);
    src = img;
    sw = img.width;
    sh = img.height;
  } else {
    await ensureThumbs(item.mediaId);
    const strip = getThumbStrip(item.mediaId);
    const n = strip?.images.length ?? 0;
    if (strip && n) {
      const i0 = clamp(Math.round((srcT - 0.02) / strip.interval), 0, n - 1);
      for (let k = 0; k < n && !src; k++) {
        const near = strip.images[i0 - k] ?? strip.images[i0 + k];
        if (near) {
          src = near;
          sw = near.width;
          sh = near.height;
        }
      }
    }
  }
  if (!src || !sw || !sh) return null;
  const c = makeCanvas(FILTER_PX, FILTER_PX);
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, FILTER_PX, FILTER_PX);
  const s = Math.max(FILTER_PX / sw, FILTER_PX / sh);
  ctx.drawImage(src, (FILTER_PX - sw * s) / 2, (FILTER_PX - sh * s) / 2, sw * s, sh * s);
  return c;
}

/** Thumbnails of the clip with each filter applied (null until ready, or if the device can't render them). */
function useFilterPreviews(item: Media): Record<string, string> | null {
  const [srcT] = useState(() => stillTime(item));
  const key = `${item.mediaId}@${Math.round(srcT)}`;
  const [previews, setPreviews] = useState(() => filterCache.get(key) ?? null);
  const itemRef = useRef(item);
  itemRef.current = item;

  useEffect(() => {
    if (filterCache.has(key)) return;
    let alive = true;
    void (async () => {
      let comp: Compositor | null = null;
      try {
        await nextFrame();
        const src = alive ? await filterSource(itemRef.current, srcT) : null;
        if (!src || !alive) return;
        const canvas = makeCanvas(FILTER_PX, FILTER_PX);
        comp = new Compositor(canvas, { preserve: true });
        const out: Record<string, string> = {};
        for (let i = 0; i < FILTERS.length; i++) {
          const f = FILTERS[i];
          const layer: DrawLayer = {
            tex: { key: 'src', source: src, version: 1 },
            color: [1, 1, 1],
            cx: FILTER_PX / 2,
            cy: FILTER_PX / 2,
            w: FILTER_PX,
            h: FILTER_PX,
            rot: 0,
            uv: [0, 0, 1, 1],
            opacity: 1,
            blend: 'normal',
            fx: computeFx({ filter: f.id, filterAmount: 1, adjust: DEFAULT_ADJUST }),
            mask: null,
            chroma: null,
          };
          comp.render({
            width: FILTER_PX,
            height: FILTER_PX,
            clear: [0, 0, 0],
            pages: [{ background: null, layers: [layer] }],
            transition: null,
            layers: [],
            seed: 7,
          });
          out[f.id] = canvas.toDataURL('image/jpeg', 0.85);
          // Keep the sheet's opening animation smooth.
          if (i % 5 === 4) {
            await nextFrame();
            if (!alive) return;
          }
        }
        filterCache.set(key, out);
        if (filterCache.size > 6) filterCache.delete(filterCache.keys().next().value!);
        if (alive) setPreviews(out);
      } catch (e) {
        console.warn('Filter previews unavailable', e);
      } finally {
        comp?.dispose();
      }
    })();
    return () => {
      alive = false;
    };
  }, [key, srcT]);

  return previews;
}

export function FiltersSheet({ item, onClose }: { item: Media; onClose: () => void }) {
  const id = item.id;
  const isMain = useIsMain(id);
  const previews = useFilterPreviews(item);
  const tilesRef = useRevealPressed();

  const pick = (filter: string) =>
    updateItem<Media>(id, (it) => {
      it.filter = filter;
      if (filter !== 'none' && it.filterAmount < 0.05) it.filterAmount = 1;
    });

  const applyAll = () => {
    const { filter, filterAmount } = item;
    const n = forMain((m) => {
      if (m.id === id || m.type === 'color' || (m.filter === filter && m.filterAmount === filterAmount)) return false;
      m.filter = filter;
      m.filterAmount = filterAmount;
      return true;
    });
    appliedToast(n, 'Filter');
  };

  return (
    <Sheet title="Filters" onClose={onClose}>
      <div className="tiles row" role="group" aria-label="Filter" ref={tilesRef}>
        {FILTERS.map((f) => (
          <button key={f.id} className="tile filter-tile" aria-pressed={item.filter === f.id} onClick={() => pick(f.id)}>
            {previews?.[f.id] ? <img src={previews[f.id]} alt="" /> : <span className="swatch" style={{ background: f.swatch }} />}
            {f.name}
          </button>
        ))}
      </div>
      <Slider
        label="Strength"
        value={item.filterAmount}
        min={0}
        max={1}
        step={0.01}
        format={pct}
        disabled={item.filter === 'none'}
        onChange={(v) =>
          updateItem<Media>(id, (it) => {
            it.filterAmount = v;
          })
        }
        {...gesture}
      />
      {isMain && (
        <button className="secondary-btn block" onClick={applyAll}>
          Apply to all clips
        </button>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Adjust

let adjustKey: keyof Adjust = 'brightness';

const isAdjusted = (a: Adjust) => ADJUST_DEFS.some((d) => Math.abs(a[d.key]) > 1e-4);

export function AdjustSheet({ item, onClose }: { item: Media; onClose: () => void }) {
  const id = item.id;
  const isMain = useIsMain(id);
  const [k, setKState] = useState(adjustKey);
  const chipsRef = useRevealPressed();
  const def = ADJUST_DEFS.find((d) => d.key === k) ?? ADJUST_DEFS[0];
  const bipolar = def.min < 0;

  const setK = (key: keyof Adjust) => {
    adjustKey = key;
    setKState(key);
  };

  const set = (v: number) =>
    updateItem<Media>(id, (it) => {
      if (it.adjust[def.key] === v) return;
      const a = { ...it.adjust };
      a[def.key] = v;
      it.adjust = a;
    });

  const reset = () =>
    updateItem<Media>(id, (it) => {
      if (isAdjusted(it.adjust)) it.adjust = { ...DEFAULT_ADJUST };
    });

  const applyAll = () => {
    const a = item.adjust;
    const n = forMain((m) => {
      if (m.id === id || m.type === 'color' || ADJUST_DEFS.every((d) => m.adjust[d.key] === a[d.key])) return false;
      m.adjust = { ...a };
      return true;
    });
    appliedToast(n, 'Adjustments');
  };

  const fmt = (v: number) => {
    const n = Math.round(v * 100);
    return bipolar && n > 0 ? `+${n}` : String(n);
  };

  return (
    <Sheet
      title="Adjust"
      onClose={onClose}
      actions={
        <button className="icon-btn" aria-label="Reset adjustments" disabled={!isAdjusted(item.adjust)} onClick={reset}>
          <RotateCcw size={20} />
        </button>
      }
    >
      <div className="chips" role="group" aria-label="Adjustment" ref={chipsRef}>
        {ADJUST_DEFS.map((d) => (
          <button key={d.key} className="chip" aria-pressed={k === d.key} onClick={() => setK(d.key)}>
            {d.label}
            <Changed on={Math.abs(item.adjust[d.key]) > 1e-4} />
          </button>
        ))}
      </div>
      <Slider
        key={def.key}
        label={def.label}
        value={item.adjust[def.key]}
        min={def.min}
        max={def.max}
        step={0.01}
        origin={0}
        snaps={bipolar ? [0] : undefined}
        format={fmt}
        onChange={set}
        {...gesture}
      />
      {isMain && (
        <button className="secondary-btn block" onClick={applyAll}>
          Apply to all clips
        </button>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Motion (slow zoom / pan across the whole clip)

const MOTIONS: TileOption<Motion>[] = [
  { id: 'none', name: 'None', Icon: Ban },
  { id: 'zoomIn', name: 'Zoom in', Icon: ZoomIn },
  { id: 'zoomOut', name: 'Zoom out', Icon: ZoomOut },
  { id: 'panLeft', name: 'Pan left', Icon: ArrowLeft },
  { id: 'panRight', name: 'Pan right', Icon: ArrowRight },
  { id: 'panUp', name: 'Pan up', Icon: ArrowUp },
  { id: 'panDown', name: 'Pan down', Icon: ArrowDown },
];

export function MotionSheet({ item, onClose }: { item: Media; onClose: () => void }) {
  const id = item.id;
  const isMain = useIsMain(id);

  const pick = (motion: Motion) => {
    updateItem<Media>(id, (it) => {
      it.motion = motion;
    });
    const it = liveItem<Media>(id);
    if (it && motion !== 'none') previewRange(it.start, Math.min(itemEnd(it), it.start + 4), it.start);
  };

  const applyAll = () => {
    const { motion } = item;
    const n = forMain((m) => {
      if (m.type !== 'image' || m.id === id || m.motion === motion) return false;
      m.motion = motion;
      return true;
    });
    appliedToast(n, 'Motion', 'photo');
  };

  return (
    <Sheet title="Motion" onClose={onClose}>
      <OptionTiles label="Motion" options={MOTIONS} value={item.motion} onPick={pick} />
      <p className="note">Slowly zooms or pans across the whole clip. Great for photos.</p>
      {isMain && item.type === 'image' && (
        <button className="secondary-btn block" onClick={applyAll}>
          Apply to all photos
        </button>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Mask

const MASKS: TileOption<MaskShape>[] = [
  { id: 'none', name: 'None', Icon: Ban },
  { id: 'circle', name: 'Circle', Icon: Circle },
  { id: 'rounded', name: 'Rounded', Icon: SquareRoundCorner },
];

export function MaskSheet({ item, onClose }: { item: VisualItem; onClose: () => void }) {
  const id = item.id;
  const mask = item.mask;

  const set = (patch: Partial<Visual['mask']>) =>
    updateItem<VisualItem>(id, (it) => {
      const next = { ...it.mask, ...patch };
      if (next.shape !== it.mask.shape || next.radius !== it.mask.radius || next.feather !== it.mask.feather) it.mask = next;
    });

  return (
    <Sheet title="Mask" onClose={onClose}>
      <OptionTiles label="Shape" options={MASKS} value={mask.shape} onPick={(shape) => set({ shape })} />
      {mask.shape === 'rounded' && (
        <Slider
          label="Corner radius"
          value={mask.radius}
          min={0.02}
          max={0.5}
          step={0.01}
          format={(v) => pct(v * 2)}
          onChange={(radius) => set({ radius })}
          {...gesture}
        />
      )}
      <Slider
        label="Soft edge"
        value={mask.feather}
        min={0}
        max={0.25}
        step={0.005}
        format={off((v) => pct(v * 4))}
        disabled={mask.shape === 'none'}
        onChange={(feather) => set({ feather })}
        {...gesture}
      />
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Opacity and blend

const BLENDS: { value: BlendMode; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'screen', label: 'Screen' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'add', label: 'Add' },
];

const BLEND_HINTS: Record<BlendMode, string> = {
  normal: 'Shows the layer as it is.',
  screen: 'Hides dark areas. Great for light leaks, flares and fire shot on black.',
  multiply: 'Hides light areas. Great for shadows and textures on white.',
  add: 'Brightens what’s underneath. Great for glows and sparkles.',
};

export function OpacitySheet({ item, onClose }: { item: VisualItem; onClose: () => void }) {
  const id = item.id;
  const isMain = useIsMain(id);
  const keyed = item.keyframes.length > 0;
  // Keyframed opacity changes over time, so follow the playhead.
  const time = useTime((s) => (keyed ? s.time : 0));
  const fps = useEditor((s) => s.project?.fps ?? 30);
  const value = currentPose(item, clamp(time - item.start, 0, item.duration)).opacity;

  const set = (v: number) => {
    const s = ed();
    // Each drag step is computed from the clip as it was when the drag began.
    const base = (s.gestureBase ? findItem(s.gestureBase, id)?.item : null) ?? liveItem(id);
    if (!base || base.type === 'audio') return;
    const local = clamp(now() - base.start, 0, base.duration);
    s.apply((d) => {
      const f = findItem(d as Project, id);
      if (f && f.item.type !== 'audio') writePose(f.item, base, local, { ...currentPose(base, local), opacity: v }, fps);
    });
  };

  return (
    <Sheet title={isMain ? 'Opacity' : 'Opacity and blend'} onClose={onClose}>
      <Slider label="Opacity" value={value} min={0} max={1} step={0.01} format={pct} onChange={set} {...gesture} />
      {keyed && <p className="note">This clip has keyframes, so opacity is set at the playhead.</p>}
      {!isMain && (
        <>
          <Segmented
            label="Blend"
            value={item.blend}
            options={BLENDS}
            onChange={(blend) =>
              updateItem<VisualItem>(id, (it) => {
                it.blend = blend;
              })
            }
          />
          <p className="note">{BLEND_HINTS[item.blend]}</p>
        </>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Green screen (chroma key)

const KEY_COLORS = ['#00ff00', '#00b140', '#0047bb', '#0000ff'];

export function ChromaSheet({ item, onClose }: { item: Media; onClose: () => void }) {
  const id = item.id;
  const isMain = useIsMain(id);
  const ch = item.chroma;
  const [picking, setPicking] = useState(false);
  const still = useSourceStill(item, picking);

  const set = (patch: Partial<Visual['chroma']>, merge?: string) =>
    updateItem<Media>(
      id,
      (it) => {
        const c = it.chroma;
        const next = { ...c, ...patch };
        if (next.enabled !== c.enabled || next.color !== c.color || next.similarity !== c.similarity || next.smoothness !== c.smoothness) {
          it.chroma = next;
        }
      },
      merge,
    );

  const onPick = (e: ReactMouseEvent<HTMLButtonElement>) => {
    const img = e.currentTarget.querySelector('img');
    if (!img?.complete || !img.naturalWidth) return;
    let fx = 0.02;
    let fy = 0.02;
    // A pointer tap picks where it lands; the keyboard picks the top-left corner (usually backdrop).
    if (e.detail !== 0) {
      const r = img.getBoundingClientRect();
      fx = (e.clientX - r.left) / r.width;
      fy = (e.clientY - r.top) / r.height;
      if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
    }
    set({ color: pickColor(img, fx, fy), enabled: true });
    setPicking(false);
    haptic('light');
  };

  return (
    <Sheet title="Green screen" onClose={onClose}>
      <Toggle label="Remove background color" checked={ch.enabled} onChange={(enabled) => set({ enabled })} />
      <Swatches
        label="Color to remove"
        colors={KEY_COLORS}
        value={ch.color}
        onChange={(color) => set({ color, enabled: true }, `chroma-color:${id}`)}
      />
      <button className="secondary-btn block" aria-expanded={picking} onClick={() => setPicking(!picking)}>
        <Pipette size={18} aria-hidden />
        {picking ? 'Cancel' : 'Pick color from clip'}
      </button>
      {picking &&
        (still === false ? (
          <p className="note">Couldn’t load a frame from this clip.</p>
        ) : still ? (
          <button className="chroma-still" aria-label="Tap the background color to remove" onClick={onPick}>
            <img src={still.url} alt="" draggable={false} />
          </button>
        ) : (
          <div className="chroma-still">
            <LoaderCircle className="spin" size={24} aria-label="Loading" />
          </div>
        ))}
      <Slider
        label="Strength"
        value={ch.similarity}
        min={0.05}
        max={1}
        step={0.01}
        format={pct}
        disabled={!ch.enabled}
        onChange={(similarity) => set({ similarity })}
        {...gesture}
      />
      <Slider
        label="Edge softness"
        value={ch.smoothness}
        min={0}
        max={0.4}
        step={0.01}
        format={off((v) => pct(v / 0.4))}
        disabled={!ch.enabled}
        onChange={(smoothness) => set({ smoothness })}
        {...gesture}
      />
      {isMain && (
        <p className="note">To show another video behind this one, add it as an overlay on top of your main video instead.</p>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Solid color clips

export function ColorSheet({ item, onClose }: { item: ColorItem; onClose: () => void }) {
  const id = item.id;
  return (
    <Sheet title="Color" onClose={onClose}>
      <Swatches
        label="Clip color"
        value={item.color}
        onChange={(color) =>
          updateItem<ColorItem>(
            id,
            (it) => {
              it.color = color;
            },
            `color:${id}`,
          )
        }
      />
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Transitions (between this main-track clip and the one before it)

const TRANSITIONS: TileOption<TransitionType>[] = [
  { id: 'none', name: 'None', Icon: Ban },
  { id: 'fade', name: 'Dissolve', Icon: Blend },
  { id: 'black', name: 'Fade black', Icon: Moon },
  { id: 'white', name: 'Flash', Icon: Sun },
  { id: 'slideLeft', name: 'Slide left', Icon: ArrowLeft },
  { id: 'slideRight', name: 'Slide right', Icon: ArrowRight },
  { id: 'slideUp', name: 'Slide up', Icon: ArrowUp },
  { id: 'slideDown', name: 'Slide down', Icon: ArrowDown },
  { id: 'wipeLeft', name: 'Wipe left', Icon: ChevronsLeft },
  { id: 'wipeRight', name: 'Wipe right', Icon: ChevronsRight },
  { id: 'wipeUp', name: 'Wipe up', Icon: ChevronsUp },
  { id: 'wipeDown', name: 'Wipe down', Icon: ChevronsDown },
  { id: 'zoomIn', name: 'Zoom in', Icon: ZoomIn },
  { id: 'zoomOut', name: 'Zoom out', Icon: ZoomOut },
  { id: 'spin', name: 'Spin', Icon: RotateCw },
  { id: 'circle', name: 'Circle', Icon: Circle },
  { id: 'blur', name: 'Blur', Icon: Droplets },
];

export function TransitionSheet({ item, onClose }: { item: MainItem; onClose: () => void }) {
  const id = item.id;
  const prevDur = useEditor((s) => {
    const main = s.project?.main ?? [];
    const i = main.findIndex((m) => m.id === id);
    return i > 0 ? main[i - 1].duration : 0;
  });
  const count = useEditor((s) => s.project?.main.length ?? 0);
  const tr = item.transition ?? { type: 'none' as TransitionType, duration: 0.5 };
  const maxDur = Math.max(0.2, Math.min(2, prevDur / 2, item.duration / 2));

  const preview = () => {
    const p = ed().project;
    const i = p ? p.main.findIndex((m) => m.id === id) : -1;
    if (!p || i < 1) return;
    const cur = p.main[i];
    const overlap = transitionOverlap(p.main[i - 1], cur);
    previewRange(cur.start - 0.6, cur.start + overlap + 0.6, cur.start + overlap / 2);
  };

  const pick = (type: TransitionType) => {
    updateItem<MainItem>(id, (it) => {
      if (type === 'none') {
        if (it.transition) delete it.transition;
      } else if (it.transition?.type !== type) {
        it.transition = { type, duration: clamp(it.transition?.duration ?? 0.5, 0.1, maxDur) };
      }
    });
    if (type !== 'none') preview();
  };

  const applyAll = () => {
    const t = liveItem<MainItem>(id)?.transition;
    const n = forMain((m, i) => {
      if (i < 1 || m.id === id) return false;
      if (!t) {
        if (!m.transition) return false;
        delete m.transition;
        return true;
      }
      if (m.transition?.type === t.type && m.transition.duration === t.duration) return false;
      m.transition = { ...t };
      return true;
    });
    if (!n) toast('Every cut already matches');
    else toast(t ? 'Transition added between all clips' : 'All transitions removed', 'success');
  };

  return (
    <Sheet title="Transition" onClose={onClose}>
      <OptionTiles label="Transition" options={TRANSITIONS} value={tr.type} onPick={pick} />
      <Slider
        label="Duration"
        value={clamp(tr.duration, 0.1, maxDur)}
        min={0.1}
        max={maxDur}
        step={0.1}
        format={secs}
        disabled={tr.type === 'none'}
        onChange={(v) =>
          updateItem<MainItem>(id, (it) => {
            if (it.transition && it.transition.duration !== v) it.transition = { ...it.transition, duration: v };
          })
        }
        onStart={gesture.onStart}
        onEnd={() => {
          gesture.onEnd();
          preview();
        }}
      />
      {count > 2 && (
        <button className="secondary-btn block" onClick={applyAll}>
          Apply to all clips
        </button>
      )}
    </Sheet>
  );
}
