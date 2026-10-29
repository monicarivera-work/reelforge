import { Clapperboard, Copy, EllipsisVertical, Film, Pencil, Plus, RefreshCw, Scissors, Smartphone, Trash, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Project } from '../types';
import { deleteProject, listProjects, requestPersistence, saveProject, storageInfo } from '../lib/db';
import { newProject } from '../lib/defaults';
import { canEncodeVideo, pickFiles } from '../lib/device';
import { projectDuration } from '../lib/layout';
import { ensureThumbs, getThumbStrip, mediaEvents } from '../lib/media';
import { openProject, openStudio } from '../lib/route';
import { formatBytes, formatDuration, isAndroid, isIOS, isNativeApp, isStandalone, uid } from '../lib/util';
import { useApp } from '../state/app';
import { toast } from '../state/store';
import { setPendingImport } from './actions';
import { ClipsLibrary } from './Clips';
import { Progress, Segmented } from './common';
import { confirmDialog, menuDialog, promptDialog } from './dialog';

const INSTALL_HINT_KEY = 'rf-install-hint';
const TAB_KEY = 'rf-home-tab';

type Tab = 'projects' | 'clips';

function initialTab(): Tab {
  try {
    return sessionStorage.getItem(TAB_KEY) === 'clips' ? 'clips' : 'projects';
  } catch {
    return 'projects';
  }
}

