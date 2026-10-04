# ReelForge

A full video editor for content creators that runs on your phone. Edit, caption and export without an account, uploads, watermark or subscription. Everything, including speech-to-text and video encoding, happens on the device.

**Open it:** https://monicarivera-work.github.io/reelforge/

## Install it on your phone

- **iPhone:** open the link in Safari, tap **Share**, then **Add to Home Screen**.
- **Android:** open the link in Chrome, tap the **⋮** menu, then **Install app** (or **Add to Home screen**).

After the first visit it works offline. Auto-captions download a speech model (about 65 MB) the first time you use them.

## What you can do

- **Clips:** import videos, photos and audio, then trim, split, duplicate, reorder, replace, rotate, flip, freeze a frame and extract the audio.
- **Speed:** 0.1× to 10×, with pitch that follows the speed.
- **Canvas:** 9:16, 16:9, 1:1, 4:5, 3:4, 4:3 and 21:9; fit or fill; a blurred or solid color background.
- **Text and stickers:** styled text presets, 12 fonts, outline, shadow, background, emoji stickers, and in and out animations.
- **Auto-captions:** word-timed captions with karaoke-style highlighting, generated on the device, with SRT export.
- **Audio:** music, voiceover recording, built-in sound effects, volume, fades and mute.
- **Look:** 20 filters, 12 adjustments (brightness, contrast, saturation, warmth and more), crop, masks, blend modes, opacity and green screen.
- **Motion:** 17 transitions, Ken Burns zoom and pan, and keyframes for position, scale, rotation and opacity.
- **Layers:** picture-in-picture overlays, text and audio tracks.
- **Export:** MP4 at up to 4K and 60 fps with a size estimate, then share straight to TikTok, Instagram or YouTube. You can also save a single frame as a thumbnail.
- **Safety net:** unlimited undo and redo, and autosave of every project to the device.

## Privacy

Projects and media are stored in your browser's storage on this device and are never uploaded. Clearing the site's data or uninstalling the app deletes them, so save finished videos to your camera roll.

## Browser support

ReelForge needs WebCodecs and WebGL2: iOS 17 or later (Safari), or a recent Chrome on Android. Desktop Chrome, Edge and Safari work too.

## Development

```sh
npm install
npm run dev      # dev server, reachable from your phone on the same Wi-Fi
npm test         # unit tests
npm run build    # type-check and production build into dist/
node scripts/icons.mjs   # regenerate the app icons in public/
```

Pushing to `main` deploys to GitHub Pages through `.github/workflows/deploy.yml`.

Built with React, TypeScript, Vite, [Mediabunny](https://mediabunny.dev) (WebCodecs), WebGL2 and [Transformers.js](https://huggingface.co/docs/transformers.js) (Whisper).
