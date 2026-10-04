import { ChevronDown, ChevronLeft, Download, LoaderCircle, Maximize2, Minimize2, Pause, Play, Redo2, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { backDepth, settled, useBack } from '../lib/back';
import { getProject, projectMediaIds } from '../lib/db';
import { projectDuration } from '../lib/layout';
import { ensurePeaks, ensureThumbs, loadAssets } from '../lib/media';
import { goHome } from '../lib/route';
import { formatTime, nextFrame } from '../lib/util';
import { duration, now, pause, seek, togglePlay } from '../state/runtime';
import { flushSave, useEditor, useTime } from '../state/store';
import { deleteSelected, duplicateSelected, importAndInsert, splitAtPlayhead, takePendingImport } from './actions';
import { loadPrefs } from './common';
import { promptDialog } from './dialog';
import { Preview } from './Preview';
import { SheetHost } from './sheets';
import { EXPORT_DEFAULTS, EXPORT_PREFS_KEY, resolutionLabel } from './sheets/ExportSheet';
import { Timeline } from './Timeline';
import { Toolbar } from './Toolbar';

export function Editor({ id }: { id: string }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [focus, setFocus] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const p = await getProject(id);
      if (!alive) return;
      if (!p) {
        setStatus('missing');
        return;
      }
      const ids = projectMediaIds(p);
      await loadAssets(ids);
      if (!alive) return;
      for (const m of ids) {
        void ensureThumbs(m);
        void ensurePeaks(m);
      }
      useTime.setState({ time: 0, playing: false });
      useEditor.getState().open(p);
      setStatus('ready');
      const files = takePendingImport(id);
      if (files?.length) {
        void importAndInsert(files, 'main', { autoAspect: true }).then(() => {
          // A new project starts with its first import; Undo shouldn't take it back to empty.
          const s = useEditor.getState();
          if (!alive || s.project?.id !== id) return;
          const past = s.past.filter((q) => q.main.length || q.overlays.length || q.texts.length || q.audios.length);
          if (past.length !== s.past.length) useEditor.setState({ past });
        });
      }
    })().catch((e) => {
      console.error(e);
      if (alive) setStatus('missing');
    });
    return () => {
      alive = false;
      useEditor.getState().close();
    };
  }, [id]);

  useBack(focus, () => setFocus(false));
  useShortcuts(status === 'ready');

  if (status === 'loading') {
    return (
      <div className="center-screen" role="status">
        <LoaderCircle className="spin" size={28} aria-hidden />
        <span>Opening project…</span>
      </div>
    );
  }
  if (status === 'missing') {
    return (
      <div className="center-screen">
        <b style={{ color: 'var(--text)', fontSize: 17 }}>Project not found</b>
        <span>It may have been deleted, or this device's storage was cleared.</span>
        <button className="secondary-btn" onClick={goHome}>
          Back to projects
        </button>
      </div>
    );
  }

  const toggleFocus = () => {
    if (!focus) {
      useEditor.getState().closeSheet();
      useEditor.getState().select(null);
    }
    setFocus(!focus);
  };

  return (
    <div className={`editor${focus ? ' focus' : ''}`}>
      <TopBar />
      <Preview focus={focus} />
      <Transport focus={focus} onToggleFocus={toggleFocus} />
      <Timeline />
      <Toolbar />
      <SheetHost />
    </div>
  );
}

/** Saves and returns to the project list once open sheets have released their history entries. */
async function leave() {
  pause();
  useEditor.getState().closeSheet();
  await nextFrame();
  await nextFrame();
  await settled();
  flushSave();
  goHome();
}

// ---------------------------------------------------------------------------

