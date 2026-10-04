import type { TextStyle, Word } from '../types';
import { rgba } from './util';

export const FONTS: { family: string; weights: number[] }[] = [
  { family: 'Montserrat', weights: [600, 800, 900] },
  { family: 'Inter', weights: [400, 600, 800] },
  { family: 'Poppins', weights: [500, 700, 900] },
  { family: 'Anton', weights: [400] },
  { family: 'Bebas Neue', weights: [400] },
  { family: 'Oswald', weights: [500, 700] },
  { family: 'Bangers', weights: [400] },
  { family: 'Permanent Marker', weights: [400] },
  { family: 'Pacifico', weights: [400] },
  { family: 'Lobster', weights: [400] },
  { family: 'Playfair Display', weights: [700, 900] },
  { family: 'Roboto Mono', weights: [500, 700] },
];

export function closestWeight(family: string, weight: number): number {
  const f = FONTS.find((x) => x.family === family);
  if (!f) return weight;
  return f.weights.reduce((a, b) => (Math.abs(b - weight) < Math.abs(a - weight) ? b : a), f.weights[0]);
}

export function fontCss(style: Pick<TextStyle, 'font' | 'weight' | 'italic'>, px: number): string {
  const w = closestWeight(style.font, style.weight);
  return `${style.italic ? 'italic ' : ''}${w} ${px.toFixed(2)}px "${style.font}", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
}

const loadedFonts = new Set<string>();
const loadingFonts = new Map<string, Promise<void>>();
export const fontEvents = new EventTarget();

export function ensureFont(family: string, weight: number, italic = false): Promise<void> {
  const w = closestWeight(family, weight);
  const key = `${italic ? 'i' : 'n'} ${w} ${family}`;
  if (loadedFonts.has(key)) return Promise.resolve();
  let p = loadingFonts.get(key);
  if (!p) {
    p = (async () => {
      try {
        await document.fonts.load(`${italic ? 'italic ' : ''}${w} 40px "${family}"`);
      } catch {
        /* fall back to system font */
      }
      loadedFonts.add(key);
      fontEvents.dispatchEvent(new Event('loaded'));
    })();
    loadingFonts.set(key, p);
  }
  return p;
}

export function isFontReady(family: string, weight: number, italic = false): boolean {
  const key = `${italic ? 'i' : 'n'} ${closestWeight(family, weight)} ${family}`;
  if (loadedFonts.has(key)) return true;
  void ensureFont(family, weight, italic);
  return false;
}

export const TEXT_PRESETS: { id: string; name: string; style: Partial<TextStyle> }[] = [
  { id: 'classic', name: 'Classic', style: { font: 'Montserrat', weight: 800, color: '#ffffff', shadowBlur: 0.12, strokeWidth: 0, bgOpacity: 0 } },
  { id: 'outline', name: 'Outline', style: { font: 'Montserrat', weight: 900, color: '#ffffff', stroke: '#000000', strokeWidth: 0.09, shadowBlur: 0, bgOpacity: 0 } },
  { id: 'box', name: 'Box', style: { font: 'Inter', weight: 800, color: '#111111', bg: '#ffffff', bgOpacity: 1, bgRadius: 0.25, strokeWidth: 0, shadowBlur: 0 } },
  { id: 'subtitle', name: 'Subtitle', style: { font: 'Inter', weight: 600, color: '#ffffff', bg: '#000000', bgOpacity: 0.6, bgRadius: 0.2, strokeWidth: 0, shadowBlur: 0, size: 0.055 } },
  { id: 'yellow', name: 'Bold Yellow', style: { font: 'Anton', weight: 400, color: '#ffe14d', stroke: '#000000', strokeWidth: 0.08, uppercase: true, shadowBlur: 0, bgOpacity: 0 } },
  { id: 'headline', name: 'Headline', style: { font: 'Bebas Neue', weight: 400, color: '#ffffff', size: 0.12, shadowBlur: 0.15, strokeWidth: 0, bgOpacity: 0, letterSpacing: 0.03 } },
  { id: 'neon', name: 'Neon', style: { font: 'Montserrat', weight: 800, color: '#ffe3fa', shadow: '#ff2bd6', shadowBlur: 0.55, strokeWidth: 0, bgOpacity: 0 } },
  { id: 'comic', name: 'Comic', style: { font: 'Bangers', weight: 400, color: '#ffd60a', stroke: '#000000', strokeWidth: 0.1, shadowBlur: 0.1, bgOpacity: 0, letterSpacing: 0.03 } },
  { id: 'marker', name: 'Marker', style: { font: 'Permanent Marker', weight: 400, color: '#ffffff', shadowBlur: 0.15, strokeWidth: 0, bgOpacity: 0 } },
  { id: 'script', name: 'Script', style: { font: 'Pacifico', weight: 400, color: '#ffffff', shadowBlur: 0.18, strokeWidth: 0, bgOpacity: 0 } },
  { id: 'elegant', name: 'Elegant', style: { font: 'Playfair Display', weight: 700, italic: true, color: '#ffffff', shadowBlur: 0.12, strokeWidth: 0, bgOpacity: 0 } },
  { id: 'retro', name: 'Retro', style: { font: 'Lobster', weight: 400, color: '#ff6b6b', stroke: '#ffffff', strokeWidth: 0.06, shadowBlur: 0, bgOpacity: 0 } },
  { id: 'terminal', name: 'Terminal', style: { font: 'Roboto Mono', weight: 700, color: '#00ff9c', bg: '#000000', bgOpacity: 0.75, bgRadius: 0.1, strokeWidth: 0, shadowBlur: 0 } },
  { id: 'pill', name: 'Pill', style: { font: 'Poppins', weight: 900, color: '#ffffff', bg: '#ff3d6e', bgOpacity: 1, bgRadius: 0.5, strokeWidth: 0, shadowBlur: 0 } },
  { id: 'condensed', name: 'Condensed', style: { font: 'Oswald', weight: 700, color: '#ffffff', uppercase: true, stroke: '#000000', strokeWidth: 0.05, shadowBlur: 0, bgOpacity: 0 } },
];

export const CAPTION_PRESETS: { id: string; name: string; style: Partial<TextStyle> }[] = [
  { id: 'bold', name: 'Bold Pop', style: { font: 'Montserrat', weight: 900, uppercase: true, color: '#ffffff', stroke: '#000000', strokeWidth: 0.11, shadowBlur: 0, bgOpacity: 0, highlight: '#ffe14d', highlightOn: true, size: 0.07 } },
  { id: 'hype', name: 'Hype', style: { font: 'Anton', weight: 400, uppercase: true, color: '#ffffff', stroke: '#000000', strokeWidth: 0.09, shadowBlur: 0, bgOpacity: 0, highlight: '#3dff6e', highlightOn: true, size: 0.08 } },
  { id: 'karaoke', name: 'Karaoke', style: { font: 'Poppins', weight: 900, color: '#ffffff', shadowBlur: 0.18, strokeWidth: 0, bgOpacity: 0, highlight: '#ff3d6e', highlightOn: true, size: 0.065 } },
  { id: 'clean', name: 'Clean', style: { font: 'Inter', weight: 700, color: '#ffffff', bg: '#000000', bgOpacity: 0.55, bgRadius: 0.2, strokeWidth: 0, shadowBlur: 0, highlightOn: false, size: 0.05 } },
  { id: 'minimal', name: 'Minimal', style: { font: 'Inter', weight: 600, color: '#ffffff', shadowBlur: 0.2, strokeWidth: 0, bgOpacity: 0, highlightOn: false, size: 0.05 } },
  { id: 'comic', name: 'Comic', style: { font: 'Bangers', weight: 400, color: '#ffffff', stroke: '#000000', strokeWidth: 0.1, shadowBlur: 0, bgOpacity: 0, highlight: '#ffd60a', highlightOn: true, size: 0.075, letterSpacing: 0.03 } },
];

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface TextRenderOpts {
  text: string;
  style: TextStyle;
  fontPx: number;
  wrapPx: number;
  words?: Word[];
  activeWord?: number;
  visibleChars?: number;
}

interface Token {
  text: string;
  w: number;
  word: number;
}

const MAX_TEX = 4096;

function setSpacing(ctx: Ctx2D, px: number) {
  const c = ctx as Ctx2D & { letterSpacing?: string };
  if ('letterSpacing' in c) c.letterSpacing = `${px.toFixed(2)}px`;
}

function layout(ctx: Ctx2D, o: TextRenderOpts, fontPx: number) {
  const s = o.style;
  ctx.font = fontCss(s, fontPx);
  setSpacing(ctx, s.letterSpacing * fontPx);
  const raw = s.uppercase ? o.text.toUpperCase() : o.text;
  const space = ctx.measureText(' ').width;
  const lines: { tokens: Token[]; w: number }[] = [];
  let word = 0;
  for (const para of raw.split('\n')) {
    const parts = para.split(/\s+/).filter(Boolean);
    let cur: Token[] = [];
    let w = 0;
    for (const p of parts) {
      const tw = ctx.measureText(p).width;
      if (cur.length && w + space + tw > o.wrapPx) {
        lines.push({ tokens: cur, w });
        cur = [];
        w = 0;
      }
      w += (cur.length ? space : 0) + tw;
      cur.push({ text: p, w: tw, word: word++ });
    }
    lines.push({ tokens: cur, w });
  }
  return { lines, space, wordCount: word };
}

function roundRectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Draws a text block onto `canvas`, resizing it to fit. Returns the factor by which the
 * canvas must be scaled up when displayed (only > 1 when the texture had to be clamped).
 */
export function renderTextCanvas(canvas: HTMLCanvasElement | OffscreenCanvas, o: TextRenderOpts): number {
  const ctx = canvas.getContext('2d') as Ctx2D;
  const s = o.style;
  let fontPx = Math.max(4, o.fontPx);
  let wrapPx = o.wrapPx;
  let upscale = 1;
  let L = layout(ctx, { ...o, wrapPx }, fontPx);
  const measure = (fp: number, lines: typeof L.lines) => {
    const lineH = fp * s.lineHeight;
    const strokePx = s.strokeWidth * fp;
    const shadowPad = s.shadowBlur > 0 ? s.shadowBlur * fp * 1.6 + fp * 0.06 : 0;
    const hasBox = s.bgOpacity > 0.001;
    const boxX = hasBox ? fp * 0.32 : 0;
    const boxY = hasBox ? fp * 0.1 : 0;
    const margin = Math.ceil(strokePx + shadowPad + 3);
    const maxW = Math.max(1, ...lines.map((l) => l.w));
    return {
      lineH,
      strokePx,
      hasBox,
      boxX,
      boxY,
      margin,
      maxW,
      cw: Math.ceil(maxW + 2 * boxX + 2 * margin),
      ch: Math.ceil(lines.length * lineH + 2 * boxY + 2 * margin),
    };
  };
  let M = measure(fontPx, L.lines);
  const big = Math.max(M.cw, M.ch);
  if (big > MAX_TEX) {
    const k = MAX_TEX / big;
    fontPx *= k;
    wrapPx *= k;
    upscale = 1 / k;
    L = layout(ctx, { ...o, wrapPx }, fontPx);
    M = measure(fontPx, L.lines);
  }
  if (canvas.width !== M.cw || canvas.height !== M.ch) {
    canvas.width = M.cw;
    canvas.height = M.ch;
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  ctx.font = fontCss(s, fontPx);
  setSpacing(ctx, s.letterSpacing * fontPx);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const highlight = s.highlightOn && o.words && o.words.length === L.wordCount ? (o.activeWord ?? -1) : -1;
  const lineX = (w: number) => {
    const inner = M.margin + M.boxX;
    if (s.align === 'left') return inner;
    if (s.align === 'right') return inner + M.maxW - w;
    return inner + (M.maxW - w) / 2;
  };
  const lineY = (i: number) => M.margin + M.boxY + i * M.lineH + M.lineH / 2;

  if (M.hasBox) {
    ctx.beginPath();
    L.lines.forEach((ln, i) => {
      if (!ln.tokens.length) return;
      const x = lineX(ln.w) - M.boxX;
      const cy = lineY(i);
      const h = Math.max(M.lineH, fontPx * 1.2) + 2 * M.boxY;
      roundRectPath(ctx, x, cy - h / 2, ln.w + 2 * M.boxX, h, s.bgRadius * fontPx);
    });
    ctx.fillStyle = rgba(s.bg, s.bgOpacity);
    ctx.fill();
  }

  let budget = o.visibleChars ?? Infinity;
  const pieces: { text: string; x: number; y: number; word: number }[] = [];
  L.lines.forEach((ln, i) => {
    let x = lineX(ln.w);
    const y = lineY(i);
    for (const tk of ln.tokens) {
      if (budget <= 0) return;
      const txt = budget >= tk.text.length ? tk.text : tk.text.slice(0, Math.max(0, Math.floor(budget)));
      budget -= tk.text.length + 1;
      pieces.push({ text: txt, x, y, word: tk.word });
      x += tk.w + L.space;
    }
  });

  const shadowOn = s.shadowBlur > 0.001;
  const applyShadow = (on: boolean) => {
    ctx.shadowColor = on ? rgba(s.shadow, 0.9) : 'transparent';
    ctx.shadowBlur = on ? s.shadowBlur * fontPx : 0;
    ctx.shadowOffsetY = on ? fontPx * 0.04 : 0;
  };

  if (M.strokePx > 0.01) {
    applyShadow(shadowOn);
    ctx.strokeStyle = s.stroke;
    ctx.lineWidth = M.strokePx * 2;
    for (const p of pieces) ctx.strokeText(p.text, p.x, p.y);
    applyShadow(false);
  } else {
    applyShadow(shadowOn);
  }
  for (const p of pieces) {
    ctx.fillStyle = p.word === highlight ? s.highlight : s.color;
    ctx.fillText(p.text, p.x, p.y);
  }
  applyShadow(false);
  return upscale;
}

export function textCharCount(text: string): number {
  return text.replace(/\s+/g, ' ').length;
}
