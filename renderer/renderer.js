import { VideoEngine } from './engine/player.js';

const $ = (sel) => document.querySelector(sel);
const ExportMode = window.trimlab?.constants?.ExportMode || { Precise: 'precise', Copy: 'copy' };

const state = {
  filePath: null,
  meta: null,
  inPct: 0,
  outPct: 100,
  durationSec: 30,
  mode: ExportMode.Precise,
  demuxer: null,
  videoEngine: null,
  mediaCtx: null,
  mediaMaster: null,
  splitEls: [],
  splitSources: [],
  splitGains: [],
  // live-seek helpers
  _seekDemuxTimer: 0,
  seekLiveDebounceMs: 120,
  audioMute: [],
  audioSolo: [],
  audioGainsDb: [],
  audioTrackPaths: [],
  audioWavePeaks: [],
  audioWavePromises: [],
  waveCanvases: [],
  waveTokens: [],
  waveTimers: [],
  _waveLoops: [],
  _waveBusy: [],
  _thumbRO: null,
  _thumbSizeTimer: 0,
  _onTransportEnded: null,
  loadToken: 0,
  isScrubbing: false,
  waveLastAt: [],
  wavePending: []
};

function fmtClockSec(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const parts = [h, m, s].map((v, i) => i === 0 ? String(v) : String(v).padStart(2, '0'));
  return (h > 0 ? parts.join(':') : parts.slice(1).join(':'));
}

