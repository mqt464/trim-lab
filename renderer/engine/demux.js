// Legacy WebCodecs pipeline: MP4Demuxer streams file chunks into MP4Box to expose tracks and samples.

export class MP4Demuxer {
  constructor(filePath, mp4boxLib) {
    this.filePath = filePath;
    this.mp4box = null;
    this._mp4boxLib = mp4boxLib || (typeof window !== 'undefined' ? window.MP4Box : undefined);
    this.onReady = null;
    this.onSamples = null;
    this.onError = null;
    this._started = false;
    this._size = 0;
    this._extracted = new Set();
    this._continuous = new Set();
    this._unsubFileChunk = null;
    this._unsubFileChunkEnd = null;
  }

  start() {
    if (this._started) return;
    this._started = true;
    const lib = this._mp4boxLib;
    if (!lib || typeof lib.createFile !== 'function') {
      this._emitError(new Error('MP4Box not loaded'));
      return;
    }
    if (!window.trimlab) {
      this._emitError(new Error('Preload bridge not available'));
      return;
    }
    // Keep mdat data so we can extract actual samples for decode
    const mp4box = lib.createFile(true);
    this.mp4box = mp4box;

    mp4box.onError = (e) => this._emitError(e);
    mp4box.onReady = (info) => {
      this.info = info;
      this.onReady && this.onReady(info);
    };

    mp4box.onSamples = (id, user, samples) => {
      try { this.onSamples && this.onSamples(id, samples); } finally {
        // If this track is flagged as continuous, release used samples
        // and immediately request more to keep decoding.
        if (this._continuous.has(id)) {
          try {
            const last = samples && samples.length ? samples[samples.length - 1] : null;
            if (last && typeof last.number === 'number') {
              mp4box.releaseUsedSamples(id, last.number);
            }
          } catch {}
          try { mp4box.start(); } catch {}
        }
      }
    };

    // Start chunked reads from main
    // Default 1MB chunks for now
    this._unsubFileChunk = window.trimlab.onFileChunk((msg) => {
      if (msg.filePath !== this.filePath) return;
      try {
        const MP4BoxBuffer = this._mp4boxLib?.MP4BoxBuffer;
        let ab = msg.buffer; // ArrayBuffer
        if (MP4BoxBuffer && typeof MP4BoxBuffer.fromArrayBuffer === 'function') {
          ab = MP4BoxBuffer.fromArrayBuffer(ab, msg.offset);
        } else {
          try { ab.fileStart = msg.offset; } catch {}
        }
        this._size = Math.max(this._size, msg.offset + (msg.length||0));
        mp4box.appendBuffer(ab);
      } catch (e) {
        this._emitError(e);
      }
    });
    this._unsubFileChunkEnd = window.trimlab.onFileChunkEnd((msg) => {
      if (msg.filePath !== this.filePath) return;
      if (msg.error) this._emitError(new Error(msg.error));
      else mp4box.flush();
    });
    window.trimlab.readFileChunks(this.filePath, 1024*1024);
  }

  extractTrack(trackId, opts={}) {
    if (!this.mp4box) throw new Error('Demuxer not started');
    try {
      if (this._extracted.has(trackId)) {
        this.mp4box.unsetExtractionOptions(trackId);
        this._extracted.delete(trackId);
      }
    } catch {}
    const startTimeSec = opts.startTimeSec;
    const { nbSamples, rapAlignment = false, continuous = false } = opts;
    // For continuous decode, use a modest batch size and loop via onSamples
    const batch = typeof nbSamples === 'number' && nbSamples > 0 ? nbSamples : (continuous ? 120 : 120);
    this.mp4box.setExtractionOptions(trackId, null, { nbSamples: batch, rapAlignment });
    if (continuous) this._continuous.add(trackId); else this._continuous.delete(trackId);
    // Seek by setting nextSample to the first sample at or after startTimeSec
    if (typeof startTimeSec === 'number' && startTimeSec >= 0) {
      try {
        const trak = this.mp4box.getTrackById(trackId);
        const timescale = trak?.mdia?.mdhd?.timescale || trak?.timescale || 1;
        const target = Math.floor(startTimeSec * timescale);
        const samples = trak?.samples || [];
        if (samples.length > 0) {
          // Binary search for first sample with cts/dts >= target
          let lo = 0, hi = samples.length - 1, ans = samples.length - 1;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const s = samples[mid];
            const ts = (typeof s.cts === 'number') ? s.cts : s.dts;
            if (ts >= target) { ans = mid; hi = mid - 1; } else { lo = mid + 1; }
          }
          // For video tracks, back up to previous RAP (keyframe) to guarantee decodability
          let idx = Math.max(0, Math.min(ans, samples.length - 1));
          while (idx > 0 && samples[idx] && samples[idx].is_sync === false) idx--;
          trak.nextSample = idx;
        }
      } catch (e) {
        // Fallback: let it start from 0 if we can't set
      }
    }
    this.mp4box.start();
    this._extracted.add(trackId);
  }

  stopExtract() {
    try { this.mp4box?.stop(); } catch {}
  }

  resume() {
    try { this.mp4box?.start(); } catch {}
  }

  dispose() {
    window.trimlab.cancelReadFile(this.filePath);
    try { if (this._unsubFileChunk) this._unsubFileChunk(); } catch {}
    try { if (this._unsubFileChunkEnd) this._unsubFileChunkEnd(); } catch {}
    this._unsubFileChunk = null;
    this._unsubFileChunkEnd = null;
    try { this.mp4box?.flush(); } catch {}
    this.mp4box = null;
  }

  _emitError(err) {
    try { console.error('Demux error:', err); } catch {}
    try { this.onError && this.onError(err); } catch {}
  }
}
