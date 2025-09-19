export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.decoder = null;
    this.track = null;
    this.timescale = 1;
    this.codec = '';
    this.channels = 2;
    this.sampleRate = 48000;
    this.playing = false;
    this._startCtxTime = 0;
    this._baseSec = 0;
    this._scheduledCtxTime = 0;
    this._outSec = Infinity;
    this._sources = [];
    this._dest = null;
    this._gain = null;
    this._fallbackEl = null;
    this._fallbackActive = false;
    this.monitorViaElement = false; // prefer WebAudio for per-stream control
  }

  onDemuxReady(info, demuxer, trackId) {
    let atrack = null;
    try {
      const tracks = (info?.tracks||[]);
      if (trackId != null) {
        atrack = tracks.find(t => t.type === 'audio' && t.id === trackId) || tracks.find(t => t.audio && t.id === trackId);
      }
      if (!atrack) atrack = tracks.find(t => t.type === 'audio');
    } catch {}
    if (!atrack) return;
    this.track = atrack;
    this.timescale = atrack.timescale || 1;
    this.codec = atrack.codec || 'mp4a.40.2';
    this.channels = atrack.audio?.channel_count || 2;
    this.sampleRate = atrack.audio?.sample_rate || 48000;
    this._mp4file = demuxer?.mp4box;
  }

  ensureContext() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: this.sampleRate }); }
      catch { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); }
    }
    if (!this._dest) {
      this._dest = this.ctx.createGain();
      this._gain = this.ctx.createGain();
      this._gain.gain.value = 1;
      this._dest.connect(this._gain);
      this._gain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  async configureDecoder() {
    if (!('AudioDecoder' in window)) throw new Error('WebCodecs AudioDecoder not supported');
    if (this.decoder) { try { this.decoder.close(); } catch {} this.decoder = null; }
    const output = (audioData) => {
      if (!this.playing) { try { audioData.close(); } catch {}; return; }
      try {
        const frames = audioData.numberOfFrames;
        const rate = audioData.sampleRate;
        const ch = audioData.numberOfChannels;
        const ctx = this.ensureContext();
        const buf = ctx.createBuffer(ch, frames, rate);
        for (let i=0;i<ch;i++) {
          const plane = new Float32Array(frames);
          audioData.copyTo(plane, { planeIndex: i });
          buf.getChannelData(i).set(plane);
        }
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this._dest);
        src.onended = () => {
          const idx = this._sources.indexOf(src);
          if (idx !== -1) this._sources.splice(idx, 1);
          try { src.disconnect(); } catch {}
        };
        const now = this.ctx.currentTime;
        if (this._scheduledCtxTime < now) this._scheduledCtxTime = now;
        const chunkSec = frames / rate;
        // Stop scheduling past outSec
        const expectedEnd = this._baseSec + (this._scheduledCtxTime - this._startCtxTime) + chunkSec;
        if (expectedEnd > this._outSec) {
          const remaining = Math.max(0, this._outSec - (this._baseSec + (this._scheduledCtxTime - this._startCtxTime)));
          if (remaining <= 0.002) { try { src.disconnect(); } catch {}; this.playing = false; this.onEnded?.(); return; }
          // Play partial then signal end (do not close decoder here)
          src.start(this._scheduledCtxTime);
          src.stop(this._scheduledCtxTime + remaining);
          this._scheduledCtxTime += remaining;
          this.playing = false;
          this.onEnded?.();
          return;
        }
        src.start(this._scheduledCtxTime);
        this._scheduledCtxTime += chunkSec;
        this._sources.push(src);
      } finally {
        audioData.close();
      }
    };
    const error = (e) => console.error('AudioDecoder error', e);
    this.decoder = new AudioDecoder({ output, error });
    const config = { codec: this.codec, numberOfChannels: this.channels, sampleRate: this.sampleRate };
    const asc = this._getAudioSpecificConfig(this._mp4file, this.track?.id);
    if (asc) config.description = asc;
    try { this.decoder.configure(config); }
    catch (e) { console.error('AudioDecoder.configure failed', e); throw e; }
  }

  _getAudioSpecificConfig(mp4file, trackId) {
    try {
      if (!mp4file?.moov?.traks) return null;
      const trak = mp4file.moov.traks.find(t => t.tkhd?.track_id === trackId);
      const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
      const esds = entry?.esds?.esd;
      if (!esds || typeof esds.findDescriptor !== 'function') return null;
      // 5 = DecoderSpecificInfo
      const dsi = esds.findDescriptor ? esds.findDescriptor(5) : null;
      const data = dsi?.data;
      if (!data || !(data instanceof Uint8Array)) return null;
      return new Uint8Array(data); // copy
    } catch (e) {
      console.warn('ASC extraction failed', e);
      return null;
    }
  }

  async start(inSec, outSec, filePath) {
    if (!this.track) return;
    this._fallbackActive = false;
    if (!this.monitorViaElement) {
      try {
        await this.ensureContext().resume();
        await this.configureDecoder();
        try { this.decoder.reset(); } catch {}
        // Stop any existing sources
        this._sources.forEach(s => { try { s.stop(0); } catch {}; try { s.disconnect(); } catch {}; });
        this._sources = [];
      } catch (e) {
        this.monitorViaElement = true;
      }
    }
    if (this.monitorViaElement) {
      this._setupFallback(filePath);
      this._fallbackActive = true;
    }
    this.playing = true;
    this._baseSec = inSec || 0;
    this._outSec = (outSec ?? Infinity);
    if (!this._fallbackActive) {
      this._startCtxTime = this.ctx.currentTime;
      this._scheduledCtxTime = this._startCtxTime;
    } else {
      if (this._fallbackEl) {
        this._fallbackEl.playbackRate = 1;
        this._fallbackEl.currentTime = this._baseSec;
        try { await this._fallbackEl.play(); } catch {}
      }
    }
  }

  stop() {
    this.playing = false;
    // Stop all scheduled sources immediately
    this._sources.forEach(s => { try { s.stop(0); } catch {}; try { s.disconnect(); } catch {}; });
    this._sources = [];
    try { this.decoder?.reset?.(); } catch {}
    try { this.ctx?.suspend?.(); } catch {}
    if (this._fallbackEl) {
      try { this._fallbackEl.pause(); } catch {}
    }
  }

  onSamples(trackId, samples) {
    if (this._fallbackActive) return; // monitoring via <audio>
    if (!this.playing || !this.decoder || this.decoder.state === 'closed' || !this.track || trackId !== this.track.id) return;
    const toUs = (val) => Math.round((val / this.timescale) * 1e6);
    for (const s of samples) {
      const tsUnits = (s.cts !== undefined ? s.cts : s.dts);
      const tsSec = tsUnits / this.timescale;
      if (tsSec < (this._baseSec - 0.02)) continue;
      if (tsSec > (this._outSec + 0.1)) continue;
      const timestamp = toUs(tsUnits);
      const duration = s.duration ? toUs(s.duration) : undefined;
      const chunk = new EncodedAudioChunk({ type: 'key', timestamp, duration, data: s.data });
      try { this.decoder.decode(chunk); } catch (e) { /* ignore post-close decode */ }
    }
  }

  getCurrentTimeSec() {
    if (this._fallbackActive && this._fallbackEl) {
      const t = this._fallbackEl.currentTime || this._baseSec;
      return Math.min(t, this._outSec);
    }
    if (!this.playing || !this.ctx) return this._baseSec;
    const t = this._baseSec + (this.ctx.currentTime - this._startCtxTime);
    return Math.min(t, this._outSec);
  }

  setGainLinear(value) {
    try {
      const v = Math.max(0, Number(value) || 0);
      this.ensureContext();
      if (this._gain) this._gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
      if (this._fallbackActive && this._fallbackEl) {
        try { this._fallbackEl.volume = Math.max(0, Math.min(1, v)); } catch {}
      }
    } catch {}
  }

  /**
   * Seek playback to an absolute timeline time in seconds while playing.
   * Works for both WebAudio and <audio> fallback monitoring paths.
   */
  seek(timeSec) {
    const target = Math.max(0, Math.min(timeSec || 0, this._outSec));
    // Always update base for consistency
    this._baseSec = target;
    if (this._fallbackActive && this._fallbackEl) {
      try { this._fallbackEl.currentTime = target; } catch {}
      return;
    }
    if (!this.ctx) return;
    // Stop any scheduled sources and reset scheduling clock
    this._sources.forEach(s => { try { s.stop(0); } catch {}; try { s.disconnect(); } catch {}; });
    this._sources = [];
    try { this.decoder?.reset?.(); } catch {}
    // Keep playing state; reset timing origin so getCurrentTimeSec tracks from target
    this._startCtxTime = this.ctx.currentTime;
    this._scheduledCtxTime = this._startCtxTime;
  }

  _setupFallback(filePath) {
    if (!filePath) return;
    if (!this._fallbackEl) {
      const a = document.createElement('audio');
      a.style.display = 'none';
      a.preload = 'auto';
      a.controls = false;
      document.body.appendChild(a);
      this._fallbackEl = a;
    }
    const url = 'file:///' + filePath.replace(/\\/g, '/');
    if (this._fallbackEl.src !== url) this._fallbackEl.src = url;
    this._fallbackEl.volume = 1;
    this._fallbackEl.muted = false;
    this._fallbackEl.playbackRate = 1;
    // Keep playback rate sane even if the platform tries to adjust it
    const enforceRate = () => { try { if (this._fallbackEl.playbackRate !== 1) this._fallbackEl.playbackRate = 1; } catch {} };
    this._fallbackEl.removeEventListener('ratechange', this._onRate);
    this._onRate = enforceRate;
    this._fallbackEl.addEventListener('ratechange', enforceRate);
    this._fallbackEl.removeEventListener('playing', this._onPlaying);
    this._onPlaying = enforceRate;
    this._fallbackEl.addEventListener('playing', enforceRate);
    const checkStop = () => {
      const t = this._fallbackEl.currentTime || 0;
      if (t >= this._outSec - 0.01) {
        try { this._fallbackEl.pause(); } catch {}
        this.playing = false;
        this.onEnded?.();
      }
    };
    this._fallbackEl.removeEventListener('timeupdate', this._onFallbackTimeupdate);
    this._onFallbackTimeupdate = checkStop;
    this._fallbackEl.addEventListener('timeupdate', checkStop);
  }
}
