import { env, pipeline } from '@huggingface/transformers';

export type CaptionModel = 'tiny' | 'base';

export interface RawWord {
  text: string;
  start: number;
  end: number;
}

export interface CaptionRequest {
  type: 'run';
  /** 16 kHz mono PCM */
  audio: Float32Array;
  model: CaptionModel;
  /** ISO code, or null to auto-detect */
  language: string | null;
  task: 'transcribe' | 'translate';
}

export type CaptionWorkerMessage =
  | { type: 'load'; progress: number; loaded: number; total: number }
  | { type: 'progress'; progress: number }
  | { type: 'result'; words: RawWord[] }
  | { type: 'error'; message: string };

const SR = 16000;
const FRAME = SR / 50; // 20 ms analysis frames
const SILENCE_RMS = 0.004;

env.allowLocalModels = false;

type Chunk = { text: string; timestamp: [number, number | null] };
type AsrOutput = { text: string; chunks?: Chunk[] };
type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<AsrOutput | AsrOutput[]>;

let loaded: { id: string; asr: Promise<Asr> } | null = null;

const post = (m: CaptionWorkerMessage) => (self as unknown as { postMessage(m: CaptionWorkerMessage): void }).postMessage(m);

function load(model: CaptionModel): Promise<Asr> {
  const id = `onnx-community/whisper-${model}_timestamped`;
  if (loaded?.id === id) return loaded.asr;
  const asr = (pipeline as unknown as (task: string, model: string, opts: Record<string, unknown>) => Promise<Asr>)(
    'automatic-speech-recognition',
    id,
    {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: (e: { status: string; progress?: number; loaded?: number; total?: number }) => {
        if (e.status === 'progress_total') {
          post({ type: 'load', progress: (e.progress ?? 0) / 100, loaded: e.loaded ?? 0, total: e.total ?? 0 });
        }
      },
    },
  );
  loaded = { id, asr };
  asr.catch(() => {
    if (loaded?.asr === asr) loaded = null;
  });
  return asr;
}

/** Splits audio into chunks of at most ~28 s, cutting at the quietest moment near the end of each chunk. */
function segment(audio: Float32Array): { a: number; b: number; silent: boolean }[] {
  const n = Math.ceil(audio.length / FRAME);
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = i * FRAME;
    const b = Math.min(audio.length, a + FRAME);
    let s = 0;
    for (let j = a; j < b; j++) s += audio[j] * audio[j];
    rms[i] = Math.sqrt(s / Math.max(1, b - a));
  }
  const MAX = 28 * 50;
  const MIN = 16 * 50;
  const WIN = 15;
  const cuts: [number, number][] = [];
  let start = 0;
  while (start < n) {
    if (n - start <= MAX) {
      cuts.push([start, n]);
      break;
    }
    let best = start + MAX;
    let bestV = Infinity;
    for (let i = start + MIN; i < start + MAX - WIN; i++) {
      let v = 0;
      for (let k = 0; k < WIN; k++) v += rms[i + k];
      if (v < bestV) {
        bestV = v;
        best = i + (WIN >> 1);
      }
    }
    cuts.push([start, best]);
    start = best;
  }
  return cuts.map(([a, b]) => {
    let peak = 0;
    for (let i = a; i < b; i++) peak = Math.max(peak, rms[i]);
    return { a: a * FRAME, b: Math.min(audio.length, b * FRAME), silent: peak < SILENCE_RMS };
  });
}

async function run(req: CaptionRequest) {
  const asr = await load(req.model);
  const segs = segment(req.audio);
  const total = segs.reduce((s, x) => s + (x.silent ? 0 : x.b - x.a), 0) || 1;
  let done = 0;
  const words: RawWord[] = [];
  post({ type: 'progress', progress: 0 });
  for (const s of segs) {
    if (s.silent) continue;
    const off = s.a / SR;
    const segEnd = s.b / SR;
    const opts: Record<string, unknown> = { return_timestamps: 'word', task: req.task };
    if (req.language) opts.language = req.language;
    let out = await asr(req.audio.slice(s.a, s.b), opts);
    if (Array.isArray(out)) out = out[0];
    for (const c of out?.chunks ?? []) {
      const [ws, we] = c.timestamp;
      const start = Math.min(segEnd, off + (ws ?? 0));
      const end = Math.min(segEnd, Math.max(start + 0.05, off + (we ?? (ws ?? 0) + 0.3)));
      words.push({ text: c.text, start, end });
    }
    done += s.b - s.a;
    post({ type: 'progress', progress: done / total });
  }
  post({ type: 'result', words });
}

self.onmessage = (e: MessageEvent<CaptionRequest>) => {
  if (e.data?.type !== 'run') return;
  run(e.data).catch((err: unknown) => {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  });
};
