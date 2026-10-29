import { Clapperboard, Download, EllipsisVertical, Film, FolderInput, FolderPlus, Music, Pencil, Play, Search, Share2, Trash, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ClipFolder, ClipMeta } from '../types';
import { filterClips, uniqueName, type KindFilter } from '../lib/clip';
import { deleteClip, deleteFolder, getClip, listClips, listFolders, putFolder, requestPersistence, saveProject, updateClipMeta } from '../lib/db';
import { newProject } from '../lib/defaults';
import { shareFile } from '../lib/device';
import { openProject } from '../lib/route';
import { downloadBlob, formatBytes, formatDuration, safeFileName, uid } from '../lib/util';
import { toast } from '../state/store';
import { setPendingImport } from './actions';
import { Segmented, Sheet } from './common';
import { confirmDialog, menuDialog, promptDialog } from './dialog';

interface Row {
  meta: ClipMeta;
  poster: Blob | null;
}

async function clipFile(id: string): Promise<File | null> {
  const rec = await getClip(id);
  if (!rec) return null;
  const ext = rec.meta.fileName.split('.').pop() ?? (rec.meta.kind === 'audio' ? 'm4a' : 'mp4');
  return new File([rec.blob], `${safeFileName(rec.meta.name, 'Clip')}.${ext}`, { type: rec.meta.mime });
}

async function shareClip(id: string) {
  const file = await clipFile(id);
  if (!file) return;
  try {
    const r = await shareFile(file, file.name);
    if (r === 'unsupported') downloadBlob(file, file.name);
  } catch (e) {
    console.error(e);
    downloadBlob(file, file.name);
  }
}

async function saveClipToDevice(id: string) {
  const file = await clipFile(id);
  if (file) downloadBlob(file, file.name);
}

