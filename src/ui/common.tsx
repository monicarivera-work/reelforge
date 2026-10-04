import { Check, X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Draft } from 'immer';
import type { Item, Project } from '../types';
import { useBack } from '../lib/back';
import { haptic } from '../lib/haptics';
import { findItem } from '../lib/layout';
import { clamp } from '../lib/util';
import { selectedItem, toast, useEditor } from '../state/store';

// ---------------------------------------------------------------------------
// Store helpers

/** The selected item with its track, or null. Stable between unrelated store updates. */
export function useSelected() {
  return useEditor(
    useShallow((s) => {
      const f = selectedItem(s);
      return f ? { item: f.item, kind: f.kind, index: f.index } : { item: null, kind: null, index: -1 };
    }),
  );
}

/** Mutates one item in an undoable edit. */
export function updateItem<T extends Item = Item>(id: string, fn: (it: Draft<T>, p: Draft<Project>) => void, merge?: string) {
  useEditor.getState().apply(
    (p) => {
      const f = findItem(p as Project, id);
      if (f) fn(f.item as Draft<T>, p);
    },
    merge ? { merge } : undefined,
  );
}

/** Slider callbacks that turn a whole drag into a single undo step. */
export const gesture = {
  onStart: () => useEditor.getState().beginGesture(),
  onEnd: () => useEditor.getState().endGesture(),
};

// ---------------------------------------------------------------------------
// Sheet

interface SheetProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** tall modal sheet with a scrim (export, captions); otherwise a compact panel over the tools */
  tall?: boolean;
  /** when set, closing is blocked and this message is shown instead */
  busy?: string | false | null;
  /** extra header buttons before the close button */
  actions?: ReactNode;
  closeIcon?: 'check' | 'x';
  bodyClassName?: string;
}

