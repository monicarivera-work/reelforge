import { ALL_FORMATS, AudioBufferSource, BlobSource, BufferTarget, Input, Mp4OutputFormat, Output, Quality } from 'mediabunny';
import type { MediaAsset, Project, VideoItem } from '../types';
import { audioItem, newProject } from '../lib/defaults';
import { itemEnd, MIN_DUR, sourceTime } from '../lib/layout';
import { getBlob } from '../lib/media';
import { clamp, formatClock, parseTime } from '../lib/util';
import { AudioMixer, canEncodeAac, encodeWav } from './audio';

/** End times typed up to this far past the end of the video snap to the end. */
const END_SLACK = 1;
const SUGGESTED_LENGTH = 5;
/** Chrome only shares .m4a files with this type. */
const M4A_TYPE = 'audio/x-m4a';

export type SoundbiteCheck =
  | { ok: true; start: number; end: number }
  | { ok: false; field: 'start' | 'end'; error: string };

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Checks typed start and end times, counted from the start of a video `duration` seconds long. */
export function checkSoundbite(startText: string, endText: string, duration: number): SoundbiteCheck {
  const s = parseTime(startText);
  if (s === null) return { ok: false, field: 'start', error: 'Type a start time like 42.5, or 102.5 for 1:02.5.' };
  const e = parseTime(endText);
  if (e === null) return { ok: false, field: 'end', error: 'Type an end time like 51, or 102.5 for 1:02.5.' };
  const start = round2(s);
  if (start >= duration) return { ok: false, field: 'start', error: `Start must be before the video ends at ${formatClock(duration)}.` };
  if (e > duration + END_SLACK) return { ok: false, field: 'end', error: `End can’t be after the video ends at ${formatClock(duration)}.` };
  const end = Math.min(duration, round2(e));
  if (end <= start) return { ok: false, field: 'end', error: 'End must be after the start.' };
  if (end - start < MIN_DUR - 1e-6) return { ok: false, field: 'end', error: 'Make the soundbite at least 0.1 seconds long.' };
  return { ok: true, start, end };
}

/** How a typed time reads once its field is left ("42.5" → "00:42.5"). Text that isn't a time is kept. */
export function tidyTime(text: string, duration: number): string {
  const v = parseTime(text);
  if (v === null) return text;
  return formatClock(v > duration && v <= duration + END_SLACK ? duration : v);
}

/** First guess: 5 seconds from the playhead, or from the clip's first frame when the playhead is elsewhere. */
export function suggestSoundbite(v: VideoItem, t: number, duration: number): { start: number; end: number } {
  const at = t >= v.start && t < itemEnd(v) ? sourceTime(v, t) : v.in;
  const latest = Math.max(0, Math.floor((duration - MIN_DUR) * 10 + 1e-6) / 10);
  const start = clamp(Math.floor(at * 10 + 1e-6) / 10, 0, latest);
  return { start, end: Math.min(duration, start + SUGGESTED_LENGTH) };
}

interface Progress {
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

interface AacFormat {
  sampleRate: number;
  numberOfChannels: number;
  bitrate: number;
}

export class NoSoundError extends Error {
  constructor() {
    super('Couldn’t read the sound in this clip.');
  }
}

/**
 * Saves `start`–`end` (seconds into the clip's video) of a clip's sound as an audio file named `name`:
 * AAC in an .m4a where the phone can encode it, otherwise WAV.
 */
export async function encodeSoundbite(asset: MediaAsset, start: number, end: number, opts: Progress & { name: string }): Promise<File> {
  const duration = end - start;
  const bite = audioItem(asset, 0, 'extracted');
  bite.in = start;
  bite.duration = duration;
  const p: Project = { ...newProject(opts.name), audios: [bite] };
  const { sampleRate, numberOfChannels } = await sourceFormat(asset);
  const frames = Math.max(1, Math.round(duration * sampleRate));
  const aac = { sampleRate, numberOfChannels, bitrate: numberOfChannels === 1 ? 128_000 : 192_000 };
  if (await canEncodeAac(aac)) {
    try {
      return new File([await encodeM4a(p, frames, aac, opts)], `${opts.name}.m4a`, { type: M4A_TYPE });
    } catch (e) {
      if (opts.signal?.aborted || e instanceof NoSoundError || (e as Error)?.name === 'AbortError') throw e;
      console.warn('AAC encoding failed, saving WAV instead', e);
    }
  }
  const pcm = Array.from({ length: numberOfChannels }, () => new Float32Array(frames));
  await mixBite(p, frames, sampleRate, numberOfChannels, opts, (data, off) => data?.forEach((d, c) => pcm[c].set(d, off)));
  return new File([encodeWav(pcm, sampleRate)], `${opts.name}.wav`, { type: 'audio/wav' });
}

/** Mixes the soundbite a second at a time, handing each chunk (null where silent) to `take`. */
async function mixBite(
  p: Project,
  frames: number,
  rate: number,
  ch: number,
  opts: Progress,
  take: (data: Float32Array[] | null, off: number, n: number) => unknown,
): Promise<void> {
  const mixer = new AudioMixer(() => p, rate, ch);
  try {
    let heard = false;
    for (let off = 0; off < frames; ) {
      if (opts.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const n = Math.min(rate, frames - off);
      const data = await mixer.mix(off / rate, n);
      heard ||= data !== null;
      await take(data, off, n);
      off += n;
      opts.onProgress?.(off / frames);
    }
    if (!heard) throw new NoSoundError();
  } finally {
    mixer.dispose();
  }
}

/** Keeps the clip's own sample rate and channel count where AAC allows, so the sound isn't resampled. */
async function sourceFormat(asset: MediaAsset): Promise<{ sampleRate: number; numberOfChannels: number }> {
  const out = { sampleRate: 48_000, numberOfChannels: 2 };
  // Clips WebCodecs can't read are decoded at 48 kHz instead (decodeWholeAudio).
  const blob = asset.canDecodeAudio ? await getBlob(asset.id) : null;
  if (!blob) return out;
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (track) {
      if ((await track.getSampleRate()) === 44_100) out.sampleRate = 44_100;
      if ((await track.getNumberOfChannels()) === 1) out.numberOfChannels = 1;
    }
  } catch {
    // Keep the defaults.
  } finally {
    input.dispose();
  }
  return out;
}

async function encodeM4a(p: Project, frames: number, fmt: AacFormat, opts: Progress): Promise<ArrayBuffer> {
  const { sampleRate: rate, numberOfChannels: ch } = fmt;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new AudioBufferSource({ codec: 'aac', quality: new Quality({ bitrate: fmt.bitrate }) });
  output.addAudioTrack(source);
  let finished = false;
  try {
    await output.start();
    await mixBite(p, frames, rate, ch, opts, async (data, _off, n) => {
      const buf = new AudioBuffer({ length: n, numberOfChannels: ch, sampleRate: rate });
      data?.forEach((d, c) => buf.copyToChannel(d as Float32Array<ArrayBuffer>, c));
      await source.add(buf);
    });
    source.close();
    await output.finalize();
    finished = true;
    const buffer = output.target.buffer;
    if (!buffer) throw new Error('Saving produced no data');
    return buffer;
  } finally {
    if (!finished) await output.cancel().catch(() => undefined);
  }
}
