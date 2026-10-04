import { AlignCenter, AlignLeft, AlignRight, CaseUpper, Italic, Palette, type LucideIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { Project, TextItem, TextStyle, Word } from '../../types';
import { DEFAULT_CAPTION_OPTIONS } from '../../engine/captions';
import { DEFAULT_TEXT_STYLE } from '../../lib/defaults';
import { deleteItem } from '../../lib/layout';
import { CAPTION_PRESETS, closestWeight, ensureFont, FONTS, TEXT_PRESETS } from '../../lib/text';
import { rgba } from '../../lib/util';
import { useEditor } from '../../state/store';
import { addSticker, createText, lastTextStyle, rememberTextStyle } from '../actions';
import { gesture, loadPrefs, savePrefs, Segmented, Sheet, Slider, Swatches, Toggle, updateItem } from '../common';

export type Preset = { id: string; name: string; style: Partial<TextStyle> };

export const CAPTION_PREFS_KEY = 'rf-captions';

/** A preset's full style, keeping the text's alignment and wrap width (and size unless the preset sets one). */
export function presetStyle(cur: TextStyle, p: Preset): TextStyle {
  return {
    ...DEFAULT_TEXT_STYLE,
    ...p.style,
    size: p.style.size ?? cur.size,
    align: cur.align,
    maxWidth: cur.maxWidth,
  };
}

function matchesPreset(s: TextStyle, p: Preset): boolean {
  return (Object.keys(p.style) as (keyof TextStyle)[]).every((k) => k === 'size' || s[k] === p.style[k]);
}

/** Re-times caption words after an edit so the karaoke highlight keeps working. */
function retimeWords(words: Word[], text: string): Word[] | undefined {
  const parts = text.split(/\s+/).filter(Boolean);
  if (!parts.length || !words.length) return undefined;
  if (parts.length === words.length) return words.map((w, i) => ({ start: w.start, end: w.end, text: parts[i] }));
  const t0 = words[0].start;
  const t1 = Math.max(t0 + 0.05, words[words.length - 1].end);
  const total = parts.reduce((a, p) => a + p.length + 1, 0);
  let acc = 0;
  return parts.map((p) => {
    const start = t0 + ((t1 - t0) * acc) / total;
    acc += p.length + 1;
    return { text: p, start, end: t0 + ((t1 - t0) * acc) / total };
  });
}

function sampleCss(st: TextStyle): CSSProperties {
  const px = 22;
  const box = st.bgOpacity > 0.001;
  return {
    fontFamily: `"${st.font}", sans-serif`,
    fontWeight: closestWeight(st.font, st.weight),
    fontStyle: st.italic ? 'italic' : undefined,
    fontSize: px,
    lineHeight: 1.15,
    color: st.color,
    textTransform: st.uppercase ? 'uppercase' : undefined,
    letterSpacing: st.letterSpacing ? `${st.letterSpacing}em` : undefined,
    WebkitTextStroke: st.strokeWidth > 0 ? `${Math.min(4, st.strokeWidth * 2 * px).toFixed(1)}px ${st.stroke}` : undefined,
    paintOrder: 'stroke fill',
    textShadow: st.shadowBlur > 0 ? `0 1px ${Math.max(2, st.shadowBlur * px).toFixed(1)}px ${st.shadow}` : undefined,
    background: box ? rgba(st.bg, st.bgOpacity) : undefined,
    borderRadius: box ? st.bgRadius * px : undefined,
    padding: box ? '1px 7px' : undefined,
    whiteSpace: 'nowrap',
  };
}

export function PresetTiles({
  presets,
  isActive,
  onPick,
  label,
}: {
  presets: Preset[];
  isActive: (p: Preset) => boolean;
  onPick: (p: Preset) => void;
  label: string;
}) {
  useEffect(() => {
    for (const p of presets) {
      const st = { ...DEFAULT_TEXT_STYLE, ...p.style };
      void ensureFont(st.font, st.weight, st.italic);
    }
  }, [presets]);

  return (
    <div className="tiles row" role="group" aria-label={label}>
      {presets.map((p) => {
        const st = { ...DEFAULT_TEXT_STYLE, ...p.style };
        return (
          <button key={p.id} className="tile preset-tile" aria-pressed={isActive(p)} onClick={() => onPick(p)}>
            <span style={sampleCss(st)} aria-hidden>
              {st.highlightOn ? (
                <>
                  A<span style={{ color: st.highlight }}>a</span>
                </>
              ) : (
                'Aa'
              )}
            </span>
            <small>{p.name}</small>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Text editing (new text or existing)

export function TextEditSheet({ item, onClose }: { item: TextItem | null; onClose: () => void }) {
  const [id, setId] = useState<string | null>(item?.id ?? null);
  const idRef = useRef(id);
  const [text, setText] = useState(item?.text ?? '');
  const textRef = useRef(text);
  const [pendingStyle, setPendingStyle] = useState<Partial<TextStyle> | undefined>(lastTextStyle);
  const live = useEditor((s) => (id && s.project ? (s.project.texts.find((t) => t.id === id) ?? null) : null));
  const taRef = useRef<HTMLTextAreaElement>(null);
  const caption = !!live?.caption;
  const style = live?.style ?? { ...DEFAULT_TEXT_STYLE, ...pendingStyle };

  // Undo/redo can change or remove the text while the sheet is open.
  useEffect(() => {
    if (!id) return;
    if (!live) {
      idRef.current = null;
      textRef.current = '';
      setId(null);
      setText('');
    } else if (live.text !== textRef.current) {
      textRef.current = live.text;
      setText(live.text);
    }
  }, [id, live]);

  // Focus before the sheet's own focus handling runs, keeping the iOS keyboard (primed by the tap) open.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus({ preventScroll: true });
    const n = ta.value.length;
    ta.setSelectionRange(n, n);
  }, []);

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight + 2}px`;
  }, [text]);

  // Text left empty is removed when the editor closes.
  useEffect(
    () => () => {
      const cur = idRef.current;
      if (!cur || textRef.current.trim()) return;
      useEditor.getState().apply((d) => void deleteItem(d as Project, cur), { merge: `text:${cur}` });
    },
    [],
  );

  const onChange = (v: string) => {
    textRef.current = v;
    setText(v);
    const cur = idRef.current;
    if (!cur) {
      if (!v.trim()) return;
      const nid = createText(v);
      idRef.current = nid;
      setId(nid);
      return;
    }
    updateItem<TextItem>(
      cur,
      (d) => {
        d.text = v;
        if (d.words) {
          const w = retimeWords(d.words, v);
          if (w) d.words = w;
          else delete d.words;
        }
      },
      `text:${cur}`,
    );
  };

  const pickPreset = (p: Preset) => {
    const cur = idRef.current;
    if (!cur) {
      rememberTextStyle(p.style);
      setPendingStyle(p.style);
      return;
    }
    if (caption) {
      useEditor.getState().apply((d) => {
        for (const t of d.texts) if (t.caption) t.style = presetStyle(t.style as TextStyle, p);
      });
      savePrefs(CAPTION_PREFS_KEY, { ...loadPrefs(CAPTION_PREFS_KEY, DEFAULT_CAPTION_OPTIONS), presetId: p.id });
    } else {
      updateItem<TextItem>(cur, (d) => {
        d.style = presetStyle(d.style as TextStyle, p);
      });
      rememberTextStyle(p.style);
    }
  };

  const openStyle = () => {
    const cur = idRef.current;
    if (!cur) return;
    const s = useEditor.getState();
    if (s.selectedId !== cur) s.select(cur);
    s.openSheet('textStyle');
  };

  return (
    <Sheet
      title={!item ? 'Add text' : caption ? 'Edit caption' : 'Edit text'}
      onClose={onClose}
      actions={
        <button className="icon-btn" aria-label="Style" disabled={!id || !text.trim()} onClick={openStyle}>
          <Palette size={22} />
        </button>
      }
    >
      <div className="text-edit">
        <textarea
          ref={taRef}
          className="input"
          rows={1}
          value={text}
          placeholder="Type your text"
          aria-label="Text"
          autoCapitalize="sentences"
          autoComplete="off"
          maxLength={500}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      <PresetTiles
        presets={caption ? CAPTION_PRESETS : TEXT_PRESETS}
        isActive={(p) => matchesPreset(style, p)}
        onPick={pickPreset}
        label={caption ? 'Caption styles (all captions)' : 'Text styles'}
      />
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Text style

type StyleTab = 'font' | 'color' | 'outline' | 'background' | 'shadow' | 'layout' | 'highlight';

const TABS: { id: StyleTab; label: string }[] = [
  { id: 'font', label: 'Font' },
  { id: 'color', label: 'Color' },
  { id: 'outline', label: 'Outline' },
  { id: 'background', label: 'Background' },
  { id: 'shadow', label: 'Shadow' },
  { id: 'layout', label: 'Layout' },
  { id: 'highlight', label: 'Highlight' },
];

const WEIGHT_NAMES: Record<number, string> = {
  400: 'Regular',
  500: 'Medium',
  600: 'Semibold',
  700: 'Bold',
  800: 'Extra bold',
  900: 'Black',
};

const SHORT_FONT: Record<string, string> = {
  'Bebas Neue': 'Bebas',
  'Permanent Marker': 'Marker',
  'Playfair Display': 'Playfair',
  'Roboto Mono': 'Mono',
};

let lastStyleTab: StyleTab = 'font';
let applyToAllCaptions = true;

const off = (f: (v: number) => string) => (v: number) => (v <= 0 ? 'Off' : f(v));

function IconLabel({ Icon, text }: { Icon: LucideIcon; text: string }) {
  return (
    <>
      <Icon size={18} aria-hidden />
      <span className="sr-only">{text}</span>
    </>
  );
}

export function TextStyleSheet({ item, onClose }: { item: TextItem; onClose: () => void }) {
  const id = item.id;
  const s = item.style;
  const caption = !!item.caption;
  const hasWords = !!item.words?.length;
  const tabs = TABS.filter((t) => t.id !== 'highlight' || hasWords);
  const [tab, setTabState] = useState<StyleTab>(() => (tabs.some((t) => t.id === lastStyleTab) ? lastStyleTab : 'font'));
  const [all, setAll] = useState(applyToAllCaptions);
  const font = FONTS.find((f) => f.family === s.font);

  const setTab = (t: StyleTab) => {
    lastStyleTab = t;
    setTabState(t);
  };

  const set = (patch: Partial<TextStyle>, merge?: string) => {
    const every = caption && all;
    useEditor.getState().apply(
      (d) => {
        for (const t of d.texts) if (every ? t.caption : t.id === id) Object.assign(t.style, patch);
      },
      merge ? { merge } : undefined,
    );
  };

  // New text starts with the look of the last one styled (but not its size).
  useEffect(
    () => () => {
      const t = useEditor.getState().project?.texts.find((x) => x.id === id);
      if (!t || t.caption || !/[\p{L}\p{N}]/u.test(t.text)) return;
      const keep: Partial<TextStyle> = { ...t.style };
      delete keep.size;
      delete keep.maxWidth;
      rememberTextStyle(keep);
    },
    [id],
  );

  return (
    <Sheet title={caption && all ? 'Caption style' : 'Text style'} onClose={onClose}>
      <div className="chips" role="group" aria-label="Style options">
        {tabs.map((t) => (
          <button key={t.id} className="chip" aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'font' && (
        <>
          <div className="tiles row" role="group" aria-label="Font">
            {FONTS.map((f) => (
              <button
                key={f.family}
                className="tile font-tile"
                aria-pressed={s.font === f.family}
                aria-label={f.family}
                onClick={() => set({ font: f.family, weight: closestWeight(f.family, s.weight) })}
              >
                <span style={{ fontFamily: `"${f.family}", sans-serif`, fontWeight: closestWeight(f.family, s.weight), fontSize: 20 }} aria-hidden>
                  Aa
                </span>
                <small aria-hidden>{SHORT_FONT[f.family] ?? f.family}</small>
              </button>
            ))}
          </div>
          <div className="chips" role="group" aria-label="Weight and case">
            {font &&
              font.weights.length > 1 &&
              font.weights.map((w) => (
                <button key={w} className="chip" aria-pressed={closestWeight(s.font, s.weight) === w} onClick={() => set({ weight: w })}>
                  {WEIGHT_NAMES[w] ?? w}
                </button>
              ))}
            <button className="chip" aria-pressed={s.italic} onClick={() => set({ italic: !s.italic })}>
              <Italic size={16} aria-hidden />
              Italic
            </button>
            <button className="chip" aria-pressed={s.uppercase} onClick={() => set({ uppercase: !s.uppercase })}>
              <CaseUpper size={16} aria-hidden />
              All caps
            </button>
          </div>
          <Slider
            label="Size"
            value={s.size}
            min={0.02}
            max={0.3}
            step={0.0025}
            format={(v) => String(Math.round(v * 400))}
            onChange={(v) => set({ size: v })}
            {...gesture}
          />
        </>
      )}

      {tab === 'color' && <Swatches label="Text color" value={s.color} onChange={(c) => set({ color: c }, `style-color:${id}`)} />}

      {tab === 'outline' && (
        <>
          <Swatches
            label="Outline color"
            value={s.stroke}
            onChange={(c) => set(s.strokeWidth > 0 ? { stroke: c } : { stroke: c, strokeWidth: 0.08 }, `style-stroke:${id}`)}
          />
          <Slider
            label="Thickness"
            value={s.strokeWidth}
            min={0}
            max={0.2}
            step={0.005}
            format={off((v) => String(Math.round(v * 100)))}
            onChange={(v) => set({ strokeWidth: v })}
            {...gesture}
          />
        </>
      )}

      {tab === 'background' && (
        <>
          <Swatches
            label="Background color"
            value={s.bg}
            onChange={(c) => set(s.bgOpacity > 0 ? { bg: c } : { bg: c, bgOpacity: 1 }, `style-bg:${id}`)}
          />
          <Slider
            label="Opacity"
            value={s.bgOpacity}
            min={0}
            max={1}
            step={0.01}
            format={off((v) => `${Math.round(v * 100)}%`)}
            onChange={(v) => set({ bgOpacity: v })}
            {...gesture}
          />
          <Slider
            label="Roundness"
            value={s.bgRadius}
            min={0}
            max={0.5}
            step={0.01}
            format={(v) => `${Math.round(v * 200)}%`}
            onChange={(v) => set({ bgRadius: v })}
            disabled={s.bgOpacity <= 0}
            {...gesture}
          />
        </>
      )}

      {tab === 'shadow' && (
        <>
          <Swatches
            label="Shadow color"
            value={s.shadow}
            onChange={(c) => set(s.shadowBlur > 0 ? { shadow: c } : { shadow: c, shadowBlur: 0.15 }, `style-shadow:${id}`)}
          />
          <Slider
            label="Blur"
            value={s.shadowBlur}
            min={0}
            max={0.6}
            step={0.01}
            format={off((v) => String(Math.round(v * 100)))}
            onChange={(v) => set({ shadowBlur: v })}
            {...gesture}
          />
        </>
      )}

      {tab === 'layout' && (
        <>
          <Segmented
            label="Alignment"
            value={s.align}
            onChange={(v) => set({ align: v })}
            options={[
              { value: 'left', label: <IconLabel Icon={AlignLeft} text="Left" /> },
              { value: 'center', label: <IconLabel Icon={AlignCenter} text="Center" /> },
              { value: 'right', label: <IconLabel Icon={AlignRight} text="Right" /> },
            ]}
          />
          <Slider
            label="Letter spacing"
            value={s.letterSpacing}
            min={-0.05}
            max={0.3}
            step={0.005}
            origin={0}
            snaps={[0]}
            format={(v) => String(Math.round(v * 100))}
            onChange={(v) => set({ letterSpacing: v })}
            {...gesture}
          />
          <Slider
            label="Line height"
            value={s.lineHeight}
            min={0.8}
            max={2}
            step={0.05}
            snaps={[DEFAULT_TEXT_STYLE.lineHeight]}
            format={(v) => v.toFixed(2)}
            onChange={(v) => set({ lineHeight: v })}
            {...gesture}
          />
          <Slider
            label="Wrap width"
            value={s.maxWidth}
            min={0.3}
            max={1}
            step={0.01}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => set({ maxWidth: v })}
            {...gesture}
          />
        </>
      )}

      {tab === 'highlight' && hasWords && (
        <>
          <Toggle
            label="Highlight the spoken word"
            hint="Each word lights up as it’s said"
            checked={s.highlightOn}
            onChange={(v) => set({ highlightOn: v })}
          />
          <Swatches
            label="Highlight color"
            value={s.highlight}
            onChange={(c) => set({ highlight: c, highlightOn: true }, `style-hl:${id}`)}
          />
        </>
      )}

      {caption && (
        <Toggle
          label="Apply to all captions"
          checked={all}
          onChange={(v) => {
            applyToAllCaptions = v;
            setAll(v);
          }}
        />
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Stickers

const STICKERS: [string, string[]][] = [
  ['Reactions', ['😂', '🤣', '😭', '😍', '🥰', '😘', '😎', '🤩', '🥳', '😱', '😳', '🤯', '🥺', '😅', '😏', '🙄', '😤', '😡', '🤔', '🤫', '🤭', '😴', '🤤', '🤮', '💀', '👻', '🤡', '😈']],
  ['Hands', ['👀', '👏', '🙌', '🙏', '👍', '👎', '👌', '✌️', '🤞', '💪', '👉', '👇', '☝️', '🤝', '💅', '🤌']],
  ['Symbols', ['❤️', '💔', '💯', '🔥', '✨', '⭐', '🌟', '💥', '💫', '⚡', '💢', '💦', '💨', '❗', '❓', '‼️', '✅', '❌', '⚠️', '🚫', '🆕', '🔴']],
  ['Fun', ['🎉', '🎊', '🎁', '🎂', '🍾', '🥂', '🎵', '🎶', '🎤', '🎧', '📸', '🎬', '📍', '💰', '💸', '💎', '👑', '🏆', '🥇', '🚀', '🌈', '☀️', '🌙', '🍕', '🍿', '☕', '🐶', '🐱', '🦋', '🌸']],
];

export function StickerSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="Stickers" onClose={onClose} closeIcon="x">
      {STICKERS.map(([title, list]) => (
        <section key={title} className="emoji-section" aria-label={title}>
          <h3 className="section-title">{title}</h3>
          <div className="emoji-grid">
            {list.map((e) => (
              <button
                key={e}
                aria-label={`Add ${e}`}
                onClick={() => {
                  addSticker(e);
                  onClose();
                }}
              >
                {e}
              </button>
            ))}
          </div>
        </section>
      ))}
    </Sheet>
  );
}