/** The clip library: folders, filters and every saved clip. */
export function ClipsLibrary() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [folders, setFolders] = useState<ClipFolder[]>([]);
  const [folder, setFolder] = useState<string>('all');
  const [kind, setKind] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');
  const [playing, setPlaying] = useState<ClipMeta | null>(null);

  const refresh = () => {
    void Promise.all([listClips(), listFolders()])
      .then(([r, f]) => {
        setRows(r);
        setFolders(f);
        setFolder((cur) => (cur === 'all' || cur === 'unfiled' || f.some((x) => x.id === cur) ? cur : 'all'));
      })
      .catch((e) => {
        console.error(e);
        setRows([]);
        toast('Could not read saved clips', 'error');
      });
  };
  useEffect(refresh, []);

  const shown = useMemo(() => filterClips(rows?.map((r) => r.meta) ?? [], { folder, kind, query }), [rows, folder, kind, query]);
  const posters = useMemo(() => new Map(rows?.map((r) => [r.meta.id, r.poster]) ?? []), [rows]);
  const folderName = (id: string | null) => folders.find((f) => f.id === id)?.name;

  const newFolder = async (): Promise<ClipFolder | null> => {
    const name = (await promptDialog({ title: 'New folder', placeholder: 'Folder name', confirm: 'Create' }))?.trim();
    if (!name) return null;
    const f: ClipFolder = {
      id: uid('f_'),
      name: uniqueName(
        name,
        folders.map((x) => x.name),
      ),
      createdAt: Date.now(),
    };
    await putFolder(f);
    return f;
  };

  const addFolder = async () => {
    const f = await newFolder();
    if (!f) return;
    refresh();
    setFolder(f.id);
  };

  const folderMenu = async (f: ClipFolder) => {
    const choice = await menuDialog({
      title: f.name,
      items: [
        { id: 'rename', label: 'Rename folder', icon: <Pencil size={20} />, keyboard: true },
        { id: 'delete', label: 'Delete folder', icon: <Trash size={20} />, danger: true },
      ],
    });
    if (choice === 'rename') {
      const name = (await promptDialog({ title: 'Rename folder', value: f.name, confirm: 'Rename' }))?.trim();
      if (!name || name === f.name) return;
      await putFolder({ ...f, name });
      refresh();
    } else if (choice === 'delete') {
      const ok = await confirmDialog({
        title: 'Delete folder?',
        message: `The clips in "${f.name}" stay in your library, without a folder.`,
        confirm: 'Delete',
        danger: true,
      });
      if (!ok) return;
      await deleteFolder(f.id);
      setFolder('all');
      refresh();
    }
  };

  const moveTo = async (c: ClipMeta) => {
    const choice = await menuDialog({
      title: `Move "${c.name}"`,
      items: [
        ...folders.map((f) => ({ id: f.id, label: f.id === c.folderId ? `${f.name} (current)` : f.name, icon: <FolderInput size={20} /> })),
        { id: '__none', label: c.folderId ? 'Remove from folder' : 'No folder (current)', icon: <X size={20} /> },
        { id: '__new', label: 'New folder…', icon: <FolderPlus size={20} />, keyboard: true },
      ],
    });
    if (!choice) return;
    let target: string | null = choice === '__none' ? null : choice;
    if (choice === '__new') {
      const f = await newFolder();
      if (!f) return;
      target = f.id;
    }
    if (target === c.folderId) return;
    await updateClipMeta(c.id, { folderId: target });
    refresh();
    toast(target ? `Moved to ${folderName(target) ?? 'folder'}` : 'Removed from folder');
  };

  const useInProject = async (c: ClipMeta) => {
    const file = await clipFile(c.id);
    if (!file) return;
    const p = newProject(c.name);
    try {
      await saveProject(p);
    } catch {
      toast('Could not create the project: device storage may be full', 'error');
      return;
    }
    void requestPersistence();
    setPendingImport(p.id, [file]);
    openProject(p.id);
  };

  const menu = async (c: ClipMeta) => {
    const choice = await menuDialog({
      title: c.name,
      items: [
        { id: 'play', label: 'Play', icon: <Play size={20} /> },
        { id: 'share', label: 'Share', icon: <Share2 size={20} /> },
        { id: 'save', label: 'Save to device', icon: <Download size={20} /> },
        { id: 'rename', label: 'Rename', icon: <Pencil size={20} />, keyboard: true },
        { id: 'move', label: 'Move to folder', icon: <FolderInput size={20} /> },
        { id: 'project', label: 'Edit in a new project', icon: <Clapperboard size={20} /> },
        { id: 'delete', label: 'Delete', icon: <Trash size={20} />, danger: true },
      ],
    });
    try {
      if (choice === 'play') setPlaying(c);
      else if (choice === 'share') await shareClip(c.id);
      else if (choice === 'save') await saveClipToDevice(c.id);
      else if (choice === 'rename') {
        const name = (await promptDialog({ title: 'Rename clip', value: c.name, confirm: 'Rename' }))?.trim();
        if (!name || name === c.name) return;
        await updateClipMeta(c.id, { name });
        refresh();
      } else if (choice === 'move') await moveTo(c);
      else if (choice === 'project') await useInProject(c);
      else if (choice === 'delete') {
        const ok = await confirmDialog({
          title: 'Delete clip?',
          message: `"${c.name}" will be removed from this device.`,
          confirm: 'Delete',
          danger: true,
        });
        if (!ok) return;
        await deleteClip(c.id);
        refresh();
        toast('Clip deleted');
      }
    } catch (e) {
      console.error(e);
      toast('Something went wrong. Please try again.', 'error');
    }
  };

  if (!rows) return null;

  if (rows.length === 0 && folders.length === 0) {
    return (
      <div className="empty">
        <Film size={32} aria-hidden />
        <b>No clips yet</b>
        <span>Open the clip studio to cut video and audio clips. They’re saved here on this device.</span>
      </div>
    );
  }

  return (
    <div className="clips">
      <div className="chips" role="group" aria-label="Folder">
        <button className="chip" aria-pressed={folder === 'all'} onClick={() => setFolder('all')}>
          All
        </button>
        <button className="chip" aria-pressed={folder === 'unfiled'} onClick={() => setFolder('unfiled')}>
          No folder
        </button>
        {folders.map((f) => (
          <button
            key={f.id}
            className="chip"
            aria-pressed={folder === f.id}
            onClick={() => (folder === f.id ? void folderMenu(f) : setFolder(f.id))}
            onContextMenu={(e) => {
              e.preventDefault();
              void folderMenu(f);
            }}
          >
            {f.name}
            {folder === f.id && <EllipsisVertical size={14} aria-label="Folder options" />}
          </button>
        ))}
        <button className="chip" aria-label="New folder" onClick={() => void addFolder()}>
          <FolderPlus size={16} aria-hidden />
          Folder
        </button>
      </div>

      <Segmented
        label="Clip type"
        value={kind}
        onChange={setKind}
        options={[
          { value: 'all', label: 'All' },
          { value: 'video', label: 'Video' },
          { value: 'audio', label: 'Audio' },
        ]}
      />

      <label className="clips-search">
        <Search size={18} aria-hidden />
        <input
          className="input"
          type="search"
          placeholder="Search clips"
          aria-label="Search clips"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      {shown.length === 0 ? (
        <p className="note">{query ? 'No clips match your search.' : 'No clips here yet.'}</p>
      ) : (
        <ul className="projects" role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {shown.map((c) => (
            <li key={c.id} className="project-row">
              <button className="project-open" onClick={() => setPlaying(c)}>
                <Poster blob={posters.get(c.id) ?? null} kind={c.kind} />
                <span className="meta">
                  <b>{c.name}</b>
                  <small>
                    {[formatDuration(c.duration), c.kind === 'audio' ? 'Audio' : `${c.width}×${c.height}`, formatBytes(c.size)].join(' · ')}
                  </small>
                  {(folder === 'all' && c.folderId && folderName(c.folderId)) || c.source ? (
                    <small>{[folder === 'all' ? folderName(c.folderId) : null, c.source].filter(Boolean).join(' · ')}</small>
                  ) : null}
                </span>
              </button>
              <button className="icon-btn" aria-label={`More options for ${c.name}`} onClick={() => void menu(c)}>
                <EllipsisVertical size={22} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {playing && <ClipViewer clip={playing} onClose={() => setPlaying(null)} />}
    </div>
  );
}

function Poster({ blob, kind }: { blob: Blob | null; kind: 'video' | 'audio' }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return (
    <span className="cover" aria-hidden>
      {url ? <img src={url} alt="" /> : kind === 'audio' ? <Music size={22} /> : <Film size={22} />}
    </span>
  );
}

function ClipViewer({ clip, onClose }: { clip: ClipMeta; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null;
    let alive = true;
    void getClip(clip.id).then((rec) => {
      if (!rec || !alive) return;
      u = URL.createObjectURL(rec.blob);
      setUrl(u);
    });
    return () => {
      alive = false;
      if (u) URL.revokeObjectURL(u);
    };
  }, [clip.id]);

  return (
    <Sheet title={clip.name} onClose={onClose} tall closeIcon="x">
      {url &&
        (clip.kind === 'video' ? (
          <video className="clip-player" src={url} controls playsInline autoPlay />
        ) : (
          <audio className="clip-audio" src={url} controls autoPlay />
        ))}
      <p className="note">
        {[formatDuration(clip.duration), clip.kind === 'audio' ? 'Audio' : `${clip.width}×${clip.height}`, formatBytes(clip.size)].join(' · ')}
        {clip.source && <> · from {clip.source}</>}
      </p>
      <div className="btn-row">
        <button className="primary-btn" onClick={() => void shareClip(clip.id)}>
          <Share2 size={20} aria-hidden />
          Share
        </button>
        <button className="secondary-btn" onClick={() => void saveClipToDevice(clip.id)}>
          <Download size={20} aria-hidden />
          Save
        </button>
      </div>
    </Sheet>
  );
}
