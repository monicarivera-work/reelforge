# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A content creator who edits their own videos on their phone (iPhone and Android), often one-handed and on the go. They shoot, cut, caption, score and publish without a computer. Their current editor is InShot, so its mental model (preview on top, a centered playhead over a scrolling clip timeline, a horizontal strip of tools that changes when a clip is selected, settings in bottom panels, Save in the top-right corner) is the baseline expectation.

## Product Purpose

ReelForge is a complete video editor for creators that installs from the browser onto the home screen. It covers the full job: import clips, photos and audio; trim, split, reorder and speed-ramp; layer text, stickers, overlays and picture-in-picture; add music, voiceover and sound effects; generate word-timed captions automatically; apply transitions, filters, color adjustment, crop, masks and green screen; then export an MP4 ready for TikTok, Reels, Shorts or YouTube. Success means a creator can finish and post a video without reaching for another app.

## Positioning

Everything happens on the phone: editing, speech-to-text captions and encoding all run on-device. No account, no uploads, no watermark, no subscription. Media never leaves the device.

## Operating Context

- Portrait phone, thumbs, short sessions in between other things; projects are reopened many times.
- Vertical 9:16 is the main output; 16:9 and 1:1 are also supported.
- Finished videos go out through the phone's share sheet or are saved to the device.
- Installed via Add to Home Screen (iOS Safari) or Install app (Android Chrome); works offline after the first visit. Captions download a speech model once (about 65 MB) on first use.

## Capabilities and Constraints

- Built as a PWA (React, WebCodecs via Mediabunny, WebGL2 compositing), hosted on GitHub Pages at `/reelforge/`.
- Projects and media are stored in the browser's IndexedDB on the device; clearing site data deletes them.
- iOS Safari limits: no background export, memory ceilings on long or 4K exports, and some codecs depend on OS version.
- Terminology follows creator editors: clip, split, trim, speed, volume, canvas, overlay, captions, transitions, keyframes, export.

## Brand Commitments

- Name: ReelForge (confirmed).
- Free, private, no watermark.
- Visual direction (user choice): the category standard, played straight. A dark InShot/CapCut-style mobile editor with one bright pink accent, held to the craft level of InShot and CapCut. Do not swap it for a novel visual world without asking.

## Evidence on Hand

No testimonials, user counts, benchmarks or press exist. Do not fabricate any.

## Product Principles

1. The video is the hero: chrome stays out of the preview and never hides the frame being edited.
2. Every edit is one thumb away and always undoable; nothing is destructive.
3. Familiar before novel: match InShot-style gestures and placement unless a change is clearly better.
4. Honest about the device: show progress, size estimates and limits plainly instead of failing silently.
5. Private by construction: no feature may require uploading the creator's media.

## Accessibility & Inclusion

- Touch targets of at least 44 px; controls reachable in the bottom half of the screen.
- Respect reduced-motion settings and keep text legible in bright outdoor light.
