# TODO

- [x] File lifecycle: add unload/cleanup before each load; cancel file reads; clear timers; gate async work with load tokens; reset UI/state for single-file workflow.
- [x] Spawn error handling: handle ffmpeg/ffprobe spawn errors and surface failures to the renderer.
- [x] Playback pipeline: default to native <video>; only start demuxer/WebCodecs path when enabled.
- [x] Audio pipeline: make split <audio> elements the single playback path; remove unused AudioEngine hooks.
- [x] Avoid duplicate probes: reuse analyze metadata for prepareAudioTracks/export.
- [x] Cache + hygiene: prune userData cache/atracks; remove control characters in HTML.
- [x] IPC constants: reduce duplication between preload, renderer, and `common/ipc.js`.
- [x] Legacy engines: mark WebCodecs audio/video/demux as unused in the current pipeline.
- [x] Manual smoke test: open/scrub/export (Copy + Precise) with multi-audio inputs.
