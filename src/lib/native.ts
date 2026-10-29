/**
 * Glue for the Android app (Capacitor). In a browser every function here falls back to the web
 * behavior, so the same build runs everywhere.
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { SocialNet } from './social';

export const isNative = (): boolean => Capacitor.isNativePlatform();

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * fetch() through the phone's own networking, which isn't limited by browser CORS rules.
 * Only used in the Android app; request bodies must be text (JSON, form data as a string).
 */
export async function nativeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k] = v));
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();
  if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const res = await CapacitorHttp.request({
    url: req.url,
    method: req.method,
    headers,
    data: body || undefined,
    responseType: 'arraybuffer',
    shouldEncodeUrlParams: false,
    connectTimeout: 20_000,
    readTimeout: 60_000,
  });
  if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const data: unknown = res.data;
  const bytes =
    typeof data === 'string'
      ? fromBase64(data)
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new TextEncoder().encode(typeof data === 'object' ? JSON.stringify(data) : String(data ?? ''));
  const nullBody = res.status === 204 || res.status === 304 || req.method === 'HEAD';
  const response = new Response(nullBody ? null : bytes, { status: res.status, headers: res.headers });
  Object.defineProperty(response, 'url', { value: res.url || req.url });
  return response;
}

/** fetch() that works for any http(s) link: native in the app, normal fetch in a browser. */
export function anyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return isNative() ? nativeFetch(input, init) : fetch(input, init);
}

/**
 * Networking for TikTok and Instagram downloads in the Android app. Android keeps cookies between
 * requests on its own (Capacitor installs a cookie manager), as a browser would.
 */
export const nativeNet: SocialNet = {
  async text(url, init = {}) {
    if (!isNative()) throw new TypeError('Only the Android app can reach this site.');
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const res = await CapacitorHttp.request({
      url,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      data: init.body,
      responseType: 'text',
      shouldEncodeUrlParams: false,
      connectTimeout: 20_000,
      readTimeout: 60_000,
    });
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = String(v);
    const data: unknown = res.data;
    return { status: res.status, url: res.url || url, headers, text: typeof data === 'string' ? data : JSON.stringify(data ?? '') };
  },
  bytes: (url, init = {}) => nativeFetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal }),
};

/** Bytes per write when handing files to the native side (base64 grows them by a third). */
const WRITE_CHUNK = 3 * 1024 * 1024;

async function writeNative(blob: Blob, path: string, directory: 'cache' | 'documents'): Promise<string> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const dir = directory === 'cache' ? Directory.Cache : Directory.Documents;
  for (let off = 0; off < Math.max(1, blob.size); off += WRITE_CHUNK) {
    const data = toBase64(new Uint8Array(await blob.slice(off, off + WRITE_CHUNK).arrayBuffer()));
    if (off === 0) await Filesystem.writeFile({ path, data, directory: dir, recursive: true });
    else await Filesystem.appendFile({ path, data, directory: dir });
  }
  return (await Filesystem.getUri({ path, directory: dir })).uri;
}

/** Opens the Android share sheet for a file. */
export async function nativeShare(file: File, title: string): Promise<'shared' | 'cancelled'> {
  const { Share } = await import('@capacitor/share');
  const uri = await writeNative(file, `share/${file.name}`, 'cache');
  try {
    await Share.share({ title, files: [uri], dialogTitle: title });
    return 'shared';
  } catch (e) {
    if (/cancel/i.test(String((e as Error)?.message ?? e))) return 'cancelled';
    throw e;
  }
}

/** Saves a file to Documents/ReelForge on the phone and returns where it went. */
export async function nativeSave(blob: Blob, name: string): Promise<string> {
  await writeNative(blob, `ReelForge/${name}`, 'documents');
  return `Documents/ReelForge/${name}`;
}
