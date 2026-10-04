import { describe, expect, it } from 'vitest';
import type { Keyframe, MediaAsset, VideoItem } from '../types';
import { imageItem, newProject, textItem, videoItem } from './defaults';
import {
  activeMain,
  applyTrim,
  canvasSize,
  clonePlain,
  duplicateItem,
  moveMainItem,
  normalize,
  pickLane,
  projectDuration,
  sampleKeyframes,
  setSpeed,
  splitItem,
  upsertKeyframe,
} from './layout';

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

const kf = (t: number, x: number, scale: number): Keyframe => ({ t, x, y: 0, scale, rotation: 0, opacity: 1 });

describe('main track layout', () => {
  it('lays clips end to end and overlaps them by the transition length', () => {
    const p = newProject('t');
    const a = videoItem(asset(4));
    const b = videoItem(asset(6));
    const c = imageItem(asset(0), 0, 3);
    a.transition = { type: 'fade', duration: 1 };
    b.transition = { type: 'fade', duration: 1 };
    // capped at half of the shorter neighbor
    c.transition = { type: 'fade', duration: 2 };
    p.main.push(a, b, c);
    normalize(p);
    expect(a.transition).toBeUndefined();
    expect(a.start).toBe(0);
    expect(b.start).toBe(3);
    expect(c.start).toBeCloseTo(7.5);
    expect(projectDuration(p)).toBeCloseTo(10.5);
  });

  it('reports both clips and the progress inside a transition', () => {
    const p = newProject('t');
    const a = videoItem(asset(4));
    const b = videoItem(asset(6));
    b.transition = { type: 'fade', duration: 1 };
    p.main.push(a, b);
    normalize(p);
    const m = activeMain(p.main, 3.5)!;
    expect(m.a.id).toBe(a.id);
    expect(m.b?.id).toBe(b.id);
    expect(m.progress).toBeCloseTo(0.5);
    expect(activeMain(p.main, 5)?.b).toBeNull();
    expect(activeMain(p.main, 20)).toBeNull();
  });

  it('reorders clips', () => {
    const p = newProject('t');
    const a = videoItem(asset(4));
    const b = videoItem(asset(6));
    const c = imageItem(asset(0), 0, 3);
    p.main.push(a, b, c);
    normalize(p);
    moveMainItem(p, c.id, 0);
    expect(p.main.map((m) => m.id)).toEqual([c.id, a.id, b.id]);
    expect(p.main.map((m) => m.start)).toEqual([0, 3, 7]);
  });
});

describe('splitItem', () => {
  it('splits a sped-up video at the right source time', () => {
    const p = newProject('t');
    const v = videoItem(asset(20));
    Object.assign(v, { in: 1, speed: 2, duration: 5, fadeIn: 0.5, fadeOut: 0.5 });
    p.main.push(v);
    normalize(p);
    const id = splitItem(p, v.id, 2);
    const [l, r] = p.main as VideoItem[];
    expect(r.id).toBe(id);
    expect([l.duration, r.start, r.duration]).toEqual([2, 2, 3]);
    expect(r.in).toBe(5);
    expect([l.fadeIn, l.fadeOut, r.fadeIn, r.fadeOut]).toEqual([0.5, 0, 0, 0.5]);
  });

  it('refuses to make a part shorter than the minimum', () => {
    const p = newProject('t');
    const v = videoItem(asset(4));
    p.main.push(v);
    normalize(p);
    expect(splitItem(p, v.id, 0.05)).toBeNull();
    expect(splitItem(p, v.id, 3.95)).toBeNull();
    expect(p.main).toHaveLength(1);
  });

  it('keeps keyframed motion continuous across the cut', () => {
    const p = newProject('t');
    const v = videoItem(asset(4));
    v.keyframes = [kf(0, 0, 1), kf(4, 0.4, 2)];
    p.main.push(v);
    normalize(p);
    splitItem(p, v.id, 2);
    const [l, r] = p.main as VideoItem[];
    expect(l.keyframes.map((k) => [k.t, k.x, k.scale])).toEqual([
      [0, 0, 1],
      [2, expect.closeTo(0.2), expect.closeTo(1.5)],
    ]);
    expect(r.keyframes.map((k) => [k.t, k.x, k.scale])).toEqual([
      [0, expect.closeTo(0.2), expect.closeTo(1.5)],
      [2, 0.4, 2],
    ]);
  });

  it('splits caption words and rebuilds the caption text', () => {
    const p = newProject('t');
    const t = textItem('hello big world', 1, 3);
    t.caption = true;
    t.words = [
      { text: 'hello', start: 0, end: 0.8 },
      { text: 'big', start: 1, end: 1.4 },
      { text: 'world', start: 2, end: 2.6 },
    ];
    p.texts.push(t);
    const id = splitItem(p, t.id, 2.5);
    const right = p.texts.find((x) => x.id === id)!;
    expect(t.text).toBe('hello big');
    expect(right.text).toBe('world');
    expect(right.words?.[0].start).toBeCloseTo(0.5);
  });
});

