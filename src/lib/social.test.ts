import { describe, expect, it } from 'vitest';
import {
  cookieFrom,
  downloadSocial,
  instagramMediaId,
  parseInstagramMedia,
  parseInstagramPage,
  parseSocialLink,
  parseTikTokPage,
  SocialError,
  type HttpRequest,
  type SocialNet,
} from './social';

describe('parseSocialLink', () => {
  it('recognizes TikTok links', () => {
    expect(parseSocialLink('https://www.tiktok.com/@someone/video/7047596209028074758?is_from_webapp=1&sender_device=pc')).toEqual({
      site: 'tiktok',
      url: 'https://www.tiktok.com/@someone/video/7047596209028074758',
    });
    expect(parseSocialLink('tiktok.com/@someone/video/7047596209028074758')?.site).toBe('tiktok');
    expect(parseSocialLink('https://m.tiktok.com/v/7047596209028074758.html')?.site).toBe('tiktok');
    expect(parseSocialLink('https://vm.tiktok.com/ZMabc123/')).toEqual({ site: 'tiktok', url: 'https://vm.tiktok.com/ZMabc123/' });
    expect(parseSocialLink('https://vt.tiktok.com/ZSxyz/?k=1')).toEqual({ site: 'tiktok', url: 'https://vt.tiktok.com/ZSxyz/' });
    expect(parseSocialLink('https://www.tiktok.com/t/ZTabc/')).toEqual({ site: 'tiktok', url: 'https://www.tiktok.com/t/ZTabc/' });
  });

  it('recognizes Instagram links', () => {
    expect(parseSocialLink('https://www.instagram.com/reel/Chunk8-jurw/?igsh=abc')).toEqual({
      site: 'instagram',
      url: 'https://www.instagram.com/p/Chunk8-jurw/',
    });
    expect(parseSocialLink('instagram.com/reels/Cop84x6u7CP')?.url).toBe('https://www.instagram.com/p/Cop84x6u7CP/');
    expect(parseSocialLink('https://www.instagram.com/someone/reel/CWqAgUZgCku/')?.url).toBe('https://www.instagram.com/p/CWqAgUZgCku/');
    expect(parseSocialLink('https://instagram.com/tv/BkfuX9UB-eK')?.url).toBe('https://www.instagram.com/p/BkfuX9UB-eK/');
    expect(parseSocialLink('https://www.instagram.com/p/BQ0eAlwhDrw/?img_index=2')?.url).toBe('https://www.instagram.com/p/BQ0eAlwhDrw/?img_index=2');
    expect(parseSocialLink('https://www.instagram.com/share/reel/BAabc123/')?.site).toBe('instagram');
  });

  it('ignores other links and profiles', () => {
    expect(parseSocialLink('https://www.tiktok.com/@someone')).toBeNull();
    expect(parseSocialLink('https://www.instagram.com/someone/')).toBeNull();
    expect(parseSocialLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(parseSocialLink('https://nottiktok.com/@a/video/7047596209028074758')).toBeNull();
    expect(parseSocialLink('cute cats')).toBeNull();
  });
});

describe('instagramMediaId', () => {
  it('turns a post code into its number', () => {
    expect(instagramMediaId('Chunk8-jurw')).toBe('2913440072144448240');
    expect(instagramMediaId('BQ0eAlwhDrw')).toBe('1455920561485265648');
  });
  it('drops the private-post suffix', () => {
    expect(instagramMediaId(`BQ0eAlwhDrw${'x'.repeat(28)}`)).toBe('1455920561485265648');
  });
});

describe('cookieFrom', () => {
  it('finds a cookie among several joined ones', () => {
    const h = 'mid=abc; Domain=.instagram.com; expires=Wed, 21 Oct 2027 07:28:00 GMT; Path=/, csrftoken=TOKEN123; Path=/; Secure';
    expect(cookieFrom(h, 'csrftoken')).toBe('TOKEN123');
    expect(cookieFrom(h, 'mid')).toBe('abc');
    expect(cookieFrom(h, 'nope')).toBeNull();
    expect(cookieFrom(undefined, 'mid')).toBeNull();
  });
});

const tikTokPage = (item: unknown, statusCode = 0) =>
  `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
    __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode, ...(item ? { itemInfo: { itemStruct: item } } : {}) } },
  })}</script></html>`;

describe('parseTikTokPage', () => {
  const item = {
    desc: 'Dance practice #fyp #dance',
    author: { uniqueId: 'dancer' },
    video: {
      playAddr: 'https://v16.example/play',
      downloadAddr: 'https://v16.example/download',
      bitrateInfo: [
        { CodecType: 'h265_hvc1', PlayAddr: { Height: 1920, Width: 1080, UrlList: ['https://v16.example/hevc'] } },
        { CodecType: 'h264', Bitrate: 900, PlayAddr: { Height: 1024, Width: 576, UrlList: ['https://a.example/540', 'https://b.example/540'] } },
        { CodecType: 'h264', Bitrate: 2000, PlayAddr: { Height: 1920, Width: 1080, UrlList: ['https://a.example/1080'] } },
      ],
    },
  };

  it('prefers the best H.264 copy, then the regular links', () => {
    const post = parseTikTokPage(tikTokPage(item));
    expect(post.title).toBe('Dance practice');
    expect(post.author).toBe('@dancer');
    expect(post.videoUrls).toEqual(['https://a.example/1080', 'https://v16.example/play', 'https://v16.example/download']);
  });

  it('respects the quality limit', () => {
    expect(parseTikTokPage(tikTokPage(item), 720).videoUrls[0]).toBe('https://b.example/540');
  });

  it('explains deleted posts and slideshows', () => {
    expect(() => parseTikTokPage(tikTokPage(null, 10204))).toThrow(/deleted or is private/);
    expect(() => parseTikTokPage(tikTokPage({ imagePost: { images: [] }, video: {} }))).toThrow(/photo slideshow/);
    expect(() => parseTikTokPage('<html></html>')).toThrow(SocialError);
  });
});

describe('Instagram', () => {
  it('reads tokens from the post page', () => {
    const html =
      '["LSD",[],{"token":"LSDTOKEN"},323]' +
      '{"queryID":"111","variables":{"media_id":"1"},"queryName":"PolarisLoggedOutDesktopWWWPostRootContentQuery"}' +
      '"csrf_token":"CSRF"';
    expect(parseInstagramPage(html)).toEqual({ lsd: 'LSDTOKEN', docId: '111', queryName: 'PolarisLoggedOutDesktopWWWPostRootContentQuery', csrf: 'CSRF' });
    expect(parseInstagramPage('<html></html>').docId).toMatch(/^\d+$/);
  });

  const wrap = (post: unknown) => ({ data: { xig_polaris_media: { if_not_gated_logged_out: post } } });

  it('reads a reel', () => {
    const post = parseInstagramMedia(
      wrap({
        user: { username: 'cats' },
        caption: { text: 'Gingerton\n\nmore text' },
        video_versions: [
          { type: 101, url: 'https://cdn/hi.mp4' },
          { type: 102, url: 'https://cdn/mid.mp4' },
        ],
      }),
    );
    expect(post).toMatchObject({ site: 'instagram', title: 'Gingerton', author: '@cats', videoUrls: ['https://cdn/hi.mp4', 'https://cdn/mid.mp4'] });
  });

  it('picks the chosen item of a carousel, or its first video', () => {
    const json = wrap({
      user: { username: 'a' },
      carousel_media: [
        { media_type: 1 },
        { media_type: 2, video_versions: [{ url: 'https://cdn/2.mp4' }] },
        { media_type: 2, video_versions: [{ url: 'https://cdn/3.mp4' }] },
      ],
    });
    expect(parseInstagramMedia(json, 3).videoUrls).toEqual(['https://cdn/3.mp4']);
    expect(parseInstagramMedia(json, 1).videoUrls).toEqual(['https://cdn/2.mp4']);
  });

  it('explains photos and hidden posts', () => {
    expect(() => parseInstagramMedia(wrap({ media_type: 1 }))).toThrow(/photo/);
    expect(() => parseInstagramMedia({ data: { xig_polaris_media: null } })).toThrow(/public posts/);
  });
});

describe('downloadSocial', () => {
  const file = new Uint8Array(20 * 1024 * 1024).map((_, i) => i % 251);

  function fakeNet(refuse: string[] = []): SocialNet & { ranges: string[] } {
    const ranges: string[] = [];
    return {
      ranges,
      async text(url) {
        return { status: 200, url, headers: {}, text: tikTokPage({ author: { uniqueId: 'x' }, video: { playAddr: 'https://cdn/bad', downloadAddr: 'https://cdn/good' } }) };
      },
      async bytes(url, init: HttpRequest = {}) {
        if (refuse.some((r) => url.endsWith(r))) return new Response('no', { status: 403 });
        const range = init.headers?.Range ?? '';
        ranges.push(range);
        const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range)!.map(Number);
        const end = Math.min(b, file.length - 1);
        return new Response(file.slice(a, end + 1), {
          status: 206,
          headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${a}-${end}/${file.length}` },
        });
      },
    };
  }

  it('skips refused links and downloads in pieces', async () => {
    const net = fakeNet(['bad']);
    const progress: (number | null)[] = [];
    const got = await downloadSocial({ site: 'tiktok', url: 'https://www.tiktok.com/@x/video/1234567' }, net, { onProgress: (p) => progress.push(p) });
    expect(got.blob.size).toBe(file.length);
    expect(got.blob.type).toBe('video/mp4');
    expect(Buffer.from(await got.blob.arrayBuffer()).equals(Buffer.from(file))).toBe(true);
    expect(net.ranges).toEqual(['bytes=0-8388607', 'bytes=8388608-16777215', 'bytes=16777216-20971519']);
    expect(progress.at(-1)).toBe(1);
    expect(got.title).toBe('TikTok by @x');
  });

  it('reports when every link is refused', async () => {
    await expect(downloadSocial({ site: 'tiktok', url: 'https://www.tiktok.com/@x/video/1234567' }, fakeNet(['bad', 'good']))).rejects.toThrow(
      /TikTok refused the download \(403\)/,
    );
  });
});