function fmtClockMs(sec) {
  const totalMs = Math.max(0, Math.round((Number(sec) || 0) * 1000));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  const mss = String(ms).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${mss}`;
}

function setViewerTimeLabel(sec) {
  const label = document.getElementById('timeLabel');
  if (!label) return;
  const next = fmtClockMs(sec);
  if (label.textContent !== next) label.textContent = next;
}

function parseFpsRate(rate) {
  if (!rate) return 0;
  if (typeof rate === 'number') return rate;
  if (typeof rate !== 'string') return 0;
  if (rate.includes('/')) {
    const parts = rate.split('/');
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    if (num && den) return num / den;
  }
  const val = parseFloat(rate);
  return Number.isFinite(val) ? val : 0;
}

function getVideoFps() {
  const streams = Array.isArray(state.meta?.streams) ? state.meta.streams : [];
  const video = streams.find((s) => s.codec_type === 'video');
  const fps = parseFpsRate(video?.avg_frame_rate) || parseFpsRate(video?.r_frame_rate);
  return fps > 0 ? fps : 30;
}

function getFrameStepSec() {
  const fps = getVideoFps();
  return fps > 0 ? 1 / fps : 1 / 30;
}

function snapTimeToFrame(sec, mode = 'round') {
  const step = getFrameStepSec();
  if (!step || !Number.isFinite(step)) return sec;
  const scaled = sec / step;
  const snap = (mode === 'floor' ? Math.floor(scaled + 1e-6) : Math.round(scaled)) * step;
  return snap;
}

function snapPctToFrame(pct, mode = 'round') {
  const dur = Math.max(0, Number(state.durationSec) || 0);
  if (!dur) return pct;
  const sec = dur * pct / 100;
  const snapped = snapTimeToFrame(sec, mode);
  return (snapped / dur) * 100;
}

function getFrameStepPct() {
  const dur = Math.max(0, Number(state.durationSec) || 0);
  if (!dur) return 0.1;
  const step = getFrameStepSec();
  if (!step) return 0.1;
  return (step / dur) * 100;
}

function updateRulerFrameTicks() {
  const span = document.querySelector('.r-span');
  const lane = document.querySelector('.r-lane');
  if (!span || !lane) return;
  const dur = Math.max(0, Number(state.durationSec) || 0);
  if (!dur) { lane.style.removeProperty('--frame-px'); return; }
  const fps = getVideoFps();
  if (!fps || !Number.isFinite(fps)) { lane.style.removeProperty('--frame-px'); return; }
  const frames = dur * fps;
  if (!frames) { lane.style.removeProperty('--frame-px'); return; }
  const width = span.getBoundingClientRect().width || 0;
  if (!width) return;
  const px = Math.max(1, Math.round(width / frames));
  lane.style.setProperty('--frame-px', px + 'px');
}

function nextLoadToken() {
  state.loadToken = (state.loadToken || 0) + 1;
  return state.loadToken;
}

function isActiveLoad(token) {
  return token === state.loadToken;
}

function unloadFile() {
  const prevPath = state.filePath;
  try { if (prevPath) window.trimlab?.cancelReadFile?.(prevPath); } catch {}
  try { state.demuxer?.dispose?.(); } catch {}
  state.demuxer = null;

  try { state.videoEngine?.dispose?.(); } catch {}
  state.videoEngine = null;

  if (state._seekDemuxTimer) { try { clearTimeout(state._seekDemuxTimer); } catch {} state._seekDemuxTimer = 0; }
  if (state._thumbSizeTimer) { try { clearTimeout(state._thumbSizeTimer); } catch {} state._thumbSizeTimer = 0; }
  if (state._thumbRO && typeof state._thumbRO.disconnect === 'function') {
    try { state._thumbRO.disconnect(); } catch {}
  }
  state._thumbRO = null;

  if (Array.isArray(state.waveTimers)) {
    state.waveTimers.forEach((t) => { if (t) { try { clearTimeout(t); } catch {} } });
  }
  state.waveTimers = [];

  if (Array.isArray(state._waveLoops)) {
    state._waveLoops.forEach((t) => { if (t) { try { clearInterval(t); } catch {} } });
  }
  state._waveLoops = [];
  state._waveBusy = [];

  try { cancelAnimationFrame(window.__trimlabRAF || 0); } catch {}

  if (Array.isArray(state.splitEls)) {
    state.splitEls.forEach((el) => {
      try { el.pause(); } catch {}
      try { el.src = ''; } catch {}
      try { el.remove(); } catch {}
    });
  }
  if (Array.isArray(state.splitSources)) {
    state.splitSources.forEach((src) => { try { src.disconnect(); } catch {} });
  }
  if (Array.isArray(state.splitGains)) {
    state.splitGains.forEach((g) => { try { g.disconnect(); } catch {} });
  }
  state.splitEls = [];
  state.splitSources = [];
  state.splitGains = [];

  if (state.mediaCtx) {
    try {
      const closed = state.mediaCtx.close?.();
      if (closed && typeof closed.catch === 'function') closed.catch(() => {});
    } catch {}
  }
  state.mediaCtx = null;
  state.mediaMaster = null;

  state.meta = null;
  state.durationSec = 30;
  state.inPct = 0;
  state.outPct = 100;
  state.mode = ExportMode.Precise;
  state.resumeSec = 0;
  state.audioMute = [];
  state.audioSolo = [];
  state.audioGainsDb = [];
  state.audioTrackPaths = [];
  state.audioWavePeaks = [];
  state.audioWavePromises = [];
  state.waveCanvases = [];
  state.waveTokens = [];
  state.thumbUrl = null;
  state.thumbCols = 0;
  state.thumbForPath = null;
  state.waveLastAt = [];
  state.wavePending = [];

  const videoContainer = document.getElementById('videoLanesContainer');
  if (videoContainer) videoContainer.innerHTML = '';
  const audioContainer = document.getElementById('audioLanesContainer');
  if (audioContainer) audioContainer.innerHTML = '';
  const dropHint = document.getElementById('dropHint');
  if (dropHint) dropHint.style.display = '';

  state.filePath = null;
  setViewerTimeLabel(0);
  updateFooter();
  renderRulerLabels();
  try {
    const lane = document.querySelector('.r-lane');
    if (lane) lane.style.removeProperty('--frame-px');
  } catch {}
}

async function analyze(filePath, loadToken) {
  const info = await window.trimlab.analyze(filePath);
  if (!isActiveLoad(loadToken)) return null;
  state.meta = info;
  const dur = parseFloat(info?.format?.duration || '0') || 0;
  state.durationSec = dur || 30;
  updateFooter();
  updateTimelineDurationLabels();
  renderRulerLabels();
  await renderAudioLanesFromMeta(info, filePath, loadToken);
  return info;
}

function updateFooter() {
  const nameEl = $('#footerName');
  if (nameEl) nameEl.textContent = state.filePath ? state.filePath.split(/[\\/]/).pop() : 'No file';
  const fIn = $('#footerIn');
  const fOut = $('#footerOut');
  const fLen = $('#footerLen');
  const fMode = $('#footerMode');
  const inT = state.durationSec * state.inPct/100;
  const outT = state.durationSec * state.outPct/100;
  const len = Math.max(0, outT - inT);
  if (fIn) fIn.textContent = fmtClockSec(inT);
  if (fOut) fOut.textContent = fmtClockSec(outT);
  if (fLen) fLen.textContent = fmtClockSec(len);
  if (fMode) fMode.textContent = state.mode === ExportMode.Copy ? 'Copy' : 'Precise';
}

function updateTimelineDurationLabels() {
  const tl = $('.timeline');
  if (!tl) return;
  const dur = state.durationSec;
  if (dur <= 30) tl.dataset.duration = '30s';
  else if (dur <= 120) tl.dataset.duration = '2m';
  else tl.dataset.duration = '2m';
}

function renderRulerLabels(){
  const span = document.querySelector('.r-span');
  if (!span) return;
  // Remove previous dynamic labels
  span.querySelectorAll('.labels.labels-dyn').forEach(n => n.remove());
  const dur = Math.max(0, Number(state.durationSec)||0);
  if (!dur) return;
  // Choose a nice step for ~7 ticks
  const nice = [1,2,5,10,15,20,30,60,120,300,600,900,1200,1800,3600];
  const targetTicks = 7;
  let step = nice[0];
  const approx = dur / targetTicks;
  for (const n of nice){ step = n; if (n >= approx) break; }
  // Build labels from 0 to dur (inclusive end)
  const labels = document.createElement('div');
  labels.className = 'labels labels-dyn';
  const fmt = (s)=>{
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s/3600); const m = Math.floor((s%3600)/60); const sec = s%60;
    if (h>0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    return `${m}:${String(sec).padStart(2,'0')}`;
  };
  const last = Math.ceil(dur/step)*step;
  for (let t=0; t<=last; t+=step){
    const sp = document.createElement('span');
    sp.textContent = fmt(t);
    labels.appendChild(sp);
  }
  span.appendChild(labels);
  updateRulerFrameTicks();
}

// Seek transport (and demux) to a given absolute time in seconds.
// If playing, this performs an immediate seek so playback continues from the new spot.
function seekTransportTo(sec, opts = {}) {
  const live = !!opts.live;
  if (!state.filePath) return;
  const dur = Math.max(0, Number(state.durationSec) || 0);
  const inSec = dur * state.inPct / 100;
  const outSec = dur * state.outPct / 100;
  let t = typeof sec === 'number' ? sec : 0;
  t = Math.min(outSec, Math.max(inSec, t));
  t = snapTimeToFrame(t, 'round');
  t = Math.min(outSec, Math.max(inSec, t));
  state.resumeSec = t;
  const tl = document.getElementById('transportTime');
  if (tl) { const d = new Date(Math.max(0, t) * 1000).toISOString().substr(11, 8); tl.textContent = d; }
  setViewerTimeLabel(t);
  // If currently playing, seek video and split audio elements immediately
  if (state.videoEngine?.isPlaying?.()) {
    try { state.videoEngine?.scrubTo?.(t); } catch {}
    if (Array.isArray(state.splitEls)) {
      state.splitEls.forEach((el) => { try { el.currentTime = t; } catch {} });
    }
  } else if (live) {
    // When paused, allow live scrubbing to update the displayed frame
    try { state.videoEngine?.scrubTo?.(t); } catch {}
  }
}

// Force-stop all playback paths (audio, video, demux, RAF) and set UI to Play
function hardPauseTransport() {
  try { state.videoEngine?.stop?.(); } catch {}
  try {
    if (Array.isArray(state.splitEls)) state.splitEls.forEach(el => { try { el.pause(); } catch {} });
  } catch {}
  try { cancelAnimationFrame(window.__trimlabRAF || 0); } catch {}
  const btn = document.getElementById('btnPlay');
  if (btn) btn.textContent = 'Play';
}

function attachMasterRangeDrag() {
  const span = document.querySelector('.r-span');
  if (!span) return;
  const rulerEl = document.querySelector('.ruler');
  const range = span.querySelector('.master-range');
  const fill  = range?.querySelector('.range-fill');
  const inH   = range?.querySelector('.handle.in');
  const outH  = range?.querySelector('.handle.out');
  const tracksEl = document.querySelector('.tracks');
  const dimLeft = tracksEl?.querySelector('.master-dim .dim.left');
  const dimRight = tracksEl?.querySelector('.master-dim .dim.right');
  let dragSpanRect = null;
  let dragTracksRect = null;
  let dragHeadWidth = 0;
  let dragOverlayRect = null;
  let lastScrubPct = null;
  let scrubTimeEl = null;
  let scrubTimeHideTimer = 0;
  const pulseNudge = (el) => {
    if (!el) return;
    el.classList.remove('nudge');
    void el.offsetWidth;
    el.classList.add('nudge');
    setTimeout(() => { try { el.classList.remove('nudge'); } catch {} }, 140);
  };
  const ensureScrubTime = () => {
    if (!scrubTimeEl) {
      scrubTimeEl = document.createElement('div');
      scrubTimeEl.className = 'scrub-time';
      scrubTimeEl.style.display = 'none';
      span.appendChild(scrubTimeEl);
    }
    return scrubTimeEl;
  };
  const showScrubTime = (pct, sec) => {
    const el = ensureScrubTime();
    if (!el) return;
    if (scrubTimeHideTimer) { clearTimeout(scrubTimeHideTimer); scrubTimeHideTimer = 0; }
    el.textContent = fmtClockSec(sec);
    el.style.left = pct + '%';
    el.style.display = 'block';
    requestAnimationFrame(() => { try { el.classList.add('show'); } catch {} });
  };
  const hideScrubTime = () => {
    if (!scrubTimeEl) return;
    scrubTimeEl.classList.remove('show');
    if (scrubTimeHideTimer) clearTimeout(scrubTimeHideTimer);
    scrubTimeHideTimer = setTimeout(() => {
      if (scrubTimeEl) scrubTimeEl.style.display = 'none';
    }, 140);
  };
  function updateMasterDimSize(){
    try {
      const md = tracksEl?.querySelector('.master-dim');
      if (md && tracksEl) md.style.height = tracksEl.scrollHeight + 'px';
    } catch {}
  }

  function apply(opts = {}) {
    const fast = !!opts.fast;
    if (!fill || !inH || !outH) return;
    // Position fill within the ruler span (lane only)
    fill.style.left  = state.inPct + '%';
    fill.style.right = (100 - state.outPct) + '%';
    inH.style.left   = `calc(${state.inPct}%)`; inH.style.right  = '';
    outH.style.right = `calc(${100 - state.outPct}%)`; outH.style.left = '';
      if (dimLeft && dimRight && tracksEl) {
        // Align overlay to start at the lane (after trackhead), and map dim widths to overlay rect
        const md = tracksEl.querySelector('.master-dim');
        const headEl = tracksEl.querySelector('.track-row .track-head') || tracksEl.querySelector('.track-head');
        let headW = 0;
        try { headW = dragHeadWidth || (headEl ? Math.round(headEl.getBoundingClientRect().width) : 0); } catch {}
        if (md) { md.style.left = headW + 'px'; md.style.right = '0'; }
        const sr = dragSpanRect || span.getBoundingClientRect();
        const ov = dragOverlayRect || (md ? md.getBoundingClientRect() : tracksEl.getBoundingClientRect());
        const inX = sr.left + (state.inPct/100) * sr.width;
        const outX = sr.left + (state.outPct/100) * sr.width;
        const leftPx = Math.max(0, Math.round(inX - ov.left));
        const rightPx = Math.max(0, Math.round(ov.right - outX));
        dimLeft.style.width = leftPx + 'px';
        dimRight.style.width = rightPx + 'px';
      }
    if (!fast) updateMasterDimSize();
    state.mode = (state.inPct <= 0.01 && state.outPct >= 99.99) ? ExportMode.Copy : ExportMode.Precise;
    updateFooter();
  }
  apply();
  // Expose updater so other flows (e.g., on load) can sync UI
  try { state.updateMasterRange = apply; } catch {}
  window.addEventListener('resize', () => {
    apply();
    updateMasterDimSize();
    updateRulerFrameTicks();
    try { scheduleAdaptiveVideoThumbnails(state.filePath); } catch {}
  });
  if ('ResizeObserver' in window && tracksEl) {
    const ro = new ResizeObserver(() => { updateMasterDimSize(); try { scheduleAdaptiveVideoThumbnails(state.filePath); } catch {} });
    ro.observe(tracksEl);
  }

  function cacheDragRects(){
    try {
      dragSpanRect = span.getBoundingClientRect();
      dragTracksRect = tracksEl?.getBoundingClientRect() || null;
      const md = tracksEl?.querySelector('.master-dim');
      const headEl = tracksEl?.querySelector('.track-row .track-head') || tracksEl?.querySelector('.track-head');
      dragHeadWidth = headEl ? Math.round(headEl.getBoundingClientRect().width) : 0;
      if (md) {
        md.style.left = dragHeadWidth + 'px';
        md.style.right = '0';
        dragOverlayRect = md.getBoundingClientRect();
      } else {
        dragOverlayRect = dragTracksRect;
      }
    } catch { dragSpanRect = null; dragTracksRect = null; }
  }
  function clearDragRects(){
    dragSpanRect = null;
    dragTracksRect = null;
    dragHeadWidth = 0;
    dragOverlayRect = null;
  }
  function pctFromEvent(e){
    const r = dragSpanRect || span.getBoundingClientRect();
    const clientX = (e?.touches?.[0]?.clientX ?? e?.clientX);
    if (!Number.isFinite(clientX)) return null;
    const width = Math.max(1, r.width || 0);
    const x = Math.min(Math.max(clientX - r.left, 0), width);
    return (x / width) * 100;
  }
  function startDrag(which, e){
    e.preventDefault();
    document.body.classList.add('dragging');
    if (rulerEl) rulerEl.classList.add('is-scrubbing');
    state.isScrubbing = true;
    cacheDragRects();
    const handleEl = (which === 'in') ? inH : outH;
    if (handleEl) handleEl.classList.add('is-dragging');
    // Begin trick-play preview while dragging handles
    let wasPlaying = false;
    try {
      wasPlaying = !!state.videoEngine?.isPlaying?.();
      // Pause split audio if currently playing to avoid drift
      if (wasPlaying && Array.isArray(state.splitEls)) {
        state.splitEls.forEach(el => { try { el.pause(); } catch {} });
      }
      state.videoEngine?.beginTrickPlay?.({ hz: 20 });
    } catch {}
    let rafMove = 0;
    let lastEv = null;
    const doMove = (ev) => {
      const pRaw = pctFromEvent(ev);
      if (!Number.isFinite(pRaw)) return;
      const p = snapPctToFrame(pRaw, 'round');
      if (!Number.isFinite(p)) return;
      const minGap = Math.max(getFrameStepPct(), 0.05);
      if (which === 'in') {
        const next = Math.min(Math.max(0, p), state.outPct - minGap);
        if (next === state.inPct) return;
        state.inPct = next;
      } else {
        const next = Math.max(Math.min(100, p), state.inPct + minGap);
        if (next === state.outPct) return;
        state.outPct = next;
      }
      apply({ fast: true });
      // Live preview: show frame at the current handle time
      try {
        const dur = Math.max(0, Number(state.durationSec) || 0);
        const raw = dur * ((which === 'in' ? state.inPct : state.outPct) / 100);
        const t = snapTimeToFrame(raw, 'round');
        state.resumeSec = t;
        const tl = document.getElementById('transportTime');
        if (tl && !tl.hasAttribute('hidden')) {
          const d = new Date(Math.max(0,t)*1000).toISOString().substr(11,8);
          tl.textContent = d;
        }
        state.videoEngine?.updateTrickTarget?.(t);
        showScrubTime(p, t);
        setViewerTimeLabel(t);
      } catch {}
    };
    const move = (ev)=>{
      lastEv = ev;
      if (rafMove) return;
      rafMove = requestAnimationFrame(() => {
        rafMove = 0;
        if (lastEv) doMove(lastEv);
        lastEv = null;
      });
    };
    const up = async ()=>{
      if (rafMove) { cancelAnimationFrame(rafMove); rafMove = 0; }
      lastEv = null;
      document.body.classList.remove('dragging');
      if (rulerEl) rulerEl.classList.remove('is-scrubbing');
      state.isScrubbing = false;
      clearDragRects();
      if (handleEl) {
        handleEl.classList.remove('is-dragging');
        pulseNudge(handleEl);
      }
      hideScrubTime();
      // End trick-play; resume playback if it was playing
      try { state.videoEngine?.endTrickPlay?.({ resume: false }); } catch {}
      apply();
      // Land exactly on the final handle position
      try {
        if (typeof state.resumeSec === 'number') {
          try { await state.videoEngine?.showFrameAt?.(state.resumeSec, { resume: false, wait: true, precise: true }); } catch {}
          if (!wasPlaying && Array.isArray(state.splitEls)) {
            // Keep split audio paused but align times for next play
            for (const el of state.splitEls) { try { el.currentTime = state.resumeSec; } catch {} }
          }
        }
      } catch {}
      if (wasPlaying) {
        try {
          // Ensure video resumes from the previewed position
          if (Array.isArray(state.splitEls)) {
            await state.mediaCtx?.resume?.();
            for (const el of state.splitEls) { try { el.currentTime = state.resumeSec; await el.play(); } catch {} }
          }
          state.videoEngine?.play?.();
        } catch {}
      }
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }
  inH?.addEventListener('mousedown', (e)=> startDrag('in', e));
  outH?.addEventListener('mousedown', (e)=> startDrag('out', e));
  // Scrub playhead when dragging anywhere on ruler that is not a handle
  const playheadEl = span.querySelector('.playhead');
  const tracksEl2 = document.querySelector('.tracks');
  let scrubActive = false;
  let scrubLine = null;
  function ensureScrubLine(){
    if (!tracksEl2) return null;
    scrubLine = tracksEl2.querySelector('.scrubline');
    if (!scrubLine){
      scrubLine = document.createElement('div');
      scrubLine.className = 'scrubline';
      tracksEl2.appendChild(scrubLine);
    }
    return scrubLine;
  }
  const scrubPreview = document.getElementById('__scrub_preview');
  function updateScrubUI(ev){
    const sr = dragSpanRect || span.getBoundingClientRect();
    const tr = dragTracksRect || tracksEl2?.getBoundingClientRect();
    const pctRaw = pctFromEvent(ev);
    if (!Number.isFinite(pctRaw)) return;
    const pct = snapPctToFrame(pctRaw, 'round');
    if (!Number.isFinite(pct)) return;
    if (pct === lastScrubPct) return;
    lastScrubPct = pct;
    if (playheadEl) playheadEl.style.left = pct + '%';
    if (tr){
      const xAbs = sr.left + (pct/100) * sr.width;
      const xOff = Math.max(0, Math.round(xAbs - tr.left));
      const line = ensureScrubLine();
      if (line){ line.style.left = xOff + 'px'; line.style.display='block'; }
    }
    if (scrubPreview) scrubPreview.style.display = 'none';
    // Update footer time display and set resumeSec so Play starts here
    const raw = (state.durationSec||0) * pct/100;
    const t = snapTimeToFrame(raw, 'round');
    state.resumeSec = t;
    const tl = document.getElementById('transportTime');
    if (tl && !tl.hasAttribute('hidden')) {
      const d = new Date(Math.max(0,t)*1000).toISOString().substr(11,8);
      tl.textContent = d;
    }
    setViewerTimeLabel(t);
    showScrubTime(pct, t);
    // Update trick-play target to keep preview snappy without flooding decoder
    try { state.videoEngine?.updateTrickTarget?.(state.resumeSec); } catch {}
  }
  span.addEventListener('mousedown', (e)=>{
    if (e.target.closest('.handle')) return; // handled by handle drag
    scrubActive = true;
    document.body.classList.add('dragging');
    if (rulerEl) rulerEl.classList.add('is-scrubbing');
    state.isScrubbing = true;
    cacheDragRects();
    lastScrubPct = null;
    // Start trick-play; remember prior play state so we can resume on mouseup
    state.__wasPlaying = !!state.videoEngine?.isPlaying?.();
    // Pause split audio while scrubbing to avoid drift
    try {
      if (state.__wasPlaying && Array.isArray(state.splitEls)) {
        state.splitEls.forEach(el => { try { el.pause(); } catch {} });
      }
    } catch {}
    try { state.videoEngine?.beginTrickPlay?.({ hz: 20 }); } catch {}
    updateScrubUI(e);
    let rafMove = 0;
    let lastEv = null;
    const move = (ev)=>{
      if (!scrubActive) return;
      lastEv = ev;
      if (rafMove) return;
      rafMove = requestAnimationFrame(() => {
        rafMove = 0;
        if (lastEv) updateScrubUI(lastEv);
        lastEv = null;
      });
    };
    const up = async ()=>{
      if (rafMove) { cancelAnimationFrame(rafMove); rafMove = 0; }
      lastEv = null;
      scrubActive = false;
      document.body.classList.remove('dragging');
      if (rulerEl) rulerEl.classList.remove('is-scrubbing');
      state.isScrubbing = false;
      clearDragRects();
      if (scrubLine) scrubLine.style.display='none';
      if (scrubPreview) scrubPreview.style.display='none';
      hideScrubTime();
      pulseNudge(playheadEl);
      // Commit and resume based on prior state: resume only if it was playing
      try { state.videoEngine?.endTrickPlay?.({ resume: false }); } catch {}
      // Ensure we land exactly at the final scrubbed frame before resuming
      if (typeof state.resumeSec === 'number') {
        try { await state.videoEngine?.showFrameAt?.(state.resumeSec, { resume: false, wait: true, precise: true }); } catch {}
        // Sync split audio elements to the same time
        try {
          if (Array.isArray(state.splitEls)) {
            state.splitEls.forEach(el => { try { el.currentTime = state.resumeSec; } catch {} });
          }
        } catch {}
      }
      if (state.__wasPlaying) {
        try { state.videoEngine?.play?.(); } catch {}
        // Resume audio context and split elements
        try {
          await state.mediaCtx?.resume?.();
          if (Array.isArray(state.splitEls)) {
            for (const el of state.splitEls) { try { await el.play(); } catch {} }
          }
        } catch {}
        const btn = document.getElementById('btnPlay');
        if (btn) btn.textContent = 'Pause';
      }
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  // We rely on videoEngine.seekTo during scrubbing to present the frame; no extra RAF here
}

function setupOpenHandlers() {
  $('#btnOpen')?.addEventListener('click', async () => {
    if (!window.trimlab) { console.error('preload bridge missing'); return; }
    const file = await window.trimlab.openFile();
    if (file) loadFile(file);
  });
  window.addEventListener('dragover', (e)=>{ e.preventDefault(); });
  window.addEventListener('drop', (e)=>{
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0]?.path;
    if (file) loadFile(file);
  });
  if (window.trimlab?.onFileOpenedFromOS) {
    window.trimlab.onFileOpenedFromOS((file)=> loadFile(file));
  }
}

async function loadFile(filePath) {
  const loadToken = nextLoadToken();
  unloadFile();
  state.filePath = filePath;
  // Reset thumbnail state so new clip regenerates a fresh strip
  try { state.thumbUrl = null; state.thumbCols = 0; state.thumbForPath = filePath; state._thumbGenToken = (state._thumbGenToken||0) + 1; } catch {}
  const baseName = filePath.split(/[\\/]/).pop();
  const footerNameEl = $('#footerName');
  if (footerNameEl) footerNameEl.textContent = baseName;
  const dropHint = $('#dropHint');
  if (dropHint) dropHint.style.display = 'none';

  // Bootstrap the new video source first
  const canvas = document.getElementById('videoCanvas');
  state.videoEngine = new VideoEngine(canvas);
  if (state._onTransportEnded) state.videoEngine.onEnded = state._onTransportEnded;
  // Provide video immediately for instant first frame; keep audio unmuted until split audio is ready
  try { state.videoEngine.setSourceFile(filePath); } catch {}
  if (state.videoEngine) { state.videoEngine._fallbackFile = 'file:///' + filePath.replace(/\\/g,'/'); }

  // Optimistically set up the lane and schedule thumbnails without blocking
  ensureVideoLane(baseName);
  try { scheduleAdaptiveVideoThumbnails(filePath, 80); } catch {}

  const analyzePromise = (async () => {
    try {
      return await analyze(filePath, loadToken);
    } catch (e) {
      if (isActiveLoad(loadToken)) console.warn('Analyze failed', e);
      return null;
    }
  })();
  // Asynchronously analyze metadata (duration, streams) and render lanes when ready
  (async () => {
    try {
      await analyzePromise;
      if (!isActiveLoad(loadToken)) return;
      // Master range: full clip on load once we know duration
      state.inPct = 0; state.outPct = 100;
      if (typeof state.updateMasterRange === 'function') state.updateMasterRange();
      // Hide default ruler labels (0-30s etc.) and clear duration flag
      document.querySelectorAll('.ruler .labels:not(.labels-dyn)').forEach(el => { el.style.display = 'none'; });
      const tlEl = document.querySelector('.timeline');
      if (tlEl) tlEl.removeAttribute('data-duration');
    } catch (e) {
      if (isActiveLoad(loadToken)) console.warn('Analyze failed', e);
    }
  })();

  // Prepare per-lane audio in the background; switch from native audio to split when ready
  (async () => {
    try {
      if (!state.mediaCtx) {
        state.mediaCtx = new (window.AudioContext || window.webkitAudioContext)();
        state.mediaMaster = state.mediaCtx.createGain();
        state.mediaMaster.gain.value = 1;
        state.mediaMaster.connect(state.mediaCtx.destination);
      }
      const meta = await analyzePromise;
      if (!isActiveLoad(loadToken)) return;
      const audioStreams = Array.isArray(meta?.streams) ? meta.streams : null;
      const res = await window.trimlab.prepareAudioTracks({ inputPath: filePath, sampleRate: 48000, channels: 2, audioStreams }) || { tracks: [] };
      if (!isActiveLoad(loadToken)) return;
      const tracks = Array.isArray(res?.tracks) ? res.tracks : [];
      state.audioTrackPaths = tracks.slice();
      state.splitEls = [];
      state.splitGains = [];
      state.splitSources = [];
      for (let i=0;i<tracks.length;i++){
        const el = document.createElement('audio');
        el.preload = 'auto'; el.muted = false; el.volume = 1; el.src = 'file:///' + String(tracks[i]).replace(/\\/g,'/');
        const src = state.mediaCtx.createMediaElementSource(el);
        const g = state.mediaCtx.createGain(); g.gain.value = 1;
        src.connect(g); g.connect(state.mediaMaster);
        state.splitEls.push(el);
        state.splitSources.push(src);
        state.splitGains.push(g);
      }
      // Fallback: if metadata parsing failed, still render lanes from prepared tracks.
      if (tracks.length) {
        renderAudioLanes(tracks.length, [], filePath, loadToken);
      }
      // If we're currently playing, align and start split audio
      try {
        const v = state.videoEngine?.getMediaElement?.();
        const isPlaying = !!state.videoEngine?.isPlaying?.();
        const cur = (v?.currentTime || 0);
        if (isPlaying && Array.isArray(state.splitEls) && state.splitEls.length) {
          await state.mediaCtx?.resume?.();
          for (const el of state.splitEls) { try { el.currentTime = cur; await el.play(); } catch {} }
        }
        // Mute video element now that split audio path is available
        try { if (v) v.muted = true; } catch {}
      } catch {}
    } catch (e) {
      if (isActiveLoad(loadToken)) console.warn('prepareAudioTracks failed', e);
    }
  })();
}

function ensureVideoLane(name){
  const container = document.getElementById('videoLanesContainer');
  if (!container) return;
  container.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'track-row';
  row.innerHTML = `
    <div class="track-head"><div class="id">V1</div></div>
    <div class="track-lane">
      <div class="lane video-lane">
        <div class="thumbstrip" aria-hidden="true"></div>
        <div class="label-divider" aria-hidden="true"></div>
        <div class="clip-label">${name ? name.replace(/</g,'&lt;') : 'Clip'}<span class="ext"></span></div>
      </div>
    </div>`;
  container.appendChild(row);
  // Attach a ResizeObserver to the thumbstrip to adjust columns immediately on size changes
  try {
    // Disconnect previous observer if any
    if (state._thumbRO && typeof state._thumbRO.disconnect === 'function') { try { state._thumbRO.disconnect(); } catch {} }
    const strip = row.querySelector('.thumbstrip');
    if (strip && 'ResizeObserver' in window) {
      const ro = new ResizeObserver(() => scheduleAdaptiveVideoThumbnails(state.filePath));
      ro.observe(strip);
      state._thumbRO = ro;
    }
  } catch {}
}

// Compute ideal number of thumbnail columns based on lane width
function calcThumbColsForLane(stripEl) {
  try {
    const rect = stripEl.getBoundingClientRect();
    const targetTile = 80; // px per thumbnail target width (narrower)
    const minCols = 10;
    const maxCols = 400;
    const cols = Math.max(minCols, Math.min(maxCols, Math.ceil(rect.width / targetTile)));
    return cols;
  } catch { return 10; }
}

async function ensureAdaptiveVideoThumbnails(filePath) {
  if (!window.trimlab?.generateThumbnails || !filePath) return;
  const strip = document.querySelector('.video-lane .thumbstrip');
  if (!strip) return;
  const cols = calcThumbColsForLane(strip);
  // If we already have a sprite for this file with the same cols, skip
  if (state.thumbUrl && state.thumbCols === cols && state.thumbForPath === filePath) return;
  const myToken = (state._thumbGenToken = (state._thumbGenToken || 0) + 1);
  try {
    const { outPath } = await window.trimlab.generateThumbnails({ inputPath: filePath, cols, width: 320, height: -1 });
    const url = `file:///${outPath.replace(/\\/g,'/')}`;
    // Only apply if this is still the latest request and filePath matches
    if (myToken === state._thumbGenToken && state.filePath === filePath) {
      strip.style.backgroundImage = `url('${url}')`;
      strip.classList.add('has-image');
      // background-size 100% 100% makes each tile width = laneWidth/cols; keeps per-tile size ~constant
      strip.style.backgroundSize = '100% 100%';
      strip.style.backgroundRepeat = 'no-repeat';
      state.thumbUrl = url;
      state.thumbCols = cols;
      state.thumbForPath = filePath;
    }
  } catch (e) { console.warn('ensureAdaptiveVideoThumbnails failed', e); }
}

