export class VideoEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.videoEl = null;
    this.srcUrl = '';
    this.inSec = 0;
    this.outSec = Infinity;
    this.ready = false;
    this.onEnded = null;
    // Trick-play state for smooth scrubbing
    this._tpActive = false;
    this._tpHz = 18;
    this._tpTargetSec = null;
    this._tpTimer = 0;
    this._tpWasPlaying = false;
    this._tpWasMuted = false;
    this._tpLastPulse = 0;
    this._ensureVideo();
    this._drawMessage('Drop a file or Open');
  }

  _drawMessage(msg) {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(2, Math.floor(rect.width * dpr));
    const h = Math.max(2, Math.floor(rect.height * dpr));
    this.canvas.width = w; this.canvas.height = h;
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#9aa3bd';
    ctx.font = '16px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(msg, w/2, h/2);
  }

  _ensureVideo() {
    try {
      if (!this.canvas || !this.canvas.parentElement) return;
      if (!this.videoEl) {
        const v = document.createElement('video');
        v.style.position = 'absolute';
        v.style.inset = '0';
        v.style.width = '100%';
        v.style.height = '100%';
        v.style.objectFit = 'contain';
        v.style.zIndex = '2';
        v.style.display = 'block';
        v.style.pointerEvents = 'none';
        v.preload = 'auto';
        v.playsInline = true;
        v.setAttribute('playsinline', '');
        v.setAttribute('webkit-playsinline', '');
        v.controls = false;
        v.controlsList = 'nodownload noplaybackrate noremoteplayback nofullscreen';
        v.setAttribute('controlslist', 'nodownload noplaybackrate noremoteplayback nofullscreen');
        v.disablePictureInPicture = true;
        v.disableRemotePlayback = true;
        v.setAttribute('disablepictureinpicture', '');
        v.setAttribute('disableremoteplayback', '');
        v.style.backgroundColor = 'black';
        // Do not force mute; keep audible fallback via native element if WebAudio engines are not active
        v.muted = false;
        this.canvas.parentElement.appendChild(v);
        this.videoEl = v;
        // Capture last rendered frame while playing so we can hold it on resume
        this._onVFC = (now, meta) => { try { this._blitHoldFromVideo(); } catch {} finally { try { this._rvfcId = this.videoEl.requestVideoFrameCallback(this._onVFC); } catch {} } };
        this._startCaptureLastFrame = () => {
          try {
            if ('requestVideoFrameCallback' in this.videoEl) {
              if (!this._rvfcId) this._rvfcId = this.videoEl.requestVideoFrameCallback(this._onVFC);
            } else {
              // Fallback: copy on timeupdate
              if (!this._tuHandler) {
                this._tuHandler = () => { try { this._blitHoldFromVideo(); } catch {} };
                this.videoEl.addEventListener('timeupdate', this._tuHandler);
              }
            }
          } catch {}
        };
        this._stopCaptureLastFrame = () => {
          try { if (this._rvfcId) { this.videoEl.cancelVideoFrameCallback(this._rvfcId); this._rvfcId = 0; } } catch {}
          try { if (this._tuHandler) { this.videoEl.removeEventListener('timeupdate', this._tuHandler); this._tuHandler = null; } } catch {}
        };
        const onTime = () => {
          if (isFinite(this.outSec) && this.videoEl.currentTime >= (this.outSec - 0.01)) {
            try { this.videoEl.pause(); } catch {}
            this.onEnded?.();
          }
        };
        v.addEventListener('timeupdate', onTime);
        v.addEventListener('ended', () => this.onEnded?.());
        v.addEventListener('playing', () => this._startCaptureLastFrame());
        v.addEventListener('pause', () => this._stopCaptureLastFrame());
        v.addEventListener('suspend', () => this._stopCaptureLastFrame());
        v.addEventListener('loadedmetadata', () => {
          try {
            const ar = (this.videoEl.videoWidth || 16) / (this.videoEl.videoHeight || 9);
            this.canvas.style.setProperty('--video-ar', String(ar));
          } catch {}
        });
      }
      if (this.srcUrl && this.videoEl.src !== this.srcUrl) this.videoEl.src = this.srcUrl;
    } catch {}
  }

  _ensureHoldCanvas() {
    try {
      if (!this.canvas || !this.canvas.parentElement) return null;
      if (!this._holdCanvas) {
        const c = document.createElement('canvas');
        c.style.position = 'absolute';
        c.style.inset = '0';
        c.style.width = '100%';
        c.style.height = '100%';
        c.style.objectFit = 'contain';
        c.style.zIndex = '4';
        c.style.pointerEvents = 'none';
        c.style.display = 'none';
        this.canvas.parentElement.appendChild(c);
        this._holdCanvas = c;
        // Initialize size once; update on resize events only
        const sizeToContainer = () => {
          try {
            const rect = this.canvas.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            const w = Math.max(2, Math.floor(rect.width * dpr));
            const h = Math.max(2, Math.floor(rect.height * dpr));
            if (this._holdCanvas.width !== w || this._holdCanvas.height !== h) {
              this._holdCanvas.width = w; this._holdCanvas.height = h;
              // Reblit last frame if available
              try { this._blitHoldFromVideo(); } catch {}
            }
          } catch {}
        };
        this._resizeHandler = sizeToContainer;
        try { window.addEventListener('resize', sizeToContainer); } catch {}
        sizeToContainer();
      }
      return this._holdCanvas;
    } catch { return null; }
  }

  _blitHoldFromVideo() {
    const v = this.videoEl; if (!v) return;
    const hc = this._ensureHoldCanvas(); if (!hc) return;
    const ctx = hc.getContext('2d');
    const vw = v.videoWidth || 0, vh = v.videoHeight || 0;
    if (vw <= 0 || vh <= 0) return; // no frame; keep previous pixels to avoid flash
    const w = hc.width, h = hc.height;
    const scale = Math.min(w / vw, h / vh);
    const dw = Math.max(1, Math.floor(vw * scale));
    const dh = Math.max(1, Math.floor(vh * scale));
    const dx = Math.floor((w - dw) / 2);
    const dy = Math.floor((h - dh) / 2);
    try { ctx.drawImage(v, dx, dy, dw, dh); } catch {}
  }

  _showResumeHold() {
    try {
      const v = this.videoEl; if (!v) return;
      const hc = this._ensureHoldCanvas(); if (!hc) return;
      // Show the last captured frame as-is to avoid clearing to black
      hc.style.display = 'block';
    } catch {}
  }

  _hideResumeHoldSoon() {
    const hide = () => { try { if (this._holdCanvas) this._holdCanvas.style.display = 'none'; } catch {} };
    try {
      // Prefer hiding after the first painted frame, not just 'playing'
      if ('requestVideoFrameCallback' in this.videoEl) {
        const id = this.videoEl.requestVideoFrameCallback(() => hide());
        // Safety timer in case rVFC doesn't fire
        setTimeout(hide, 500);
      } else {
        const once = () => { hide(); cleanup(); };
        const cleanup = () => { try { this.videoEl.removeEventListener('timeupdate', once); } catch {} };
        this.videoEl.addEventListener('timeupdate', once, { once: true });
        setTimeout(hide, 500);
      }
    } catch { hide(); }
  }

  setSourceFile(filePath) {
    const url = 'file:///' + String(filePath || '').replace(/\\/g, '/');
    this.srcUrl = url;
    this._ensureVideo();
  }

  onDemuxReady(info, demuxer) {
    // Playback does not use demux; keep for metadata only
    this.ready = true;
    try {
      const v = (info?.tracks||[]).find(t => t.type === 'video') || (info?.tracks||[]).find(t => t.video);
      if (v) {
        const w = v.track_width || v.video?.width || 0;
        const h = v.track_height || v.video?.height || 0;
        if (w>0 && h>0) this.canvas.style.setProperty('--video-ar', String(w/h));
      }
    } catch {}
  }

  onSamples() { /* no-op */ }

  start(baseSec, outSec) {
    this.inSec = baseSec || 0;
    this.outSec = (outSec ?? Infinity);
    this._ensureVideo();
    this._showResumeHold();
    try { this.videoEl.currentTime = this.inSec; } catch {}
    try { this.videoEl.playbackRate = 1; } catch {}
    try { this.videoEl.play(); } catch {}
    this._hideResumeHoldSoon();
  }

  stop() { try { this.videoEl?.pause?.(); } catch {} }

  presentAt() { /* native video paints; no manual blit */ }
  resizeRedraw() { /* CSS scaling handles this */ }
  dispose() { try { this.videoEl?.pause?.(); } catch {}; }
  getCurrentTimeSec() { return this.videoEl?.currentTime || 0; }
  isPlaying() { return !!(this.videoEl && !this.videoEl.paused && !this.videoEl.ended); }
  seekTo(sec) { this._ensureVideo(); try { this.videoEl.pause(); this.videoEl.currentTime = Math.max(0, Number(sec)||0); } catch {} }
  scrubTo(sec) {
    this._ensureVideo();
    const t = Math.max(0, Number(sec)||0);
    try {
      if (typeof this.videoEl.fastSeek === 'function') {
        // fast keyframe-aligned seek is snappier while dragging
        this.videoEl.fastSeek(t);
      } else {
        this.videoEl.currentTime = t;
      }
    } catch { try { this.videoEl.currentTime = t; } catch {} }
  }
  play() { this._ensureVideo(); this._showResumeHold(); try { this.videoEl.play(); } catch {}; this._hideResumeHoldSoon(); }
  _hideOverlay() { try { if (this.videoEl) this.videoEl.style.display = 'block'; } catch {} }
  getMediaElement() { this._ensureVideo(); return this.videoEl; }
  setVolumeLinear(v) { try { this._ensureVideo(); this.videoEl.volume = Math.max(0, Math.min(1, Number(v)||0)); } catch {} }

  // Begin keyframe-friendly trick-play for ultra-smooth scrubbing
  beginTrickPlay(opts={}) {
    this._ensureVideo();
    if (this._tpActive) return;
    this._tpActive = true;
    this._tpHz = Math.max(6, Math.min(60, Number(opts.hz)||18));
    this._tpWasPlaying = this.isPlaying();
    this._tpWasMuted = !!this.videoEl.muted;
    // Mute during trick-play to avoid audio stutter
    try { this.videoEl.muted = true; } catch {}
    // Pause underlying playback; frames will be pulsed
    try { this.videoEl.pause(); } catch {}
    const interval = Math.max(10, Math.floor(1000 / this._tpHz));
    const tick = () => {
      if (!this._tpActive) return;
      const t = this._tpTargetSec;
      if (typeof t === 'number') {
        try {
          if (typeof this.videoEl.fastSeek === 'function') {
            this.videoEl.fastSeek(t);
          } else {
            this.videoEl.currentTime = t;
          }
        } catch { try { this.videoEl.currentTime = t; } catch {} }
        // Pulse play to force a frame paint, then pause next frame (only if still in trick-play)
        try {
          const now = performance.now();
          if (now - this._tpLastPulse > 8) {
            this.videoEl.play().finally(() => {
              requestAnimationFrame(() => {
                if (this._tpActive) {
                  try { this.videoEl.pause(); } catch {}
                }
              });
            });
            this._tpLastPulse = now;
          }
        } catch {}
      }
      this._tpTimer = setTimeout(tick, interval);
    };
    this._tpTimer = setTimeout(tick, interval);
  }

  updateTrickTarget(sec) {
    const t = Math.max(0, Number(sec)||0);
    this._tpTargetSec = t;
  }

  async endTrickPlay(opts={}) {
    if (!this._tpActive) return;
    this._tpActive = false;
    try { clearTimeout(this._tpTimer); } catch {}
    this._tpTimer = 0;
    const resume = opts.resume ?? this._tpWasPlaying;
    const finalT = (typeof this._tpTargetSec === 'number') ? this._tpTargetSec : this.getCurrentTimeSec();
    try { this.videoEl.currentTime = finalT; } catch {}
    try { this.videoEl.muted = this._tpWasMuted; } catch {}
    if (resume) {
      try { await this.videoEl.play(); } catch {}
    }
  }

  /**
   * Show the frame at `sec` in the viewer, optionally resuming playback.
   * - When paused: waits for the seek to complete so the correct frame is shown.
   * - When playing: jumps currentTime without pausing for smooth live scrubs.
   * opts:
   *   - resume: 'auto' | true | false (default 'auto' = resume if was playing)
   *   - wait: boolean (default true when paused, false when playing)
   */
  async showFrameAt(sec, opts={}) {
    this._ensureVideo();
    const target = Math.max(0, Number(sec) || 0);
    const wasPlaying = this.isPlaying();
    const resumeOpt = opts.resume ?? 'auto';
    const shouldResume = resumeOpt === true || (resumeOpt === 'auto' && wasPlaying);
    const wait = opts.wait ?? !wasPlaying;
    const precise = !!opts.precise;
    try {
      // Aggressively nudge the pipeline for near-instant preview
      if (!wasPlaying) { try { this.videoEl.pause(); } catch {} }
      if (!precise && typeof this.videoEl.fastSeek === 'function') {
        try { this.videoEl.fastSeek(target); } catch { this.videoEl.currentTime = target; }
      } else {
        this.videoEl.currentTime = target;
      }
      // Briefly play to force a frame to render ASAP on some platforms
      if (!wasPlaying && !precise) { try { await this.videoEl.play(); } catch {} }
      if (wait) {
        await new Promise((resolve) => {
          let done = false;
          const onSeeked = () => { if (done) return; done = true; cleanup(); resolve(); };
          const onTimeUpdate = () => { if (done) return; done = true; cleanup(); resolve(); };
          const cleanup = () => {
            try { this.videoEl.removeEventListener('seeked', onSeeked); } catch {}
            try { this.videoEl.removeEventListener('timeupdate', onTimeUpdate); } catch {}
          };
          try { this.videoEl.addEventListener('seeked', onSeeked, { once: true }); } catch {}
          // Fallback in case some platforms fire only timeupdate
          try { this.videoEl.addEventListener('timeupdate', onTimeUpdate, { once: true }); } catch {}
          // Safety timeout in case neither fires (corrupted file etc.)
          setTimeout(() => { if (!done) { done = true; resolve(); } }, 300);
        });
        if (precise && 'requestVideoFrameCallback' in this.videoEl) {
          await new Promise((resolve) => {
            try { this.videoEl.requestVideoFrameCallback(() => resolve()); } catch { resolve(); }
          });
        }
      }
      if (shouldResume) { try { await this.videoEl.play(); } catch {} }
      else if (!wasPlaying) { try { this.videoEl.pause(); } catch {} }
    } catch {}
  }
}
