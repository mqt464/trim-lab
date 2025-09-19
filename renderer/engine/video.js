export class VideoEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ready = false;
    this.decoder = null;
    this.track = null;
    this.timescale = 1;
    this._gotKey = false;
    this.queue = [];
    this.baseSec = 0;
    this.outSec = Infinity;
    this.playing = false;
    this._cw = 0; this._ch = 0; this._dpr = window.devicePixelRatio || 1;
    this._lastPresented = -Infinity;
    // Disable overlay fallback per request
    this._fallbackVideo = null;
    this._fallbackFile = null;
    this._fallbackTimer = null;
    this._firstAfterResume = false;
    // Demux reference and targeted seeking state
    this.demuxer = null;
    this.isSeeking = false;
    this._seekTargetSec = 0;
    this._seekGen = 0;
    this._seekingGen = 0;
    this._seekCandidate = null;
    this._lastSeekAt = 0;
    this._drawMessage('Drop a file or Open');
  }

  _drawMessage(msg) {
    const ctx = this.ctx;
    const { width, height } = this._ensureSize();
    ctx.fillStyle = 'black';
    ctx.fillRect(0,0,width,height);
    ctx.fillStyle = '#9aa3bd';
    ctx.font = '16px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(msg, width/2, height/2);
  }

  _ensureSize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const wantW = Math.max(2, Math.floor(rect.width * dpr));
    const wantH = Math.max(2, Math.floor(rect.height * dpr));
    if (wantW !== this._cw || wantH !== this._ch || dpr !== this._dpr) {
      this._dpr = dpr;
      this._cw = wantW; this._ch = wantH;
      this.canvas.width = wantW; this.canvas.height = wantH;
    }
    return { width: this._cw, height: this._ch };
  }

  _resizeToContainer() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width  = Math.max(2, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(2, Math.floor(rect.height * dpr));
    return { width: this.canvas.width, height: this.canvas.height };
  }

  _getAvcCRecordFromISO(mp4file, trackId) {
    try {
      const moov = mp4file.moov;
      if (!moov?.traks) return null;
      const trak = moov.traks.find(t => t.tkhd?.track_id === trackId);
      const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
      const avcC = entry?.avcC;
      if (!avcC) return null;
      const spsCount = avcC.SPS?.length || 0;
      const ppsCount = avcC.PPS?.length || 0;
      let size = 7;
      for (let i = 0; i < spsCount; i++) size += 2 + avcC.SPS[i].length;
      size += 1; // pps count
      for (let i = 0; i < ppsCount; i++) size += 2 + avcC.PPS[i].length;
      if (avcC.ext) size += avcC.ext.length;
      const buf = new Uint8Array(size);
      let off = 0;
      const writeU8 = (v)=>{ buf[off++] = v & 0xFF; };
      const writeU16 = (v)=>{ buf[off++] = (v>>>8)&0xFF; buf[off++] = v&0xFF; };
      const writeBytes = (arr)=>{ buf.set(arr, off); off += arr.length; };
      writeU8(avcC.configurationVersion);
      writeU8(avcC.AVCProfileIndication);
      writeU8(avcC.profile_compatibility);
      writeU8(avcC.AVCLevelIndication);
      writeU8((63<<2) + (avcC.lengthSizeMinusOne&3));
      writeU8((7<<5) + (spsCount & 31));
      for (let i=0;i<spsCount;i++){ writeU16(avcC.SPS[i].length); writeBytes(avcC.SPS[i].data); }
      writeU8(ppsCount);
      for (let i=0;i<ppsCount;i++){ writeU16(avcC.PPS[i].length); writeBytes(avcC.PPS[i].data); }
      if (avcC.ext) writeBytes(avcC.ext);
      return buf;
    } catch (e) {
      console.error('Failed to build avcC record', e);
      return null;
    }
  }

  async onDemuxReady(info, demuxer) {
    this.demuxer = demuxer;
    const tracks = (info?.tracks||[]);
    const v = tracks.find(t => t.type === 'video') || tracks.find(t => t.video);
    if (!v) {
      this._drawMessage('No video track');
      return;
    }
    this.track = v;
    this.timescale = v.timescale || 1;
    const codec = v.codec; // e.g. 'avc1.640028' or 'hvc1.1.6.L93.B0'
    if (!('VideoDecoder' in window)) {
      this._drawMessage('WebCodecs not supported');
      return;
    }
    let description = null;
    if (/^avc[13]/i.test(codec)) {
      description = this._getAvcCRecordFromISO(demuxer.mp4box, v.id);
    } else if (/^(hvc1|hev1)/i.test(codec)) {
      description = this._getHvccRecordFromISO(demuxer.mp4box, v.id);
    }
    const config = { codec, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true };
    if (description) config.description = description;
    this.decoder?.close?.();
    this.decoder = new VideoDecoder({
      output: (frame) => {
        const tsSec = typeof frame.timestamp === 'number' ? (frame.timestamp/1e6) : 0;
        // Drop stale seek outputs from previous generations
        if (this.isSeeking && this._seekingGen !== this._seekGen) { try { frame.close(); } catch {}; return; }
        // If we're in a targeted seek, pick best <= target and stop extraction quickly
        if (this.isSeeking && this._seekingGen === this._seekGen) {
          const eps = 1/120; // ~8ms
          try {
            if (tsSec <= this._seekTargetSec + eps) {
              try { this._seekCandidate?.close?.(); } catch {}
              this._seekCandidate = frame.clone();
            }
            if (tsSec + eps >= this._seekTargetSec) {
              const chosen = this._seekCandidate || frame;
              const { width, height } = this._ensureSize();
              try { this._lastFrame?.close?.(); } catch {}
              this._lastFrame = chosen.clone();
              this._blitFrame(chosen, width, height);
              this._lastPresented = this._seekTargetSec;
              try { this.demuxer?.stopExtract?.(); } catch {}
              this.isSeeking = false;
              this._seekingGen = 0;
              try { this._seekCandidate?.close?.(); } catch {}
              this._seekCandidate = null;
              // Hide overlay preview if shown
              try { this._hideOverlay(); } catch {}
              while (this.queue.length) { const f = this.queue.shift(); try { f.frame.close(); } catch {} }
              if (chosen !== frame) { try { frame.close(); } catch {} }
              return;
            }
          } catch {}
          try { frame.close(); } catch {}
          return;
        }
        // Normal streaming: buffer frames for presentAt
        this.queue.push({ ts: tsSec, frame });
        if (this.queue.length > 240) {
          const old = this.queue.shift();
          try { old.frame.close(); } catch {}
        }
        if (this._firstAfterResume) {
          try {
            const { width, height } = this._ensureSize();
            try { this._lastFrame?.close?.(); } catch {}
            this._lastFrame = frame.clone();
            this._blitFrame(frame, width, height);
          } catch {}
          this._firstAfterResume = false;
        }
      },
      error: (e) => console.error('Decoder error', e)
    });
    try {
      this.decoder.configure(config);
    } catch (e) {
      console.error('Decoder configure failed', e);
      this._drawMessage('Decoder configure failed');
      return;
    }

    this._gotKey = false;
    this.ready = true;

    // Expose aspect ratio to CSS so canvas can size with contain behavior
    try {
      const w = v.track_width || v.video?.width || 16;
      const h = v.track_height || v.video?.height || 9;
      if (w > 0 && h > 0) {
        const ar = w / h;
        this.canvas.style.setProperty('--video-ar', ar.toString());
      }
    } catch {}
  }

  onSamples(id, samples) {
    if (!this.decoder || this.decoder.state === 'closed' || !this.track || id !== this.track.id) return;
    for (const s of samples) {
      const ts_units0 = (s.cts !== undefined ? s.cts : s.dts);
      const tsSec0 = ts_units0 / this.timescale;
      // Require the first keyframe to begin decoding, regardless of time
      if (!this._gotKey) {
        if (!s.is_sync) continue; // wait for a keyframe
        this._gotKey = true;
      }
      // During normal playback we let demux determine the window; do not skip pre-target frames here
      if (tsSec0 > (this.outSec + 0.1)) continue;
      const ts_units = ts_units0;
      const ts_us = Math.round((ts_units / this.timescale) * 1e6);
      const dur_us = s.duration ? Math.round((s.duration / this.timescale) * 1e6) : undefined;
      const chunk = new EncodedVideoChunk({ type: s.is_sync ? 'key' : 'delta', timestamp: ts_us, duration: dur_us, data: s.data });
      try { this.decoder.decode(chunk); } catch (e) { /* ignore if decoder not ready */ }
    }
  }

  start(baseSec, outSec, opts) {
    this.baseSec = baseSec || 0;
    this.outSec = (outSec ?? Infinity);
    this.playing = true;
    this._gotKey = false;
    // Do not reset decoder on resume to avoid visual gaps
    try { /* keep decoder configured */ } catch {}
    // Clear any queued frames
    while (this.queue.length) {
      const f = this.queue.shift();
      try { f.frame.close(); } catch {}
    }
    // Optionally re-blit the last paused frame (skip during live seek to avoid flashing old frame)
    if (!opts || opts.reblit !== false) {
      try {
        const sized = this._ensureSize();
        if (this._lastFrame) {
          this._blitFrame(this._lastFrame, sized.width, sized.height);
        }
      } catch {}
    }
    this._lastPresented = -Infinity;
    this._firstAfterResume = true;
  }

  stop() {
    this.playing = false;
    // Do not close decoder here; keep it configured for resume
    if (this._fallbackTimer) { clearTimeout(this._fallbackTimer); this._fallbackTimer = null; }
    if (this._fallbackVideo) {
      try { this._fallbackVideo.pause(); } catch {}
      // Keep visible so paused frame shows if fallback is active
      // this._fallbackVideo.style.display = 'none';
    }
  }

  presentAt(timeSec) {
    if (!this.decoder) return;
    const { width, height } = this._ensureSize();
    const epsilon = 1/60; // ~16.6ms
    // Find the newest frame <= target time; if none, hold last frame (do not jump ahead)
    let idx = -1;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].ts <= timeSec + epsilon) { idx = i; break; }
    }
    if (idx < 0) return; // nothing ready yet at or before this time
    if (idx >= 0 && idx < this.queue.length) {
      // Drop frames before idx
      for (let i = 0; i < idx; i++) { try { this.queue[i].frame.close(); } catch {} }
      const picked = this.queue[idx];
      // Remove up to idx
      this.queue.splice(0, idx + 1);
      const frame = picked.frame;
      try {
        try { this._lastFrame?.close?.(); } catch {}
        this._lastFrame = frame.clone();
        this._blitFrame(frame, width, height);
        this._lastPresented = timeSec;
      } finally { frame.close(); }
    }
  }

  _blitFrame(frame, cw, ch) {
    // Preserve aspect ratio with letterboxing (no stretch)
    const vw = (typeof frame.displayWidth === 'number' ? frame.displayWidth : (frame.codedWidth || frame.width || cw));
    const vh = (typeof frame.displayHeight === 'number' ? frame.displayHeight : (frame.codedHeight || frame.height || ch));
    const scale = Math.min(cw / vw, ch / vh);
    const dw = Math.max(1, Math.floor(vw * scale));
    const dh = Math.max(1, Math.floor(vh * scale));
    const dx = Math.floor((cw - dw) / 2);
    const dy = Math.floor((ch - dh) / 2);
    // Draw centered without clearing to avoid flashes
    this.ctx.drawImage(frame, dx, dy, dw, dh);
  }

  _getHvccRecordFromISO(mp4file, trackId) {
    try {
      const moov = mp4file?.moov; if (!moov?.traks) return null;
      const trak = moov.traks.find(t => t.tkhd?.track_id === trackId);
      const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
      const hvcC = entry?.hvcC;
      if (!hvcC) return null;
      // Build HEVCDecoderConfigurationRecord (no box header)
      // Compute total length
      let size = 23 + 1; // up to numOfArrays + numOfArrays byte
      for (const arr of hvcC.nalu_arrays) {
        size += 1 + 2; // array header + numNalus
        for (const n of arr) size += 2 + (n.data?.length || 0);
      }
      const buf = new Uint8Array(size);
      let o = 0;
      const w8 = v => buf[o++] = v & 0xFF;
      const w16 = v => { buf[o++] = (v>>>8)&0xFF; buf[o++] = v&0xFF; };
      const w32 = v => { buf[o++] = (v>>>24)&0xFF; buf[o++] = (v>>>16)&0xFF; buf[o++] = (v>>>8)&0xFF; buf[o++] = v&0xFF; };
      const wba = a => { buf.set(a, o); o += a.length; };

      w8(hvcC.configurationVersion);
      w8(((hvcC.general_profile_space & 3) << 6) | ((hvcC.general_tier_flag & 1) << 5) | (hvcC.general_profile_idc & 31));
      w32(hvcC.general_profile_compatibility >>> 0);
      wba(hvcC.general_constraint_indicator);
      w8(hvcC.general_level_idc);
      const mssi = ((0xF << 12) | (hvcC.min_spatial_segmentation_idc & 0x0FFF)) & 0xFFFF; w16(mssi);
      w8(((0x3F << 2) | (hvcC.parallelismType & 3)) & 0xFF);
      w8(((0x3F << 2) | (hvcC.chroma_format_idc & 3)) & 0xFF);
      w8(((31 << 3) | (hvcC.bit_depth_luma_minus8 & 7)) & 0xFF);
      w8(((31 << 3) | (hvcC.bit_depth_chroma_minus8 & 7)) & 0xFF);
      w16(hvcC.avgFrameRate & 0xFFFF);
      w8(((hvcC.constantFrameRate & 3) << 6) | ((hvcC.numTemporalLayers & 7) << 3) | ((hvcC.temporalIdNested & 1) << 2) | (hvcC.lengthSizeMinusOne & 3));
      w8(hvcC.nalu_arrays.length & 0xFF);
      for (const arr of hvcC.nalu_arrays) {
        const header = ((arr.completeness & 1) << 7) | (arr.nalu_type & 63);
        w8(header);
        w16(arr.length & 0xFFFF);
        for (const n of arr) { const data = n.data || new Uint8Array(0); w16(data.length & 0xFFFF); wba(data); }
      }
      return buf;
    } catch (e) {
      console.warn('Failed to build hvcc record', e);
      return null;
    }
  }

  _ensureFallbackVideo() {
    try {
      if (!this.canvas || !this.canvas.parentElement) return;
      if (!this._fallbackVideo) {
        const v = document.createElement('video');
        v.style.position = 'absolute';
        v.style.inset = '0';
        v.style.width = '100%';
        v.style.height = '100%';
        v.style.objectFit = 'contain';
        v.style.zIndex = '2';
        v.style.display = 'none';
        v.muted = true; v.playsInline = true; v.controls = false; v.preload = 'auto'; v.disablePictureInPicture = true;
        this.canvas.parentElement.appendChild(v);
        this._fallbackVideo = v;
      }
      // Set src if changed
      if (this._fallbackFile && this._fallbackVideo.src !== this._fallbackFile) {
        this._fallbackVideo.src = this._fallbackFile;
      }
      this._fallbackVideo.muted = true;
    } catch {}
  }

  _showOverlayAt(sec) {
    try {
      this._ensureFallbackVideo();
      if (!this._fallbackVideo || !this._fallbackFile) return;
      if (this._fallbackVideo.src !== this._fallbackFile) this._fallbackVideo.src = this._fallbackFile;
      this._fallbackVideo.style.display = 'block';
      this._fallbackVideo.pause();
      this._fallbackVideo.currentTime = Math.max(0, Number(sec)||0);
    } catch {}
  }

  _hideOverlay() {
    try { if (this._fallbackVideo) this._fallbackVideo.style.display = 'none'; } catch {}
  }

  dispose() {
    try { this.decoder?.close?.(); } catch {}
    this.decoder = null;
    try { this._lastFrame?.close?.(); } catch {}
    this._lastFrame = null;
  }

  resizeRedraw() {
    // Redraw the last frame to new canvas size to avoid stale scaling when paused
    if (!this._lastFrame) return;
    const { width, height } = this._ensureSize();
    this._blitFrame(this._lastFrame, width, height);
  }

  // Targeted seek: decode from nearest RAP and show exact frame at 'sec'
  seekTo(sec) {
    if (!this.ready || !this.track || !this.demuxer || !this.decoder) return;
    const t = Math.max(0, Number(sec) || 0);
    // No throttling — prefer responsiveness; generations cancel stale seeks
    this._seekTargetSec = t;
    this.baseSec = t;
    this.isSeeking = true;
    this._seekingGen = ++this._seekGen;
    this._gotKey = false;
    // Clear queued frames
    while (this.queue.length) { const f = this.queue.shift(); try { f.frame.close(); } catch {} }
    try { this._seekCandidate?.close?.(); } catch {}
    this._seekCandidate = null;
    // Reset decoder for fast turnaround
    try { this.decoder.reset(); } catch {}
    // Start demux extraction from target time (rapAlignment handled inside demuxer)
    try { this.demuxer.stopExtract(); } catch {}
    try {
      this.demuxer.extractTrack(this.track.id, { nbSamples: 180, rapAlignment: true, startTimeSec: t });
    } catch (e) { /* ignore */ }
    // Show overlay immediately to avoid perceived freeze while we decode the GOP
    this._showOverlayAt(t);
  }
}

