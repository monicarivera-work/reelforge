import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.monicariverawork.reelforge',
  appName: 'ReelForge',
  webDir: 'dist',
  backgroundColor: '#0b0b0f',
  android: {
    // Lets you inspect the app from desktop Chrome (chrome://inspect) when it misbehaves.
    webContentsDebuggingEnabled: true,
  },
};

export default config;
