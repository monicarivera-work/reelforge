import { describe, expect, it } from 'vitest';
import type { ClipMeta } from '../types';
import {
  checkClipRange,
  cropForAspect,
  cropPixels,
  filterClips,
  isDirectMediaUrl,
  isFullCrop,
  moveCrop,
  parseYouTubeId,
  parseYouTubeStart,
  resizeCrop,
  timeStamp,
  uniqueName,
} from './clip';

describe('checkClipRange', () => {
  it('accepts seconds and clock times', () => {
    expect(checkClipRange('42.5', '1:02.5', 120)).toEqual({ ok: true, start: 42.5, end: 62.5 });
    expect(checkClipRange('0', '102.5', 120)).toEqual({ ok: true, start: 0, end: 62.5 });
  });

  it('points at the field to fix', () => {
    expect(checkClipRange('abc', '5', 60)).toMatchObject({ ok: false, field: 'start' });
    expect(checkClipRange('5', '', 60)).toMatchObject({ ok: false, field: 'end' });
    expect(checkClipRange('60', '61', 60)).toMatchObject({ ok: false, field: 'start' });
    expect(checkClipRange('10', '5', 60)).toMatchObject({ ok: false, field: 'end' });
    expect(checkClipRange('10', '10.05', 60)).toMatchObject({ ok: false, field: 'end' });
    expect(checkClipRange('10', '70', 60)).toMatchObject({ ok: false, field: 'end' });
  });

  it('snaps an end just past the source to its end', () => {
    expect(checkClipRange('50', '60.6', 60)).toEqual({ ok: true, start: 50, end: 60 });
  });
});

