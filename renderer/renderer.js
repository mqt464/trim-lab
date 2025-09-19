import { IPC, ExportMode } from '../common/ipc.js';
import { MP4Demuxer } from './engine/demux.js';
import { VideoEngine } from './engine/player.js';
import { AudioEngine } from './engine/audio.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  filePath: null,
  meta: null,
  inPct: 0,
  outPct: 100,
  durationSec: 30,
  mode: ExportMode.Precise,
  demuxer: null,
  videoEngine: null,
  audioEngines: [],
  audioTrackIds: [],
  mediaCtx: null,
  mediaSrc: null,
  mediaGain: null,
  // live-seek helpers
  _seekDemuxTimer: 0,
  seekLiveDebounceMs: 120,
  audioMute: [],
  audioSolo: []
};

function fmtClockSec(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const parts = [h, m, s].map((v, i) => i === 0 ? String(v) : String(v).padStart(2, '0'));
  return (h > 0 ? parts.join(':') : parts.slice(1).join(':'));
}

async function analyze(filePath) {
  const info = await window.trimlab.analyze(filePath);
  state.meta = info;
  const dur = parseFloat(info?.format?.duration || '0') || 0;
  state.durationSec = dur || 30;
  updateFooter();
  updateTimelineDurationLabels();
  renderRulerLabels();
  await renderAudioLanesFromMeta(info, filePath);
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
  state.resumeSec = t;
  const tl = document.getElementById('transportTime');
  if (tl) { const d = new Date(Math.max(0, t) * 1000).toISOString().substr(11, 8); tl.textContent = d; }
  // If currently playing, seek immediately in audio and refresh demux/video from new time
  if (state.audioEngine?.playing && state.demuxer) {
    try { state.audioEngine.seek(t); } catch {}
    // For live scrubs, debounce heavy demux restarts while the pointer is moving
    const restartDemux = () => {
      try { state.demuxer.stopExtract(); } catch {}
      const v = state.videoEngine?.track;
      const a = state.audioEngine?.track;
      if (v) state.demuxer.extractTrack(v.id, { continuous: true, rapAlignment: true, startTimeSec: t });
      // Only (re)extract audio samples if not using fallback element
      if (a && !state.audioEngine?._fallbackActive) state.demuxer.extractTrack(a.id, { continuous: true, startTimeSec: t });
      try { state.videoEngine?.start?.(t, outSec, { reblit: false }); } catch {}
    };
    if (live) {
      if (state._seekDemuxTimer) { try { clearTimeout(state._seekDemuxTimer); } catch {} }
      state._seekDemuxTimer = setTimeout(() => { state._seekDemuxTimer = 0; restartDemux(); }, state.seekLiveDebounceMs);
    } else {
      restartDemux();
    }
  } else if (live && state.demuxer) {
    // When paused, allow live scrubbing to update the displayed frame via demux+video only
    try { state.demuxer.stopExtract(); } catch {}
    const v = state.videoEngine?.track;
    if (v) state.demuxer.extractTrack(v.id, { nbSamples: 60, rapAlignment: true, startTimeSec: t });
    try { state.videoEngine?.start?.(t, outSec, { reblit: false }); } catch {}
  }
}

// Force-stop all playback paths (audio, video, demux, RAF) and set UI to Play
function hardPauseTransport() {
  try { state.demuxer?.stopExtract?.(); } catch {}
  try { state.audioEngine?.stop?.(); } catch {}
  try { state.videoEngine?.stop?.(); } catch {}
  try { cancelAnimationFrame(window.__trimlabRAF || 0); } catch {}
  const btn = document.getElementById('btnPlay');
  if (btn) btn.textContent = 'Play';
}

