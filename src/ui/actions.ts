/**
 * Editing commands shared by the toolbar, keyboard shortcuts and sheets.
 */
import type {
  Aspect,
  AudioItem,
  ImageItem,
  Item,
  MainItem,
  MediaAsset,
  Project,
  TextItem,
  TextStyle,
  VideoItem,
  Visual,
  VisualItem,
} from '../types';
import { aspectFor, audioItem, colorItem, imageItem, textItem, videoItem } from '../lib/defaults';
import { primeKeyboard } from '../lib/device';
import { haptic } from '../lib/haptics';
import {
  deleteItem,
  duplicateItem,
  findItem,
  itemEnd,
  mainEnd,
  mainIndexAt,
  mainInsertIndex,
  MIN_DUR,
  pickLane,
  sampleKeyframes,
  sourceTime,
  splitItem,
  upsertKeyframe,
  type KeyValues,
} from '../lib/layout';
import { captureFrame, getAsset, importFiles } from '../lib/media';
import { clamp, formatClock } from '../lib/util';
import { now, pause, seek } from '../state/runtime';
import { selectedItem, toast, useEditor, type ApplyOptions } from '../state/store';

const ed = () => useEditor.getState();

// ---------------------------------------------------------------------------
// Files picked on Home for a brand-new project, imported once the editor opens.

const pendingImports = new Map<string, File[]>();

export function setPendingImport(projectId: string, files: File[]) {
  pendingImports.set(projectId, files);
}

export function takePendingImport(projectId: string): File[] | null {
  const f = pendingImports.get(projectId) ?? null;
  pendingImports.delete(projectId);
  return f;
}

// ---------------------------------------------------------------------------
// Text

const TEXT_STYLE_KEY = 'rf-text-style';

/** The look of the last text preset the user picked, reused for new text. */
export function lastTextStyle(): Partial<TextStyle> | undefined {
  try {
    const raw = localStorage.getItem(TEXT_STYLE_KEY);
    return raw ? (JSON.parse(raw) as Partial<TextStyle>) : undefined;
  } catch {
    return undefined;
  }
}

export function rememberTextStyle(style: Partial<TextStyle>) {
  try {
    localStorage.setItem(TEXT_STYLE_KEY, JSON.stringify(style));
  } catch {
    /* ignore */
  }
}

/** Opens the text editor for a new text. Call synchronously from a tap so the keyboard opens on iOS. */
export function addText() {
  primeKeyboard();
  pause();
  ed().openSheet('textEdit', 'new');
}

/** Creates a text item at the playhead and selects it; returns its id. */
export function createText(text: string, style?: Partial<TextStyle>, merge?: string): string {
  const it = textItem(text, now(), 3, style ?? lastTextStyle());
  ed().apply(
    (d) => {
      it.lane = pickLane(d.texts as Item[], it.start, itemEnd(it));
      d.texts.push(it);
    },
    { select: it.id, merge: merge ?? `text:${it.id}` },
  );
  return it.id;
}

export function addSticker(emoji: string) {
  pause();
  const it: TextItem = textItem(emoji, now(), 3, { size: 0.16, shadowBlur: 0, strokeWidth: 0, bgOpacity: 0, highlightOn: false });
  ed().apply(
    (d) => {
      it.lane = pickLane(d.texts as Item[], it.start, itemEnd(it));
      d.texts.push(it);
    },
    { select: it.id },
  );
  haptic('light');
}

// ---------------------------------------------------------------------------
// Pose (position / scale / rotation / opacity) edits that respect keyframes

/** The item's pose at item-local time `local` (keyframed or base values). */
export function currentPose(it: VisualItem, local: number): KeyValues {
  return sampleKeyframes(it.keyframes, local) ?? { ...it.transform, opacity: it.opacity };
}

/**
 * Writes pose values computed from `base` (the item when the gesture began): as a keyframe at the
 * playhead when the item is keyframed, otherwise to its base transform.
 */
