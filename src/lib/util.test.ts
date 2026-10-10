import { describe, expect, it } from 'vitest';
import { formatClock, formatDuration, formatTime, parseTime, safeFileName } from './util';

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

describe('formatClock', () => {
  it('matches the editor timer for whole tenths', () => {
    expect(formatClock(0)).toBe('00:00.0');
    expect(formatClock(42.5)).toBe('00:42.5');
    expect(formatClock(62)).toBe('01:02.0');
    expect(formatClock(4500)).toBe('75:00.0');
  });

  it('keeps hundredths only when they matter', () => {
    expect(formatClock(42.55)).toBe('00:42.55');
    expect(formatClock(42.05)).toBe('00:42.05');
    expect(formatClock(59.999)).toBe('01:00.0');
  });

  it('treats invalid input as zero', () => {
    expect(formatClock(Number.NaN)).toBe('00:00.0');
    expect(formatClock(-1)).toBe('00:00.0');
  });
});

describe('parseTime', () => {
  it('reads seconds, with a dot or a comma', () => {
    expect(parseTime('42.5')).toBe(42.5);
    expect(parseTime(' 42,5 ')).toBe(42.5);
    expect(parseTime('99.9')).toBe(99.9);
    expect(parseTime('.5')).toBe(0.5);
    expect(parseTime('42.')).toBe(42);
    expect(parseTime('42s')).toBe(42);
    expect(parseTime('135s')).toBe(135);
  });

  it('reads digits from 100 up as minutes and seconds, as number pads have no colon', () => {
    expect(parseTime('102')).toBe(62);
    expect(parseTime('102.5')).toBe(62.5);
    expect(parseTime('130')).toBe(90);
    expect(parseTime('1000')).toBe(600);
    expect(parseTime('0042.5')).toBe(42.5);
  });

  it('reads minutes and hours', () => {
    expect(parseTime('0:42.5')).toBe(42.5);
    expect(parseTime('1:02')).toBe(62);
    expect(parseTime('1:2')).toBe(62);
    expect(parseTime('00:42.5')).toBe(42.5);
    expect(parseTime('75:00.0')).toBe(4500);
    expect(parseTime('1:02:03.5')).toBe(3723.5);
  });

  it('rejects anything that isn’t a time', () => {
    for (const bad of ['', ' ', '.', 's', 'abc', '-1', '+1', '1e3', '42.5.1', '1,2,3', '160', '1:', ':30', '1:60', '1:123', '1:60:00', '1:2:3:4', '4 2']) {
      expect(parseTime(bad), bad).toBeNull();
    }
  });

  it('reads back what formatClock shows', () => {
    for (const s of [0, 0.1, 9.95, 42.5, 59.99, 62, 754.25, 4500]) expect(parseTime(formatClock(s))).toBeCloseTo(s, 6);
  });
});
