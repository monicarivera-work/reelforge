// Generates the app icons in public/ (no dependencies): node scripts/icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';

const OUT = new URL('../public/', import.meta.url);
mkdirSync(OUT, { recursive: true });

// Geometry in unit coordinates (0..1, y down). The play triangle is rounded by R.
const TRI = [
  [0.4, 0.31],
  [0.4, 0.69],
  [0.72, 0.5],
];
const R = 0.045;

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const BG_TOP = hex('#2a2a36');
const BG_BOTTOM = hex('#0b0b0f');
const PINK_TOP = hex('#ff5a85');
const PINK_BOTTOM = hex('#e0245e');
const GLOW = hex('#ff3d6e');

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

// Signed distance to a triangle (Inigo Quilez).
function sdTriangle(p, [p0, p1, p2]) {
  const e = [
    [p1[0] - p0[0], p1[1] - p0[1]],
    [p2[0] - p1[0], p2[1] - p1[1]],
    [p0[0] - p2[0], p0[1] - p2[1]],
  ];
  const v = [
    [p[0] - p0[0], p[1] - p0[1]],
    [p[0] - p1[0], p[1] - p1[1]],
    [p[0] - p2[0], p[1] - p2[1]],
  ];
  const s = Math.sign(e[0][0] * e[2][1] - e[0][1] * e[2][0]);
  let dx = Infinity;
  let dy = Infinity;
  for (let i = 0; i < 3; i++) {
    const h = clamp(dot(v[i], e[i]) / dot(e[i], e[i]), 0, 1);
    const pq = [v[i][0] - e[i][0] * h, v[i][1] - e[i][1] * h];
    dx = Math.min(dx, dot(pq, pq));
    dy = Math.min(dy, s * (v[i][0] * e[i][1] - v[i][1] * e[i][0]));
  }
  return -Math.sqrt(dx) * Math.sign(dy);
}

function sdRoundRect(p, radius) {
  const qx = Math.abs(p[0] - 0.5) - (0.5 - radius);
  const qy = Math.abs(p[1] - 0.5) - (0.5 - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/**
 * @param size output pixels
 * @param corner tile corner radius (0 = full-bleed square)
 * @param scale size of the glyph relative to the tile (maskable icons keep it inside the safe zone)
 */
function render(size, { corner = 0, scale = 1 } = {}) {
  const SS = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const p = [(x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size];
          if (corner > 0 && sdRoundRect(p, corner) > 0) continue;
          let c = mix(BG_TOP, BG_BOTTOM, p[1]);
          const gd = Math.hypot(p[0] - 0.53, p[1] - 0.5) / 0.48;
          if (gd < 1) c = mix(c, GLOW, 0.2 * (1 - gd) ** 2);
          // glyph space: scale around the centre
          const q = [(p[0] - 0.5) / scale + 0.5, (p[1] - 0.5) / scale + 0.5];
          if (sdTriangle(q, TRI) - R <= 0) c = mix(PINK_TOP, PINK_BOTTOM, clamp((q[1] - 0.265) / 0.47, 0, 1));
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const i = (y * size + x) * 4;
      const n = SS * SS;
      // stored un-premultiplied: average colour of the covered samples, alpha = coverage
      px[i] = a ? Math.round((r / a) * 255) : 0;
      px[i + 1] = a ? Math.round((g / a) * 255) : 0;
      px[i + 2] = a ? Math.round((b / a) * 255) : 0;
      px[i + 3] = Math.round((a / n) * 255);
    }
  }
  return encodePng(size, size, px);
}

function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const files = {
  'pwa-192.png': render(192, { corner: 0.22 }),
  'pwa-512.png': render(512, { corner: 0.22 }),
  'maskable-512.png': render(512, { scale: 0.82 }),
  // iOS rounds the corners itself and needs an opaque square
  'apple-touch-icon.png': render(180),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(new URL(name, OUT), data);
  console.log(`${name}  ${data.length} bytes`);
}

const f = (v) => +(v * 64).toFixed(2);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2a36"/><stop offset="1" stop-color="#0b0b0f"/></linearGradient>
    <linearGradient id="pk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff5a85"/><stop offset="1" stop-color="#e0245e"/></linearGradient>
  </defs>
  <rect width="64" height="64" rx="${f(0.22)}" fill="url(#bg)"/>
  <path d="M${TRI.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L')} Z" fill="url(#pk)" stroke="url(#pk)" stroke-width="${f(R * 2)}" stroke-linejoin="round"/>
</svg>
`;
writeFileSync(new URL('favicon.svg', OUT), svg);
console.log('favicon.svg');

// Android launcher icons (legacy square and round, plus the adaptive-icon foreground).
const RES = new URL('../android/app/src/main/res/', import.meta.url);
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, k] of Object.entries(DENSITIES)) {
  const dir = new URL(`mipmap-${d}/`, RES);
  mkdirSync(dir, { recursive: true });
  // Adaptive icons are 108dp with the middle 66dp always visible, so the glyph shrinks to fit.
  writeFileSync(new URL('ic_launcher_foreground.png', dir), render(Math.round(108 * k), { scale: 0.6 }));
  writeFileSync(new URL('ic_launcher.png', dir), render(Math.round(48 * k), { corner: 0.22 }));
  writeFileSync(new URL('ic_launcher_round.png', dir), render(Math.round(48 * k), { corner: 0.5 }));
}
console.log('android launcher icons');
