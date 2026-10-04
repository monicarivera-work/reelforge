import type { LucideIcon } from 'lucide-react';
import {
  ArrowRightLeft,
  AudioLines,
  Blend,
  Captions,
  ChevronLeft,
  CircleDashed,
  Copy,
  Crop,
  Diamond,
  Expand,
  FlipHorizontal2,
  Gauge,
  ImagePlus,
  Layers,
  Move,
  Music,
  PaintBucket,
  Palette,
  Pencil,
  Pipette,
  Ratio,
  Replace,
  RotateCw,
  Scissors,
  SlidersHorizontal,
  Smile,
  Snowflake,
  Sparkles,
  Trash,
  Type,
  Volume2,
  VolumeX,
  WandSparkles,
} from 'lucide-react';
import type { Item, MainItem, TrackKind } from '../types';
import { primeKeyboard, pickFiles } from '../lib/device';
import { pause } from '../state/runtime';
import { toast, useEditor, useTime, type SheetId } from '../state/store';
import {
  addText,
  deleteSelected,
  duplicateSelected,
  extractAudio,
  flipSelected,
  freezeFrame,
  replaceSelected,
  rotateSelected,
  splitAtPlayhead,
  targetMain,
  toggleFit,
  toggleKeyframe,
} from './actions';
import { useSelected } from './common';

interface Tool {
  key: string;
  label: string;
  Icon: LucideIcon;
  run: () => void;
  /** the sheet this tool opens (highlighted while open) */
  sheet?: SheetId;
  /** state of an on/off tool */
  pressed?: boolean;
  /** fill the icon (keyframe diamond) */
  filled?: boolean;
}

const ed = () => useEditor.getState();

function toggleSheet(id: SheetId, arg: string | null = null) {
  const s = ed();
  if (s.sheet === id && s.sheetArg === arg) s.closeSheet();
  else s.openSheet(id, arg);
}

const sheetTool = (sheet: SheetId, label: string, Icon: LucideIcon, arg: string | null = null): Tool => ({
  key: sheet,
  label,
  Icon,
  sheet,
  run: () => toggleSheet(sheet, arg),
});

/** Root tools that edit "the clip" act on the one under the playhead (selecting it). */
function forMain(sheet: SheetId, check?: (m: MainItem) => string | null) {
  return () => {
    const m = targetMain();
    if (!m) {
      toast('Move the playhead over a clip first');
      return;
    }
    const why = check?.(m);
    if (why) {
      toast(why);
      return;
    }
    ed().select(m.id);
    ed().openSheet(sheet);
  };
}

const ROOT_TOOLS: Tool[] = [
  sheetTool('media', 'Media', ImagePlus),
  sheetTool('audio', 'Audio', Music),
  { key: 'text', label: 'Text', Icon: Type, run: addText },
  sheetTool('captions', 'Captions', Captions),
  sheetTool('stickers', 'Stickers', Smile),
  sheetTool('overlay', 'Overlay', Layers),
  { key: 'split', label: 'Split', Icon: Scissors, run: splitAtPlayhead },
  {
    key: 'speed',
    label: 'Speed',
    Icon: Gauge,
    run: forMain('speed', (m) => (m.type === 'video' ? null : 'Speed works on video. Drag a photo’s edges to change how long it shows')),
  },
  { key: 'filters', label: 'Filters', Icon: Sparkles, run: forMain('filters', (m) => (m.type === 'color' ? 'Filters work on videos and photos' : null)) },
  { key: 'adjust', label: 'Adjust', Icon: SlidersHorizontal, run: forMain('adjust', (m) => (m.type === 'color' ? 'Adjust works on videos and photos' : null)) },
  sheetTool('canvas', 'Canvas', Ratio),
];

const replace = () => void pickFiles('video/*,image/*', false).then((f) => replaceSelected(f));

const editText = (id: string) => () => {
  primeKeyboard();
  pause();
  toggleSheet('textEdit', id);
};

