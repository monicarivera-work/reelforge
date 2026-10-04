import { create } from 'zustand';

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface AppState {
  /** a new version of the app has been downloaded and is waiting */
  needRefresh: boolean;
  /** Android/desktop Chrome install prompt, captured for a custom Install button */
  installEvent: BeforeInstallPromptEvent | null;
  updateSW: ((reload?: boolean) => Promise<void>) | null;
}

export const useApp = create<AppState>()(() => ({
  needRefresh: false,
  installEvent: null,
  updateSW: null,
}));

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    useApp.setState({ installEvent: e as BeforeInstallPromptEvent });
  });
  window.addEventListener('appinstalled', () => useApp.setState({ installEvent: null }));
}
