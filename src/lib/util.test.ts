import { describe, expect, it } from 'vitest';
import { formatDuration, formatTime, safeFileName } from './util';

describe('safeFileName', () => {
  it('keeps spaces, dashes, accents and emoji', () => {
    expect(safeFileName('Video – Oct 3')).toBe('Video – Oct 3');
    expect(safeFileName('Mi canción 🎵')).toBe('Mi canción 🎵');
  });

  it('removes characters file systems reject', () => {
    expect(safeFileName('a/b\\c:d*e?"f"<g>|h')).toBe('a b c d e f g h');
    expect(safeFileName('...hidden')).toBe('hidden');
    expect(safeFileName('  \n ')).toBe('video');
    expect(safeFileName('???', 'ReelForge')).toBe('ReelForge');
  });

  it('caps the length without splitting an emoji', () => {
    const out = safeFileName('😀'.repeat(100));
    expect(Array.from(out)).toHaveLength(80);
    expect(out.endsWith('😀')).toBe(true);
  });
});

describe('formatTime', () => {
  it('formats minutes and seconds', () => {
    expect(formatTime(0)).toBe('00:00');
    expect(formatTime(59.99)).toBe('00:59');
    expect(formatTime(125.4)).toBe('02:05');
  });

  it('shows tenths without float drift', () => {
    expect(formatTime(2.3, true)).toBe('00:02.3');
    expect(formatTime(13.9, true)).toBe('00:13.9');
    expect(formatTime(60.1, true)).toBe('01:00.1');
    expect(formatTime(0.05, true)).toBe('00:00.0');
  });

  it('treats invalid input as zero', () => {
    expect(formatTime(Number.NaN)).toBe('00:00');
    expect(formatTime(-3, true)).toBe('00:00.0');
  });
});

describe('formatDuration', () => {
  it('uses seconds for short videos and minutes for long ones', () => {
    expect(formatDuration(8.9)).toBe('8.9s');
    expect(formatDuration(13.97)).toBe('14s');
    expect(formatDuration(125.4)).toBe('02:05');
  });

  it('matches the editor timer and never shows 60s', () => {
    expect(formatDuration(8.97)).toBe('8.9s');
    expect(formatDuration(9.99)).toBe('9.9s');
    expect(formatDuration(59.6)).toBe('01:00');
    expect(formatDuration(Number.NaN)).toBe('0.0s');
  });
});
