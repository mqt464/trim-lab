# TrimLab

TrimLab is a lightweight desktop trimmer built with Electron. Open a clip, set
in and out on the timeline, and export a trimmed file with either fast stream
copy or precise re-encode.

## Features

- Single-clip workflow optimized for fast open, trim, export.
- Timeline ruler with in and out handles plus playhead scrubbing.
- Per-track audio lanes with waveforms and gain control.
- Drag and drop support alongside an Open button.
- Export modes: Copy (stream copy) and Precise (re-encode).
- Cross-platform builds via electron-builder.

## Supported formats

- MP4 (.mp4)
- QuickTime (.mov)
- M4V (.m4v)

## Requirements

- Node.js 20+ and npm
- Windows, macOS, or Linux

## Changelog

All notable changes:

### [0.1.2] - 2025-12-23

- UX: refined dark UI, timeline ruler, and export bar styling.
- Workflow: single-file load/unload cleanup; cancelable reads; safer async gating.
- Playback: native video element default with gated WebCodecs path.
- Audio: split-track playback via audio elements; prep reuse from analyze metadata.
- Reliability: shared IPC constants and improved ffmpeg/ffprobe error handling.

### [0.1.1] - 2025-09-19

- Feature: Spacebar toggles play/pause (ignored while typing in inputs).
- Feature: Live frame preview while dragging Master In/Out handles.
- Performance: Faster open for double-clicked files - defer heavy tasks,
  lazy-load ffmpeg/ffprobe, async thumbnails/waveforms, background audio prep.
- Fix: Waveform gain drag regenerates images based on actual gain (no CSS stretch).
- Reverts: Removed earlier experiments around default waveform amplification and lane size.

### [0.1.0] - 2025-01-01

- Initial release.