export function Home() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [tab, setTab] = useState<Tab>(initialTab);

  const pickTab = (t: Tab) => {
    setTab(t);
    try {
      sessionStorage.setItem(TAB_KEY, t);
    } catch {
      /* ignore */
    }
  };

  const refresh = () => {
    void listProjects()
      .then(setProjects)
      .catch((e) => {
        console.error(e);
        setProjects([]);
        toast('Could not read saved projects', 'error');
      });
    void storageInfo().then((s) => setStorage(s.quota ? s : null));
  };

  useEffect(refresh, []);

  const startNew = () => {
    // The picker has to open synchronously inside the tap.
    void pickFiles('video/*,image/*').then(async (files) => {
      if (!files.length) return;
      const p = newProject(uniqueName(defaultName(), projects ?? []));
      try {
        await saveProject(p);
      } catch {
        toast('Could not create the project: device storage may be full', 'error');
        return;
      }
      void requestPersistence();
      setPendingImport(p.id, files);
      openProject(p.id);
    });
  };

  return (
    <main className="home">
      <header className="home-head">
        <h1 className="brand">
          <Clapperboard size={26} aria-hidden />
          ReelForge
        </h1>
      </header>

      <UpdateNotice />
      <InstallNotice />
      {!canEncodeVideo() && (
        <div className="notice" role="note">
          <TriangleAlert size={20} aria-hidden />
          <div className="body">
            <b>This browser can't save videos yet</b>
            <p>You can still edit, but to save the finished video update your phone's software, or open ReelForge in Chrome (Android) or Safari (iPhone).</p>
          </div>
        </div>
      )}

      <div className="home-actions">
        <button className="new-project" onClick={startNew}>
          <Plus size={28} aria-hidden />
          <span>
            <b>New project</b>
            <small>Pick videos and photos</small>
          </span>
        </button>
        <button className="new-project alt" onClick={openStudio}>
          <Scissors size={26} aria-hidden />
          <span>
            <b>Clip studio</b>
            <small>{isNativeApp() ? 'YouTube, links and files' : 'Links and files'}</small>
          </span>
        </button>
      </div>

      <Segmented
        label="Show"
        value={tab}
        onChange={pickTab}
        options={[
          { value: 'projects', label: 'Projects' },
          { value: 'clips', label: 'Clips' },
        ]}
      />

      {tab === 'clips' && <ClipsLibrary />}

      {tab === 'projects' && projects && projects.length > 0 && (
        <>
          <h2>Projects</h2>
          <ul className="projects" role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {projects.map((p) => (
              <ProjectRow key={p.id} project={p} all={projects} onChanged={refresh} />
            ))}
          </ul>
        </>
      )}

      {tab === 'projects' && projects && projects.length === 0 && (
        <div className="empty">
          <Film size={32} aria-hidden />
          <b>No projects yet</b>
          <span>Tap New project to pick clips from your phone. Everything is saved on this device as you edit.</span>
        </div>
      )}

      {storage && (
        <div className="storage">
          <span>
            {formatBytes(storage.usage)} used of {formatBytes(storage.quota)} available on this device
          </span>
          <Progress value={storage.usage / storage.quota} label="Storage used" />
          <span>Projects and clips are stored on this device and never uploaded.</span>
        </div>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------

function UpdateNotice() {
  const needRefresh = useApp((s) => s.needRefresh);
  const updateSW = useApp((s) => s.updateSW);
  if (!needRefresh || !updateSW) return null;
  return (
    <div className="notice" role="status">
      <RefreshCw size={20} aria-hidden />
      <div className="body">
        <b>Update ready</b>
        <p>A new version of ReelForge has been downloaded.</p>
        <button className="secondary-btn" onClick={() => void updateSW(true)}>
          Restart to update
        </button>
      </div>
    </div>
  );
}

function InstallNotice() {
  const installEvent = useApp((s) => s.installEvent);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(INSTALL_HINT_KEY) === '1';
    } catch {
      return false;
    }
  });
  if (dismissed || isStandalone() || isNativeApp() || (!installEvent && !isIOS && !isAndroid)) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(INSTALL_HINT_KEY, '1');
    } catch {
      /* ignore */
    }
  };

  const install = () => {
    const ev = useApp.getState().installEvent;
    if (!ev) return;
    // prompt() must run inside the tap.
    void ev
      .prompt()
      .then(() => ev.userChoice)
      .then((c) => {
        useApp.setState({ installEvent: null });
        if (c.outcome === 'accepted') toast('ReelForge is being added to your home screen', 'success');
      })
      .catch(() => useApp.setState({ installEvent: null }));
  };

  return (
    <div className="notice" role="note">
      <Smartphone size={20} aria-hidden />
      <div className="body">
        <b>Put ReelForge on your home screen</b>
        {installEvent ? (
          <>
            <p>It opens full screen like a regular app and works offline.</p>
            <button className="secondary-btn" onClick={install}>
              Install app
            </button>
          </>
        ) : isIOS ? (
          <p>In Safari, tap the Share button, then Add to Home Screen. It opens full screen and works offline.</p>
        ) : (
          <p>Open your browser's menu (⋮) and tap Install app or Add to Home screen.</p>
        )}
      </div>
      <button className="icon-btn" style={{ margin: '-10px -10px 0 0' }} aria-label="Dismiss" onClick={dismiss}>
        <X size={18} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ProjectRow({ project: p, all, onChanged }: { project: Project; all: Project[]; onChanged: () => void }) {
  const dur = projectDuration(p);
  const meta = `${dur > 0 ? formatDuration(dur) : 'Empty'} · edited ${ago(p.updatedAt)}`;

  const menu = async () => {
    const choice = await menuDialog({
      title: p.name,
      items: [
        { id: 'rename', label: 'Rename', icon: <Pencil size={20} />, keyboard: true },
        { id: 'duplicate', label: 'Duplicate', icon: <Copy size={20} /> },
        { id: 'delete', label: 'Delete', icon: <Trash size={20} />, danger: true },
      ],
    });
    try {
      if (choice === 'rename') {
        const name = (await promptDialog({ title: 'Rename project', value: p.name, confirm: 'Rename' }))?.trim();
        if (!name || name === p.name) return;
        await saveProject({ ...p, name, updatedAt: Date.now() });
        onChanged();
      } else if (choice === 'duplicate') {
        const now = Date.now();
        const copy: Project = { ...structuredClone(p), id: uid('p_'), name: uniqueName(`${p.name} copy`, all), createdAt: now, updatedAt: now };
        await saveProject(copy);
        onChanged();
        toast('Project duplicated', 'success');
      } else if (choice === 'delete') {
        const ok = await confirmDialog({
          title: 'Delete project?',
          message: `"${p.name}" and any clips only it uses will be removed from this device. This can't be undone.`,
          confirm: 'Delete',
          danger: true,
        });
        if (!ok) return;
        await deleteProject(p.id);
        onChanged();
        toast('Project deleted');
      }
    } catch (e) {
      console.error(e);
      toast('Something went wrong. Please try again.', 'error');
    }
  };

  return (
    <li className="project-row">
      <button className="project-open" onClick={() => openProject(p.id)}>
        <Cover project={p} />
        <span className="meta">
          <b>{p.name || 'Untitled'}</b>
          <small>{meta}</small>
        </span>
      </button>
      <button className="icon-btn" aria-label={`More options for ${p.name}`} onClick={() => void menu()}>
        <EllipsisVertical size={22} />
      </button>
    </li>
  );
}

const COVER_W = 112;
const COVER_H = 144;

function Cover({ project }: { project: Project }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const first = project.main[0];

  useEffect(() => {
    if (!first) return;
    const draw = (): boolean => {
      const c = ref.current;
      const ctx = c?.getContext('2d');
      if (!c || !ctx) return false;
      if (first.type === 'color') {
        ctx.fillStyle = first.color;
        ctx.fillRect(0, 0, COVER_W, COVER_H);
        return true;
      }
      const strip = getThumbStrip(first.mediaId);
      if (!strip?.images.length) return false;
      const at = first.type === 'video' ? first.in : 0;
      const img = strip.images[Math.min(strip.images.length - 1, Math.max(0, Math.floor(at / strip.interval)))] ?? strip.images.find(Boolean);
      if (!img) return false;
      const s = Math.max(COVER_W / img.width, COVER_H / img.height);
      const w = img.width * s;
      const h = img.height * s;
      ctx.drawImage(img, (COVER_W - w) / 2, (COVER_H - h) / 2, w, h);
      return true;
    };
    if (draw()) {
      setReady(true);
      return;
    }
    if (first.type === 'color') return;
    const id = first.mediaId;
    const onUpdate = (e: Event) => {
      if ((e as CustomEvent<string>).detail === id && draw()) setReady(true);
    };
    mediaEvents.addEventListener('update', onUpdate);
    void ensureThumbs(id);
    return () => mediaEvents.removeEventListener('update', onUpdate);
  }, [first]);

  return (
    <span className="cover" aria-hidden>
      <canvas ref={ref} width={COVER_W} height={COVER_H} style={ready ? undefined : { display: 'none' }} />
      {!ready && <Film size={22} />}
    </span>
  );
}

// ---------------------------------------------------------------------------

function defaultName(): string {
  return `Video – ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function uniqueName(base: string, projects: Project[]): string {
  const names = new Set(projects.map((p) => p.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}

const rtf = typeof Intl !== 'undefined' && 'RelativeTimeFormat' in Intl ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;

function ago(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [604800, 'week'],
  ];
  if (s >= 2592000) return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  let unit = steps[0];
  for (const st of steps) if (s >= st[0]) unit = st;
  const n = Math.floor(s / unit[0]);
  return rtf ? rtf.format(-n, unit[1]) : `${n} ${unit[1]}${n === 1 ? '' : 's'} ago`;
}