export function Sheet({ title, onClose, children, tall, busy, actions, closeIcon = 'check', bodyClassName }: SheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const state = useRef({ busy, onClose });
  state.current = { busy, onClose };

  const tryClose = (): boolean => {
    const { busy: b, onClose: close } = state.current;
    if (b) {
      toast(b);
      return false;
    }
    close();
    return true;
  };

  useBack(true, () => (tryClose() ? undefined : false));

  useEffect(() => {
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, []);

  return (
    <>
      {tall && <div className="scrim" aria-hidden onClick={() => tryClose()} />}
      <div
        ref={ref}
        className={`sheet${tall ? ' tall' : ''}`}
        role="dialog"
        aria-modal={tall ? true : undefined}
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="sheet-head">
          <h2 id={titleId}>{title}</h2>
          {actions}
          <button
            className="icon-btn"
            aria-label={closeIcon === 'check' ? 'Done' : 'Close'}
            onClick={() => tryClose()}
          >
            {closeIcon === 'check' ? <Check size={22} /> : <X size={22} />}
          </button>
        </div>
        <div className={`sheet-body${bodyClassName ? ` ${bodyClassName}` : ''}`}>{children}</div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Slider

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  /** value quantum (linear) or keyboard step */
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  onStart?: () => void;
  onEnd?: () => void;
  /** values the thumb sticks to (with a tick on the track) */
  snaps?: number[];
  scale?: 'linear' | 'log';
  /** the fill starts here (e.g. 0 for a -1..1 slider); defaults to min */
  origin?: number;
  disabled?: boolean;
  hideLabel?: boolean;
}

export function Slider(props: SliderProps) {
  const { label, value, min, max, format, snaps, disabled, hideLabel } = props;
  const p = useRef(props);
  p.current = props;
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x0: number; y0: number; dragging: boolean; last: number; snap: number | null } | null>(null);

  const toPos = (v: number) => {
    const { min: a, max: b, scale } = p.current;
    if (scale === 'log') return Math.log(v / a) / Math.log(b / a);
    return (v - a) / (b - a);
  };
  const fromPos = (pos: number) => {
    const { min: a, max: b, scale, step } = p.current;
    pos = clamp(pos, 0, 1);
    let v = scale === 'log' ? a * Math.pow(b / a, pos) : a + (b - a) * pos;
    const q = step ?? (scale === 'log' ? 0.01 : (b - a) / 200);
    v = Math.round(v / q) * q;
    return clamp(Number(v.toFixed(6)), a, b);
  };

  const emit = (v: number) => {
    const d = drag.current;
    if (d && d.last === v) return;
    if (d) d.last = v;
    p.current.onChange(v);
  };

  const fromClient = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    const pos = (clientX - r.left) / Math.max(1, r.width);
    let v = fromPos(pos);
    const d = drag.current;
    let snapped: number | null = null;
    for (const s of p.current.snaps ?? []) {
      if (Math.abs(toPos(s) - clamp(pos, 0, 1)) < 0.025) {
        v = s;
        snapped = s;
        break;
      }
    }
    if (d) {
      if (snapped !== null && d.snap !== snapped) haptic('light');
      d.snap = snapped;
    }
    return v;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button > 0) return;
    drag.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dragging: false, last: NaN, snap: null };
    if (e.pointerType === 'mouse') begin(e);
  };

  const begin = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current!;
    d.dragging = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    p.current.onStart?.();
    emit(fromClient(e.clientX));
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.dragging) {
      const dx = e.clientX - d.x0;
      const dy = e.clientY - d.y0;
      if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) begin(e);
      return;
    }
    emit(fromClient(e.clientX));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (d.dragging) {
      drag.current = null;
      p.current.onEnd?.();
      return;
    }
    if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 10) {
      // tap: jump to the position
      p.current.onStart?.();
      emit(fromClient(e.clientX));
      p.current.onEnd?.();
    }
    drag.current = null;
  };

  const onPointerCancel = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.dragging) p.current.onEnd?.();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const { step, scale, min: a, max: b } = p.current;
    const linStep = step ?? (b - a) / 100;
    let next: number | null = null;
    const nudge = (n: number) =>
      scale === 'log' ? fromPos(toPos(value) + n * 0.02) : clamp(Number((value + n * linStep).toFixed(6)), a, b);
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = nudge(1);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        next = nudge(-1);
        break;
      case 'PageUp':
        next = nudge(10);
        break;
      case 'PageDown':
        next = nudge(-10);
        break;
      case 'Home':
        next = a;
        break;
      case 'End':
        next = b;
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (next !== value) {
      p.current.onStart?.();
      p.current.onChange(next);
      p.current.onEnd?.();
    }
  };

  const pos = clamp(toPos(value), 0, 1);
  const o = clamp(toPos(props.origin ?? min), 0, 1);
  const text = format ? format(value) : String(value);

  return (
    <div>
      {!hideLabel && (
        <div className="field-label" aria-hidden>
          <span>{label}</span>
          <b>{text}</b>
        </div>
      )}
      <div
        className="slider"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={text}
        aria-disabled={disabled || undefined}
        style={{ opacity: disabled ? 0.38 : 1, touchAction: 'pan-y' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onKeyDown={onKeyDown}
      >
        <div className="slider-track" ref={trackRef}>
          <div className="slider-fill" style={{ left: `${Math.min(o, pos) * 100}%`, width: `${Math.abs(pos - o) * 100}%` }} />
          {snaps?.map((s) => (
            <div key={s} className="slider-mark" style={{ left: `${clamp(toPos(s), 0, 1) * 100}%` }} />
          ))}
          <div className="slider-thumb" style={{ left: `${pos * 100}%` }} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small controls

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const PALETTE = [
  '#ffffff',
  '#000000',
  '#8e8e93',
  '#ff3d6e',
  '#ff3b30',
  '#ff8a00',
  '#ffe14d',
  '#33c98a',
  '#00c7be',
  '#00b2ff',
  '#3f6bff',
  '#a67cff',
  '#ff7ad9',
  '#7a4a2b',
];

export function Swatches({
  value,
  onChange,
  label,
  colors = PALETTE,
}: {
  value: string;
  onChange: (c: string) => void;
  label: string;
  colors?: string[];
}) {
  const v = value.toLowerCase();
  const custom = !colors.some((c) => c.toLowerCase() === v);
  return (
    <div className="swatches" role="group" aria-label={label}>
      {colors.map((c) => (
        <button key={c} className="swatch-btn" aria-pressed={c.toLowerCase() === v} aria-label={colorName(c)} onClick={() => onChange(c)}>
          <i style={{ background: c }} />
        </button>
      ))}
      <label className="swatch-btn" data-on={custom}>
        <i className="custom" style={custom ? { background: value } : undefined} />
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff'} aria-label="Custom color" onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
  );
}

const NAMES: Record<string, string> = {
  '#ffffff': 'White',
  '#000000': 'Black',
  '#8e8e93': 'Gray',
  '#ff3d6e': 'Pink',
  '#ff3b30': 'Red',
  '#ff8a00': 'Orange',
  '#ffe14d': 'Yellow',
  '#33c98a': 'Green',
  '#00c7be': 'Teal',
  '#00b2ff': 'Sky blue',
  '#3f6bff': 'Blue',
  '#a67cff': 'Purple',
  '#ff7ad9': 'Rose',
  '#7a4a2b': 'Brown',
  '#00ff00': 'Bright green',
  '#00b140': 'Green screen',
  '#0047bb': 'Blue screen',
  '#0000ff': 'Bright blue',
};
export const colorName = (c: string) => NAMES[c.toLowerCase()] ?? c;

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button className="toggle-row" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}>
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <i className="switch" aria-hidden />
    </button>
  );
}

export function Progress({ value, label }: { value: number | null; label?: string }) {
  return (
    <div
      className={`progress${value === null ? ' indeterminate' : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.round(clamp(value, 0, 1) * 100)}
    >
      <i style={value === null ? undefined : { transform: `scaleX(${clamp(value, 0, 1)})` }} />
    </div>
  );
}

/** Persists small option objects (export/caption settings) in localStorage. */
export function loadPrefs<T extends object>(key: string, defaults: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return { ...defaults, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    /* private mode or corrupt */
  }
  return { ...defaults };
}

export function savePrefs(key: string, v: object) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}
