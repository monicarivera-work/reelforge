/**
 * Phone-specific glue: on-screen keyboard tracking, iOS keyboard priming and file picking.
 */

/** Keeps `--kb` (CSS px hidden behind the on-screen keyboard) up to date. */
export function trackKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  const update = () => {
    const raw = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    const kb = raw > 60 ? raw : 0;
    root.style.setProperty('--kb', `${kb}px`);
    if (kb) root.setAttribute('data-kb', '');
    else root.removeAttribute('data-kb');
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
  // iOS sometimes leaves the page scrolled after the keyboard closes.
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      const a = document.activeElement;
      if (!a || !(a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement)) window.scrollTo(0, 0);
    }, 50);
  });
}

let primer: HTMLInputElement | null = null;

/**
 * iOS only opens the keyboard for focus() calls made during a tap. Call this synchronously in the
 * tap handler; the real input can then take focus when it mounts and the keyboard stays up.
 */
export function primeKeyboard() {
  if (!primer) {
    primer = document.createElement('input');
    primer.type = 'text';
    primer.setAttribute('aria-hidden', 'true');
    primer.tabIndex = -1;
    primer.style.cssText =
      'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;font-size:16px;border:0;padding:0;pointer-events:none;';
    document.body.appendChild(primer);
  }
  primer.focus({ preventScroll: true });
}

/** Opens the system file picker. Must be called synchronously from a tap/click handler. */
export function pickFiles(accept: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.cssText = 'position:fixed;left:-1000px;top:0;opacity:0;';
    let done = false;
    const finish = (files: File[]) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
}

/** Shares a file through the OS share sheet when possible; returns false if unsupported. */
export async function shareFile(file: File, title: string): Promise<'shared' | 'cancelled' | 'unsupported'> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (!nav.share || !nav.canShare?.({ files: [file] })) return 'unsupported';
  try {
    await nav.share({ files: [file], title });
    return 'shared';
  } catch (e) {
    if ((e as Error).name === 'AbortError') return 'cancelled';
    throw e;
  }
}

export const canEncodeVideo = () => typeof VideoEncoder !== 'undefined';

type WakeLockNav = Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };

/** Keeps the screen on during long jobs (export, captions); null where unsupported or refused. */
export async function acquireWakeLock(): Promise<{ release(): Promise<void> } | null> {
  try {
    return (await (navigator as WakeLockNav).wakeLock?.request('screen')) ?? null;
  } catch {
    return null;
  }
}