// Resume playback from an absolute time (clamped to in/out)
async function resumeTransportFrom(sec) {
  if (!state.filePath || !state.demuxer) return;
  const dur = Math.max(0, Number(state.durationSec) || 0);
  const inSec = dur * state.inPct / 100;
  const outSec = dur * state.outPct / 100;
  const t = Math.min(outSec, Math.max(inSec, Number(sec)||0));
  state.resumeSec = t;
  try {
    // First restart demux extraction so video frames are ready immediately
    try { state.demuxer.stopExtract(); } catch {}
    const v = state.videoEngine?.track;
    const a = state.audioEngine?.track;
    if (v) state.demuxer.extractTrack(v.id, { continuous: true, rapAlignment: true, startTimeSec: t });
    if (a) state.demuxer.extractTrack(a.id, { continuous: true, startTimeSec: t });
    // Then start audio + video at the exact time
    await state.audioEngine.start(t, outSec, state.filePath);
    if (state.videoEngine) { state.videoEngine._fallbackFile = 'file:///' + state.filePath.replace(/\\/g,'/'); }
    try { state.videoEngine?._hideOverlay?.(); } catch {}
    state.videoEngine?.start?.(t, outSec);
    const btn = document.getElementById('btnPlay');
    if (btn) btn.textContent = 'Pause';
    // restart RAF
    try { cancelAnimationFrame(window.__trimlabRAF || 0); } catch {}
    const loop = () => {
      const playhead = document.querySelector('.r-span .playhead');
      const tlabel = document.getElementById('transportTime');
      const tnow = state.audioEngine?.getCurrentTimeSec?.() ?? 0;
      const dur2 = Math.max(0.001, state.durationSec || 0.001);
      const pct = Math.min(100, Math.max(0, (tnow / dur2) * 100));
      if (playhead) playhead.style.left = pct + '%';
      if (tlabel) tlabel.textContent = new Date(tnow*1000).toISOString().substr(11, 8);
      state.videoEngine?.presentAt?.(tnow);
      window.__trimlabRAF = requestAnimationFrame(loop);
    };
    window.__trimlabRAF = requestAnimationFrame(loop);
  } catch (e) {
    console.error('resumeTransportFrom failed', e);
  }
}