describe('crop', () => {
  it('centers the largest crop of an aspect', () => {
    const c = cropForAspect(1920, 1080, 9 / 16);
    expect(c.h).toBe(1);
    expect(c.w).toBeCloseTo(0.31640625);
    expect(c.x).toBeCloseTo((1 - c.w) / 2);
    const wide = cropForAspect(1080, 1920, 16 / 9);
    expect(wide.w).toBe(1);
    expect(wide.h).toBeCloseTo(0.31640625);
    expect(cropForAspect(1920, 1080, null)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('keeps a moved crop inside the frame', () => {
    expect(moveCrop({ x: 0.5, y: 0.5, w: 0.4, h: 0.4 }, 0.5, -1)).toEqual({ x: 0.6, y: 0, w: 0.4, h: 0.4 });
  });

  it('resizes freely or at a fixed shape', () => {
    const free = resizeCrop({ x: 0, y: 0, w: 0.5, h: 0.5 }, 0.2, -0.1, null, 100, 100);
    expect(free.w).toBeCloseTo(0.7);
    expect(free.h).toBeCloseTo(0.4);
    const square = resizeCrop({ x: 0, y: 0, w: 0.25, h: 0.5 }, 0.25, 0, 1, 200, 100);
    // 0.5 of 200 px wide → 100 px, so height is 100 px = 1.0 of the frame.
    expect(square.w).toBeCloseTo(0.5);
    expect(square.h).toBeCloseTo(1);
    const capped = resizeCrop({ x: 0, y: 0.5, w: 0.25, h: 0.5 }, 0.5, 0, 1, 200, 100);
    expect(capped.h).toBeCloseTo(0.5);
    expect(capped.w).toBeCloseTo(0.25);
  });

  it('gives even pixel rectangles inside the frame', () => {
    expect(cropPixels({ x: 0, y: 0, w: 1, h: 1 }, 1921, 1081)).toEqual({ left: 0, top: 0, width: 1920, height: 1080 });
    const p = cropPixels({ x: 0.3333, y: 0.1, w: 0.31640625, h: 0.9 }, 1920, 1080);
    expect(p.width % 2).toBe(0);
    expect(p.height % 2).toBe(0);
    expect(p.left % 2).toBe(0);
    expect(p.left + p.width).toBeLessThanOrEqual(1920);
    expect(p.top + p.height).toBeLessThanOrEqual(1080);
    expect(isFullCrop({ x: 0, y: 0, w: 1, h: 1 })).toBe(true);
    expect(isFullCrop({ x: 0.1, y: 0, w: 0.9, h: 1 })).toBe(false);
  });
});

describe('links', () => {
  it('finds YouTube video IDs', () => {
    const id = 'dQw4w9WgXcQ';
    for (const s of [
      id,
      `https://www.youtube.com/watch?v=${id}&t=42`,
      `youtube.com/watch?v=${id}`,
      `https://m.youtube.com/watch?v=${id}`,
      `https://youtu.be/${id}?si=abc`,
      `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/embed/${id}`,
      `https://www.youtube.com/live/${id}`,
      `https://music.youtube.com/watch?v=${id}`,
    ])
      expect(parseYouTubeId(s)).toBe(id);
    expect(parseYouTubeId('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(parseYouTubeId('cute cats')).toBeNull();
    expect(parseYouTubeId('https://www.youtube.com/watch?v=short')).toBeNull();
  });

  it('reads start times', () => {
    expect(parseYouTubeStart('https://youtu.be/dQw4w9WgXcQ?t=90')).toBe(90);
    expect(parseYouTubeStart('https://youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s')).toBe(90);
    expect(parseYouTubeStart('https://youtube.com/watch?v=dQw4w9WgXcQ')).toBe(0);
  });

  it('recognizes direct media links', () => {
    expect(isDirectMediaUrl('https://example.com/a/b.mp4')).toBe(true);
    expect(isDirectMediaUrl('https://example.com/song.MP3?x=1')).toBe(true);
    expect(isDirectMediaUrl('https://example.com/page')).toBe(false);
    expect(isDirectMediaUrl('file:///x.mp4')).toBe(false);
  });
});

describe('library', () => {
  const clip = (o: Partial<ClipMeta>): ClipMeta => ({
    id: 'c',
    name: 'Clip',
    kind: 'video',
    mime: 'video/mp4',
    fileName: 'Clip.mp4',
    size: 1,
    duration: 1,
    width: 1,
    height: 1,
    folderId: null,
    start: 0,
    end: 1,
    createdAt: 0,
    ...o,
  });
  const clips = [
    clip({ id: 'a', name: 'Goal', folderId: 'f1', createdAt: 1 }),
    clip({ id: 'b', name: 'Crowd noise', kind: 'audio', createdAt: 3 }),
    clip({ id: 'c', name: 'Intro', source: 'Match highlights', createdAt: 2 }),
  ];
  const ids = (o: Parameters<typeof filterClips>[1]) => filterClips(clips, o).map((c) => c.id);

  it('filters by folder, kind and text, newest first', () => {
    expect(ids({ folder: 'all', kind: 'all', query: '' })).toEqual(['b', 'c', 'a']);
    expect(ids({ folder: 'f1', kind: 'all', query: '' })).toEqual(['a']);
    expect(ids({ folder: 'unfiled', kind: 'all', query: '' })).toEqual(['b', 'c']);
    expect(ids({ folder: 'all', kind: 'audio', query: '' })).toEqual(['b']);
    expect(ids({ folder: 'all', kind: 'all', query: 'HIGHLIGHT' })).toEqual(['c']);
  });

  it('makes unique names', () => {
    expect(uniqueName('Clip', ['Other'])).toBe('Clip');
    expect(uniqueName('Clip', ['Clip', 'Clip 2'])).toBe('Clip 3');
  });

  it('stamps times for file names', () => {
    expect(timeStamp(42.5)).toBe('42.5s');
    expect(timeStamp(65)).toBe('1m05s');
    expect(timeStamp(62.5)).toBe('1m02.5s');
    expect(timeStamp(600)).toBe('10m00s');
  });
});
