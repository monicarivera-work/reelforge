import { create } from 'zustand';
import { produce, setAutoFreeze, type Draft } from 'immer';
import type { Project } from '../types';
import { findItem, normalize, projectDuration } from '../lib/layout';
import { saveProject } from '../lib/db';
import { debounce } from '../lib/util';

// The preview/export engines only read projects; skipping deep-freeze keeps big edits fast.
setAutoFreeze(false);

const HISTORY = 100;
const MERGE_MS = 1500;

export type SheetId =
  | 'media'
  | 'overlay'
  | 'audio'
  | 'text'
  | 'captions'
  | 'stickers'
  | 'canvas'
  | 'export'
  | 'speed'
  | 'volume'
  | 'animation'
  | 'filters'
  | 'adjust'
  | 'crop'
  | 'motion'
  | 'mask'
  | 'opacity'
  | 'chroma'
  | 'transition'
  | 'textEdit'
  | 'textStyle'
  | 'color'
  | 'replace';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'success';
}

export interface Task {
  label: string;
  /** 0..1, or null for indeterminate */
  progress: number | null;
}

export interface ApplyOptions {
  /** coalesce consecutive edits with the same key (e.g. typing) into one undo step */
  merge?: string;
  /** set the selection after the edit (null clears it) */
  select?: string | null;
}

interface EditorState {
  project: Project | null;
  selectedId: string | null;
  sheet: SheetId | null;
  /** extra context for the open sheet (e.g. the clip a transition belongs to) */
  sheetArg: string | null;
  past: Project[];
  future: Project[];
  /** project snapshot taken when a continuous gesture (drag, slider) started */
  gestureBase: Project | null;
  /** timeline zoom in pixels per second */
  zoom: number;
  toasts: Toast[];
  task: Task | null;

  open(p: Project): void;
  close(): void;
  apply(recipe: (p: Draft<Project>) => void, opts?: ApplyOptions): void;
  beginGesture(): void;
  endGesture(): void;
  undo(): void;
  redo(): void;
  select(id: string | null): void;
  openSheet(sheet: SheetId, arg?: string | null): void;
  closeSheet(): void;
  setZoom(z: number): void;
  toast(text: string, kind?: Toast['kind']): void;
  dismissToast(id: number): void;
  setTask(t: Task | null): void;
}

let mergeKey: string | null = null;
let mergeAt = 0;
let toastSeq = 0;

let pending: Project | null = null;

function saveNow() {
  const p = pending;
  if (!p) return;
  pending = null;
  void saveProject({ ...p, updatedAt: Date.now() }).catch((e) => {
    console.error('save failed', e);
    useEditor.getState().toast('Could not save: device storage may be full', 'error');
  });
}

const saveLater = debounce(saveNow, 600);

function persist(p: Project) {
  pending = p;
  saveLater();
}

/** Writes any pending project changes immediately. */
export function flushSave() {
  saveNow();
}

function validSelection(p: Project | null, id: string | null): string | null {
  return p && id && findItem(p, id) ? id : null;
}

export const useEditor = create<EditorState>()((set, get) => ({
  project: null,
  selectedId: null,
  sheet: null,
  sheetArg: null,
  past: [],
  future: [],
  gestureBase: null,
  zoom: 60,
  toasts: [],
  task: null,

  open(p) {
    const proj = produce(p, (d) => normalize(d as Project));
    mergeKey = null;
    set({
      project: proj,
      selectedId: null,
      sheet: null,
      sheetArg: null,
      past: [],
      future: [],
      gestureBase: null,
      zoom: initialZoom(proj),
    });
  },

  close() {
    saveNow();
    set({ project: null, selectedId: null, sheet: null, sheetArg: null, past: [], future: [], gestureBase: null, task: null });
  },

  apply(recipe, opts = {}) {
    const { project, gestureBase, past, selectedId } = get();
    if (!project) return;
    const next = produce(project, (d) => {
      recipe(d);
      normalize(d as Project);
    });
    if (next === project) {
      if (opts.select !== undefined) set({ selectedId: validSelection(project, opts.select) });
      return;
    }
    let nextPast = past;
    let future = get().future;
    if (!gestureBase) {
      const now = performance.now();
      const merging = !!opts.merge && opts.merge === mergeKey && now - mergeAt < MERGE_MS;
      if (!merging) {
        nextPast = [...past, project].slice(-HISTORY);
        future = [];
      }
      mergeKey = opts.merge ?? null;
      mergeAt = now;
    }
    const sel = opts.select !== undefined ? opts.select : selectedId;
    set({ project: next, past: nextPast, future, selectedId: validSelection(next, sel) });
    persist(next);
  },

  beginGesture() {
    const { project, gestureBase } = get();
    if (project && !gestureBase) set({ gestureBase: project });
  },

  endGesture() {
    const { project, gestureBase, past } = get();
    if (!gestureBase) return;
    mergeKey = null;
    if (project && project !== gestureBase) {
      set({ gestureBase: null, past: [...past, gestureBase].slice(-HISTORY), future: [] });
    } else set({ gestureBase: null });
  },

  undo() {
    const { project, past, future, selectedId, gestureBase } = get();
    if (!project || !past.length || gestureBase) return;
    const prev = past[past.length - 1];
    mergeKey = null;
    set({
      project: prev,
      past: past.slice(0, -1),
      future: [project, ...future].slice(0, HISTORY),
      selectedId: validSelection(prev, selectedId),
    });
    persist(prev);
  },

  redo() {
    const { project, past, future, selectedId, gestureBase } = get();
    if (!project || !future.length || gestureBase) return;
    const next = future[0];
    mergeKey = null;
    set({
      project: next,
      past: [...past, project].slice(-HISTORY),
      future: future.slice(1),
      selectedId: validSelection(next, selectedId),
    });
    persist(next);
  },

  select(id) {
    const { project, selectedId, sheet } = get();
    const v = validSelection(project, id);
    if (v === selectedId) return;
    // Item-specific sheets make no sense once the selection changes.
    const keep = sheet && ROOT_SHEETS.has(sheet) ? sheet : null;
    set({ selectedId: v, sheet: keep, sheetArg: keep ? get().sheetArg : null });
  },

  openSheet(sheet, arg = null) {
    set({ sheet, sheetArg: arg });
  },

  closeSheet() {
    if (get().gestureBase) get().endGesture();
    set({ sheet: null, sheetArg: null });
  },

  setZoom(z) {
    set({ zoom: Math.min(800, Math.max(8, z)) });
  },

  toast(text, kind = 'info') {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts.slice(-2), { id, text, kind }] });
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 5000 : 2600);
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  setTask(t) {
    set({ task: t });
  },
}));

const ROOT_SHEETS = new Set<SheetId>(['media', 'overlay', 'audio', 'text', 'captions', 'stickers', 'canvas', 'export']);

function initialZoom(p: Project): number {
  const d = projectDuration(p);
  if (d <= 0) return 60;
  const w = typeof window !== 'undefined' ? window.innerWidth : 400;
  return Math.min(200, Math.max(10, (w * 0.8) / d));
}

/** Flush pending saves when the app is backgrounded or closed (iOS may kill it at any moment). */
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });
}

/** Playback position, updated every frame; kept separate so the editor doesn't re-render at 60 fps. */
export const useTime = create<{ time: number; playing: boolean }>()(() => ({ time: 0, playing: false }));

export const toast = (text: string, kind?: Toast['kind']) => useEditor.getState().toast(text, kind);

export function selectedItem(s: Pick<EditorState, 'project' | 'selectedId'>) {
  return s.project && s.selectedId ? findItem(s.project, s.selectedId) : null;
}