describe('applyTrim', () => {
  it('moves the in point when trimming the start and stops at the source start', () => {
    const p = newProject('t');
    const v = videoItem(asset(10));
    Object.assign(v, { in: 2, duration: 6 });
    p.main.push(v);
    normalize(p);
    const orig = clonePlain(v);
    applyTrim(p, v.id, orig, 'start', 1);
    expect([v.start, v.in, v.duration]).toEqual([0, 3, 5]);
    applyTrim(p, v.id, orig, 'start', -5);
    expect([v.in, v.duration]).toEqual([0, 8]);
  });

  it('cannot extend past the end of the source', () => {
    const p = newProject('t');
    const v = videoItem(asset(10));
    Object.assign(v, { in: 2, duration: 6 });
    p.main.push(v);
    normalize(p);
    applyTrim(p, v.id, clonePlain(v), 'end', 10, asset(10));
    expect(v.duration).toBe(8);
  });
});

describe('setSpeed', () => {
  it('keeps the same source footage and rescales keyframes', () => {
    const p = newProject('t');
    const v = videoItem(asset(10));
    v.duration = 8;
    v.keyframes = [kf(4, 0, 1)];
    p.main.push(v);
    normalize(p);
    setSpeed(p, v.id, 2, asset(10));
    expect(v.duration).toBe(4);
    expect(v.keyframes[0].t).toBe(2);
    setSpeed(p, v.id, 0.5, asset(10));
    expect(v.duration).toBe(16);
    expect(v.keyframes[0].t).toBe(8);
  });
});

describe('lanes', () => {
  it('picks the preferred lane when free, otherwise the lowest free one', () => {
    const a = textItem('a', 0, 2);
    const b = textItem('b', 1, 2);
    b.lane = 1;
    const items = [a, b];
    expect(pickLane(items, 0.5, 1.5)).toBe(2);
    expect(pickLane(items, 2, 3)).toBe(0);
    expect(pickLane(items, 2.5, 3, undefined, 1)).toBe(0);
    expect(pickLane(items, 0.5, 1.5, a.id)).toBe(0);
  });

  it('compacts unused lanes', () => {
    const p = newProject('t');
    const items = [textItem('a', 0, 1), textItem('b', 0, 1), textItem('c', 0, 1)];
    items.forEach((t, i) => (t.lane = [0, 3, 5][i]));
    p.texts.push(...items);
    normalize(p);
    expect(p.texts.map((t) => t.lane)).toEqual([0, 1, 2]);
  });

  it('duplicates main clips in place without their transition', () => {
    const p = newProject('t');
    const a = videoItem(asset(4));
    const b = videoItem(asset(6));
    b.transition = { type: 'fade', duration: 1 };
    p.main.push(a, b);
    normalize(p);
    const id = duplicateItem(p, b.id);
    expect(p.main.map((m) => m.id)).toEqual([a.id, b.id, id]);
    expect(p.main[2].transition).toBeUndefined();
  });

  it('puts duplicated overlays right after the original', () => {
    const p = newProject('t');
    const t = textItem('a', 1, 2);
    p.texts.push(t);
    const id = duplicateItem(p, t.id);
    const copy = p.texts.find((x) => x.id === id)!;
    expect([copy.start, copy.lane]).toEqual([3, 0]);
  });
});

describe('keyframes', () => {
  it('holds the first and last values and eases in between', () => {
    const k = [kf(1, 0, 1), kf(3, 1, 3)];
    expect(sampleKeyframes([], 0)).toBeNull();
    expect(sampleKeyframes(k, 0)?.x).toBe(0);
    expect(sampleKeyframes(k, 5)?.x).toBe(1);
    expect(sampleKeyframes(k, 2)?.scale).toBeCloseTo(2);
    // ease-in-out: slower than linear near the start
    expect(sampleKeyframes(k, 1.5)!.x).toBeLessThan(0.25);
  });

  it('replaces a keyframe within the tolerance and keeps them sorted', () => {
    const out = upsertKeyframe([kf(2, 0, 1), kf(0, 0, 1)], kf(2.001, 0.5, 1));
    expect(out.map((k) => [k.t, k.x])).toEqual([
      [0, 0],
      [2.001, 0.5],
    ]);
  });
});

describe('canvasSize', () => {
  it('uses the short side for the smaller dimension', () => {
    expect(canvasSize('9:16', 1080)).toEqual({ w: 1080, h: 1920 });
    expect(canvasSize('16:9', 1080)).toEqual({ w: 1920, h: 1080 });
    expect(canvasSize('1:1', 720)).toEqual({ w: 720, h: 720 });
  });
});
