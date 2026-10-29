/**
 * TikTok and Instagram downloads for the Android app. Browsers block these requests (CORS).
 *
 * Both sites change their pages from time to time, which can break downloading until this file is
 * updated. Only public posts work; nothing here signs in.
 */

export type SocialSite = 'tiktok' | 'instagram';

export const SITE_NAMES: Record<SocialSite, string> = { tiktok: 'TikTok', instagram: 'Instagram' };

export interface SocialLink {
  site: SocialSite;
  /** the link as https, without tracking junk the sites don't need */
  url: string;
}

export class SocialError extends Error {}

/** A TikTok or Instagram post link; null for anything else. */
export function parseSocialLink(text: string): SocialLink | null {
  const s = text.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.protocol = 'https:';
  url.hash = '';
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);

  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    // Short share links (vm./vt.tiktok.com/XXXX, tiktok.com/t/XXXX) redirect to the post.
    if (/^v[mt]\.tiktok\.com$/.test(host) && parts.length >= 1) return { site: 'tiktok', url: `https://${host}/${parts[0]}/` };
    if (parts[0] === 't' && parts[1]) return { site: 'tiktok', url: `https://www.tiktok.com/t/${parts[1]}/` };
    const id = tikTokId(url.href);
    return id ? { site: 'tiktok', url: url.href.split('?')[0] } : null;
  }

  if (host === 'instagram.com' || host.endsWith('.instagram.com') || host === 'instagr.am') {
    if (parts[0] === 'share' && parts.length >= 2) return { site: 'instagram', url: url.href };
    const code = instagramShortcode(url.href);
    if (!code) return null;
    const index = Number(url.searchParams.get('img_index'));
    return { site: 'instagram', url: `https://www.instagram.com/p/${code}/${index > 1 ? `?img_index=${index}` : ''}` };
  }
  return null;
}

/** The numeric video ID in a full TikTok link. */
export function tikTokId(link: string): string | null {
  return /\/(?:video|photo|v)\/(\d{6,})/.exec(link)?.[1] ?? /[?&](?:item_id|share_item_id)=(\d{6,})/.exec(link)?.[1] ?? null;
}

/** The post code in an Instagram link (/p/, /reel/, /reels/, /tv/). */
export function instagramShortcode(link: string): string | null {
  return /instagr(?:am\.com|\.am)\/(?:[\w.]+\/)?(?:p|reels?|tv)\/([\w-]+)/i.exec(link)?.[1] ?? null;
}

const IG_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Instagram's numeric media ID for a post code. */
export function instagramMediaId(shortcode: string): string {
  // Private posts have 28 extra characters on the end.
  const code = shortcode.length > 28 ? shortcode.slice(0, -28) : shortcode;
  let n = 0n;
  for (const c of code) {
    const v = IG_ALPHABET.indexOf(c);
    if (v < 0) throw new SocialError('That Instagram link looks broken.');
    n = n * 64n + BigInt(v);
  }
  return n.toString();
}

// ---------------------------------------------------------------------------
// Networking (supplied by the caller so the extractors can be tested)

