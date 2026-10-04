import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { AudioItem, ColorItem, ImageItem, Item, TextItem, VideoItem, VisualItem } from '../../types';
import { findItem } from '../../lib/layout';
import { useEditor, type SheetId } from '../../state/store';
import { useSelected } from '../common';
import { AudioSheet } from './AudioSheet';
import { CanvasSheet } from './CanvasSheet';
import { CaptionsSheet } from './CaptionsSheet';
import {
  AdjustSheet,
  AnimationSheet,
  ChromaSheet,
  ColorSheet,
  FiltersSheet,
  MaskSheet,
  MotionSheet,
  OpacitySheet,
  SpeedSheet,
  TransitionSheet,
  VolumeSheet,
} from './ClipSheets';
import { CropSheet } from './CropSheet';
import { ExportSheet } from './ExportSheet';
import { MediaSheet } from './MediaSheet';
import { StickerSheet, TextEditSheet, TextStyleSheet } from './TextSheets';

const close = () => useEditor.getState().closeSheet();

const media = (it: Item) => it.type === 'video' || it.type === 'image';
const timed = (it: Item) => it.type === 'video' || it.type === 'audio';
const visual = (it: Item) => it.type !== 'audio';

/** Which items each item sheet can edit. */
const FITS: Partial<Record<SheetId, (it: Item) => boolean>> = {
  speed: timed,
  volume: timed,
  animation: visual,
  filters: media,
  adjust: media,
  crop: media,
  motion: media,
  mask: (it) => visual(it) && it.type !== 'text',
  opacity: visual,
  chroma: media,
  color: (it) => it.type === 'color',
  textEdit: (it) => it.type === 'text',
  textStyle: (it) => it.type === 'text',
  transition: (it) => it.type !== 'audio' && it.type !== 'text',
};

export function SheetHost() {
  const { sheet, arg } = useEditor(useShallow((s) => ({ sheet: s.sheet, arg: s.sheetArg })));
  const sel = useSelected();
  // Transition and text-edit sheets name their item explicitly.
  const argItem = useEditor((s) => (s.project && s.sheetArg ? (findItem(s.project, s.sheetArg)?.item ?? null) : null));
  // A transition belongs to a main-track clip that has a clip before it.
  const argMainIndex = useEditor((s) => (s.project && s.sheetArg ? s.project.main.findIndex((m) => m.id === s.sheetArg) : -1));

  const creating = sheet === 'text' || (sheet === 'textEdit' && arg === 'new');
  const fits = sheet ? FITS[sheet] : undefined;
  const target = sheet === 'transition' || (sheet === 'textEdit' && !creating) ? argItem : sel.item;
  const invalid =
    (!!fits && !creating && !(target && fits(target))) || (sheet === 'transition' && argMainIndex < 1) || sheet === 'replace';

  useEffect(() => {
    if (invalid) close();
  }, [invalid]);

  if (!sheet || invalid) return null;

  switch (sheet) {
    case 'media':
      return <MediaSheet target="main" onClose={close} />;
    case 'overlay':
      return <MediaSheet target="overlay" onClose={close} />;
    case 'audio':
      return <AudioSheet onClose={close} />;
    case 'captions':
      return <CaptionsSheet onClose={close} />;
    case 'stickers':
      return <StickerSheet onClose={close} />;
    case 'canvas':
      return <CanvasSheet onClose={close} />;
    case 'export':
      return <ExportSheet onClose={close} autoStart={arg === 'start'} />;
    case 'text':
    case 'textEdit':
      return creating ? (
        <TextEditSheet key="new" item={null} onClose={close} />
      ) : (
        <TextEditSheet key={target!.id} item={target as TextItem} onClose={close} />
      );
    default:
      break;
  }

  const it = target!;
  const key = it.id;
  switch (sheet) {
    case 'textStyle':
      return <TextStyleSheet key={key} item={it as TextItem} onClose={close} />;
    case 'speed':
      return <SpeedSheet key={key} item={it as VideoItem | AudioItem} onClose={close} />;
    case 'volume':
      return <VolumeSheet key={key} item={it as VideoItem | AudioItem} onClose={close} />;
    case 'animation':
      return <AnimationSheet key={key} item={it as VisualItem} onClose={close} />;
    case 'filters':
      return <FiltersSheet key={key} item={it as VideoItem | ImageItem} onClose={close} />;
    case 'adjust':
      return <AdjustSheet key={key} item={it as VideoItem | ImageItem} onClose={close} />;
    case 'crop':
      return <CropSheet key={key} item={it as VideoItem | ImageItem} onClose={close} />;
    case 'motion':
      return <MotionSheet key={key} item={it as VideoItem | ImageItem} onClose={close} />;
    case 'mask':
      return <MaskSheet key={key} item={it as VisualItem} onClose={close} />;
    case 'opacity':
      return <OpacitySheet key={key} item={it as VisualItem} onClose={close} />;
    case 'chroma':
      return <ChromaSheet key={key} item={it as VideoItem | ImageItem} onClose={close} />;
    case 'color':
      return <ColorSheet key={key} item={it as ColorItem} onClose={close} />;
    case 'transition':
      return <TransitionSheet key={key} item={it as VideoItem | ImageItem | ColorItem} onClose={close} />;
    default:
      return null;
  }
}
