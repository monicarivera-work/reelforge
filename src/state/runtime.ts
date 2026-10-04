import type { PreviewEngine } from '../engine/preview';
import { projectDuration } from '../lib/layout';
import { clamp } from '../lib/util';
import { useEditor, useTime } from './store';

let engine: PreviewEngine | null = null;

export function setEngine(e: PreviewEngine | null) {
  engine = e;
}

export function getEngine(): PreviewEngine | null {
  return engine;
}

export function duration(): number {
  const p = useEditor.getState().project;
  return p ? projectDuration(p) : 0;
}

/** Moves the playhead (and the preview) to t. */
export function seek(t: number) {
  const tt = clamp(t, 0, duration());
  useTime.setState({ time: tt });
  engine?.seek(tt);
}

/** Current playhead time (live while playing). */
export function now(): number {
  return engine?.playing ? engine.time : useTime.getState().time;
}

/** Must be called directly from a tap handler so playback can start on iOS. */
export function togglePlay() {
  engine?.toggle();
}

export function pause() {
  engine?.pause();
}
