export type Aspect = '9:16' | '16:9' | '1:1' | '4:5' | '3:4' | '4:3' | '21:9';

export const ASPECTS: { id: Aspect; hint: string; w: number; h: number }[] = [
  { id: '9:16', hint: 'TikTok · Reels · Shorts', w: 9, h: 16 },
  { id: '16:9', hint: 'YouTube', w: 16, h: 9 },
  { id: '1:1', hint: 'Square', w: 1, h: 1 },
  { id: '4:5', hint: 'Instagram feed', w: 4, h: 5 },
  { id: '3:4', hint: 'Portrait', w: 3, h: 4 },
  { id: '4:3', hint: 'Classic', w: 4, h: 3 },
  { id: '21:9', hint: 'Cinematic', w: 21, h: 9 },
];

export type MediaKind = 'video' | 'image' | 'audio';

export interface MediaAsset {
  id: string;
  name: string;
  kind: MediaKind;
  mime: string;
  size: number;
  /** seconds; 0 for images */
  duration: number;
  /** display dimensions (rotation metadata applied) */
  width: number;
  height: number;
  hasAudio: boolean;
  /** whether WebCodecs (through Mediabunny) can decode the tracks */
  canDecodeVideo: boolean;
  canDecodeAudio: boolean;
  createdAt: number;
}

export interface Transform {
  /** offset of the item center from the canvas center, as a fraction of canvas width */
  x: number;
  /** offset of the item center from the canvas center, as a fraction of canvas height */
  y: number;
  scale: number;
  /** degrees, clockwise */
  rotation: number;
}

export interface Adjust {
  brightness: number;
  contrast: number;
  saturation: number;
  exposure: number;
  temperature: number;
  tint: number;
  highlights: number;
  shadows: number;
  fade: number;
  vignette: number;
  grain: number;
  sharpen: number;
}

export interface Keyframe {
  /** seconds relative to the item start */
  t: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
}

export type AnimType =
  | 'none'
  | 'fade'
  | 'zoomIn'
  | 'zoomOut'
  | 'slideUp'
  | 'slideDown'
  | 'slideLeft'
  | 'slideRight'
  | 'pop'
  | 'spin'
  | 'typewriter';

export interface Anim {
  type: AnimType;
  duration: number;
}

export type Motion = 'none' | 'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight' | 'panUp' | 'panDown';
export type BlendMode = 'normal' | 'screen' | 'multiply' | 'add';
export type MaskShape = 'none' | 'circle' | 'rounded';

export interface Crop {
  /** fractions of the source cut away from each side */
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface Visual {
  transform: Transform;
  opacity: number;
  flipH: boolean;
  flipV: boolean;
  fit: 'fit' | 'fill';
  crop: Crop;
  filter: string;
  filterAmount: number;
  adjust: Adjust;
  animIn: Anim;
  animOut: Anim;
  motion: Motion;
  keyframes: Keyframe[];
  blend: BlendMode;
  mask: { shape: MaskShape; radius: number; feather: number };
  chroma: { enabled: boolean; color: string; similarity: number; smoothness: number };
}

export interface AudioProps {
  /** 0..2, 1 = 100% */
  volume: number;
  muted: boolean;
  fadeIn: number;
  fadeOut: number;
}

export type TransitionType =
  | 'none'
  | 'fade'
  | 'black'
  | 'white'
  | 'slideLeft'
  | 'slideRight'
  | 'slideUp'
  | 'slideDown'
  | 'wipeLeft'
  | 'wipeRight'
  | 'wipeUp'
  | 'wipeDown'
  | 'zoomIn'
  | 'zoomOut'
  | 'spin'
  | 'circle'
  | 'blur';

export interface Transition {
  type: TransitionType;
  duration: number;
}

interface ItemCommon {
  id: string;
  /** timeline start in seconds (main-track items are laid out automatically) */
  start: number;
  /** timeline duration in seconds */
  duration: number;
  lane: number;
}

export interface VideoItem extends ItemCommon, Visual, AudioProps {
  type: 'video';
  mediaId: string;
  /** source in-point in seconds */
  in: number;
  speed: number;
  /** transition from the previous main-track item into this one */
  transition?: Transition;
}

export interface ImageItem extends ItemCommon, Visual {
  type: 'image';
  mediaId: string;
  transition?: Transition;
}

export interface ColorItem extends ItemCommon, Visual {
  type: 'color';
  color: string;
  transition?: Transition;
}

export interface Word {
  text: string;
  /** seconds relative to the item start */
  start: number;
  end: number;
}

export interface TextStyle {
  font: string;
  weight: number;
  italic: boolean;
  /** font size as a fraction of min(canvasW, canvasH) */
  size: number;
  color: string;
  align: 'left' | 'center' | 'right';
  stroke: string;
  /** fraction of the font size; 0 disables the outline */
  strokeWidth: number;
  bg: string;
  /** 0 disables the background box */
  bgOpacity: number;
  /** fraction of the font size */
  bgRadius: number;
  shadow: string;
  /** 0 disables the shadow; fraction of the font size */
  shadowBlur: number;
  uppercase: boolean;
  /** fraction of the font size */
  letterSpacing: number;
  lineHeight: number;
  /** wrap width as a fraction of canvas width */
  maxWidth: number;
  highlight: string;
  highlightOn: boolean;
}

export interface TextItem extends ItemCommon, Visual {
  type: 'text';
  text: string;
  style: TextStyle;
  caption?: boolean;
  words?: Word[];
}

export interface AudioItem extends ItemCommon, AudioProps {
  type: 'audio';
  mediaId: string;
  in: number;
  speed: number;
  role: 'music' | 'voice' | 'sfx' | 'extracted';
  name: string;
}

export type MainItem = VideoItem | ImageItem | ColorItem;
export type OverlayItem = VideoItem | ImageItem | ColorItem;
export type VisualItem = VideoItem | ImageItem | ColorItem | TextItem;
export type Item = VideoItem | ImageItem | ColorItem | TextItem | AudioItem;
export type TrackKind = 'main' | 'overlays' | 'texts' | 'audios';

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  version: 1;
  aspect: Aspect;
  fps: number;
  background: { mode: 'blur' | 'color'; color: string; blur: number };
  main: MainItem[];
  overlays: OverlayItem[];
  texts: TextItem[];
  audios: AudioItem[];
}

export function isVisual(item: Item): item is VisualItem {
  return item.type !== 'audio';
}

export function isTimedMedia(item: Item): item is VideoItem | AudioItem {
  return item.type === 'video' || item.type === 'audio';
}

/** A clip saved to the clip library (the file itself is stored next to it). */
export interface ClipMeta {
  id: string;
  name: string;
  kind: 'video' | 'audio';
  mime: string;
  /** file name with extension, used when sharing or saving */
  fileName: string;
  size: number;
  /** seconds */
  duration: number;
  /** pixels; 0 for audio */
  width: number;
  height: number;
  folderId: string | null;
  /** where it came from: a YouTube title, a file name or a link */
  source?: string;
  /** YouTube video ID when it came from YouTube */
  youtubeId?: string;
  /** TikTok or Instagram post link when it came from one */
  sourceUrl?: string;
  /** seconds into the source */
  start: number;
  end: number;
  createdAt: number;
}

export interface ClipFolder {
  id: string;
  name: string;
  createdAt: number;
}