function scheduleAdaptiveVideoThumbnails(filePath, delay=80) {
  if (!filePath) return;
  try { if (state._thumbSizeTimer) { clearTimeout(state._thumbSizeTimer); state._thumbSizeTimer = 0; } } catch {}
  state._thumbSizeTimer = setTimeout(() => { state._thumbSizeTimer = 0; ensureAdaptiveVideoThumbnails(filePath); }, delay);
}

function audioLaneMarkup(idx, name){
  const id = `A${idx+1}`;
  return `
  <div class="track-row">
    <div class="track-head"><div class="id">${id}</div><div class="tog mute off" data-tip="Mute (M)">M</div><div class="tog solo off" data-tip="Solo (S)">S</div></div>
    <div class="track-lane">
        <div class="lane audio-lane">
          <div class="content">
            <div class="wave-img top"></div>
            <div class="wave-img bottom"></div>
            <div class="divider"></div>
            <div class="divider-grab" data-tip="+0.0 dB"></div>
        </div>
        <div class="label-divider" aria-hidden="true"></div>
        <div class="clip-label">${name || id} <span class="ext">.wav</span></div>
      </div>
    </div>
  </div>`;
}

function renderAudioLanes(count, titles, filePath, loadToken) {
  if (!isActiveLoad(loadToken)) return;
  const container = document.getElementById('audioLanesContainer');
  if (!container || count <= 0) return;
  container.innerHTML = '';
  // reset lane gain + waveform trackers
  state.audioGainsDb = [];
  state.audioMute = [];
  state.audioSolo = [];
  state.waveTokens = [];
  state.waveTimers = [];
  const safeTitles = Array.isArray(titles) ? titles : [];
  for (let i = 0; i < count; i++) {
    const title = safeTitles[i] || '';
    container.insertAdjacentHTML('beforeend', audioLaneMarkup(i, title));
    state.audioGainsDb[i] = 0;
    state.waveTokens[i] = 0;
    state.waveTimers[i] = 0;
    state.audioMute[i] = false;
    state.audioSolo[i] = false;
    state.wavePending[i] = false;
    state.waveLastAt[i] = 0;
  }
  // bind divider handlers for new lanes
  if (setupTooltips.bindDividerHandlers) setupTooltips.bindDividerHandlers(container);
  try { bindMuteSoloHandlers(container); } catch {}
  // Generate waveforms per stream in the background so UI is responsive
  for (let i = 0; i < count; i++) {
    const delay = i * 80;
    setTimeout(async () => {
      try{
        const trackPath = Array.isArray(state.audioTrackPaths) ? state.audioTrackPaths[i] : null;
        const inputPath = trackPath || filePath;
        const streamIndex = trackPath ? 0 : i;
        const { outPath } = await window.trimlab.generateWaveform({ inputPath, streamIndex, width: 1200, height: 180 });
        // Ignore if file has changed
        if (!isActiveLoad(loadToken) || state.filePath !== filePath) return;
        const row = container.children[i];
        const top = row?.querySelector('.wave-img.top');
        const bottom = row?.querySelector('.wave-img.bottom');
        const url = `file:///${outPath.replace(/\\/g,'/')}?v=${Date.now()}`;
        if (top) top.style.backgroundImage = `url('${url}')`;
        if (bottom) bottom.style.backgroundImage = `url('${url}')`;
      } catch(e) { console.warn('Waveform generation failed for stream', i, e); }
    }, delay);
  }
  // Ensure dim overlay matches the full scrollable height
  try {
    const tracksEl = document.querySelector('.tracks');
    const md = tracksEl?.querySelector('.master-dim');
    if (md && tracksEl) md.style.height = tracksEl.scrollHeight + 'px';
  } catch {}
}