function attachMasterRangeDrag() {
  const span = document.querySelector('.r-span');
  if (!span) return;
  const range = span.querySelector('.master-range');
  const fill  = range?.querySelector('.range-fill');
  const inH   = range?.querySelector('.handle.in');
  const outH  = range?.querySelector('.handle.out');
  const tracksEl = document.querySelector('.tracks');
  const dimLeft = tracksEl?.querySelector('.master-dim .dim.left');
  const dimRight = tracksEl?.querySelector('.master-dim .dim.right');
  function updateMasterDimSize(){
    try {
      const md = tracksEl?.querySelector('.master-dim');
      if (md && tracksEl) md.style.height = tracksEl.scrollHeight + 'px';
    } catch {}
  }

  function apply() {
    if (!fill || !inH || !outH) return;
    // Position fill within the ruler span (lane only)
    fill.style.left  = state.inPct + '%';
    fill.style.right = (100 - state.outPct) + '%';
    inH.style.left   = `calc(${state.inPct}% - 1px)`; inH.style.right  = '';
    outH.style.right = `calc(${100 - state.outPct}% - 1px)`; outH.style.left = '';
      if (dimLeft && dimRight && tracksEl) {
        // Align overlay to start at the lane (after trackhead), and map dim widths to overlay rect
        const md = tracksEl.querySelector('.master-dim');
        const headEl = tracksEl.querySelector('.track-row .track-head') || tracksEl.querySelector('.track-head');
        let headW = 0;
        try { headW = headEl ? Math.round(headEl.getBoundingClientRect().width) : 0; } catch {}
        if (md) { md.style.left = headW + 'px'; md.style.right = '0'; }
        const sr = span.getBoundingClientRect();
        const ov = md ? md.getBoundingClientRect() : tracksEl.getBoundingClientRect();
        const inX = sr.left + (state.inPct/100) * sr.width;
        const outX = sr.left + (state.outPct/100) * sr.width;
        const leftPx = Math.max(0, Math.round(inX - ov.left));
        const rightPx = Math.max(0, Math.round(ov.right - outX));
        dimLeft.style.width = leftPx + 'px';
        dimRight.style.width = rightPx + 'px';
      }
    updateMasterDimSize();
    state.mode = (state.inPct <= 0.01 && state.outPct >= 99.99) ? ExportMode.Copy : ExportMode.Precise;
    updateFooter();
    // Debounced: regenerate per-lane waveforms to reflect selected range
    try { scheduleWaveformUpdateForSelection(180); } catch {}
  }
  apply();
  // Expose updater so other flows (e.g., on load) can sync UI
  try { state.updateMasterRange = apply; } catch {}
  window.addEventListener('resize', () => { apply(); updateMasterDimSize(); try { scheduleAdaptiveVideoThumbnails(state.filePath); } catch {} });
  if ('ResizeObserver' in window && tracksEl) {
    const ro = new ResizeObserver(() => { updateMasterDimSize(); try { scheduleAdaptiveVideoThumbnails(state.filePath); } catch {} });
    ro.observe(tracksEl);
  }

  function pctFromEvent(e){
    const r = span.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - r.left, 0), r.width);
    return (x / r.width) * 100;
  }
  function startDrag(which, e){
    e.preventDefault();
    document.body.classList.add('dragging');
    const move = (ev)=>{
      const p = pctFromEvent(ev);
      if(which === 'in'){
        state.inPct = Math.min(Math.max(0, p), state.outPct - 0.1);
      }else{
        state.outPct = Math.max(Math.min(100, p), state.inPct + 0.1);
      }
      apply();
    };
    const up = async ()=>{
      document.body.classList.remove('dragging');
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
    const sr = span.getBoundingClientRect();
    const tr = tracksEl2?.getBoundingClientRect();
    const pct = pctFromEvent(ev);
    if (playheadEl) playheadEl.style.left = pct + '%';
    if (tr){
      const xAbs = sr.left + (pct/100) * sr.width;
      const xOff = Math.max(0, Math.round(xAbs - tr.left));
      const line = ensureScrubLine();
      if (line){ line.style.left = xOff + 'px'; line.style.display='block'; }
    }
    // Thumbnail preview if we have a sprite
    if (scrubPreview && state.thumbUrl){
      const cols = state.thumbCols || 10;
      scrubPreview.style.display = 'block';
      scrubPreview.style.backgroundImage = `url('${state.thumbUrl}')`;
      scrubPreview.style.backgroundSize = `${cols*100}% 100%`;
      const idx = Math.min(cols-1, Math.max(0, Math.floor((pct/100)*cols)));
      const posX = (idx/(cols-1))*100;
      scrubPreview.style.backgroundPosition = `${posX}% 0%`;
      const x = ev.clientX + 12;
      const y = Math.max(6, ev.clientY - 110);
      scrubPreview.style.left = x + 'px';
      scrubPreview.style.top = y + 'px';
    }
    // Update footer time display and set resumeSec so Play starts here
    const t = (state.durationSec||0) * pct/100;
    state.resumeSec = t;
    const tl = document.getElementById('transportTime');
    if (tl){ const d = new Date(Math.max(0,t)*1000).toISOString().substr(11,8); tl.textContent = d; }
    // Update trick-play target to keep preview snappy without flooding decoder
    try { state.videoEngine?.updateTrickTarget?.(state.resumeSec); } catch {}
  }
  span.addEventListener('mousedown', (e)=>{
    if (e.target.closest('.handle')) return; // handled by handle drag
    scrubActive = true;
    document.body.classList.add('dragging');
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
    const move = (ev)=>{ if (scrubActive) updateScrubUI(ev); };
    const up = async ()=>{
      scrubActive = false;
      document.body.classList.remove('dragging');
      if (scrubLine) scrubLine.style.display='none';
      if (scrubPreview) scrubPreview.style.display='none';
      // Commit and resume based on prior state: resume only if it was playing
      try { state.videoEngine?.endTrickPlay?.({ resume: false }); } catch {}
      // Ensure we land exactly at the final scrubbed frame before resuming
      if (typeof state.resumeSec === 'number') {
        try { state.videoEngine?.scrubTo?.(state.resumeSec); } catch {}
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
  state.filePath = filePath;
  // Reset thumbnail state so new clip regenerates a fresh strip
  try { state.thumbUrl = null; state.thumbCols = 0; state.thumbForPath = filePath; state._thumbGenToken = (state._thumbGenToken||0) + 1; } catch {}
  const baseName = filePath.split(/[\\/]/).pop();
  const footerNameEl = $('#footerName');
  if (footerNameEl) footerNameEl.textContent = baseName;
  $('#dropHint').style.display = 'none';
  await analyze(filePath);
  // Master range: full clip on load
  state.inPct = 0; state.outPct = 100;
  if (typeof state.updateMasterRange === 'function') state.updateMasterRange();
  // Hide default ruler labels (0-30s etc.) and clear duration flag
  document.querySelectorAll('.ruler .labels:not(.labels-dyn)').forEach(el => { el.style.display = 'none'; });
  const tlEl = document.querySelector('.timeline');
  if (tlEl) tlEl.removeAttribute('data-duration');
  // Ensure video lane exists and is set to file name
  ensureVideoLane(baseName);
  // Generate thumbnail strip for video lane based on lane width (adaptive columns)
  try {
    await ensureAdaptiveVideoThumbnails(filePath);
  } catch (e) { console.warn('Thumbnail generation failed', e); }

  // Start demux & prepare engine (Option B foundation)
  state.demuxer?.dispose?.();
  state.videoEngine?.dispose?.();
  try { (state.audioEngines||[]).forEach(e=>e?.stop?.()); } catch {}
  state.audioEngines = [];
  state.audioTrackIds = [];
  const canvas = document.getElementById('videoCanvas');
  state.videoEngine = new VideoEngine(canvas);
  state.audioEngine = new AudioEngine();
  // set native video source for playback
  try { state.videoEngine.setSourceFile(filePath); } catch {}
  // Setup MediaElementAudioSource pipeline only if WebCodecs is not available
  try {
    const canWCAudio = ('AudioDecoder' in window);
    const v = state.videoEngine.getMediaElement();
    // We will use robust split-audio demux; always mute the element and mix lanes in WebAudio
    v.muted = true;
    if (!state.mediaCtx) {
      state.mediaCtx = new (window.AudioContext || window.webkitAudioContext)();
      state.mediaMaster = state.mediaCtx.createGain();
      state.mediaMaster.gain.value = 1;
      state.mediaMaster.connect(state.mediaCtx.destination);
    }
    // Prepare per-lane audio files via main process
    const { tracks } = await window.trimlab.prepareAudioTracks({ inputPath: filePath, sampleRate: 48000, channels: 2 }) || { tracks: [] };
    // Build per-lane elements and gain nodes
    state.splitEls = [];
    state.splitGains = [];
    for (let i=0;i<tracks.length;i++){
      const el = document.createElement('audio');
      el.preload = 'auto'; el.muted = false; el.volume = 1; el.src = 'file:///' + String(tracks[i]).replace(/\\/g,'/');
      const src = state.mediaCtx.createMediaElementSource(el);
      const g = state.mediaCtx.createGain(); g.gain.value = 1;
      src.connect(g); g.connect(state.mediaMaster);
      state.splitEls.push(el);
      state.splitGains.push(g);
    }
  } catch {}
  // Provide video fallback URL immediately for preview features
  if (state.videoEngine) { state.videoEngine._fallbackFile = 'file:///' + filePath.replace(/\\/g,'/'); }
  // Ensure transport end handler is connected when engine is created
  const btnEl = document.getElementById('btnPlay');
  const onEndedInit = () => {
    try { state.demuxer.stopExtract(); } catch {}
    state.audioEngine.stop();
    state.videoEngine?.stop?.();
    cancelAnimationFrame(window.__trimlabRAF || 0);
    if (btnEl) btnEl.textContent = 'Play';
  };
  state.audioEngine.onEnded = onEndedInit;
  let MP4BoxMod = null;
  try {
    MP4BoxMod = await import('../node_modules/mp4box/dist/mp4box.all.js');
  } catch (e) {
    console.error('Failed to load MP4Box module', e);
  }
  state.demuxer = new MP4Demuxer(filePath, MP4BoxMod);
  
  state.demuxer.onReady = (info) => {
    state.videoEngine?.onDemuxReady(info, state.demuxer);
    const vtrack = info.tracks.find(t => t.type === 'video') || info.tracks.find(t => t.video);
    // Always route only video to videoEngine; audio handled via split media elements
    state.demuxer.onSamples = (id, samples) => {
      if (vtrack && id === vtrack.id) state.videoEngine.onSamples(id, samples);
    };
  };
  state.demuxer.onError = (err) => {
    console.error('Demux error', err);
  };
  state.demuxer.start();
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

let __thumbSizeTimer = 0;
async function ensureAdaptiveVideoThumbnails(filePath) {
  if (!window.trimlab?.generateThumbnails) return;
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
  try { if (__thumbSizeTimer) { clearTimeout(__thumbSizeTimer); __thumbSizeTimer = 0; } } catch {}
  __thumbSizeTimer = setTimeout(() => { __thumbSizeTimer = 0; ensureAdaptiveVideoThumbnails(filePath); }, delay);
}

function audioLaneMarkup(idx, name){
  const id = `A${idx+1}`;
  return `
  <div class="track-row">
    <div class="track-head"><div class="id">${id}</div><div class="tog mute off" data-tip="Mute (M)">M</div><div class="tog solo off" data-tip="Solo (S)">S</div></div>
    <div class="track-lane">
      <div class="lane audio-lane">
        <div class="content">
          <div class="lr-badge l">L</div>
          <div class="lr-badge r">R</div>
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

async function renderAudioLanesFromMeta(info, filePath) {
  const container = document.getElementById('audioLanesContainer');
  if (!container) return;
  container.innerHTML = '';
  // reset lane gain + waveform trackers
  state.audioGainsDb = [];
  state.waveTokens = [];
  state.waveTimers = [];
  const streams = (info?.streams||[]).filter(s => s.codec_type === 'audio');
  if (!streams.length) return;
  streams.forEach((s, idx)=>{
    const title = s.tags?.title || s.tags?.language || '';
    container.insertAdjacentHTML('beforeend', audioLaneMarkup(idx, title));
    state.audioGainsDb[idx] = 0;
    state.waveTokens[idx] = 0;
    state.waveTimers[idx] = 0;
    state.audioMute[idx] = false;
    state.audioSolo[idx] = false;
  });
  // bind divider handlers for new lanes
  if (setupTooltips.bindDividerHandlers) setupTooltips.bindDividerHandlers(container);
  try { bindMuteSoloHandlers(container); } catch {}
  // Generate waveforms per stream
  for (let i=0;i<streams.length;i++){
    try{
      const { outPath } = await window.trimlab.generateWaveform({ inputPath: filePath, streamIndex: i, width: 1200, height: 180 });
      const row = container.children[i];
      const top = row?.querySelector('.wave-img.top');
      const bottom = row?.querySelector('.wave-img.bottom');
      const url = `file:///${outPath.replace(/\\/g,'/')}?v=${Date.now()}`;
      if (top) top.style.backgroundImage = `url('${url}')`;
      if (bottom) bottom.style.backgroundImage = `url('${url}')`;
      // rely on CSS for mirroring (no inline transform)
      row.querySelectorAll('.wave-img').forEach(el => el.style.removeProperty('transform'));
    }catch(e){ console.warn('Waveform generation failed for stream', i, e); }
  }
  // Ensure dim overlay matches the full scrollable height
  try {
    const tracksEl = document.querySelector('.tracks');
    const md = tracksEl?.querySelector('.master-dim');
    if (md && tracksEl) md.style.height = tracksEl.scrollHeight + 'px';
  } catch {}
}

// Debounced regeneration of per-lane waveforms for the currently selected master range
function scheduleWaveformUpdateForSelection(delay = 180) {
  try {
    const lanes = document.getElementById('audioLanesContainer');
    if (!lanes || !state.filePath) return;
    const count = lanes.children.length;
    if (!count || !window.trimlab?.generateWaveform) return;
    const dur = Math.max(0, Number(state.durationSec) || 0);
    const inSec = dur * (Math.max(0, Math.min(100, state.inPct)) / 100);
    const outSec = dur * (Math.max(0, Math.min(100, state.outPct)) / 100);
    for (let i = 0; i < count; i++) {
      try { if (state.waveTimers[i]) { clearTimeout(state.waveTimers[i]); state.waveTimers[i] = 0; } } catch {}
      const myToken = (state.waveTokens[i] = (state.waveTokens[i] || 0) + 1);
      state.waveTimers[i] = setTimeout(async () => {
        try {
          const row = lanes.children[i];
          const top = row?.querySelector('.wave-img.top');
          const bottom = row?.querySelector('.wave-img.bottom');
          if (!top || !bottom) return;
          // Use the actual lane content size for pixel-accurate waveform
          let width = 1200;
          let height = 180;
          try {
            const contentEl = row.querySelector('.audio-lane .content') || row.querySelector('.audio-lane');
            if (contentEl) {
              const r = contentEl.getBoundingClientRect();
              width = Math.max(200, Math.round(r.width));
              height = Math.max(80, Math.round(r.height));
              if (height % 2) height += 1; // even height for clean mirroring
            }
          } catch {}
          const { outPath } = await window.trimlab.generateWaveform({
            inputPath: state.filePath,
            streamIndex: i,
            width,
            height,
            startSec: inSec,
            endSec: outSec
          });
          // Ignore if another newer request was made for this lane
          if (state.waveTokens[i] !== myToken) return;
          const url = `file:///${String(outPath).replace(/\\/g, '/')}` + `?v=${Date.now()}`;
          top.style.backgroundImage = `url('${url}')`;
          bottom.style.backgroundImage = `url('${url}')`;
          // Ensure mirroring is applied (CSS should handle it, but be defensive)
          try { top.style.removeProperty('transform'); bottom.style.removeProperty('transform'); } catch {}
        } catch (e) {
          console.warn('Waveform update failed for lane', i, e);
        }
      }, delay);
    }
  } catch {}
}

function setupExport() {
  $('#btnExport')?.addEventListener('click', async () => {
    if (!state.filePath) return;
    const inSec = state.durationSec * state.inPct / 100;
    const outSec = state.durationSec * state.outPct / 100;
    try {
      if (!window.trimlab) throw new Error('preload bridge missing');
      const btn = document.getElementById('btnExport');
      if (btn) { btn.disabled = true; btn.textContent = 'Exporting…'; }
      // Show progress UI
      showExportProgress(0, 'ETA 00:00');
      // Bind progress updates
      if (!state._progressBound && window.trimlab.onExportProgress){
        window.trimlab.onExportProgress((msg)=>{
          if (msg?.error){ hideExportProgress(); return; }
          const pct = Math.max(0, Math.min(100, msg?.percent ?? 0));
          const eta = msg?.eta ? `ETA ${msg.eta}` : '';
          updateExportProgress(pct, eta);
          if (msg?.done){ setTimeout(()=> hideExportProgress(), 600); }
        });
        state._progressBound = true;
      }
      const res = await window.trimlab.export({
        inputPath: state.filePath,
        inSec,
        outSec,
        mode: state.mode,
        audioGainsDb: Array.isArray(state.audioGainsDb) ? state.audioGainsDb : [],
        audioMute: Array.isArray(state.audioMute) ? state.audioMute : [],
        audioSolo: Array.isArray(state.audioSolo) ? state.audioSolo : []
      });
      console.log('Exported', res);
      if (btn) { btn.disabled = false; btn.textContent = 'Export'; }
      // Optionally reveal path is handled in main; we keep UI subtle
    } catch (e) {
      console.error('Export failed', e);
      alert('Export failed: ' + e.message);
    } finally {
      const btn = document.getElementById('btnExport');
      if (btn) { btn.disabled = false; btn.textContent = 'Export'; }
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
        const btn = document.getElementById('btnExport');
        if (btn) { btn.disabled = false; btn.textContent = 'Export'; }
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
    const barRect = bar.getBoundingClientRect();
    const textRect = (textInner || text).getBoundingClientRect();
    const widthStr = (fill.style.width || '0%').trim();
    const pct = parseFloat(widthStr.endsWith('%') ? widthStr.slice(0, -1) : widthStr) || 0;
    const fillRight = barRect.left + (barRect.width * pct / 100);
    const overlapLeft = Math.max(barRect.left, textRect.left);
    const overlapRight = Math.min(fillRight, textRect.right);
    const overlaps = overlapRight > overlapLeft + 0.5;
    const styles = getComputedStyle(document.documentElement);
    const bgColor = styles.getPropertyValue('--bg').trim() || '#0b0e14';
    const fillColor = styles.getPropertyValue('--accent').trim() || '#7aa2ff';
    text.style.color = overlaps ? bgColor : fillColor;
  } catch {}
}

function setupTransport() {
  const btn = $('#btnPlay');
  const playhead = document.querySelector('.r-span .playhead');
  const tlabel = $('#transportTime');
  let raf = 0;
  const tick = () => {
    const t = state.videoEngine?.getCurrentTimeSec?.() ?? state.audioEngine?.getCurrentTimeSec?.() ?? 0;
    // Update playhead position (relative to duration)
    const dur = Math.max(0.001, state.durationSec || 0.001);
    const pct = Math.min(100, Math.max(0, (t / dur) * 100));
    if (playhead) playhead.style.left = pct + '%';
    if (tlabel) tlabel.textContent = new Date(t*1000).toISOString().substr(11, 8);
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
      const t0 = state.videoEngine?.getCurrentTimeSec?.();
      const tA = (state.audioEngines||[]).map(e=>e?.getCurrentTimeSec?.()||0).reduce((a,b)=>Math.max(a,b), 0);
      state.resumeSec = (t0 || tA || state.resumeSec);
    } catch {}
    try { state.demuxer.stopExtract(); } catch {}
    try { state.audioEngine.stop(); } catch {}
    try { (state.audioEngines||[]).forEach(e=> e?.stop?.()); } catch {}
    state.videoEngine?.stop?.();
    cancelAnimationFrame(raf);
    btn.textContent = 'Play';
  };
  // Attach to audio engine lifecycle if exists later
  if (state.audioEngine) state.audioEngine.onEnded = onEnded;
  if (state.videoEngine) state.videoEngine.onEnded = onEnded;

  btn?.addEventListener('click', async () => {
    if (!state.filePath || !state.demuxer) return;
    const inSec = state.durationSec * state.inPct / 100;
    const outSec = state.durationSec * state.outPct / 100;
    if (!state.videoEngine?.isPlaying?.()) {
      try {
        const startSec = (typeof state.resumeSec === 'number' && state.resumeSec >= inSec) ? state.resumeSec : inSec;
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
}

function setupTooltips() {
  const tip = document.getElementById('__float_tip');
  function showTip(x,y,text){
    tip.textContent = text; tip.style.display = 'block';
    requestAnimationFrame(()=>{
      const r = tip.getBoundingClientRect();
      let left = x - r.width/2; left = Math.max(6, Math.min(window.innerWidth - r.width - 6, left));
      let top  = y - r.height - 12; if(top < 6) top = y + 16;
      tip.style.left = left + 'px';
      tip.style.top  = top  + 'px';
    });
  }
  function hideTip(){ tip.style.display = 'none'; }
  // Generic data-tip binder (for ruler handles, buttons, etc.)
  function bindDataTip(root){
    root.querySelectorAll('[data-tip]')
      .forEach(el => {
        // Avoid rebinding repeatedly
        if (el.__tlTipBound) return; el.__tlTipBound = true;
        el.addEventListener('mouseenter', (ev)=>{
          const t = el.getAttribute('data-tip'); if (!t) return;
          showTip(ev.clientX, ev.clientY, t);
        });
        el.addEventListener('mousemove', (ev)=>{
          const t = el.getAttribute('data-tip'); if (!t) return;
          showTip(ev.clientX, ev.clientY, t);
        });
        el.addEventListener('mouseleave', ()=>{ hideTip(); });
        el.addEventListener('mousedown', ()=>{ hideTip(); });
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
          const scale = Math.max(0.05, Math.pow(10, db/20));
          if (!Array.isArray(state.audioGainsDb)) state.audioGainsDb = [];
          state.audioGainsDb[idx] = db;
          // Apply per-lane gain respecting Mute/Solo state
          try {
            const tracksEl = document.querySelector('.tracks');
            applyMuteSolo(rows, tracksEl);
          } catch {}
        } catch {}
      };
      const startLaneWaveLoop = (idx, period=30)=>{
        try {
          if (!state._waveLoops) state._waveLoops = [];
          if (state._waveLoops[idx]) return;
          state._waveLoops[idx] = setInterval(() => {
            try { generateLaneWaveOnce(idx); } catch {}
          }, Math.max(60, period));
        } catch {}
      };
      const stopLaneWaveLoop = (idx)=>{
        try { if (state._waveLoops?.[idx]) { clearInterval(state._waveLoops[idx]); state._waveLoops[idx] = 0; } } catch {}
      };
      const onMove=(ev)=>{ if(dragging) updateFromEvent(ev); };
      const onUp=()=>{ dragging=false; document.body.classList.remove('dragging'); hideTip();
        try {
          const row = divider.closest('.track-row');
          const rows = Array.from(document.querySelectorAll('#audioLanesContainer .track-row'));
          const idx = rows.indexOf(row);
          // Stop the loop and do a final regeneration pass at the settled value
          stopLaneWaveLoop(idx);
          scheduleWaveformRegenerate(idx, 120);
        } catch {}
        window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
      };
      const onDown = (e)=>{ if(e.button!==0) return; e.preventDefault(); dragging = true; document.body.classList.add('dragging');
        // Determine lane index once for this drag and start a throttled regen loop
        try {
          const row = divider.closest('.track-row');
          const rows = Array.from(document.querySelectorAll('#audioLanesContainer .track-row'));
          const idx = rows.indexOf(row);
          startLaneWaveLoop(idx, 35);
        } catch {}
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
    const filePath = state.filePath; if (!filePath) return;
    const container = document.getElementById('audioLanesContainer');
    const row = container?.children?.[laneIdx]; if (!row) return;
    if (!Array.isArray(state.waveTokens)) state.waveTokens = [];
    if (!Array.isArray(state.waveTimers)) state.waveTimers = [];
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
    // Debounce: cancel prior timer before scheduling
    if (state.waveTimers[laneIdx]) { try { clearTimeout(state.waveTimers[laneIdx]); } catch {} }
    state.waveTimers[laneIdx] = setTimeout(async () => {
      state.waveTimers[laneIdx] = 0;
      try {
        const { outPath } = await window.trimlab.generateWaveform({ inputPath: filePath, streamIndex: laneIdx, width, height, gainDb: db });
        if (token !== state.waveTokens[laneIdx]) return; // stale response
        const url = `file:///${outPath.replace(/\\/g,'/')}?v=${Date.now()}`;
        const top = row.querySelector('.wave-img.top');
        const bottom = row.querySelector('.wave-img.bottom');
        if (top) top.style.backgroundImage = `url('${url}')`;
        if (bottom) bottom.style.backgroundImage = `url('${url}')`;
      } catch {}
    }, Math.max(50, Number(delayMs)||150));
  } catch {}
}

// Throttled single-shot generator used by the drag-time loop
async function generateLaneWaveOnce(laneIdx) {
  try {
    if (!window.trimlab?.generateWaveform) return;
    const filePath = state.filePath; if (!filePath) return;
    const container = document.getElementById('audioLanesContainer');
    const row = container?.children?.[laneIdx]; if (!row) return;
    if (!state._waveBusy) state._waveBusy = [];
    if (state._waveBusy[laneIdx]) return; // skip if a run is in flight
    state._waveBusy[laneIdx] = true;
    const db = Array.isArray(state.audioGainsDb) ? (state.audioGainsDb[laneIdx]||0) : 0;
    let width = 1200, height = 180;
    try {
      const contentEl = row.querySelector('.audio-lane .content') || row.querySelector('.audio-lane');
      if (contentEl) { const r = contentEl.getBoundingClientRect(); width = Math.max(200, Math.round(r.width)); height = Math.max(80, Math.round(r.height)); if (height % 2) height += 1; }
    } catch {}
    const { outPath } = await window.trimlab.generateWaveform({ inputPath: filePath, streamIndex: laneIdx, width, height, gainDb: db });
    const url = `file:///${outPath.replace(/\\/g,'/')}?v=${Date.now()}`;
    const top = row.querySelector('.wave-img.top');
    const bottom = row.querySelector('.wave-img.bottom');
    if (top) top.style.backgroundImage = `url('${url}')`;
    if (bottom) bottom.style.backgroundImage = `url('${url}')`;
    state._waveBusy[laneIdx] = false;
  } catch { try { state._waveBusy[laneIdx] = false; } catch {} }
}

function init() {
  attachMasterRangeDrag();
  setupOpenHandlers();
  setupExport();
  setupTransport();
  setupTooltips();
}

init();

