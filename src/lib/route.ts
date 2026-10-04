import { useSyncExternalStore } from 'react';

export type Route = { name: 'home' } | { name: 'editor'; id: string };

function parse(): Route {
  const m = /^#\/p\/([\w-]+)/.exec(location.hash);
  return m ? { name: 'editor', id: m[1] } : { name: 'home' };
}

let current: Route = typeof location !== 'undefined' ? parse() : { name: 'home' };
const listeners = new Set<() => void>();
/** Whether the editor entry was pushed on top of Home (so leaving can simply go back). */
let pushedFromHome = false;

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    const next = parse();
    if (next.name === 'home') pushedFromHome = false;
    if (next.name !== current.name || (next.name === 'editor' && current.name === 'editor' && next.id !== current.id)) {
      current = next;
      listeners.forEach((l) => l());
    }
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, () => current);
}

export function openProject(id: string) {
  pushedFromHome = true;
  location.hash = `#/p/${id}`;
}

export function goHome() {
  if (pushedFromHome) {
    pushedFromHome = false;
    history.back();
  } else {
    location.replace('#/');
  }
}
