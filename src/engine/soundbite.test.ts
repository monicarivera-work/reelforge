import { describe, expect, it } from 'vitest';
import type { MediaAsset } from '../types';
import { videoItem } from '../lib/defaults';
import { checkSoundbite, suggestSoundbite, tidyTime } from './soundbite';

const asset = (duration: number): MediaAsset => ({
  id: 'm1',
  name: 'clip.mp4',
  kind: 'video',
  mime: 'video/mp4',
  size: 1,
  duration,
  width: 1080,
  height: 1920,
  hasAudio: true,
  canDecodeVideo: true,
  canDecodeAudio: true,
  createdAt: 0,
});

describe('checkSoundbite', () => {
  it('accepts seconds and minutes:seconds', () => {
    expect(checkSoundbite('42.5', '0:51', 90)).toEqual({ ok: true, start: 42.5, end: 51 });
    expect(checkSoundbite('1:02', '01:10.25', 90)).toEqual({ ok: true, start: 62, end: 70.25 });
  });

  it('reads minutes typed without a colon, as phone number pads have none', () => {
    expect(checkSoundbite('102', '110.5', 90)).toEqual({ ok: true, start: 62, end: 70.5 });
    expect(checkSoundbite('160', '170', 900)).toMatchObject({ ok: false, field: 'start' });
  });

  it('points at the field to fix', () => {
    expect(checkSoundbite('', '5', 90)).toMatchObject({ ok: false, field: 'start' });
    expect(checkSoundbite('abc', '5', 90)).toMatchObject({ ok: false, field: 'start' });
    expect(checkSoundbite('5', '', 90)).toMatchObject({ ok: false, field: 'end' });
    expect(checkSoundbite('95', '96', 90)).toEqual({
      ok: false,
      field: 'start',
      error: 'Start must be before the video ends at 01:30.0.',
    });
    expect(checkSoundbite('80', '1:32', 90)).toMatchObject({ ok: false, field: 'end' });
    expect(checkSoundbite('10', '10', 90)).toEqual({ ok: false, field: 'end', error: 'End must be after the start.' });
    expect(checkSoundbite('10', '9', 90)).toMatchObject({ ok: false, field: 'end' });
    expect(checkSoundbite('10', '10.05', 90)).toEqual({
      ok: false,
      field: 'end',
      error: 'Make the soundbite at least 0.1 seconds long.',
    });
  });

  it('snaps an end just past the video to its last moment', () => {
    // Gallery players often round the length up.
    expect(checkSoundbite('85', '1:31', 90.4)).toEqual({ ok: true, start: 85, end: 90.4 });
  });

  it('allows the shortest soundbite despite rounding', () => {
    expect(checkSoundbite('0.2', '0.3', 90)).toEqual({ ok: true, start: 0.2, end: 0.3 });
  });
});

describe('tidyTime', () => {
  it('shows typed times as minutes and seconds', () => {
    expect(tidyTime('42.5', 90)).toBe('00:42.5');
    expect(tidyTime('1:2', 90)).toBe('01:02.0');
    expect(tidyTime('102.5', 90)).toBe('01:02.5');
  });

  it('snaps just past the end, and keeps text that is not a time', () => {
    expect(tidyTime('90.6', 90.4)).toBe('01:30.4');
    expect(tidyTime('95', 90)).toBe('01:35.0');
    expect(tidyTime('4 2', 90)).toBe('4 2');
  });
});

describe('suggestSoundbite', () => {
  it('starts at the playhead, counted in the clip’s own video', () => {
    const v = videoItem(asset(60), 10);
    v.in = 20;
    v.speed = 2;
    v.duration = 15;
    // 3 s into the clip at 2× is 26 s into its video
    expect(suggestSoundbite(v, 13, 60)).toEqual({ start: 26, end: 31 });
  });

  it('starts at the clip’s first frame when the playhead is elsewhere', () => {
    const v = videoItem(asset(60), 10);
    v.in = 20;
    v.duration = 40;
    expect(suggestSoundbite(v, 5, 60)).toEqual({ start: 20, end: 25 });
    expect(suggestSoundbite(v, 50, 60)).toEqual({ start: 20, end: 25 });
  });

  it('stays inside the video', () => {
    expect(suggestSoundbite(videoItem(asset(30)), 29.97, 30)).toEqual({ start: 29.9, end: 30 });
    expect(suggestSoundbite(videoItem(asset(3)), 0, 3)).toEqual({ start: 0, end: 3 });
  });
});
