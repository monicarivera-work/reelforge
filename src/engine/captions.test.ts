import { describe, expect, it } from 'vitest';
import { newProject, textItem } from '../lib/defaults';
import { CAPTION_PRESETS } from '../lib/text';
import { buildCaptions, cleanWords, groupWords, toSrt, type TimedWord } from './captions';

const w = (text: string, start: number, end: number): TimedWord => ({ text, start, end });

describe('cleanWords', () => {
  it('drops sound tags, joins punctuation and splits multi-word tokens', () => {
    const out = cleanWords([
      w(' [Music] ', 0, 1),
      w('Hello', 1, 1.4),
      w(',', 1.4, 1.45),
      w(' big world', 1.5, 2.5),
      w('(laughs)', 2.5, 2.6),
    ]);
    expect(out.map((x) => x.text)).toEqual(['Hello,', 'big', 'world']);
    expect(out[1]).toEqual({ text: 'big', start: 1.5, end: 2 });
    expect(out[2]).toEqual({ text: 'world', start: 2, end: 2.5 });
  });

  it('keeps times in order with a minimum length', () => {
    const out = cleanWords([w('one', 2.4, 2.42), w('two', 2, 2.3)]);
    expect(out[0].end).toBeCloseTo(2.45);
    expect(out[1].start).toBe(2.4);
    expect(out[1].end).toBeCloseTo(2.45);
  });
});

describe('groupWords', () => {
  it('breaks at sentence ends and long pauses', () => {
    const words = [
      w('one', 0, 0.3),
      w('two', 0.3, 0.6),
      w('three.', 0.6, 0.9),
      w('four', 1, 1.3),
      w('five', 1.3, 1.6),
      w('six', 2.5, 2.8),
      w('seven', 2.8, 3),
    ];
    expect(groupWords(words, 3).map((g) => g.map((x) => x.text).join(' '))).toEqual([
      'one two three.',
      'four five',
      'six seven',
    ]);
  });

  it('respects the word limit, the duration limit and clause breaks', () => {
    const run = ['a', 'b', 'c', 'd', 'e'].map((t, i) => w(t, i * 0.2, i * 0.2 + 0.2));
    expect(groupWords(run, 2).map((g) => g.length)).toEqual([2, 2, 1]);
    const slow = ['a', 'b', 'c'].map((t, i) => w(t, i, i + 1));
    expect(groupWords(slow, 5).map((g) => g.length)).toEqual([2, 1]);
    const clause = [w('so', 0, 0.2), w('well,', 0.2, 0.4), w('then', 0.4, 0.6)];
    expect(groupWords(clause, 4).map((g) => g.length)).toEqual([2, 1]);
  });
});

describe('buildCaptions', () => {
  it('makes one caption per phrase with word timings relative to it', () => {
    const words = [w('Hi', 1, 1.3), w('there.', 1.3, 1.8), w('How', 2, 2.2), w('are', 2.2, 2.4), w('you?', 2.4, 2.9)];
    const [a, b] = buildCaptions(words, { maxWords: 4, presetId: CAPTION_PRESETS[0].id }, []);
    expect(a.text).toBe('Hi there.');
    expect(a.caption).toBe(true);
    expect(a.start).toBe(1);
    // a short gap before the next caption is closed up
    expect(a.duration).toBeCloseTo(1);
    expect(a.words?.map((x) => [x.text, x.start])).toEqual([
      ['Hi', 0],
      ['there.', expect.closeTo(0.3)],
    ]);
    expect(b.text).toBe('How are you?');
    expect(b.duration).toBeCloseTo(0.9);
  });

  it('avoids lanes already used by other text', () => {
    const other = textItem('Title', 0, 10);
    const items = buildCaptions([w('Hi', 1, 1.3)], { maxWords: 4, presetId: CAPTION_PRESETS[0].id }, [other]);
    expect(items[0].lane).toBe(1);
  });
});

describe('toSrt', () => {
  it('exports captions in time order', () => {
    const p = newProject('t');
    const second = textItem('Second', 3, 2);
    const first = textItem(' First ', 0.5, 1.25);
    second.caption = first.caption = true;
    p.texts.push(second, textItem('Title', 0, 10), first);
    expect(toSrt(p)).toBe('1\n00:00:00,500 --> 00:00:01,750\nFirst\n\n2\n00:00:03,000 --> 00:00:05,000\nSecond\n');
  });

  it('falls back to all text and formats hours', () => {
    const p = newProject('t');
    p.texts.push(textItem('Late', 3725.5, 1));
    expect(toSrt(p)).toBe('1\n01:02:05,500 --> 01:02:06,500\nLate\n');
  });
});
