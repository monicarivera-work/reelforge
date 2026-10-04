import { useEffect, useRef } from 'react';

/**
 * Hardware/gesture "back" support: every open sheet or dialog pushes a history entry so the
 * Android back button (or iOS edge swipe in the installed app) closes it instead of leaving.
 */
interface Entry {
  id: number;
  close: () => void;
  /** whether its history entry exists yet (pushes wait for pending programmatic backs) */
  pushed: boolean;
}

const stack: Entry[] = [];
let seq = 0;
let ignore = 0;
let ignoreTimer: ReturnType<typeof setTimeout> | null = null;

function flushPushes() {
  for (const e of stack) {
    if (e.pushed) continue;
    e.pushed = true;
    history.pushState({ rfBack: e.id }, '');
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    if (ignore > 0) {
      ignore--;
      if (ignore === 0) {
        if (ignoreTimer) clearTimeout(ignoreTimer);
        ignoreTimer = null;
        flushPushes();
      }
      return;
    }
    stack.pop()?.close();
  });
}

/** Registers a back handler. Returns a release function to call when closed by other means. */
export function pushBack(close: () => void): () => void {
  const id = ++seq;
  // history.back() is asynchronous; pushing before it lands would make it pop the new entry.
  const e: Entry = { id, close, pushed: ignore === 0 };
  stack.push(e);
  if (e.pushed) history.pushState({ rfBack: id }, '');
  return () => {
    const i = stack.findIndex((x) => x.id === id);
    if (i < 0) return;
    stack.splice(i, 1);
    if (!e.pushed) return;
    ignore++;
    history.back();
    // Safety net in case the popstate never arrives (should not happen).
    if (ignoreTimer) clearTimeout(ignoreTimer);
    ignoreTimer = setTimeout(() => {
      ignore = 0;
      ignoreTimer = null;
      flushPushes();
    }, 1500);
  };
}

/**
 * Closes the component via the back button while `active` is true. If `onBack` returns false
 * (e.g. a running export), the entry is re-armed so the next back press is caught too.
 */
export function useBack(active: boolean, onBack: () => void | boolean) {
  const ref = useRef(onBack);
  ref.current = onBack;
  useEffect(() => {
    if (!active) return;
    let popped = false;
    let release = () => {};
    const arm = () => {
      popped = false;
      release = pushBack(() => {
        popped = true;
        if (ref.current() === false) arm();
      });
    };
    arm();
    return () => {
      if (!popped) release();
    };
  }, [active]);
}

/** Number of open back handlers (sheets/dialogs). */
export function backDepth(): number {
  return stack.length;
}

/** Resolves once programmatic history.back() calls from closed sheets have been processed. */
export function settled(timeoutMs = 600): Promise<void> {
  const until = performance.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = () => (ignore === 0 || performance.now() > until ? resolve() : setTimeout(check, 16));
    check();
  });
}
