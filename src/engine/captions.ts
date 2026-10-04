import type { AudioItem, Project, TextItem, TextStyle } from '../types';
import { textItem } from '../lib/defaults';
import { itemEnd, pickLane } from '../lib/layout';
import { CAPTION_PRESETS } from '../lib/text';
import { renderMix } from './audio';
import type { CaptionModel, CaptionRequest, CaptionWorkerMessage, RawWord } from './captions.worker';

export type { CaptionModel };

export const CAPTION_MODELS: { id: CaptionModel; name: string; note: string }[] = [
  { id: 'tiny', name: 'Fast', note: '≈ 65 MB one-time download' },
  { id: 'base', name: 'Accurate', note: '≈ 100 MB one-time download' },
];

export const CAPTION_LANGUAGES: [string, string][] = [
  ['auto', 'Auto-detect'],
  ['en', 'English'],
  ['es', 'Spanish'],
  ['pt', 'Portuguese'],
  ['fr', 'French'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['nl', 'Dutch'],
  ['pl', 'Polish'],
  ['tr', 'Turkish'],
  ['ru', 'Russian'],
  ['uk', 'Ukrainian'],
  ['ar', 'Arabic'],
  ['hi', 'Hindi'],
  ['id', 'Indonesian'],
  ['vi', 'Vietnamese'],
  ['th', 'Thai'],
  ['tl', 'Tagalog'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['zh', 'Chinese'],
];

export interface CaptionOptions {
  model: CaptionModel;
  language: string;
  translate: boolean;
  presetId: string;
  /** maximum words per caption */
  maxWords: number;
  includeMusic: boolean;
  /** remove previously generated captions */
  replace: boolean;
}

export const DEFAULT_CAPTION_OPTIONS: CaptionOptions = {
  model: 'tiny',
  language: 'auto',
  translate: false,
  presetId: 'bold',
  maxWords: 4,
  includeMusic: false,
  replace: true,
};

export interface CaptionProgress {
  phase: 'audio' | 'download' | 'transcribe';
  progress: number;
  loaded?: number;
  total?: number;
}

export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

let worker: Worker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function getWorker(): Worker {
  clearTimeout(idleTimer);
  worker ??= new Worker(new URL('./captions.worker.ts', import.meta.url), { type: 'module', name: 'captions' });
  return worker;
}

function killWorker() {
  clearTimeout(idleTimer);
  worker?.terminate();
  worker = null;
}

/** Transcribes the project's voice audio into timed words (project time). */
export async function transcribe(
  p: Project,
  o: CaptionOptions,
  cb: { signal?: AbortSignal; onProgress?: (e: CaptionProgress) => void } = {},
): Promise<TimedWord[]> {
  const { signal, onProgress } = cb;
  const exclude: AudioItem['role'][] = o.includeMusic ? ['sfx'] : ['music', 'sfx'];
  const [audio] = await renderMix(p, 16000, 1, {
    excludeRoles: exclude,
    signal,
    onProgress: (f) => onProgress?.({ phase: 'audio', progress: f }),
  });
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const w = getWorker();
  const raw = await new Promise<RawWord[]>((resolve, reject) => {
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      w.onmessage = null;
      w.onerror = null;
    };
    const onAbort = () => {
      cleanup();
      killWorker();
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    w.onmessage = (e: MessageEvent<CaptionWorkerMessage>) => {
      const m = e.data;
      if (m.type === 'load') onProgress?.({ phase: 'download', progress: m.progress, loaded: m.loaded, total: m.total });
      else if (m.type === 'progress') onProgress?.({ phase: 'transcribe', progress: m.progress });
      else if (m.type === 'result') {
        cleanup();
        resolve(m.words);
      } else if (m.type === 'error') {
        cleanup();
        killWorker();
        reject(new Error(friendlyError(m.message)));
      }
    };
    w.onerror = (e) => {
      cleanup();
      killWorker();
      reject(new Error(friendlyError(e.message || 'The speech engine crashed')));
    };
    const req: CaptionRequest = {
      type: 'run',
      audio,
      model: o.model,
      language: o.language === 'auto' ? null : o.language,
      task: o.translate ? 'translate' : 'transcribe',
    };
    w.postMessage(req, [audio.buffer]);
  });
  // Free the model's memory if captions aren't used again soon.
  idleTimer = setTimeout(killWorker, 120_000);
  return cleanWords(raw);
}

function friendlyError(msg: string): string {
  if (/fetch|network|Failed to load/i.test(msg)) return 'Could not download the speech model. Check your connection and try again.';
  if (/memory|allocation|OOM/i.test(msg)) return 'Not enough memory to run speech recognition. Try the Fast model or close other apps.';
  return msg;
}

const HAS_TEXT = /[\p{L}\p{N}]/u;

/** Normalizes raw recognizer output into single-token words with monotonic times. */
export function cleanWords(raw: RawWord[]): TimedWord[] {
  const out: TimedWord[] = [];
  for (const r of raw) {
    const t = r.text.trim();
    if (!t) continue;
    if (/^[[(].*[\])]$/.test(t)) continue; // [Music], (laughs)
    if (!HAS_TEXT.test(t)) {
      if (out.length) out[out.length - 1].text += t;
      continue;
    }
    const parts = t.split(/\s+/);
    const d = Math.max(0.05, r.end - r.start) / parts.length;
    parts.forEach((part, k) => out.push({ text: part, start: r.start + k * d, end: r.start + (k + 1) * d }));
  }
  for (let i = 0; i < out.length; i++) {
    if (i > 0 && out[i].start < out[i - 1].start) out[i].start = out[i - 1].start;
    if (out[i].end < out[i].start + 0.05) out[i].end = out[i].start + 0.05;
  }
  return out;
}

/** Groups words into caption-sized phrases. */
export function groupWords(words: TimedWord[], maxWords: number, maxDur = 2.8): TimedWord[][] {
  const groups: TimedWord[][] = [];
  let cur: TimedWord[] = [];
  const limit = Math.max(1, Math.round(maxWords));
  for (const w of words) {
    if (cur.length) {
      const first = cur[0];
      const last = cur[cur.length - 1];
      const sentence = /[.!?…。！？]["')\]]?$/.test(last.text);
      const clause = /[,;:，、]$/.test(last.text);
      if (
        cur.length >= limit ||
        w.end - first.start > maxDur ||
        w.start - last.end > 0.7 ||
        sentence ||
        (clause && cur.length >= Math.ceil(limit / 2))
      ) {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

export function captionStyle(presetId: string): Partial<TextStyle> {
  return (CAPTION_PRESETS.find((c) => c.id === presetId) ?? CAPTION_PRESETS[0]).style;
}

/** Builds caption text items for the given words. Lanes are assigned against `existing`. */
export function buildCaptions(words: TimedWord[], o: Pick<CaptionOptions, 'maxWords' | 'presetId'>, existing: TextItem[]): TextItem[] {
  const groups = groupWords(words, o.maxWords);
  if (!groups.length) return [];
  const style = captionStyle(o.presetId);
  const spanStart = groups[0][0].start;
  const lastG = groups[groups.length - 1];
  const spanEnd = lastG[lastG.length - 1].end + 0.6;
  const lane = pickLane(existing, spanStart, spanEnd);
  const items: TextItem[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const start = g[0].start;
    const next = groups[i + 1]?.[0].start ?? Infinity;
    let end = Math.max(g[g.length - 1].end, start + 0.5);
    if (next - end < 0.4) end = next;
    end = Math.max(start + 0.1, Math.min(end, next));
    const it = textItem(g.map((w) => w.text).join(' '), start, end - start, style);
    it.caption = true;
    it.words = g.map((w) => ({ text: w.text, start: Math.max(0, w.start - start), end: Math.max(0, w.end - start) }));
    it.transform.y = 0.22;
    it.lane = lane;
    items.push(it);
  }
  return items;
}

/** Restyles every caption in the project (mutates; use inside a store recipe). */
export function applyCaptionStyle(p: Project, style: Partial<TextStyle>) {
  for (const t of p.texts) if (t.caption) Object.assign(t.style, style);
}

function srtTime(t: number) {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)},${String(r).padStart(3, '0')}`;
}

/** Exports captions (or all text if there are no captions) as an SRT subtitle file. */
export function toSrt(p: Project): string {
  const caps = p.texts.filter((t) => t.caption);
  const list = (caps.length ? caps : p.texts).slice().sort((a, b) => a.start - b.start);
  return list
    .map((t, i) => `${i + 1}\n${srtTime(t.start)} --> ${srtTime(itemEnd(t))}\n${t.text.trim()}\n`)
    .join('\n');
}