async function renderAudioLanesFromMeta(info, filePath, loadToken) {
  if (!isActiveLoad(loadToken)) return;
  const streams = (info?.streams||[]).filter(s => s.codec_type === 'audio');
  if (!streams.length) return;
  const titles = streams.map((s) => s.tags?.title || s.tags?.language || '');
  renderAudioLanes(streams.length, titles, filePath, loadToken);
}


function setExportButtonBusy(isBusy) {
  const btn = document.getElementById('btnExport');
  if (!btn) return;
  if (isBusy) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent || 'Export';
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.textContent = 'Exporting...';
  } else {
    const label = btn.dataset.label || 'Export';
    btn.textContent = label;
    btn.disabled = false;
    btn.classList.remove('is-busy');
    btn.dataset.label = '';
  }
}

function setupExport() {
  $('#btnExport')?.addEventListener('click', async () => {
    if (!state.filePath) return;
    const inSec = state.durationSec * state.inPct / 100;
    const outSec = state.durationSec * state.outPct / 100;
    try {
      if (!window.trimlab) throw new Error('preload bridge missing');
      setExportButtonBusy(true);
      // Show progress UI
      showExportProgress(0, 'ETA 00:00');
      // Bind progress updates
      if (!state._progressBound && window.trimlab.onExportProgress){
        window.trimlab.onExportProgress((msg)=>{
          if (msg?.error){ hideExportProgress(); setExportButtonBusy(false); return; }
          if (msg?.canceled){ hideExportProgress(); setExportButtonBusy(false); return; }
          const pct = Math.max(0, Math.min(100, msg?.percent ?? 0));
          const eta = msg?.eta ? `ETA ${msg.eta}` : '';
          updateExportProgress(pct, eta);
          if (msg?.done){
            setExportButtonBusy(false);
            setTimeout(()=> hideExportProgress(), 600);
          }
        });
        state._progressBound = true;
      }
      const res = await window.trimlab.export({
        inputPath: state.filePath,
        inSec,
        outSec,
        mode: state.mode,
        audioCount: Array.isArray(state.meta?.streams)
          ? state.meta.streams.filter(s => s.codec_type === 'audio').length
          : undefined,
        audioGainsDb: Array.isArray(state.audioGainsDb) ? state.audioGainsDb : [],
        audioMute: Array.isArray(state.audioMute) ? state.audioMute : [],
        audioSolo: Array.isArray(state.audioSolo) ? state.audioSolo : []
      });
      console.log('Exported', res);
      setExportButtonBusy(false);
      // Optionally reveal path is handled in main; we keep UI subtle
    } catch (e) {
      console.error('Export failed', e);
      alert('Export failed: ' + e.message);
    } finally {
      setExportButtonBusy(false);
    }
  });
}