export function writePose(d: VisualItem, base: VisualItem, local: number, v: KeyValues, fps = 30) {
  if (base.keyframes.length) {
    const t = clamp(local, 0, base.duration);
    d.keyframes = upsertKeyframe(
      base.keyframes.map((k) => ({ ...k })),
      { t, ...v },
      0.5 / fps,
    );
  } else {
    d.transform = { x: v.x, y: v.y, scale: v.scale, rotation: v.rotation };
    d.opacity = v.opacity;
  }
}

/** Runs an undoable edit and returns the recipe's result. */
export function run<T>(fn: (p: Project) => T, opts?: ApplyOptions): T {
  let out!: T;
  ed().apply((d) => {
    out = fn(d as Project);
  }, opts);
  return out;
}

/** The selected main-track clip, or the one under the playhead. */
export function targetMain(): MainItem | null {
  const s = ed();
  const p = s.project;
  if (!p) return null;
  const sel = selectedItem(s);
  if (sel?.kind === 'main') return sel.item as MainItem;
  const i = mainIndexAt(p.main, now());
  return i >= 0 ? p.main[i] : null;
}

/** For root tools that edit "the clip": selects the clip under the playhead so its sheet can open. */
export function selectTargetMain(): MainItem | null {
  const m = targetMain();
  if (!m) {
    toast('Move the playhead over a clip first');
    return null;
  }
  if (ed().selectedId !== m.id) ed().select(m.id);
  return m;
}

const VISUAL_KEYS: (keyof Visual)[] = [
  'transform',
  'opacity',
  'flipH',
  'flipV',
  'fit',
  'crop',
  'filter',
  'filterAmount',
  'adjust',
  'animIn',
  'animOut',
  'motion',
  'keyframes',
  'blend',
  'mask',
  'chroma',
];

function copyVisual(from: Visual, to: Visual) {
  for (const k of VISUAL_KEYS) (to as unknown as Record<string, unknown>)[k] = structuredClone(from[k]);
}

// ---------------------------------------------------------------------------

export function splitAtPlayhead() {
  const s = ed();
  const p = s.project;
  if (!p) return;
  pause();
  const t = now();
  const sel = selectedItem(s);
  let id: string | null = null;
  if (sel) {
    if (t <= sel.item.start || t >= itemEnd(sel.item)) {
      toast('Move the playhead over the selected clip to split it');
      return;
    }
    id = sel.item.id;
  } else {
    const i = mainIndexAt(p.main, t);
    if (i >= 0) id = p.main[i].id;
  }
  if (!id) {
    toast('Move the playhead over a clip to split it');
    return;
  }
  const target = id;
  const right = run((d) => splitItem(d, target, t));
  if (right) haptic('light');
  else toast('Too close to the edge of the clip to split');
}

export function deleteSelected() {
  const s = ed();
  const sel = selectedItem(s);
  if (!sel) return;
  const id = sel.item.id;
  s.apply((d) => void deleteItem(d as Project, id), { select: null });
  haptic('light');
}

export function duplicateSelected() {
  const s = ed();
  const sel = selectedItem(s);
  if (!sel) return;
  const id = sel.item.id;
  const copy = run((d) => duplicateItem(d, id));
  if (copy) {
    ed().select(copy);
    const it = findItem(ed().project!, copy)?.item;
    if (it && sel.kind === 'main') seek(it.start);
  }
}

export function rotateSelected() {
  const sel = selectedItem(ed());
  if (!sel || sel.item.type === 'audio') return;
  const id = sel.item.id;
  run((p) => {
    const it = findItem(p, id)?.item as VisualItem | undefined;
    if (!it) return;
    const r = it.transform.rotation + 90;
    it.transform.rotation = ((((r + 180) % 360) + 360) % 360) - 180;
    for (const k of it.keyframes) k.rotation += 90;
  });
}

export function flipSelected(axis: 'h' | 'v' = 'h') {
  const sel = selectedItem(ed());
  if (!sel || sel.item.type === 'audio') return;
  const id = sel.item.id;
  run((p) => {
    const it = findItem(p, id)?.item as VisualItem | undefined;
    if (!it) return;
    if (axis === 'h') it.flipH = !it.flipH;
    else it.flipV = !it.flipV;
  });
}

