import type { ClipMeta } from '../types';
import { clamp, formatClock, parseTime } from './util';

/** Shortest clip that can be saved, in seconds. */
export const MIN_CLIP = 0.1;
/** End times typed up to this far past the end of the source snap to the end. */
const END_SLACK = 1;

export type RangeCheck = { ok: true; start: number; end: number } | { ok: false; field: 'start' | 'end'; error: string };

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Checks typed start and end times against a source `duration` seconds long. */
export function checkClipRange(startText: string, endText: string, duration: number): RangeCheck {
  const s = parseTime(startText);
  if (s === null) return { ok: false, field: 'start', error: 'Type a start time like 42.5, or 102.5 for 1:02.5.' };
  const e = parseTime(endText);
  if (e === null) return { ok: false, field: 'end', error: 'Type an end time like 51, or 102.5 for 1:02.5.' };
  const start = round2(s);
  if (start >= duration) return { ok: false, field: 'start', error: `Start must be before the video ends at ${formatClock(duration)}.` };
  if (e > duration + END_SLACK) return { ok: false, field: 'end', error: `End can’t be after the video ends at ${formatClock(duration)}.` };
  const end = Math.min(duration, round2(e));
  if (end <= start) return { ok: false, field: 'end', error: 'End must be after the start.' };
  if (end - start < MIN_CLIP - 1e-6) return { ok: false, field: 'end', error: 'Make the clip at least 0.1 seconds long.' };
  return { ok: true, start, end };
}

// ---------------------------------------------------------------------------
// Crop

/** A crop rectangle as fractions (0–1) of the source frame. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 };

export type CropAspect = 'original' | 'free' | '9:16' | '1:1' | '4:5' | '16:9';

export const CROP_ASPECTS: { id: CropAspect; label: string }[] = [
  { id: 'original', label: 'Original' },
  { id: 'free', label: 'Free' },
  { id: '9:16', label: '9:16' },
  { id: '1:1', label: '1:1' },
  { id: '4:5', label: '4:5' },
  { id: '16:9', label: '16:9' },
];

/** Width / height for a fixed aspect, or null for original and free. */
export function aspectRatio(a: CropAspect): number | null {
  const m = /^(\d+):(\d+)$/.exec(a);
  return m ? Number(m[1]) / Number(m[2]) : null;
}

/** Smallest crop side, as a fraction of the frame. */
const MIN_SIDE = 0.1;

/** The largest centered crop with `ratio` (width / height in pixels) inside a `srcW`×`srcH` frame. */
export function cropForAspect(srcW: number, srcH: number, ratio: number | null): CropRect {
  if (!ratio || srcW <= 0 || srcH <= 0) return { ...FULL_CROP };
  const src = srcW / srcH;
  if (ratio >= src) {
    const h = src / ratio;
    return { x: 0, y: (1 - h) / 2, w: 1, h };
  }
  const w = ratio / src;
  return { x: (1 - w) / 2, y: 0, w, h: 1 };
}

/** Moves a crop by (dx, dy) fractions, keeping it inside the frame. */
export function moveCrop(c: CropRect, dx: number, dy: number): CropRect {
  return { ...c, x: clamp(c.x + dx, 0, 1 - c.w), y: clamp(c.y + dy, 0, 1 - c.h) };
}

/**
 * Drags the bottom-right corner by (dx, dy) fractions. With `ratio` (pixels), the crop keeps that shape;
 * `srcW`/`srcH` turn fractions into pixels for it.
 */
export function resizeCrop(c: CropRect, dx: number, dy: number, ratio: number | null, srcW: number, srcH: number): CropRect {
  let w = clamp(c.w + dx, MIN_SIDE, 1 - c.x);
  let h = clamp(c.h + dy, MIN_SIDE, 1 - c.y);
  if (ratio && srcW > 0 && srcH > 0) {
    // Height as a fraction for a given width fraction at this pixel ratio.
    const k = srcW / srcH / ratio;
    h = w * k;
    if (h > 1 - c.y) {
      h = 1 - c.y;
      w = h / k;
    }
    if (h < MIN_SIDE) {
      h = MIN_SIDE;
      w = h / k;
    }
    if (w < MIN_SIDE) {
      w = MIN_SIDE;
      h = w * k;
    }
  }
  return { ...c, w, h };
}

export function isFullCrop(c: CropRect): boolean {
  return c.x <= 1e-4 && c.y <= 1e-4 && c.w >= 1 - 1e-4 && c.h >= 1 - 1e-4;
}

/** Pixel rectangle for an encoder: even sizes and offsets, inside the frame. */
export function cropPixels(c: CropRect, srcW: number, srcH: number): { left: number; top: number; width: number; height: number } {
  const even = (v: number) => Math.max(2, Math.floor(v / 2) * 2);
  const width = Math.min(even(c.w * srcW), even(srcW));
  const height = Math.min(even(c.h * srcH), even(srcH));
  const left = clamp(Math.floor((c.x * srcW) / 2) * 2, 0, Math.max(0, srcW - width));
  const top = clamp(Math.floor((c.y * srcH) / 2) * 2, 0, Math.max(0, srcH - height));
  return { left, top, width, height };
}

// ---------------------------------------------------------------------------
// Links

const YT_ID = /^[\w-]{11}$/;

/** The video ID in a YouTube link (watch, youtu.be, shorts, embed, live, music) or a bare ID; null otherwise. */
export function parseYouTubeId(text: string): string | null {
  const s = text.trim();
  if (YT_ID.test(s)) return s;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'watch') id = url.searchParams.get('v');
    else if (['shorts', 'embed', 'live', 'v', 'e'].includes(parts[0])) id = parts[1] ?? null;
  }
  return id && YT_ID.test(id) ? id : null;
}

/** Start time in a YouTube link (`t=90`, `t=1m30s`, `start=90`), in seconds. */
export function parseYouTubeStart(text: string): number {
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text.trim()) ? text.trim() : `https://${text.trim()}`);
  } catch {
    return 0;
  }
  const t = url.searchParams.get('t') ?? url.searchParams.get('start');
  if (!t) return 0;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
}

/** Whether text is an http(s) link to a media file ReelForge can open directly. */
export function isDirectMediaUrl(text: string): boolean {
  try {
    const u = new URL(text.trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') && /\.(mp4|m4v|mov|webm|mkv|mp3|m4a|aac|wav|ogg|opus|flac)$/i.test(u.pathname);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Library

export type KindFilter = 'all' | 'video' | 'audio';
/** A folder ID, or `all` / `unfiled`. */
export type FolderFilter = string;

export function filterClips(clips: ClipMeta[], o: { folder: FolderFilter; kind: KindFilter; query: string }): ClipMeta[] {
  const q = o.query.trim().toLowerCase();
  return clips
    .filter((c) => o.folder === 'all' || (o.folder === 'unfiled' ? !c.folderId : c.folderId === o.folder))
    .filter((c) => o.kind === 'all' || c.kind === o.kind)
    .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.source ?? '').toLowerCase().includes(q))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** `base`, or `base 2`, `base 3`… so names stay distinct. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** "1m05s" style stamp for file names (colons aren't allowed in them). */
export function timeStamp(s: number): string {
  const t = Math.round(s * 10) / 10;
  const m = Math.floor(t / 60);
  const sec = t - m * 60;
  const ss = Number.isInteger(sec) ? String(sec) : sec.toFixed(1);
  return m ? `${m}m${sec < 10 ? '0' : ''}${ss}s` : `${ss}s`;
}