function showExportProgress(pct, eta){
  try {
    const box = document.getElementById('exportProgress');
    const fill = box?.querySelector('.export-fill');
    const pctEl = document.getElementById('exportPct');
    const etaEl = document.getElementById('exportEta');
    const pctEl2 = document.getElementById('exportPct2');
    const etaEl2 = document.getElementById('exportEta2');
    box.classList.add('show');
    if (fill) fill.style.width = Math.round(pct)+'%';
    if (pctEl) pctEl.textContent = Math.round(pct)+'%';
    if (etaEl) etaEl.textContent = eta || '';
    if (pctEl2) pctEl2.textContent = Math.round(pct)+'%';
    if (etaEl2) etaEl2.textContent = eta || '';
    try { requestAnimationFrame(()=> setProgressTextContrast()); } catch {}
    const cancel = document.getElementById('exportCancel');
    if (cancel && !cancel.__bound){
      cancel.__bound = true;
      cancel.addEventListener('click', async ()=>{
        try { await window.trimlab.cancelExport?.(); } catch {}
        hideExportProgress();
        setExportButtonBusy(false);
      });
    }
  } catch {}
}

function updateExportProgress(pct, eta){
  try {
    const box = document.getElementById('exportProgress');
    const fill = box?.querySelector('.export-fill');
    const pctEl = document.getElementById('exportPct');
    const etaEl = document.getElementById('exportEta');
    const pctEl2 = document.getElementById('exportPct2');
    const etaEl2 = document.getElementById('exportEta2');
    if (fill) fill.style.width = Math.round(pct)+'%';
    if (pctEl) pctEl.textContent = Math.round(pct)+'%';
    if (etaEl) etaEl.textContent = eta || '';
    if (pctEl2) pctEl2.textContent = Math.round(pct)+'%';
    if (etaEl2) etaEl2.textContent = eta || '';
    try { requestAnimationFrame(()=> setProgressTextContrast()); } catch {}
  } catch {}
}

