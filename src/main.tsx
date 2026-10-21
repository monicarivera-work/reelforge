import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';

// Text fonts (subsets load on demand through unicode-range).
import '@fontsource/montserrat/600.css';
import '@fontsource/montserrat/800.css';
import '@fontsource/montserrat/900.css';
import '@fontsource/montserrat/600-italic.css';
import '@fontsource/montserrat/800-italic.css';
import '@fontsource/montserrat/900-italic.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/800.css';
import '@fontsource/inter/400-italic.css';
import '@fontsource/inter/600-italic.css';
import '@fontsource/inter/800-italic.css';
import '@fontsource/poppins/500.css';
import '@fontsource/poppins/700.css';
import '@fontsource/poppins/900.css';
import '@fontsource/poppins/500-italic.css';
import '@fontsource/poppins/700-italic.css';
import '@fontsource/poppins/900-italic.css';
import '@fontsource/anton/400.css';
import '@fontsource/bebas-neue/400.css';
import '@fontsource/oswald/500.css';
import '@fontsource/oswald/700.css';
import '@fontsource/bangers/400.css';
import '@fontsource/permanent-marker/400.css';
import '@fontsource/pacifico/400.css';
import '@fontsource/lobster/400.css';
import '@fontsource/playfair-display/700.css';
import '@fontsource/playfair-display/900.css';
import '@fontsource/playfair-display/700-italic.css';
import '@fontsource/playfair-display/900-italic.css';
import '@fontsource/roboto-mono/500.css';
import '@fontsource/roboto-mono/700.css';
import '@fontsource/roboto-mono/500-italic.css';
import '@fontsource/roboto-mono/700-italic.css';

import './styles.css';
import { App } from './App';
import { useApp } from './state/app';
import { trackKeyboard } from './lib/device';
import { isNativeApp } from './lib/util';

trackKeyboard();

// The Android app updates by installing a new APK, so it doesn't use the offline service worker.
const updateSW = isNativeApp()
  ? null
  : registerSW({
      onNeedRefresh() {
        useApp.setState({ needRefresh: true });
      },
      onRegisteredSW(_url, reg) {
        // Installed apps can stay open for days; look for updates every hour.
        if (reg) setInterval(() => void reg.update().catch(() => undefined), 60 * 60 * 1000);
      },
      onRegisterError(e) {
        console.warn('Service worker registration failed', e);
      },
    });
if (updateSW) useApp.setState({ updateSW });

createRoot(document.getElementById('root')!).render(<App />);