export interface HttpRequest {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface HttpTextResponse {
  status: number;
  /** after redirects */
  url: string;
  /** lower-case names; repeated headers joined with ", " */
  headers: Record<string, string>;
  text: string;
}

export interface SocialNet {
  /** a request whose body is read as text; cookies are kept between requests */
  text(url: string, init?: HttpRequest): Promise<HttpTextResponse>;
  /** a request whose body is read as bytes */
  bytes(url: string, init?: HttpRequest): Promise<Response>;
}

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const PAGE_HEADERS: Record<string, string> = {
  'User-Agent': DESKTOP_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
};

/** A cookie's value from a Set-Cookie header, even when several are joined with ", ". */
export function cookieFrom(setCookie: string | undefined, name: string): string | null {
  if (!setCookie) return null;
  for (const part of setCookie.split(/,\s*(?=[^;,=\s]+=)/)) {
    const [kv] = part.split(';');
    const i = kv.indexOf('=');
    if (i > 0 && kv.slice(0, i).trim() === name) return kv.slice(i + 1).trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// What a post is

export interface SocialPost {
  site: SocialSite;
  title: string;
  author: string;
  /** links to the same video, best first; each is tried until one works */
  videoUrls: string[];
  /** headers the video host wants */
  headers: Record<string, string>;
}

// ---------------------------------------------------------------------------
// TikTok

interface TikTokBitrate {
  CodecType?: string;
  Bitrate?: number;
  PlayAddr?: { UrlList?: string[]; Height?: number; Width?: number };
}

interface TikTokItem {
  desc?: string;
  author?: { uniqueId?: string; nickname?: string };
  imagePost?: unknown;
  video?: { playAddr?: string; downloadAddr?: string; bitrateInfo?: TikTokBitrate[]; height?: number; width?: number };
}

/** Reads the post out of a TikTok video page. */
export function parseTikTokPage(html: string, maxHeight = 1080): Omit<SocialPost, 'headers'> {
  const json = /<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!json) throw new SocialError('TikTok sent a page ReelForge doesn’t understand. TikTok may have changed something.');
  let data: { __DEFAULT_SCOPE__?: Record<string, { statusCode?: number; itemInfo?: { itemStruct?: TikTokItem } }> };
  try {
    data = JSON.parse(json);
  } catch {
    throw new SocialError('TikTok sent a page ReelForge doesn’t understand. TikTok may have changed something.');
  }
  const scope = data.__DEFAULT_SCOPE__ ?? {};
  const detail = scope['webapp.video-detail'] ?? scope['webapp.reflow.video.detail'];
  const item = detail?.itemInfo?.itemStruct;
  if (!item) {
    const code = detail?.statusCode;
    throw new SocialError(
      code === 10204 || code === 10216
        ? 'This TikTok was deleted or is private.'
        : code === 10222
          ? 'This TikTok is private. Only public posts can be downloaded.'
          : 'Couldn’t find a video on that TikTok page. It may be private, deleted or age-restricted.',
    );
  }
  const v = item.video;
  if (item.imagePost && !v?.playAddr) throw new SocialError('That TikTok is a photo slideshow, not a video.');

  const urls: string[] = [];
  // Plain H.264 is the only kind every phone can edit; HEVC copies are skipped.
  const h264 = (v?.bitrateInfo ?? [])
    .filter((b) => /^h264$/i.test(b.CodecType ?? '') && b.PlayAddr?.UrlList?.length)
    .sort((a, b) => (b.PlayAddr?.Height ?? 0) - (a.PlayAddr?.Height ?? 0) || (b.Bitrate ?? 0) - (a.Bitrate ?? 0));
  const best = h264.find((b) => Math.min(b.PlayAddr?.Height ?? 0, b.PlayAddr?.Width ?? Infinity) <= maxHeight) ?? h264[h264.length - 1];
  if (best) urls.push(...[...best.PlayAddr!.UrlList!].reverse());
  if (v?.playAddr) urls.push(v.playAddr);
  if (v?.downloadAddr) urls.push(v.downloadAddr);
  const unique = [...new Set(urls.filter((u) => /^https?:\/\//.test(u)))];
  if (!unique.length) throw new SocialError('TikTok didn’t offer a downloadable video for this post.');

  const author = item.author?.uniqueId ?? '';
  return {
    site: 'tiktok',
    title: cleanTitle(item.desc) || (author ? `TikTok by @${author}` : 'TikTok video'),
    author: author ? `@${author}` : '',
    videoUrls: unique,
  };
}

async function resolveTikTok(link: SocialLink, net: SocialNet, signal?: AbortSignal, maxHeight?: number): Promise<SocialPost> {
  let page = await net.text(link.url, { headers: PAGE_HEADERS, signal });
  // Short links can land on a page without the video; open the full link instead.
  if (!/__UNIVERSAL_DATA_FOR_REHYDRATION__/.test(page.text) || !/itemStruct/.test(page.text)) {
    const id = tikTokId(page.url) ?? tikTokId(page.text.match(/"canonical"[^>]*href="([^"]+)"/)?.[1] ?? '');
    if (id && !page.url.includes(`/video/${id}`)) page = await net.text(`https://www.tiktok.com/@_/video/${id}`, { headers: PAGE_HEADERS, signal });
  }
  if (page.status >= 400) throw new SocialError(`TikTok refused the request (${page.status}).`);
  return { ...parseTikTokPage(page.text, maxHeight), headers: { 'User-Agent': DESKTOP_UA, Referer: 'https://www.tiktok.com/' } };
}

// ---------------------------------------------------------------------------
// Instagram

/** Fallbacks for when the post page doesn't say; Instagram changes these now and then. */
const IG_DOC_ID = '27776306792043877';
const IG_QUERY = 'PolarisLoggedOutDesktopWWWPostRootContentQuery';
const IG_APP_ID = '936619743392459';

export interface InstagramPageInfo {
  lsd: string | null;
  docId: string;
  queryName: string;
  csrf: string | null;
}

/** The tokens Instagram's own page uses to load a post. */
export function parseInstagramPage(html: string): InstagramPageInfo {
  const lsd =
    /\["LSD",\[\],\{"token":"([^"]+)"/.exec(html)?.[1] ??
    /<script\b[^>]*\bid="__eqmc"[^>]*>[^<]*?"l":"([^"]+)"/.exec(html)?.[1] ??
    /"lsd":"([^"]+)"/.exec(html)?.[1] ??
    null;
  let docId = IG_DOC_ID;
  let queryName = IG_QUERY;
  const at = html.search(/"queryName":"PolarisLoggedOut\w*PostRootContentQuery"/);
  if (at > 0) {
    const seg = html.slice(Math.max(0, at - 600), at + 120);
    docId = [...seg.matchAll(/"queryID":"(\d+)"/g)].pop()?.[1] ?? docId;
    queryName = /"queryName":"(\w+)"/.exec(html.slice(at))?.[1] ?? queryName;
  }
  const csrf = /"csrf_token":"([^"]+)"/.exec(html)?.[1] ?? null;
  return { lsd, docId, queryName, csrf };
}

