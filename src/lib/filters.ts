import type { Adjust, Visual } from '../types';
import { DEFAULT_ADJUST } from './defaults';

export interface FxParams extends Adjust {
  sepia: number;
  splitShadow: [number, number, number];
  splitHighlight: [number, number, number];
  splitAmount: number;
}

export const ADJUST_KEYS = Object.keys(DEFAULT_ADJUST) as (keyof Adjust)[];

export const ADJUST_DEFS: { key: keyof Adjust; label: string; min: number; max: number }[] = [
  { key: 'brightness', label: 'Brightness', min: -1, max: 1 },
  { key: 'contrast', label: 'Contrast', min: -1, max: 1 },
  { key: 'saturation', label: 'Saturation', min: -1, max: 1 },
  { key: 'exposure', label: 'Exposure', min: -1, max: 1 },
  { key: 'temperature', label: 'Temperature', min: -1, max: 1 },
  { key: 'tint', label: 'Tint', min: -1, max: 1 },
  { key: 'highlights', label: 'Highlights', min: -1, max: 1 },
  { key: 'shadows', label: 'Shadows', min: -1, max: 1 },
  { key: 'fade', label: 'Fade', min: 0, max: 1 },
  { key: 'vignette', label: 'Vignette', min: 0, max: 1 },
  { key: 'grain', label: 'Grain', min: 0, max: 1 },
  { key: 'sharpen', label: 'Sharpen', min: 0, max: 1 },
];

export interface FilterDef {
  id: string;
  name: string;
  params: Partial<FxParams>;
  swatch: string;
}

export const FILTERS: FilterDef[] = [
  { id: 'none', name: 'None', params: {}, swatch: 'linear-gradient(135deg,#3a3a44,#202027)' },
  { id: 'vivid', name: 'Vivid', params: { saturation: 0.35, contrast: 0.15 }, swatch: 'linear-gradient(135deg,#ff4d6d,#ffd23f)' },
  { id: 'punch', name: 'Punch', params: { contrast: 0.35, saturation: 0.4, sharpen: 0.35 }, swatch: 'linear-gradient(135deg,#ff006e,#3a86ff)' },
  { id: 'bright', name: 'Bright', params: { exposure: 0.22, shadows: 0.25, contrast: -0.05 }, swatch: 'linear-gradient(135deg,#fff3b0,#ffd6a5)' },
  { id: 'warm', name: 'Warm', params: { temperature: 0.45, saturation: 0.1 }, swatch: 'linear-gradient(135deg,#ff9e00,#ff5400)' },
  { id: 'golden', name: 'Golden', params: { temperature: 0.6, tint: -0.1, saturation: 0.2, highlights: -0.15 }, swatch: 'linear-gradient(135deg,#f9c74f,#f3722c)' },
  { id: 'cool', name: 'Cool', params: { temperature: -0.45, tint: 0.05 }, swatch: 'linear-gradient(135deg,#48cae4,#0077b6)' },
  {
    id: 'teal',
    name: 'Teal & Orange',
    params: { contrast: 0.15, splitShadow: [0.05, 0.45, 0.5], splitHighlight: [1, 0.6, 0.3], splitAmount: 0.45 },
    swatch: 'linear-gradient(135deg,#0a9396,#ee9b00)',
  },
  {
    id: 'cinema',
    name: 'Cinema',
    params: { contrast: 0.2, saturation: -0.1, splitShadow: [0.1, 0.3, 0.45], splitHighlight: [1, 0.75, 0.5], splitAmount: 0.3, vignette: 0.35 },
    swatch: 'linear-gradient(135deg,#1d3557,#e9c46a)',
  },
  { id: 'moody', name: 'Moody', params: { exposure: -0.15, contrast: 0.25, saturation: -0.3, temperature: -0.15, shadows: -0.2, vignette: 0.4 }, swatch: 'linear-gradient(135deg,#22223b,#4a4e69)' },
  { id: 'film', name: 'Film', params: { fade: 0.25, grain: 0.3, saturation: -0.15, temperature: 0.1, contrast: 0.1 }, swatch: 'linear-gradient(135deg,#bc6c25,#606c38)' },
  { id: 'vintage', name: 'Vintage', params: { sepia: 0.45, fade: 0.35, contrast: -0.1, grain: 0.25, vignette: 0.3 }, swatch: 'linear-gradient(135deg,#d4a373,#7f5539)' },
  { id: 'faded', name: 'Faded', params: { fade: 0.5, saturation: -0.25, contrast: -0.15 }, swatch: 'linear-gradient(135deg,#cdb4db,#a2d2ff)' },
  { id: 'pastel', name: 'Pastel', params: { saturation: -0.3, brightness: 0.08, fade: 0.25, tint: 0.1 }, swatch: 'linear-gradient(135deg,#ffc8dd,#bde0fe)' },
  { id: 'dreamy', name: 'Dreamy', params: { brightness: 0.1, contrast: -0.2, saturation: 0.1, fade: 0.2, tint: 0.15 }, swatch: 'linear-gradient(135deg,#e0aaff,#ffafcc)' },
  {
    id: 'sunset',
    name: 'Sunset',
    params: { temperature: 0.3, splitShadow: [0.5, 0.1, 0.45], splitHighlight: [1, 0.55, 0.2], splitAmount: 0.45 },
    swatch: 'linear-gradient(135deg,#7209b7,#f77f00)',
  },
  {
    id: 'cyber',
    name: 'Cyberpunk',
    params: { saturation: 0.3, contrast: 0.2, splitShadow: [0.25, 0, 0.65], splitHighlight: [0, 0.9, 1], splitAmount: 0.5 },
    swatch: 'linear-gradient(135deg,#7400b8,#00f5d4)',
  },
  { id: 'forest', name: 'Forest', params: { tint: -0.25, saturation: 0.1, temperature: -0.05, shadows: 0.1 }, swatch: 'linear-gradient(135deg,#2d6a4f,#95d5b2)' },
  { id: 'mono', name: 'B&W', params: { saturation: -1, contrast: 0.2 }, swatch: 'linear-gradient(135deg,#f8f9fa,#212529)' },
  { id: 'noir', name: 'Noir', params: { saturation: -1, contrast: 0.45, vignette: 0.5, exposure: -0.1 }, swatch: 'linear-gradient(135deg,#6c757d,#000)' },
];

export function computeFx(v: Pick<Visual, 'filter' | 'filterAmount' | 'adjust'>): FxParams | null {
  const def = FILTERS.find((f) => f.id === v.filter);
  const a = def && def.id !== 'none' ? v.filterAmount : 0;
  let any = false;
  const out = {
    sepia: (def?.params.sepia ?? 0) * a,
    splitShadow: def?.params.splitShadow ?? [0.5, 0.5, 0.5],
    splitHighlight: def?.params.splitHighlight ?? [0.5, 0.5, 0.5],
    splitAmount: (def?.params.splitAmount ?? 0) * a,
  } as FxParams;
  for (const k of ADJUST_KEYS) {
    const val = (def?.params[k] ?? 0) * a + (v.adjust?.[k] ?? 0);
    out[k] = val;
    if (Math.abs(val) > 1e-4) any = true;
  }
  if (out.sepia > 1e-4 || out.splitAmount > 1e-4) any = true;
  return any ? out : null;
}
