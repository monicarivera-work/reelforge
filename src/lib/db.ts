import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ClipFolder, ClipMeta, MediaAsset, Project } from '../types';
import { allItems } from './layout';

export interface ThumbRecord {
  id: string;
  /** seconds between thumbnails */
  interval: number;
  blobs: Blob[];
}

export interface PeakRecord {
  id: string;
  /** peak values per second */
  rate: number;
  data: Uint8Array;
}

interface RFSchema extends DBSchema {
  projects: { key: string; value: Project };
  media: { key: string; value: { asset: MediaAsset; blob: Blob } };
  thumbs: { key: string; value: ThumbRecord };
  peaks: { key: string; value: PeakRecord };
  clips: { key: string; value: ClipRecord };
  folders: { key: string; value: ClipFolder };
}

export interface ClipRecord {
  meta: ClipMeta;
  blob: Blob;
  /** a JPEG frame for video clips */
  poster: Blob | null;
}

let dbp: Promise<IDBPDatabase<RFSchema>> | null = null;

export function db(): Promise<IDBPDatabase<RFSchema>> {
  dbp ??= openDB<RFSchema>('reelforge', 2, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        d.createObjectStore('projects', { keyPath: 'id' });
        d.createObjectStore('media');
        d.createObjectStore('thumbs', { keyPath: 'id' });
        d.createObjectStore('peaks', { keyPath: 'id' });
      }
      if (oldVersion < 2) {
        d.createObjectStore('clips', { keyPath: 'meta.id' });
        d.createObjectStore('folders', { keyPath: 'id' });
      }
    },
  });
  return dbp;
}

export async function listProjects(): Promise<Project[]> {
  const all = await (await db()).getAll('projects');
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id: string): Promise<Project | undefined> {
  return (await db()).get('projects', id);
}

export async function saveProject(p: Project): Promise<void> {
  await (await db()).put('projects', p);
}

export async function deleteProject(id: string): Promise<void> {
  await (await db()).delete('projects', id);
  await gcMedia();
}

export async function putMedia(asset: MediaAsset, blob: Blob): Promise<void> {
  await (await db()).put('media', { asset, blob }, asset.id);
}

export async function getMedia(id: string): Promise<{ asset: MediaAsset; blob: Blob } | undefined> {
  return (await db()).get('media', id);
}

export async function getThumbs(id: string): Promise<ThumbRecord | undefined> {
  return (await db()).get('thumbs', id);
}

export async function putThumbs(rec: ThumbRecord): Promise<void> {
  await (await db()).put('thumbs', rec);
}

export async function getPeaks(id: string): Promise<PeakRecord | undefined> {
  return (await db()).get('peaks', id);
}

export async function putPeaks(rec: PeakRecord): Promise<void> {
  await (await db()).put('peaks', rec);
}

// ---------------------------------------------------------------------------
// Clip library

/** Every clip's details, without loading the files. */
export async function listClips(): Promise<{ meta: ClipMeta; poster: Blob | null }[]> {
  const d = await db();
  const out: { meta: ClipMeta; poster: Blob | null }[] = [];
  let cur = await d.transaction('clips').store.openCursor();
  while (cur) {
    out.push({ meta: cur.value.meta, poster: cur.value.poster });
    cur = await cur.continue();
  }
  return out;
}

export async function getClip(id: string): Promise<ClipRecord | undefined> {
  return (await db()).get('clips', id);
}

export async function putClip(rec: ClipRecord): Promise<void> {
  await (await db()).put('clips', rec);
}

export async function updateClipMeta(id: string, patch: Partial<ClipMeta>): Promise<void> {
  const d = await db();
  const tx = d.transaction('clips', 'readwrite');
  const rec = await tx.store.get(id);
  if (rec) await tx.store.put({ ...rec, meta: { ...rec.meta, ...patch, id } });
  await tx.done;
}

export async function deleteClip(id: string): Promise<void> {
  await (await db()).delete('clips', id);
}

export async function listFolders(): Promise<ClipFolder[]> {
  const all = await (await db()).getAll('folders');
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

export async function putFolder(f: ClipFolder): Promise<void> {
  await (await db()).put('folders', f);
}

/** Deletes a folder; its clips stay in the library, unfiled. */
export async function deleteFolder(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['folders', 'clips'], 'readwrite');
  await tx.objectStore('folders').delete(id);
  let cur = await tx.objectStore('clips').openCursor();
  while (cur) {
    if (cur.value.meta.folderId === id) await cur.update({ ...cur.value, meta: { ...cur.value.meta, folderId: null } });
    cur = await cur.continue();
  }
  await tx.done;
}

export function projectMediaIds(p: Project): string[] {
  const ids = new Set<string>();
  for (const it of allItems(p)) if ('mediaId' in it) ids.add(it.mediaId);
  return [...ids];
}

/** Removes media that no saved project references. */
export async function gcMedia(keep: string[] = []): Promise<void> {
  const d = await db();
  const projects = await d.getAll('projects');
  const used = new Set<string>(keep);
  for (const p of projects) for (const id of projectMediaIds(p)) used.add(id);
  const keys = await d.getAllKeys('media');
  for (const k of keys) {
    if (used.has(k)) continue;
    await d.delete('media', k);
    await d.delete('thumbs', k);
    await d.delete('peaks', k);
  }
}

export async function storageInfo(): Promise<{ usage: number; quota: number; persisted: boolean }> {
  try {
    const est = await navigator.storage?.estimate?.();
    const persisted = (await navigator.storage?.persisted?.()) ?? false;
    return { usage: est?.usage ?? 0, quota: est?.quota ?? 0, persisted };
  } catch {
    return { usage: 0, quota: 0, persisted: false };
  }
}

export async function requestPersistence(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* not supported */
  }
}
