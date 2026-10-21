# ReelForge

A full video editor for content creators that runs on your phone. Edit, caption and export without an account, uploads, watermark or subscription. Everything, including speech-to-text and video encoding, happens on the device.

**Open it:** https://monicarivera-work.github.io/reelforge/

## Install it on your phone

- **Android app (Samsung and other Android phones):** on the phone, open the [Latest Android app release](https://github.com/monicarivera-work/reelforge/releases/tag/android-latest) and tap **ReelForge.apk**. Open the downloaded file and tap **Install**. The first time, Android asks you to allow installs from your browser (on Samsung: **Settings → Apps → Special access → Install unknown apps**). New versions install over the old one and keep your clips. Only the Android app can search and download from YouTube.
- **iPhone:** open the link in Safari, tap **Share**, then **Add to Home Screen**.
- **Android, desktop or any browser:** open the link in Chrome, tap the **⋮** menu, then **Install app** (or **Add to Home screen**).

After the first visit it works offline. Auto-captions download a speech model (about 65 MB) the first time you use them.

## What you can do

- **Clips:** import videos, photos and audio, then trim, split, duplicate, reorder, replace, rotate, flip, freeze a frame, extract the audio and make soundbites.
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

## Clip studio

Tap **Clip studio** on the home screen to watch, search and clip on one screen.

1. **Find a video.** In the Android app, type in the search box to search YouTube, or paste a YouTube link. In any browser you can paste a YouTube link to watch it, paste a direct link to a video or audio file, or tap the folder button to open a file from your device.
2. **Mark the clip.** Play the video and tap **Now** to set the start and end, or type the times. Tap **Play the clip** to check it.
3. **Choose video or audio,** and pick a crop shape (9:16, 1:1, 4:5, 16:9 or free). Drag the box to move it; drag its corner to resize it.
4. **YouTube videos** download first (Android app only): pick 360p, 720p or 1080p and tap **Download to crop and clip**. Your start and end stay marked.
5. **Name it, pick a folder and tap Save.** Video clips are saved as MP4 and audio clips as .m4a (or .wav).

Saved clips appear under **Clips** on the home screen. There you can make folders, filter by video or audio, search, play, share, save to the device (Documents/ReelForge in the Android app), rename, move, delete, or open a clip in a new editing project.

Only download and clip videos you own or have permission to use, and follow YouTube's Terms of Service. YouTube changes how it serves videos from time to time, so YouTube search or downloads may stop working until the app is updated.

## Make a soundbite

1. Tap a video clip on the timeline, then tap **Soundbite**.
2. Type where the soundbite starts and ends, counted from the beginning of the clip's original video. `42.5` is 42.5 seconds and `102.5` is 1:02.5, so you don't need a colon (`1:02.5` works too).
3. Tap **Add to audio track** to place it at the playhead, or **Save audio file** to share or download it as an .m4a file (or .wav if the device can't make .m4a files).

The clip keeps its own sound, so move the soundbite or mute the clip if you hear both at once.

## Privacy

Projects, clips and media are stored in your browser's storage on this device and are never uploaded. Clearing the site's data or uninstalling the app deletes them, so save finished videos to your camera roll.

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

### Android app

The Android app wraps the same web app with [Capacitor](https://capacitorjs.com). Native networking lets it reach YouTube, which browsers block.

```sh
npm run build:android    # build the web app for the app and copy it into android/
npx cap open android     # open in Android Studio to run it on a phone or emulator
```

`.github/workflows/android.yml` builds `ReelForge.apk` on every push and uploads it as a workflow artifact. On `main` it also replaces the **android-latest** release. To sign with your own key, add the repository secrets `ANDROID_KEYSTORE_BASE64` (a base64 .jks file), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`. Without them, the workflow makes a key once and keeps it in the Actions cache. GitHub drops caches that go unused for 7 days, and a new key means you must uninstall the app (which deletes its clips) before you can install the next build, so add the secrets if you want to keep it long term.

Built with React, TypeScript, Vite, [Mediabunny](https://mediabunny.dev) (WebCodecs), WebGL2 and [Transformers.js](https://huggingface.co/docs/transformers.js) (Whisper).
