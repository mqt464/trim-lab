# Changelog

All notable changes to this project will be documented in this file.

## [0.1.1] - 2025-09-19

- Feature: Spacebar toggles play/pause (ignored while typing in inputs).
- Feature: Live frame preview while dragging Master In/Out handles.
- Performance: Faster open for double‑clicked files — defer heavy tasks,
  lazy‑load ffmpeg/ffprobe, async thumbnails/waveforms, background audio prep.
- Fix: Waveform gain drag regenerates images based on actual gain (no CSS stretch).
- Reverts: Removed earlier experiments around default waveform amplification and lane size.

## [0.1.0] - 2025-01-01

- Initial release.