interface IgMedia {
  media_type?: number;
  video_versions?: { url?: string; width?: number; height?: number; type?: number }[];
  carousel_media?: IgMedia[];
  caption?: { text?: string } | null;
  user?: { username?: string; full_name?: string };
  title?: string;
}

/**
 * Reads the video out of Instagram's answer. `index` is 1-based and picks one item of a post
 * with several photos and videos; the first video is used when it isn't one.
 */
export function parseInstagramMedia(json: unknown, index = 1): Omit<SocialPost, 'headers'> {
  const media = (json as { data?: { xig_polaris_media?: { if_not_gated_logged_out?: IgMedia } | null } })?.data?.xig_polaris_media;
  const post = media?.if_not_gated_logged_out;
  if (!post) throw new SocialError('Instagram didn’t share this post. Only public posts can be downloaded, and Instagram sometimes asks you to sign in after a few downloads.');
  const items = post.carousel_media?.length ? post.carousel_media : [post];
  const withVideo = (m: IgMedia | undefined) => !!m?.video_versions?.some((v) => v.url);
  const item = withVideo(items[index - 1]) ? items[index - 1] : items.find(withVideo);
  if (!item) throw new SocialError('That Instagram post is a photo, not a video.');
  const versions = [...item.video_versions!].filter((v) => v.url);
  versions.sort((a, b) => (b.height ?? 0) * (b.width ?? 0) - (a.height ?? 0) * (a.width ?? 0) || (a.type ?? 0) - (b.type ?? 0));
  const author = post.user?.username ?? '';
  return {
    site: 'instagram',
    title: cleanTitle(post.title) || cleanTitle(post.caption?.text) || (author ? `Instagram by @${author}` : 'Instagram video'),
    author: author ? `@${author}` : '',
    videoUrls: [...new Set(versions.map((v) => v.url!))],
  };
}

async function resolveInstagram(link: SocialLink, net: SocialNet, signal?: AbortSignal): Promise<SocialPost> {
  let page = await net.text(link.url, { headers: PAGE_HEADERS, signal });
  let code = instagramShortcode(page.url) ?? instagramShortcode(link.url);
  // Share links redirect to the post, or name it in the page.
  if (!code) code = instagramShortcode(/<meta[^>]+property="og:url"[^>]+content="([^"]+)"/.exec(page.text)?.[1] ?? '');
  if (!code) {
    if (/\/accounts\/login/.test(page.url)) throw new SocialError('Instagram wants you to sign in before it shows this post. Try again later.');
    throw new SocialError('Couldn’t find the post in that Instagram link.');
  }
  if (!instagramShortcode(page.url)) page = await net.text(`https://www.instagram.com/p/${code}/`, { headers: PAGE_HEADERS, signal });
  if (/\/accounts\/login/.test(page.url)) throw new SocialError('Instagram wants you to sign in before it shows posts. Wait a while and try again.');

  const info = parseInstagramPage(page.text);
  const csrf = info.csrf ?? cookieFrom(page.headers['set-cookie'], 'csrftoken') ?? '';
  if (!info.lsd) throw new SocialError('Instagram sent a page ReelForge doesn’t understand. Instagram may have changed something.');
  const referer = `https://www.instagram.com/p/${code}/`;
  const body = new URLSearchParams({
    lsd: info.lsd,
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: info.queryName,
    server_timestamps: 'true',
    variables: JSON.stringify({ media_id: instagramMediaId(code) }),
    doc_id: info.docId,
  }).toString();
  const res = await net.text('https://www.instagram.com/api/graphql', {
    method: 'POST',
    body,
    signal,
    headers: {
      'User-Agent': DESKTOP_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: '*/*',
      Origin: 'https://www.instagram.com',
      Referer: referer,
      'X-FB-LSD': info.lsd,
      'X-FB-Friendly-Name': info.queryName,
      'X-IG-App-ID': IG_APP_ID,
      'X-ASBD-ID': '359341',
      'X-IG-WWW-Claim': '0',
      'X-CSRFToken': csrf,
      'X-Requested-With': 'XMLHttpRequest',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    },
  });
  if (res.status === 429) throw new SocialError('Instagram says too many downloads. Wait a while and try again.');
  let json: unknown;
  try {
    json = JSON.parse(res.text.replace(/^for \(;;\);/, ''));
  } catch {
    throw new SocialError(
      res.status >= 400 ? `Instagram refused the request (${res.status}).` : 'Instagram sent an answer ReelForge doesn’t understand. Instagram may have changed something.',
    );
  }
  const index = Number(new URL(link.url).searchParams.get('img_index')) || 1;
  return { ...parseInstagramMedia(json, index), headers: { 'User-Agent': DESKTOP_UA, Referer: 'https://www.instagram.com/' } };
}