export function toggleFit() {
  const sel = selectedItem(ed());
  if (!sel || (sel.item.type !== 'video' && sel.item.type !== 'image')) return;
  const id = sel.item.id;
  const fill = sel.item.fit !== 'fill';
  run((p) => {
    const it = findItem(p, id)?.item as VideoItem | ImageItem | undefined;
    if (it) it.fit = fill ? 'fill' : 'fit';
  });
  toast(fill ? 'Fill: the clip covers the frame' : 'Fit: the whole clip is visible');
}

/** Adds or removes a keyframe for the selected visual item at the playhead. */
export function toggleKeyframe() {
  const sel = selectedItem(ed());
  if (!sel || sel.item.type === 'audio') return;
  const it = sel.item as VisualItem;
  pause();
  const local = now() - it.start;
  if (local < -1e-3 || local > it.duration + 1e-3) {
    toast('Move the playhead over the clip to add a keyframe');
    return;
  }
  const tol = 0.5 / (ed().project?.fps ?? 30);
  const existing = it.keyframes.some((k) => Math.abs(k.t - local) <= tol);
  const id = it.id;
  run((p) => {
    const d = findItem(p, id)?.item as VisualItem | undefined;
    if (!d) return;
    if (existing) {
      d.keyframes = d.keyframes.filter((k) => Math.abs(k.t - local) > tol);
      return;
    }
    const cur = sampleKeyframes(d.keyframes, local) ?? { ...d.transform, opacity: d.opacity };
    d.keyframes = upsertKeyframe(d.keyframes, { t: Math.max(0, Math.min(d.duration, local)), ...cur }, tol);
  });
  haptic('light');
  if (!existing && it.keyframes.length === 0) toast('Keyframe added. Move the playhead, then drag the clip to animate it');
}

// ---------------------------------------------------------------------------
// Media

export interface InsertOptions {
  /** append to the end of the main track instead of at the playhead */
  at?: 'end';
  /** match the project's format to the first clip (used when the timeline is empty) */
  autoAspect?: boolean;
}

/** Imports picked files and puts visual media on the main track or as overlays; audio becomes music. */
export async function importAndInsert(files: File[], target: 'main' | 'overlay', opts: InsertOptions = {}) {
  if (!files.length) return;
  const s = ed();
  s.setTask({ label: files.length > 1 ? `Importing 1 of ${files.length}…` : 'Importing…', progress: 0 });
  try {
    const { assets, errors } = await importFiles(files, (done, total) => {
      if (done < total) ed().setTask({ label: total > 1 ? `Importing ${done + 1} of ${total}…` : 'Importing…', progress: done / total });
    });
    if (errors.length === 1) toast(`Couldn't import ${errors[0]}`, 'error');
    else if (errors.length > 1) toast(`${errors.length} files couldn't be imported`, 'error');
    if (!ed().project) return;
    const visual = assets.filter((a) => a.kind !== 'audio');
    const audio = assets.filter((a) => a.kind === 'audio');
    if (visual.length) insertMedia(visual, target, opts);
    for (const a of audio) addAudio(a, 'music');
    if (assets.some((a) => a.kind === 'video' && !a.canDecodeVideo)) {
      toast('Some video uses a format this device may not export. If saving fails, convert it to H.264 MP4.', 'error');
    }
  } finally {
    ed().setTask(null);
  }
}

export function insertMedia(assets: MediaAsset[], target: 'main' | 'overlay', opts: InsertOptions = {}) {
  const p = ed().project;
  if (!p || !assets.length) return;
  pause();
  const t = now();
  if (target === 'main') {
    const idx = opts.at === 'end' ? p.main.length : mainInsertIndex(p.main, t);
    const items = assets.map((a) => (a.kind === 'video' ? videoItem(a) : imageItem(a)));
    let aspect: Aspect | null = null;
    if (opts.autoAspect && !p.main.length) {
      const first = assets.find((a) => a.width > 0 && a.height > 0);
      if (first) aspect = aspectFor(first.width, first.height);
    }
    ed().apply((d) => {
      d.main.splice(idx, 0, ...(items as MainItem[]));
      if (aspect) d.aspect = aspect;
    });
    const first = ed().project!.main.find((m) => m.id === items[0].id);
    if (first) seek(first.start);
    return;
  }
  let start = t;
  let last = '';
  const added: MainItem[] = [];
  for (const a of assets) {
    const it = a.kind === 'video' ? videoItem(a, start, true) : imageItem(a, start, 3, true);
    added.push(it);
    start += it.duration;
  }
  ed().apply((d) => {
    for (const it of added) {
      it.lane = pickLane(d.overlays as Item[], it.start, itemEnd(it));
      d.overlays.push(it);
      last = it.id;
    }
  });
  if (last) ed().select(last);
}