function hideExportProgress(){
  try { const box = document.getElementById('exportProgress'); box.classList.remove('show'); } catch {}
}

function setProgressTextContrast(){
  try {
    const box = document.getElementById('exportProgress');
    const bar = box?.querySelector('.export-bar');
    const fill = box?.querySelector('.export-fill');
    const text = box?.querySelector('.export-text');
    const textInner = box?.querySelector('#exportTextInner');
    if (!bar || !fill || !text) return;
    const styles = getComputedStyle(document.documentElement);
    const textColor = styles.getPropertyValue('--export-text').trim() || '#ffffff';
    (textInner || text).style.color = textColor;
  } catch {}
}

function setupTransport() {
  const btn = $('#btnPlay');
  const playhead = document.querySelector('.r-span .playhead');
  const tlabel = $('#transportTime');
  const vlabel = $('#timeLabel');
  let raf = 0;
  let lastFrame = -1;
  let lastFps = 0;
  const tick = () => {
    const raw = state.videoEngine?.getCurrentTimeSec?.() ?? 0;
    const fps = getVideoFps();
    if (fps !== lastFps) { lastFps = fps; lastFrame = -1; }
    const frame = Math.max(0, Math.floor((raw * fps) + 1e-6));
    if (!state.isScrubbing && frame !== lastFrame) {
      lastFrame = frame;
      const t = frame / fps;
      const dur = Math.max(0.001, state.durationSec || 0.001);
      const pct = Math.min(100, Math.max(0, (t / dur) * 100));
      if (playhead) playhead.style.left = pct + '%';
      if (tlabel) tlabel.textContent = new Date(t*1000).toISOString().substr(11, 8);
    }
    if (!state.isScrubbing && vlabel) vlabel.textContent = fmtClockMs(raw);
    // Native <video> paints itself; no manual blit needed
    raf = requestAnimationFrame(tick);
    window.__trimlabRAF = raf;
  };

  // Ensure redraw on window resize so the last frame fits vertically
  window.addEventListener('resize', () => {
    state.videoEngine?.resizeRedraw?.();
  });
  // Also observe viewer size changes to redraw immediately on container resizes
  try {
    const viewer = document.querySelector('.viewer .frame') || document.querySelector('.viewer');
    if (viewer && 'ResizeObserver' in window) {
      const ro = new ResizeObserver(() => state.videoEngine?.resizeRedraw?.());
      ro.observe(viewer);
    }
  } catch {}

  const onEnded = () => {
    // Capture pause position for resume
    try {
      const t0 = state.videoEngine?.getCurrentTimeSec?.() || 0;
      const tA = Array.isArray(state.splitEls)
        ? state.splitEls.map(e=>e?.currentTime||0).reduce((a,b)=>Math.max(a,b), 0)
        : 0;
      const maxT = Math.max(t0, tA, state.resumeSec || 0);
      state.resumeSec = snapTimeToFrame(maxT, 'round');
      setViewerTimeLabel(state.resumeSec);
    } catch {}
    try { if (Array.isArray(state.splitEls)) state.splitEls.forEach(el => { try { el.pause(); } catch {} }); } catch {}
    state.videoEngine?.stop?.();
    cancelAnimationFrame(raf);
    if (btn) btn.textContent = 'Play';
  };
  state._onTransportEnded = onEnded;
  if (state.videoEngine) state.videoEngine.onEnded = onEnded;

  btn?.addEventListener('click', async () => {
    if (!state.filePath) return;
    const inSec = state.durationSec * state.inPct / 100;
    const outSec = state.durationSec * state.outPct / 100;
    if (!state.videoEngine?.isPlaying?.()) {
      try {
        const step = getFrameStepSec();
        const atEnd = typeof state.resumeSec === 'number' && state.resumeSec >= (outSec - step);
        const startRaw = atEnd ? inSec : ((typeof state.resumeSec === 'number' && state.resumeSec >= inSec) ? state.resumeSec : inSec);
        const startSec = snapTimeToFrame(startRaw, 'round');
        state.videoEngine?.setSourceFile?.(state.filePath);
        try { state.videoEngine?._hideOverlay?.(); } catch {}
        state.videoEngine?.start?.(startSec, outSec);
        // Split audio pipeline: align and play per-lane elements
        try {
          await state.mediaCtx?.resume?.();
          if (Array.isArray(state.splitEls)) {
            for (const el of state.splitEls) {
              try { el.currentTime = startSec; await el.play(); } catch {}
            }
          }
        } catch {}
        btn.textContent = 'Pause';
        cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); window.__trimlabRAF = raf;
      } catch (e) {
        console.error('Playback start failed', e);
      }
    } else {
      // Pause all
      try {
        if (Array.isArray(state.splitEls)) state.splitEls.forEach(el => { try { el.pause(); } catch {} });
      } catch {}
      onEnded();
    }
  });

  // Global spacebar toggle for play/pause (ignore when typing in inputs)
  window.addEventListener('keydown', (e) => {
    try {
      const key = e.code || e.key || '';
      const isSpace = (key === 'Space' || key === ' ' || e.keyCode === 32);
      if (!isSpace) return;
      // Do not hijack space when focused in editable elements
      const t = e.target;
      const tag = (t && t.tagName) ? String(t.tagName).toLowerCase() : '';
      const isEditable = (t && (t.isContentEditable || tag === 'input' || tag === 'textarea')); 
      if (isEditable) return;
      e.preventDefault();
      document.getElementById('btnPlay')?.click();
    } catch {}
  });
}