function TopBar() {
  const name = useEditor((s) => s.project?.name ?? '');
  const sheet = useEditor((s) => s.sheet);
  // Re-read after the export sheet closes, where the setting is changed.
  const res = useMemo(() => loadPrefs(EXPORT_PREFS_KEY, EXPORT_DEFAULTS).resolution, [sheet]);
  const openSheet = useEditor((s) => s.openSheet);

  const rename = async () => {
    const p = useEditor.getState().project;
    if (!p) return;
    const v = (await promptDialog({ title: 'Rename project', value: p.name, confirm: 'Rename' }))?.trim();
    if (v && v !== useEditor.getState().project?.name) {
      useEditor.getState().apply((d) => {
        d.name = v;
      });
    }
  };

  return (
    <header className="topbar">
      <button className="icon-btn" aria-label="Back to projects" onClick={() => void leave()}>
        <ChevronLeft size={26} />
      </button>
      <button className="title" aria-label={`Project name: ${name}. Tap to rename`} onClick={() => void rename()}>
        {name || 'Untitled'}
      </button>
      <button className="res-chip" aria-label={`Export settings, ${resolutionLabel(res)}`} onClick={() => openSheet('export')}>
        <span>
          {resolutionLabel(res)}
          <ChevronDown size={14} aria-hidden />
        </span>
      </button>
      <button className="save-pill" onClick={() => openSheet('export', 'start')}>
        <span>
          <Download size={16} strokeWidth={2.5} aria-hidden />
          Save
        </span>
      </button>
    </header>
  );
}

function Transport({ focus, onToggleFocus }: { focus: boolean; onToggleFocus: () => void }) {
  const playing = useTime((s) => s.playing);
  const canUndo = useEditor((s) => s.past.length > 0 && !s.gestureBase);
  const canRedo = useEditor((s) => s.future.length > 0 && !s.gestureBase);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  return (
    <div className="transport">
      <div className="left">
        <TimeLabel />
      </div>
      <button className="play-btn" aria-label={playing ? 'Pause' : 'Play'} onClick={() => togglePlay()}>
        {playing ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}
      </button>
      <div className="right">
        {!focus && (
          <>
            <button className="icon-btn" aria-label="Undo" disabled={!canUndo} onClick={undo}>
              <Undo2 size={22} />
            </button>
            <button className="icon-btn" aria-label="Redo" disabled={!canRedo} onClick={redo}>
              <Redo2 size={22} />
            </button>
          </>
        )}
        <button className="icon-btn" aria-label={focus ? 'Exit full screen preview' : 'Full screen preview'} onClick={onToggleFocus}>
          {focus ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
        </button>
      </div>
    </div>
  );
}

function TimeLabel() {
  const t = useTime((s) => Math.floor(s.time * 10) / 10);
  const total = useEditor((s) => (s.project ? projectDuration(s.project) : 0));
  return (
    <span className="time" aria-label={`${formatTime(t)} of ${formatTime(total)}`}>
      <span>{formatTime(t, true)}</span>
      <span className="dim">/ {formatTime(total, true)}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts (tablets with keyboards, desktop browsers)

function useShortcuts(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('.dialog-wrap, .menu-sheet')) return;
      const inSheet = !!target?.closest('.sheet');
      const s = useEditor.getState();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key;

      if (key === ' ' && !mod) {
        if (inSheet) return;
        e.preventDefault();
        // Keep Space from also clicking the focused button on key-up.
        if (target instanceof HTMLElement && target.tagName === 'BUTTON') target.blur();
        togglePlay();
        return;
      }
      if (mod && (key === 'z' || key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (mod && (key === 'y' || key === 'Y')) {
        e.preventDefault();
        s.redo();
        return;
      }
      if (mod && (key === 'd' || key === 'D')) {
        e.preventDefault();
        duplicateSelected();
        return;
      }
      if (mod || e.altKey) return;
      switch (key) {
        case 'Delete':
        case 'Backspace':
          if (!s.selectedId) return;
          e.preventDefault();
          deleteSelected();
          return;
        case 's':
        case 'S':
          e.preventDefault();
          splitAtPlayhead();
          return;
        case 'ArrowLeft':
        case 'ArrowRight': {
          if (inSheet) return;
          e.preventDefault();
          pause();
          const fps = s.project?.fps ?? 30;
          const step = e.shiftKey ? 1 : 1 / fps;
          seek(now() + (key === 'ArrowLeft' ? -step : step));
          return;
        }
        case 'Home':
          if (inSheet) return;
          e.preventDefault();
          pause();
          seek(0);
          return;
        case 'End':
          if (inSheet) return;
          e.preventDefault();
          pause();
          seek(duration());
          return;
        case 'Escape':
          if (backDepth() === 0 && s.selectedId) {
            e.preventDefault();
            s.select(null);
          }
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);
}