export function addColorClip(color: string, target: 'main' | 'overlay') {
  const p = ed().project;
  if (!p) return;
  pause();
  const t = now();
  if (target === 'main') {
    const it = colorItem(color, 0, 3);
    const idx = mainInsertIndex(p.main, t);
    ed().apply((d) => void d.main.splice(idx, 0, it));
    const added = ed().project!.main.find((m) => m.id === it.id);
    if (added) seek(added.start);
  } else {
    const it = colorItem(color, t, 3, true);
    ed().apply(
      (d) => {
        it.lane = pickLane(d.overlays as Item[], it.start, itemEnd(it));
        d.overlays.push(it);
      },
      { select: it.id },
    );
  }
}

/** Where the picture ends (main clips, overlays and text). */
function visualEnd(p: Project): number {
  let e = mainEnd(p);
  for (const it of [...p.overlays, ...p.texts]) e = Math.max(e, itemEnd(it));
  return e;
}

export function addAudio(asset: MediaAsset, role: AudioItem['role'], start = now(), name?: string, select = false) {
  const it = audioItem(asset, start, role, name ?? prettyName(asset.name));
  const p = ed().project;
  // A long song shouldn't stretch the video with black frames: end it with the picture.
  const room = role === 'music' && p ? visualEnd(p) - start : 0;
  const trimmed = room >= 1 && it.duration > room + 0.05;
  if (trimmed) {
    it.duration = room;
    it.fadeOut = Math.min(1, room / 4);
  }
  ed().apply(
    (d) => {
      it.lane = pickLane(d.audios as Item[], it.start, itemEnd(it));
      d.audios.push(it);
    },
    select ? { select: it.id } : undefined,
  );
  if (trimmed) toast('Music trimmed to end with your video. Drag its edge to change.');
  return it.id;
}

export function prettyName(file: string): string {
  return file.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[_]+/g, ' ').trim() || 'Audio';
}

export function extractAudio() {
  const sel = selectedItem(ed());
  if (!sel || sel.item.type !== 'video') return;
  const v = sel.item as VideoItem;
  const asset = getAsset(v.mediaId);
  if (!asset?.hasAudio) {
    toast('This clip has no sound');
    return;
  }
  const a = audioItem(asset, v.start, 'extracted', `${prettyName(asset.name)} audio`);
  a.in = v.in;
  a.speed = v.speed;
  a.duration = v.duration;
  a.volume = v.volume;
  a.fadeIn = v.fadeIn;
  a.fadeOut = v.fadeOut;
  ed().apply(
    (d) => {
      a.lane = pickLane(d.audios as Item[], a.start, itemEnd(a));
      d.audios.push(a);
      const vv = findItem(d as Project, v.id)?.item as VideoItem | undefined;
      if (vv) vv.muted = true;
    },
    { select: a.id },
  );
  toast('Sound moved to its own track', 'success');
}

/** Adds `start`–`end` (seconds into the clip's video) of a clip's sound at the playhead. The clip keeps its own sound. */
export function addSoundbite(v: VideoItem, start: number, end: number) {
  const asset = getAsset(v.mediaId);
  if (!asset?.hasAudio) {
    toast('This clip has no sound');
    return;
  }
  const a = audioItem(asset, now(), 'extracted', `${prettyName(asset.name)} ${formatClock(start)}–${formatClock(end)}`);
  a.in = start;
  a.duration = end - start;
  ed().apply(
    (d) => {
      a.lane = pickLane(d.audios as Item[], a.start, itemEnd(a));
      d.audios.push(a);
    },
    { select: a.id },
  );
  toast('Soundbite added to the audio track', 'success');
}

