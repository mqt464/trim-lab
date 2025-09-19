# TrimLab (MVP)

A blazing-fast trimmer using Electron (Main/Renderer/Preload), ffprobe/ffmpeg for export, and a WebCodecs (Option B) foundation for custom playback.

## Quick start (dev)

- Install deps: `npm i`
- Run the app: `npm run dev`
- Open a file via the Open button, drag & drop, or by launching the app with a `*.mp4` path.

## Key choices

- Playback: Option B foundation (MP4Box + WebCodecs). The demux/decode pipeline is scaffolded; decoding is WIP in this first cut.
- Export: Precise by default. Re-encodes video edges (whole range for MVP) while copying other streams, preserving all tracks via `-map 0`.
- Output: Saves to `Pictures/TrimLab` and reveals the file in Explorer.

## Structure

- `electron/` — Main + Preload (IPC, ffprobe/ffmpeg, OS hooks)
- `renderer/` — UI, timeline, and engine scaffolding (Option B)
- `common/` — IPC channel constants
- `bin/UIReference.html` — Design reference for the UI

## Roadmap progress

- Stage 0–1: App scaffolding, single instance hand-off (argv), open & inspect with ffprobe.
- Stage 2 (Option B): Demux/decoder hooks added; rendering WIP.
- Stage 3: Export (Precise default) implemented; Copy mode when full-range is selected.

## Packaging

- `electron-builder` configured with Windows file associations for `.mp4`, `.mov`, `.m4v`. User still selects defaults in Windows Settings.

## Notes

- FFmpeg binaries are provided by `ffmpeg-static` (GPL). Ensure you review license obligations before shipping.
- MP4 demux library isn’t vendored yet; next step is to bundle a pinned `mp4box.js` build and complete WebCodecs playback.

## FIX

- video playback