function itemTools(item: Item, kind: TrackKind, index: number, keyframeHere: boolean): Tool[] {
  const split: Tool = { key: 'split', label: 'Split', Icon: Scissors, run: splitAtPlayhead };
  const del: Tool = { key: 'delete', label: 'Delete', Icon: Trash, run: deleteSelected };
  const dup: Tool = { key: 'duplicate', label: 'Duplicate', Icon: Copy, run: duplicateSelected };

  if (item.type === 'audio') {
    return [
      sheetTool('volume', 'Volume', item.muted ? VolumeX : Volume2),
      sheetTool('speed', 'Speed', Gauge),
      split,
      dup,
      del,
    ];
  }

  const anim = sheetTool('animation', 'Animation', WandSparkles);
  const keyframe: Tool = { key: 'keyframe', label: 'Keyframe', Icon: Diamond, run: toggleKeyframe, pressed: keyframeHere, filled: keyframeHere };
  const opacity = sheetTool('opacity', 'Opacity', Blend);
  const mask = sheetTool('mask', 'Mask', CircleDashed);
  const transition = kind === 'main' && index > 0 ? [sheetTool('transition', 'Transition', ArrowRightLeft, item.id)] : [];

  if (item.type === 'text') {
    return [
      { key: 'edit', label: 'Edit', Icon: Pencil, sheet: 'textEdit', run: editText(item.id) },
      sheetTool('textStyle', 'Style', Palette),
      del,
      split,
      anim,
      keyframe,
      opacity,
      dup,
    ];
  }

  if (item.type === 'color') {
    return [sheetTool('color', 'Color', PaintBucket), split, del, anim, ...transition, keyframe, opacity, mask, dup];
  }

  const look: Tool[] = [
    sheetTool('filters', 'Filters', Sparkles),
    sheetTool('adjust', 'Adjust', SlidersHorizontal),
    sheetTool('crop', 'Crop', Crop),
  ];
  const place: Tool[] = [
    keyframe,
    sheetTool('motion', 'Motion', Move),
    opacity,
    mask,
    sheetTool('chroma', 'Green screen', Pipette),
    { key: 'rotate', label: 'Rotate', Icon: RotateCw, run: rotateSelected },
    { key: 'flip', label: 'Flip', Icon: FlipHorizontal2, run: () => flipSelected('h'), pressed: item.flipH },
    { key: 'fill', label: 'Fill', Icon: Expand, run: toggleFit, pressed: item.fit === 'fill' },
  ];

  if (item.type === 'image') {
    return [split, del, anim, ...look, ...transition, ...place, { key: 'replace', label: 'Replace', Icon: Replace, run: replace }, dup];
  }

  return [
    split,
    sheetTool('speed', 'Speed', Gauge),
    sheetTool('volume', 'Volume', item.muted ? VolumeX : Volume2),
    del,
    anim,
    ...look,
    ...transition,
    ...place,
    ...(kind === 'main' ? [{ key: 'freeze', label: 'Freeze', Icon: Snowflake, run: () => void freezeFrame() }] : []),
    { key: 'extract', label: 'Extract audio', Icon: AudioLines, run: extractAudio },
    { key: 'replace', label: 'Replace', Icon: Replace, run: replace },
    dup,
  ];
}

const KIND_LABEL: Record<Item['type'], string> = {
  video: 'Video',
  image: 'Photo',
  color: 'Color clip',
  text: 'Text',
  audio: 'Audio',
};

export function Toolbar() {
  const { item, kind, index } = useSelected();
  const sheet = useEditor((s) => s.sheet);
  const fps = useEditor((s) => s.project?.fps ?? 30);
  const keyframeHere = useTime((s) => {
    if (!item || item.type === 'audio') return false;
    const local = s.time - item.start;
    const tol = 0.5 / fps;
    return item.keyframes.some((k) => Math.abs(k.t - local) <= tol);
  });

  const tools = item && kind ? itemTools(item, kind, index, keyframeHere) : ROOT_TOOLS;

  return (
    <nav className="toolbar" aria-label={item ? `${KIND_LABEL[item.type]} tools` : 'Tools'}>
      {item && (
        <button className="tool back" aria-label="Back to all tools" onClick={() => ed().select(null)}>
          <ChevronLeft size={26} />
        </button>
      )}
      {/* Remount per group so the strip starts scrolled to its first tool. */}
      <div className="scroller" key={item && kind ? `${kind}:${item.type}` : 'root'}>
        {tools.map(({ key, label, Icon, run, sheet: own, pressed, filled }) => {
          const open = !!own && own === sheet;
          return (
            <button
              key={key}
              className={`tool${open || pressed ? ' on' : ''}`}
              aria-pressed={pressed === undefined ? undefined : pressed}
              aria-expanded={own ? open : undefined}
              onClick={run}
            >
              <Icon size={22} fill={filled ? 'currentColor' : 'none'} aria-hidden />
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