/** Swaps the media of the selected video/photo, keeping its timing and look. */
export async function replaceSelected(files: File[]) {
  const sel = selectedItem(ed());
  const file = files[0];
  if (!sel || !file || (sel.item.type !== 'video' && sel.item.type !== 'image')) return;
  const id = sel.item.id;
  ed().setTask({ label: 'Importing…', progress: null });
  try {
    const { assets, errors } = await importFiles([file]);
    const asset = assets[0];
    if (!asset) {
      toast(errors[0] ? `Couldn't import ${errors[0]}` : 'Could not import that file', 'error');
      return;
    }
    if (asset.kind === 'audio') {
      toast('Choose a video or photo to replace this clip', 'error');
      return;
    }
    run((p) => {
      const f = findItem(p, id);
      if (!f) return;
      const old = f.item as VideoItem | ImageItem;
      let n: VideoItem | ImageItem;
      if (asset.kind === 'video') {
        const vi = videoItem(asset, old.start, f.kind !== 'main');
        vi.duration = Math.min(old.duration, Math.max(MIN_DUR, asset.duration));
        if (old.type === 'video') {
          vi.volume = old.volume;
          vi.muted = old.muted;
          vi.fadeIn = old.fadeIn;
          vi.fadeOut = old.fadeOut;
        }
        n = vi;
      } else {
        n = imageItem(asset, old.start, old.duration, f.kind !== 'main');
      }
      copyVisual(old, n);
      n.crop = { l: 0, t: 0, r: 0, b: 0 };
      n.id = old.id;
      n.lane = old.lane;
      if (old.transition) n.transition = { ...old.transition };
      (p[f.kind] as Item[])[f.index] = n;
    });
    toast('Clip replaced', 'success');
  } finally {
    ed().setTask(null);
  }
}

/** Inserts a 2-second still of the current frame, splitting the video at the playhead. */
export async function freezeFrame() {
  const sel = selectedItem(ed());
  if (!sel || sel.kind !== 'main' || sel.item.type !== 'video') return;
  const v = sel.item as VideoItem;
  pause();
  const t = now();
  if (t < v.start || t > itemEnd(v)) {
    toast('Move the playhead over the clip first');
    return;
  }
  const asset = getAsset(v.mediaId);
  if (!asset) return;
  ed().setTask({ label: 'Capturing frame…', progress: null });
  try {
    const st = Math.min(sourceTime(v, t), Math.max(0, asset.duration - 0.05));
    const blob = await captureFrame(asset, st);
    const { assets } = await importFiles([new File([blob], `${prettyName(asset.name)} frame.jpg`, { type: 'image/jpeg' })]);
    const img = assets[0];
    if (!img) throw new Error('import failed');
    const still = imageItem(img, 0, 2);
    copyVisual(v, still);
    const kv = sampleKeyframes(v.keyframes, t - v.start);
    if (kv) {
      still.transform = { x: kv.x, y: kv.y, scale: kv.scale, rotation: kv.rotation };
      still.opacity = kv.opacity;
    }
    still.keyframes = [];
    still.animIn = { type: 'none', duration: 0.5 };
    still.animOut = { type: 'none', duration: 0.5 };
    still.motion = 'none';
    run(
      (p) => {
        const local = t - v.start;
        let at: number;
        if (local < MIN_DUR) at = p.main.findIndex((m) => m.id === v.id);
        else {
          splitItem(p, v.id, t);
          at = p.main.findIndex((m) => m.id === v.id) + 1;
        }
        p.main.splice(Math.max(0, at), 0, still);
      },
      { select: still.id },
    );
    const added = ed().project!.main.find((m) => m.id === still.id);
    if (added) seek(added.start);
    toast('Freeze frame added', 'success');
  } catch (e) {
    console.error(e);
    toast('Could not capture this frame', 'error');
  } finally {
    ed().setTask(null);
  }
}
