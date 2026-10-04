import type {
  Adjust,
  Aspect,
  AudioItem,
  ColorItem,
  ImageItem,
  MediaAsset,
  Project,
  TextItem,
  TextStyle,
  VideoItem,
  Visual,
} from '../types';
import { uid } from './util';

export const DEFAULT_ADJUST: Adjust = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  exposure: 0,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  fade: 0,
  vignette: 0,
  grain: 0,
  sharpen: 0,
};

export function defaultVisual(fit: 'fit' | 'fill' = 'fit', scale = 1): Visual {
  return {
    transform: { x: 0, y: 0, scale, rotation: 0 },
    opacity: 1,
    flipH: false,
    flipV: false,
    fit,
    crop: { l: 0, t: 0, r: 0, b: 0 },
    filter: 'none',
    filterAmount: 1,
    adjust: { ...DEFAULT_ADJUST },
    animIn: { type: 'none', duration: 0.5 },
    animOut: { type: 'none', duration: 0.5 },
    motion: 'none',
    keyframes: [],
    blend: 'normal',
    mask: { shape: 'none', radius: 0.18, feather: 0.01 },
    chroma: { enabled: false, color: '#00ff00', similarity: 0.4, smoothness: 0.08 },
  };
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  font: 'Montserrat',
  weight: 800,
  italic: false,
  size: 0.075,
  color: '#ffffff',
  align: 'center',
  stroke: '#000000',
  strokeWidth: 0,
  bg: '#000000',
  bgOpacity: 0,
  bgRadius: 0.25,
  shadow: '#000000',
  shadowBlur: 0.12,
  uppercase: false,
  letterSpacing: 0,
  lineHeight: 1.15,
  maxWidth: 0.86,
  highlight: '#ffe14d',
  highlightOn: false,
};

export function newProject(name: string, aspect: Aspect = '9:16'): Project {
  const now = Date.now();
  return {
    id: uid('p_'),
    name,
    createdAt: now,
    updatedAt: now,
    version: 1,
    aspect,
    fps: 30,
    background: { mode: 'blur', color: '#000000', blur: 0.6 },
    main: [],
    overlays: [],
    texts: [],
    audios: [],
  };
}

export function videoItem(asset: MediaAsset, start = 0, overlay = false): VideoItem {
  return {
    id: uid('v_'),
    type: 'video',
    mediaId: asset.id,
    start,
    duration: Math.max(0.1, asset.duration),
    lane: 0,
    in: 0,
    speed: 1,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    ...defaultVisual('fit', overlay ? 0.55 : 1),
  };
}

export function imageItem(asset: MediaAsset, start = 0, duration = 3, overlay = false): ImageItem {
  return {
    id: uid('i_'),
    type: 'image',
    mediaId: asset.id,
    start,
    duration,
    lane: 0,
    ...defaultVisual('fit', overlay ? 0.55 : 1),
  };
}

export function colorItem(color: string, start = 0, duration = 3, overlay = false): ColorItem {
  return {
    id: uid('c_'),
    type: 'color',
    color,
    start,
    duration,
    lane: 0,
    ...defaultVisual('fill', overlay ? 0.5 : 1),
  };
}

export function textItem(text: string, start: number, duration: number, style?: Partial<TextStyle>): TextItem {
  return {
    id: uid('t_'),
    type: 'text',
    text,
    start,
    duration,
    lane: 0,
    style: { ...DEFAULT_TEXT_STYLE, ...style },
    ...defaultVisual('fit', 1),
  };
}

export function audioItem(asset: MediaAsset, start: number, role: AudioItem['role'], name?: string): AudioItem {
  return {
    id: uid('a_'),
    type: 'audio',
    mediaId: asset.id,
    start,
    duration: Math.max(0.1, asset.duration),
    lane: 0,
    in: 0,
    speed: 1,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    role,
    name: name ?? asset.name,
  };
}

/** Picks the preset aspect closest to the given media dimensions. */
export function aspectFor(width: number, height: number): Aspect {
  if (!width || !height) return '9:16';
  const r = width / height;
  const options: [Aspect, number][] = [
    ['9:16', 9 / 16],
    ['3:4', 3 / 4],
    ['4:5', 4 / 5],
    ['1:1', 1],
    ['4:3', 4 / 3],
    ['16:9', 16 / 9],
    ['21:9', 21 / 9],
  ];
  let best = options[0];
  for (const o of options) if (Math.abs(Math.log(o[1] / r)) < Math.abs(Math.log(best[1] / r))) best = o;
  return best[0];
}
