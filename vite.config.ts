import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The Android app (Capacitor) serves the build from the root; GitHub Pages serves it from /reelforge/.
const BASE = process.env.CAPACITOR_BUILD ? '/' : '/reelforge/';

export default defineConfig({
  base: BASE,
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        id: BASE,
        name: 'ReelForge – Video Editor',
        short_name: 'ReelForge',
        description:
          'Edit videos on your phone: trim, split, auto-captions, text, music, voiceover, transitions, filters, green screen and HD export.',
        lang: 'en',
        theme_color: '#0b0b0f',
        background_color: '#0b0b0f',
        display: 'standalone',
        orientation: 'portrait',
        start_url: BASE,
        scope: BASE,
        categories: ['photo', 'video', 'productivity'],
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Icons are added by includeAssets and the manifest, so they aren't globbed again here.
        globPatterns: ['**/*.{js,css,html}', 'assets/*-latin-[0-9]*-*.woff2'],
        // The speech-recognition runtime is large and optional: cache it the first time captions are used.
        globIgnores: ['**/captions.worker*', '**/*.wasm'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.endsWith('.woff2') || url.pathname.endsWith('.woff'),
            handler: 'CacheFirst',
            options: { cacheName: 'rf-fonts', expiration: { maxEntries: 300 } },
          },
          {
            urlPattern: ({ url }) => url.pathname.includes('/assets/captions.worker'),
            handler: 'CacheFirst',
            options: { cacheName: 'rf-captions', expiration: { maxEntries: 8 } },
          },
        ],
      },
    }),
  ],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
  },
});
