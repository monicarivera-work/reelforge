export const uid = (prefix = '') =>
  prefix + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
export const backOut = (t: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

export function formatTime(s: number, frac = false): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  // Integer tenths avoid float drift (2.3 - 2 = 0.2999…).
  const tenths = Math.floor(s * 10 + 1e-6);
  const whole = Math.floor(tenths / 10);
  const mm = String(Math.floor(whole / 60)).padStart(2, '0');
  const ss = String(whole % 60).padStart(2, '0');
  return frac ? `${mm}:${ss}.${tenths % 10}` : `${mm}:${ss}`;
}

export function formatDuration(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  // Tenths are truncated like formatTime so this matches the editor's timer.
  const tenths = Math.floor(s * 10 + 1e-6);
  if (tenths < 100) return `${(tenths / 10).toFixed(1)}s`;
  const whole = Math.round(s);
  return whole < 60 ? `${whole}s` : formatTime(whole);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i >= 2 ? 1 : 0)} ${u[i]}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return [1, 1, 1];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, ms);
  };
  wrapped.flush = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    fn(...args);
  };
  return wrapped;
}

export const isIOS = (() => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
})();

export const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

export function deepClone<T>(v: T): T {
  return structuredClone(v);
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * A name that's safe to save on any phone or computer. Keeps spaces, accents and emoji;
 * only removes the characters file systems reject.
 */
export function safeFileName(name: string, fallback = 'video'): string {
  const s = name
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return Array.from(s).slice(0, 80).join('').trim() || fallback;
}