// ---------------------------------------------------------------------------
// Download

export interface SocialDownloadOptions {
  /** largest picture height to choose, when the site offers several */
  maxHeight?: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number | null, label: string) => void;
}

export interface SocialDownload {
  /** an MP4 with picture and sound */
  blob: Blob;
  title: string;
  author: string;
}

const CHUNK = 8 * 1024 * 1024;

/** Finds the post's video and downloads it. */
export async function downloadSocial(link: SocialLink, net: SocialNet, o: SocialDownloadOptions = {}): Promise<SocialDownload> {
  const name = SITE_NAMES[link.site];
  o.onProgress?.(null, `Opening the ${name} post`);
  const post = link.site === 'tiktok' ? await resolveTikTok(link, net, o.signal, o.maxHeight) : await resolveInstagram(link, net, o.signal);
  let lastStatus = 0;
  for (const url of post.videoUrls) {
    if (o.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    try {
      const blob = await fetchRanges(url, post.headers, net, o, `Downloading from ${name}`);
      if (blob) return { blob, title: post.title, author: post.author };
    } catch (e) {
      if (o.signal?.aborted || (e as Error)?.name === 'AbortError') throw e;
      lastStatus = (e as { status?: number })?.status ?? lastStatus;
      console.warn(`${name} video link failed`, e);
    }
  }
  throw new SocialError(
    lastStatus ? `${name} refused the download (${lastStatus}). Try again in a minute.` : `Couldn’t download the video from ${name}. Check your connection and try again.`,
  );
}

/** Downloads a file in pieces so progress can be shown; null when the host sent nothing usable. */
async function fetchRanges(url: string, headers: Record<string, string>, net: SocialNet, o: SocialDownloadOptions, label: string): Promise<Blob | null> {
  const parts: Blob[] = [];
  let got = 0;
  let total = 0;
  let type = '';
  for (;;) {
    if (o.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const end = total ? Math.min(total, got + CHUNK) - 1 : got + CHUNK - 1;
    let res: Response | null = null;
    for (let attempt = 0; attempt < 3 && !res?.ok; attempt++) {
      try {
        res = await net.bytes(url, { headers: { ...headers, Range: `bytes=${got}-${end}` }, signal: o.signal });
      } catch (e) {
        if (o.signal?.aborted) throw e;
        res = null;
      }
      // A refusal won't change on a retry.
      if (res && (res.status === 403 || res.status === 404 || res.status === 410)) break;
    }
    if (!res?.ok) throw Object.assign(new SocialError(`HTTP ${res?.status ?? 'no connection'}`), { status: res?.status });
    type ||= res.headers.get('content-type') ?? '';
    if (got === 0 && /text\/html|application\/json/i.test(type)) return null;
    const buf = await res.arrayBuffer();
    if (!buf.byteLength) break;
    // The host ignored the range and sent the whole file.
    if (res.status === 200) {
      parts.length = 0;
      parts.push(new Blob([buf]));
      got = buf.byteLength;
      break;
    }
    total ||= Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1]) || 0;
    parts.push(new Blob([buf]));
    got += buf.byteLength;
    o.onProgress?.(total ? Math.min(1, got / total) : null, label);
    if (total ? got >= total : buf.byteLength < CHUNK) break;
  }
  if (!got) return null;
  return new Blob(parts, { type: /^video\//.test(type) ? type.split(';')[0] : 'video/mp4' });
}

function cleanTitle(text: string | undefined | null): string {
  if (!text) return '';
  const firstLine = text.split('\n')[0].replace(/\s+/g, ' ').trim();
  // Hashtag-only captions make poor names.
  const words = firstLine.replace(/(^|\s)#[^\s#]+/g, ' ').replace(/\s+/g, ' ').trim();
  const t = words || firstLine;
  return t.length > 80 ? `${t.slice(0, 77).trimEnd()}…` : t;
}