function setupTooltips() {
  const tip = document.getElementById('__float_tip');
  let hideTimer = 0;
  function showTip(x,y,text){
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
    tip.textContent = text; tip.style.display = 'block';
    tip.classList.add('show');
    requestAnimationFrame(()=>{
      const r = tip.getBoundingClientRect();
      let left = x - r.width/2; left = Math.max(6, Math.min(window.innerWidth - r.width - 6, left));
      let top  = y - r.height - 12; if(top < 6) top = y + 16;
      tip.style.left = left + 'px';
      tip.style.top  = top  + 'px';
    });
  }
  function hideTip(immediate = false){
    tip.classList.remove('show');
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
    if (immediate) { tip.style.display = 'none'; return; }
    hideTimer = setTimeout(()=>{ tip.style.display = 'none'; }, 140);
  }
  // Generic data-tip binder (for ruler handles, buttons, etc.)
  function bindDataTip(root){
    root.querySelectorAll('[data-tip]')
      .forEach(el => {
        // Avoid rebinding repeatedly
        if (el.__tlTipBound) return; el.__tlTipBound = true;
        el.addEventListener('mouseenter', (ev)=>{
          if (el.classList.contains('handle') && document.body.classList.contains('dragging')) return;
          const t = el.getAttribute('data-tip'); if (!t) return;
          showTip(ev.clientX, ev.clientY, t);
        });
        el.addEventListener('mousemove', (ev)=>{
          if (el.classList.contains('handle') && document.body.classList.contains('dragging')) return;
          const t = el.getAttribute('data-tip'); if (!t) return;
          showTip(ev.clientX, ev.clientY, t);
        });
        el.addEventListener('mouseleave', ()=>{ hideTip(); });
        el.addEventListener('mousedown', ()=>{ hideTip(el.classList.contains('handle')); });
      });
  }
  function bindDividerHandlers(root){
    root.querySelectorAll('.audio-lane .content .divider-grab').forEach(divider => {
      const content = divider.parentElement; const line = content.querySelector('.divider');
      const formatDb = (v)=> (v>=0?'+':'') + v.toFixed(1) + ' dB';
      const mapPctToDb = (pct)=> ((50 - pct) / 50) * 24;
      if(!line.style.top) line.style.top = '50%'; if(!divider.style.top) divider.style.top = 'calc(50% - 6px)';
      let dragging = false;
      const updateFromEvent = (ev)=>{
        const rect = content.getBoundingClientRect(); let y = Math.min(Math.max(ev.clientY - rect.top, 1), rect.height - 1);
        const pct = (y / rect.height) * 100; line.style.top = pct + '%';
        let gy = Math.min(Math.max(y - 6, 0), rect.height - 12); divider.style.top = gy + 'px';
        const db = mapPctToDb(pct);
        // Keep data-tip updated for hover, and show live while dragging
        try { divider.setAttribute('data-tip', formatDb(db)); } catch {}
        try { showTip(ev.clientX, ev.clientY, formatDb(db)); } catch {}
        // Apply per-lane gain to audio and live-regenerate the waveform (no stretch)
        try {
          const row = divider.closest('.track-row');
          const rows = Array.from(document.querySelectorAll('#audioLanesContainer .track-row'));
          const idx = rows.indexOf(row);
          if (!Array.isArray(state.audioGainsDb)) state.audioGainsDb = [];
          const prevDb = state.audioGainsDb[idx] ?? 0;
          state.audioGainsDb[idx] = db;
          // Apply per-lane gain respecting Mute/Solo state
          try {
            const tracksEl = document.querySelector('.tracks');
            applyMuteSolo(rows, tracksEl);
          } catch {}
          // Debounced waveform regenerate only when the volume slider moves
          if (Math.abs(prevDb - db) >= 0.01) scheduleWaveformRegenerate(idx, 40, { mode: 'throttle' });
        } catch {}
      };
      const onMove=(ev)=>{ if(dragging) updateFromEvent(ev); };
      const onUp=()=>{ dragging=false; document.body.classList.remove('dragging'); hideTip();
        try {
          const row = divider.closest('.track-row');
          const rows = Array.from(document.querySelectorAll('#audioLanesContainer .track-row'));
          const idx = rows.indexOf(row);
          scheduleWaveformRegenerate(idx, 80, { mode: 'debounce' });
        } catch {}
        window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
      };
      const onDown = (e)=>{ if(e.button!==0) return; e.preventDefault(); dragging = true; document.body.classList.add('dragging');
        updateFromEvent(e);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      };
      divider.addEventListener('mousedown', onDown);
      divider.addEventListener('mouseenter', (ev)=>{ if(dragging) return; const pct = parseFloat(line.style.top)||50; const db = mapPctToDb(pct); try { divider.setAttribute('data-tip', formatDb(db)); } catch {} });
      divider.addEventListener('mouseleave', ()=>{ if(!dragging) hideTip(); });
      // Ensure the generic data-tip listeners are bound for this newly created element
      try { if (setupTooltips.bindDataTip) setupTooltips.bindDataTip(divider.parentElement || divider); } catch {}
    });
  }
  bindDividerHandlers(document);
  bindDataTip(document);
  // expose so we can bind for dynamically inserted lanes
setupTooltips.bindDividerHandlers = bindDividerHandlers;
setupTooltips.bindDataTip = bindDataTip;
}

function bindMuteSoloHandlers(root){
  const rows = Array.from(root.querySelectorAll('.track-row'));
  const tracksEl = document.querySelector('.tracks');
  const apply = ()=> applyMuteSolo(rows, tracksEl);
  rows.forEach((row, idx) => {
    const muteBtn = row.querySelector('.track-head .tog.mute');
    const soloBtn = row.querySelector('.track-head .tog.solo');
    if (muteBtn && !muteBtn.__mlBound){
      muteBtn.__mlBound = true;
      muteBtn.addEventListener('click', (e)=>{
        e.preventDefault(); e.stopPropagation();
        state.audioMute[idx] = !state.audioMute[idx];
        muteBtn.classList.toggle('on', state.audioMute[idx]);
        muteBtn.classList.toggle('off', !state.audioMute[idx]);
        apply();
      });
    }
    if (soloBtn && !soloBtn.__mlBound){
      soloBtn.__mlBound = true;
      soloBtn.addEventListener('click', (e)=>{
        e.preventDefault(); e.stopPropagation();
        state.audioSolo[idx] = !state.audioSolo[idx];
        soloBtn.classList.toggle('on', state.audioSolo[idx]);
        soloBtn.classList.toggle('off', !state.audioSolo[idx]);
        apply();
      });
    }
  });
  apply();
}

function applyMuteSolo(rows, tracksEl){
  const anySolo = (state.audioSolo||[]).some(Boolean);
  try { if (tracksEl) tracksEl.classList.toggle('has-solo', anySolo); } catch {}
  const ctxTime = state.mediaCtx?.currentTime || 0;
  rows.forEach((row, idx) => {
    const lane = row.querySelector('.audio-lane');
    const isSolo = !!state.audioSolo[idx];
    const isMuted = !!state.audioMute[idx];
    const forcedMute = anySolo ? !isSolo : false;
    const effMute = isMuted || forcedMute;
    if (lane){
      lane.classList.toggle('is-solo', isSolo);
      lane.classList.toggle('is-muted', effMute);
    }
    const db = (state.audioGainsDb||[])[idx] || 0;
    const baseLin = Math.max(0, Math.pow(10, db/20));
    const effLin = effMute ? 0 : baseLin;
    try { state.splitGains?.[idx]?.gain?.setTargetAtTime(effLin, ctxTime, 0.01); } catch {}
  });
}

function scheduleWaveformRegenerate(laneIdx, delayMs = 150) {
  try {
    if (!window.trimlab?.generateWaveform) return;
    const loadToken = state.loadToken;
    const filePath = state.filePath; if (!filePath) return;
    const trackPath = Array.isArray(state.audioTrackPaths) ? state.audioTrackPaths[laneIdx] : null;
    const inputPath = trackPath || filePath;
    const streamIndex = trackPath ? 0 : laneIdx;
    const container = document.getElementById('audioLanesContainer');
    const row = container?.children?.[laneIdx]; if (!row) return;
    if (!Array.isArray(state.waveTokens)) state.waveTokens = [];
    if (!Array.isArray(state.waveTimers)) state.waveTimers = [];
    if (!Array.isArray(state.waveLastAt)) state.waveLastAt = [];
    if (!Array.isArray(state.wavePending)) state.wavePending = [];
    if (!Array.isArray(state._waveBusy)) state._waveBusy = [];
    const token = (state.waveTokens[laneIdx] = (state.waveTokens[laneIdx]||0) + 1);
    const db = Array.isArray(state.audioGainsDb) ? (state.audioGainsDb[laneIdx]||0) : 0;
    let width = 1200, height = 180;
    try {
      const contentEl = row.querySelector('.audio-lane .content') || row.querySelector('.audio-lane');
      if (contentEl) {
        const r = contentEl.getBoundingClientRect();
        width = Math.max(200, Math.round(r.width));
        height = Math.max(80, Math.round(r.height));
        if (height % 2) height += 1; // even height for clean half-split
      }
    } catch {}
    const mode = arguments.length > 2 ? arguments[2] : null;
    const modeName = (typeof mode === 'string') ? mode : (mode?.mode || 'debounce');
    const run = async () => {
      if (state._waveBusy[laneIdx]) {
        state.wavePending[laneIdx] = true;
        return;
      }
      state._waveBusy[laneIdx] = true;
      try {
        if (!isActiveLoad(loadToken)) return;
        const { outPath } = await window.trimlab.generateWaveform({ inputPath, streamIndex, width, height, gainDb: db });
        if (!isActiveLoad(loadToken)) return;
        if (token !== state.waveTokens[laneIdx]) return; // stale response
        const url = `file:///${outPath.replace(/\\/g,'/')}?v=${Date.now()}`;
        const top = row.querySelector('.wave-img.top');
        const bottom = row.querySelector('.wave-img.bottom');
        if (top) top.style.backgroundImage = `url('${url}')`;
        if (bottom) bottom.style.backgroundImage = `url('${url}')`;
      } catch {} finally {
        state._waveBusy[laneIdx] = false;
        if (state.wavePending[laneIdx]) {
          state.wavePending[laneIdx] = false;
          setTimeout(() => scheduleWaveformRegenerate(laneIdx, delay, { mode: modeName }), 0);
        }
      }
    };
    const delay = Math.max(50, Number(delayMs) || 150);
    if (modeName === 'throttle') {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const lastAt = state.waveLastAt[laneIdx] || 0;
      const elapsed = now - lastAt;
      if (elapsed >= delay && !state._waveBusy[laneIdx]) {
        state.waveLastAt[laneIdx] = now;
        run();
        return;
      }
      if (!state.waveTimers[laneIdx]) {
        const wait = Math.max(0, delay - elapsed);
        state.waveTimers[laneIdx] = setTimeout(() => {
          state.waveTimers[laneIdx] = 0;
          state.waveLastAt[laneIdx] = (typeof performance !== 'undefined' ? performance.now() : Date.now());
          run();
        }, wait);
      }
      return;
    }
    // Debounce: cancel prior timer before scheduling
    if (state.waveTimers[laneIdx]) { try { clearTimeout(state.waveTimers[laneIdx]); } catch {} }
    state.waveTimers[laneIdx] = setTimeout(() => {
      state.waveTimers[laneIdx] = 0;
      state.waveLastAt[laneIdx] = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      run();
    }, delay);
  } catch {}
}

function init() {
  attachMasterRangeDrag();
  setupOpenHandlers();
  setupExport();
  setupTransport();
  setupTooltips();
}

init();

