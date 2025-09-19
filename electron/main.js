const { app, BrowserWindow, dialog, ipcMain, shell, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs/promises');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

function binPathFromStatic(mod, fallbackName){
  try {
    let p = (typeof mod === 'string') ? mod : (mod?.path || fallbackName);
    if (typeof p === 'string' && p.includes('app.asar')) {
      // When packaged, binaries must be executed from the unpacked directory
      p = p.replace('app.asar', 'app.asar.unpacked');
    }
    return p || fallbackName;
  } catch {
    return fallbackName;
  }
}

const IPC = {
  openFileDialog: 'open-file-dialog',
  fileOpenedFromOS: 'file-opened-from-os',
  analyze: 'analyze-file',
  export: 'export-clip',
  exportProgress: 'export-progress',
  exportCancel: 'export-cancel',
  revealItem: 'reveal-item',
  readFileChunks: 'read-file-chunks',
  fileChunk: 'file-chunk',
  fileChunkEnd: 'file-chunk-end',
  cancelReadFile: 'cancel-read-file'
};
const ExportMode = { Precise: 'precise', Copy: 'copy' };
const GEN_WAVEFORM = 'generate-waveform';
const GEN_THUMBS = 'generate-thumbnails';
const PREP_AUDIO = 'prepare-audio-tracks';

let mainWindow;
const isDev = !app.isPackaged;
const readStreams = new Map(); // key: filePath, value: ReadStream
const pendingOpenFiles = []; // macOS open-file queue before window ready

function createWindow() {
  // Build an in-memory blue square icon to replace Electron's default logo (Windows/Linux)
  const makeBlueIcon = (size=256) => {
    try {
      const w = size, h = size; const stride = w*4;
      const buf = Buffer.alloc(w*h*4);
      const B = 0xFF, G = 0xA2, R = 0x7A, A = 0xFF; // #7aa2ff in BGRA
      for (let y=0; y<h; y++) {
        for (let x=0; x<w; x++) {
          const o = y*stride + x*4;
          buf[o+0] = B; buf[o+1] = G; buf[o+2] = R; buf[o+3] = A;
        }
      }
      // Overlay keyframe-style white lines: two evenly spaced verticals (no diagonals)
      const drawWhite = (x, y) => {
        const o = y*stride + x*4; buf[o+0]=0xFF; buf[o+1]=0xFF; buf[o+2]=0xFF; buf[o+3]=0xFF;
      };
      const tVert = Math.max(2, Math.floor(w * 0.035));
      const x1 = Math.floor(w * 1/3);
      const x2 = Math.floor(w * 2/3);
      for (let y=0; y<h; y++) {
        for (let x=0; x<w; x++) {
          if (Math.abs(x - x1) < tVert) drawWhite(x, y);
          if (Math.abs(x - x2) < tVert) drawWhite(x, y);
        }
      }
      return nativeImage.createFromBitmap(buf, { width: w, height: h });
    } catch { return null; }
  };
  const appIcon = (process.platform !== 'darwin') ? makeBlueIcon(256) : undefined;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#0b0e14',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(app.getAppPath(), 'electron', 'preload.js')
    },
    title: 'TrimLab',
    // Hide menubar unless Alt is pressed (Windows/Linux). We also fully remove below.
    autoHideMenuBar: true,
    icon: appIcon || undefined
  });

  const indexPath = path.join(app.getAppPath(), 'renderer', 'index.html');
  mainWindow.loadFile(indexPath);

  // Enable DevTools toggles from the window even without a menu
  // Ctrl+Shift+I (or Cmd+Opt+I on macOS) and F12
  try {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = String(input.key || '').toLowerCase();
      const openOrToggle = () => {
        try {
          if (mainWindow.webContents.isDevToolsOpened()) {
            mainWindow.webContents.closeDevTools();
          } else {
            mainWindow.webContents.openDevTools({ mode: 'detach' });
          }
        } catch {}
      };
      // Windows/Linux: Ctrl+Shift+I, macOS: Cmd+Opt+I
      const comboI = ((input.control || input.meta) && input.shift && (key === 'i'))
                   || (process.platform === 'darwin' && input.meta && input.alt && (key === 'i'));
      if (comboI || key === 'f12') {
        event.preventDefault();
        openOrToggle();
      }
    });
  } catch {}

  // Remove the application menu entirely on Windows/Linux
  if (process.platform !== 'darwin') {
    try { Menu.setApplicationMenu(null); } catch {}
    try { mainWindow.removeMenu(); } catch {}
    try { mainWindow.setMenuBarVisibility(false); } catch {}
  }
}

// macOS: handle files opened via Finder (both when app is running and before ready)
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  try {
    if (mainWindow && mainWindow.webContents) {
      const send = () => mainWindow.webContents.send(IPC.fileOpenedFromOS, filePath);
      if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', send);
      else send();
    } else {
      pendingOpenFiles.push(filePath);
    }
  } catch {}
});

// Single instance in production; allow multiple in dev for hot restarts
if (!isDev) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', (_event, argv) => {
      const file = argv.find(a => /\.(mp4|mov|m4v)$/i.test(a));
      if (file && mainWindow) {
        mainWindow.webContents.send(IPC.fileOpenedFromOS, file);
      }
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });

    app.whenReady().then(() => {
      createWindow();
      const argvFile = process.argv.find(a => /\.(mp4|mov|m4v)$/i.test(a));
      if (argvFile) {
        mainWindow.webContents.once('did-finish-load', () => {
          mainWindow.webContents.send(IPC.fileOpenedFromOS, argvFile);
        });
      }
      // Flush any files queued by the macOS open-file event before window creation
      if (pendingOpenFiles.length) {
        const files = pendingOpenFiles.splice(0, pendingOpenFiles.length);
        mainWindow.webContents.once('did-finish-load', () => {
          for (const f of files) {
            try { mainWindow.webContents.send(IPC.fileOpenedFromOS, f); } catch {}
          }
        });
      }
    });
  }
} else {
  app.on('second-instance', (_event, argv) => {
    const file = argv.find(a => /\.(mp4|mov|m4v)$/i.test(a));
    if (file && mainWindow) {
      mainWindow.webContents.send(IPC.fileOpenedFromOS, file);
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    const argvFile = process.argv.find(a => /\.(mp4|mov|m4v)$/i.test(a));
    if (argvFile) {
      mainWindow.webContents.once('did-finish-load', () => {
        mainWindow.webContents.send(IPC.fileOpenedFromOS, argvFile);
      });
    }
    // Flush any files queued by the macOS open-file event before window creation
    if (pendingOpenFiles.length) {
      const files = pendingOpenFiles.splice(0, pendingOpenFiles.length);
      mainWindow.webContents.once('did-finish-load', () => {
        for (const f of files) {
          try { mainWindow.webContents.send(IPC.fileOpenedFromOS, f); } catch {}
        }
      });
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC: Open file dialog
ipcMain.handle(IPC.openFileDialog, async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Open Video',
    properties: ['openFile'],
    filters: [
      { name: 'Video', extensions: ['mp4', 'mov', 'm4v'] }
    ]
  });
  if (canceled || !filePaths?.length) return null;
  return filePaths[0];
});

// IPC: Analyze with ffprobe
ipcMain.handle(IPC.analyze, async (_event, inputPath) => {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', inputPath];
    const ffprobe = binPathFromStatic(ffprobeStatic, 'ffprobe');
    const proc = spawn(ffprobe, args, { windowsHide: true });
    let out = '';
    let err = '';
    proc.stdout.on('data', d => (out += d.toString()))
    proc.stderr.on('data', d => (err += d.toString()))
    proc.on('close', code => {
      if (code === 0) {
        try {
          resolve(JSON.parse(out));
        } catch (e) {
          reject(new Error('Failed to parse ffprobe JSON'));
        }
      } else {
        reject(new Error(err || `ffprobe exited ${code}`));
      }
    });
  });
});

// IPC: Read file in chunks and stream to renderer
ipcMain.on(IPC.readFileChunks, (event, { filePath, chunkSize = 1024 * 1024 }) => {
  try {
    const rs = fs.createReadStream(filePath, { highWaterMark: chunkSize });
    readStreams.set(filePath, rs);
    let offset = 0;
    rs.on('data', (chunk) => {
      const arrayBuf = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
      event.sender.send(IPC.fileChunk, { filePath, offset, buffer: arrayBuf, length: chunk.length });
      offset += chunk.length;
    });
    rs.on('end', () => {
      event.sender.send(IPC.fileChunkEnd, { filePath, size: offset });
      readStreams.delete(filePath);
    });
    rs.on('error', (err) => {
      event.sender.send(IPC.fileChunkEnd, { filePath, error: err.message });
      readStreams.delete(filePath);
    });
  } catch (e) {
    event.sender.send(IPC.fileChunkEnd, { filePath, error: String(e) });
  }
});

ipcMain.on(IPC.cancelReadFile, (_event, filePath) => {
  const rs = readStreams.get(filePath);
  if (rs) {
    rs.destroy();
    readStreams.delete(filePath);
  }
});

// Ensure output directory exists under Videos/trimlab
async function ensureOutDir() {
  // Electron maps 'videos' to the OS-specific user Videos/Movies folder
  const videosDir = app.getPath('videos');
  const outDir = path.join(videosDir, 'trimlab');
  await fsPromises.mkdir(outDir, { recursive: true });
  return outDir;
}

// Build export command (precise default)
function buildExportArgs({ inputPath, inSec, outSec, mode, outPath, audioMod }) {
  const duration = Math.max(0, (outSec ?? 0) - (inSec ?? 0));
  if (!duration) throw new Error('Invalid in/out range');
  // If there are audio modifications (mute/solo/gain), we cannot copy audio
  const hasAudioMods = !!(audioMod && audioMod.hasMods);
  if (mode === ExportMode.Copy && !hasAudioMods) {
    // Copy all streams (fast, keyframe-bound)
    return [
      '-ss', String(inSec),
      '-to', String(outSec),
      '-i', inputPath,
      '-map', '0',
      '-c', 'copy',
      '-movflags', '+faststart',
      outPath
    ];
  }
  // Precise: re-encode video, and if audioMods present, process audio with volume per track
  const baseArgs = [
    '-ss', String(inSec),
    '-to', String(outSec),
    '-i', inputPath
  ];

  if (!hasAudioMods) {
    baseArgs.push(
      '-map', '0',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-c:a', 'copy',
      '-c:s', 'copy',
      '-c:d', 'copy',
      '-movflags', '+faststart',
      '-avoid_negative_ts', 'make_zero',
      outPath
    );
    return baseArgs;
  }

  // Build filter_complex for audio per-track volume, dropping muted lanes entirely
  const { audioCount, gainsDb, mutes, solos } = audioMod;
  const anySolo = solos.some(Boolean);
  const filters = [];
  const volLabels = [];
  for (let i=0;i<audioCount;i++){
    const drop = mutes[i] || (anySolo && !solos[i]);
    if (drop) continue; // do not include this lane at all
    const volDb = (typeof gainsDb[i] === 'number') ? gainsDb[i] : 0;
    const inLbl = `[0:a:${i}]`;
    const outLbl = `[avol${i}]`;
    filters.push(`${inLbl}volume=${volDb.toFixed(2)}dB${outLbl}`);
    volLabels.push(outLbl);
  }
  let audioOutLabel = null;
  if (filters.length) {
    if (volLabels.length === 1) {
      audioOutLabel = volLabels[0];
      baseArgs.push('-filter_complex', filters.join(';'));
    } else {
      // Mix all included lanes down to a single stereo track
      const aout = '[aout]';
      const amix = `${volLabels.join('')}amix=inputs=${volLabels.length}:normalize=0${aout}`;
      baseArgs.push('-filter_complex', filters.concat(amix).join(';'));
      audioOutLabel = aout;
    }
  }
  // Map video, subs, data directly
  baseArgs.push('-map', '0:v?');
  baseArgs.push('-map', '0:s?');
  baseArgs.push('-map', '0:d?');
  // Map audio only if any lane remains; otherwise drop audio (-an)
  if (audioOutLabel) {
    baseArgs.push('-map', audioOutLabel);
  } else {
    baseArgs.push('-an');
  }
  // Re-encode video and audio
  baseArgs.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-avoid_negative_ts', 'make_zero',
    outPath
  );
  return baseArgs;
}

// IPC: Export
ipcMain.handle(IPC.export, async (_event, payload) => {
  const { inputPath, inSec, outSec, mode = ExportMode.Precise, reveal = true, audioGainsDb = [], audioMute = [], audioSolo = [] } = payload;
  const outDir = await ensureOutDir();
  const inTag = Math.floor((inSec ?? 0) * 1000);
  const outTag = Math.floor((outSec ?? 0) * 1000);
  const base = path.parse(inputPath).name;
  const outName = `${base}_${inTag}-${outTag}.mp4`;
  const uniqueOutPath = (dir, baseName) => {
    const ext = path.extname(baseName);
    const stem = path.basename(baseName, ext);
    let p = path.join(dir, baseName);
    let i = 1;
    while (fs.existsSync(p)) {
      p = path.join(dir, `${stem} (${i})${ext}`);
      i++;
    }
    return p;
  };
  const outPath = uniqueOutPath(outDir, outName);

  // Determine audio stream count
  let audioCount = 0;
  try {
    const argsProbe = ['-v', 'error', '-print_format', 'json', '-show_streams', inputPath];
    const ffprobe = binPathFromStatic(ffprobeStatic, 'ffprobe');
    const info = await new Promise((resolve, reject) => {
      const p = spawn(ffprobe, argsProbe, { windowsHide: true });
      let out=''; let err='';
      p.stdout.on('data', d=> out += d.toString());
      p.stderr.on('data', d=> err += d.toString());
      p.on('close', c => c===0 ? resolve(JSON.parse(out||'{}')) : reject(new Error(err||`ffprobe exited ${c}`)));
    });
    audioCount = (info?.streams||[]).filter(s=> s.codec_type==='audio').length;
  } catch {}

  const hasMods = (audioCount>0) && (
    (audioGainsDb||[]).some(v => Math.abs(v||0) > 0.0001) ||
    (audioMute||[]).some(Boolean) ||
    (audioSolo||[]).some(Boolean)
  );

  const audioMod = hasMods ? { hasMods, audioCount, gainsDb: audioGainsDb || [], mutes: audioMute || [], solos: audioSolo || [] } : null;
  const args = buildExportArgs({ inputPath, inSec, outSec, mode, outPath, audioMod });
  // Enable ffmpeg progress output
  args.unshift('-progress', 'pipe:1', '-nostats');

  return await new Promise((resolve, reject) => {
    const ffmpeg = binPathFromStatic(ffmpegStatic, 'ffmpeg');
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    currentExportProc = proc;
    let err = '';
    const started = Date.now();
    const sendProgress = (percent, outSecElapsed) => {
      try {
        const elapsed = Math.max(0, (Date.now() - started) / 1000);
        const remain = Math.max(0, (outSecElapsed > 0 && percent > 0) ? ((elapsed / (percent/100)) - elapsed) : 0);
        const fmt = (s)=>{
          s=Math.floor(s); const m=Math.floor(s/60), sec=s%60; return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
        };
        mainWindow?.webContents?.send(IPC.exportProgress, { percent: Math.max(0, Math.min(100, Math.round(percent))), eta: fmt(remain) });
      } catch {}
    };
    const total = Math.max(0.001, (outSec ?? 0) - (inSec ?? 0));
    proc.stdout.on('data', d => {
      const lines = d.toString().split(/\r?\n/);
      let outMs = null; let outTime = null;
      for (const line of lines){
        const [k,v] = line.split('=');
        if (!k) continue;
        if (k.trim()==='out_time_ms') outMs = parseInt(v||'0',10) || 0;
        if (k.trim()==='out_time') outTime = (v||'').trim();
      }
      let seconds = 0;
      if (outMs!=null) seconds = outMs/1000000;
      else if (outTime) {
        const m = outTime.match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
        if (m){ const h=parseInt(m[1]||'0',10), mi=parseInt(m[2]||'0',10), s=parseFloat(m[3]||'0'); seconds = h*3600+mi*60+s; }
      }
      if (seconds>0){ const pct = (seconds/total)*100; sendProgress(pct, seconds); }
    });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', code => {
      if (code === 0) {
        try { mainWindow?.webContents?.send(IPC.exportProgress, { percent: 100, eta: '00:00', done: true, outPath }); } catch {}
        if (reveal) shell.showItemInFolder(outPath);
        resolve({ outPath });
      } else {
        try { mainWindow?.webContents?.send(IPC.exportProgress, { error: err || `ffmpeg exited ${code}` }); } catch {}
        reject(new Error(err || `ffmpeg exited ${code}`));
      }
    });
  });
});

let currentExportProc = null;
ipcMain.handle(IPC.exportCancel, async () => {
  try { currentExportProc?.kill(); currentExportProc = null; return { canceled: true }; }
  catch (e) { return { canceled: false, error: String(e) }; }
});

// IPC: Reveal in Explorer
ipcMain.handle(IPC.revealItem, (_event, filePath) => {
  shell.showItemInFolder(filePath);
});

// IPC: Generate waveform PNG using ffmpeg showwavespic (fallback for MVP)
ipcMain.handle(GEN_WAVEFORM, async (_event, opts) => {
  const { inputPath, streamIndex = 0, width = 1000, height = 90, color = '9af27d', startSec = null, endSec = null, gainDb = 0 } = opts || {};
  const userDir = app.getPath('userData');
  const outDir = path.join(userDir, 'cache');
  await fsPromises.mkdir(outDir, { recursive: true });
  const base = path.parse(inputPath).name;
  const outPath = path.join(outDir, `${base}_a${streamIndex}_${width}x${height}_${Date.now()}.png`);
  const ffmpeg = binPathFromStatic(ffmpegStatic, 'ffmpeg');
  // If a time range is provided, trim before generating the waveform so the
  // visual matches the selected segment instead of stretching the full clip
  const timeTrim = (typeof startSec === 'number' || typeof endSec === 'number');
  const start = (typeof startSec === 'number' && startSec >= 0) ? startSec : null;
  const end = (typeof endSec === 'number' && endSec >= 0) ? endSec : null;
  const parts = [];
  if (timeTrim) {
    const range = `${start != null ? `start=${start}` : ''}${(start != null && end != null) ? ':' : ''}${end != null ? `end=${end}` : ''}`;
    parts.push(`atrim=${range}`);
    parts.push('asetpts=PTS-STARTPTS');
  }
  // Apply gain in dB if provided so waveform amplitude reflects lane loudness
  if (typeof gainDb === 'number' && isFinite(gainDb) && gainDb !== 0) {
    // FFmpeg volume filter accepts dB via dB flag
    parts.push(`volume=${gainDb}dB`);
  }
  parts.push(`showwavespic=s=${width}x${height}:colors=${color}`);
  const filter = `[0:a:${streamIndex}]${parts.join(',')}`;
  const args = [
    '-y',
    '-i', inputPath,
    '-filter_complex', filter,
    '-frames:v', '1',
    outPath
  ];
  await new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    let err = '';
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(err || `ffmpeg exited ${code}`)));
  });
  return { outPath };
});

// IPC: Generate thumbnail sprite strip using ffmpeg
ipcMain.handle(GEN_THUMBS, async (_event, opts) => {
  const { inputPath, cols = 10, width = 320, height = -1 } = opts || {};
  const userDir = app.getPath('userData');
  const outDir = path.join(userDir, 'cache');
  await fsPromises.mkdir(outDir, { recursive: true });
  const base = path.parse(inputPath).name;
  const outPath = path.join(outDir, `${base}_thumbs_${cols}x1_${Date.now()}.png`);
  const ffmpeg = binPathFromStatic(ffmpegStatic, 'ffmpeg');
  const vf = `thumbnail,scale=${width}:${height},tile=${cols}x1`;
  const args = [
    '-y',
    '-i', inputPath,
    '-vf', vf,
    '-frames:v', '1',
    outPath
  ];
  await new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    let err = '';
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(err || `ffmpeg exited ${code}`)));
  });
  return { outPath };
});

// IPC: Demux each audio track to its own WAV file for per-lane playback
ipcMain.handle(PREP_AUDIO, async (_event, opts) => {
  const { inputPath, sampleRate = 48000, channels = 2 } = opts || {};
  if (!inputPath) throw new Error('inputPath required');
  // Probe streams to count audio tracks
  const info = await new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', inputPath];
    const ffprobe = binPathFromStatic(ffprobeStatic, 'ffprobe');
    const proc = spawn(ffprobe, args, { windowsHide: true });
    let out = '';
    let err = '';
    proc.stdout.on('data', d => (out += d.toString()))
    proc.stderr.on('data', d => (err += d.toString()))
    proc.on('close', code => {
      if (code === 0) {
        try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('Failed to parse ffprobe JSON')) }
      } else {
        reject(new Error(err || `ffprobe exited ${code}`));
      }
    });
  });
  const streams = (info?.streams || []).filter(s => s.codec_type === 'audio');
  if (!streams.length) return { tracks: [] };
  const userDir = app.getPath('userData');
  const outDir = path.join(userDir, 'cache', 'atracks');
  await fsPromises.mkdir(outDir, { recursive: true });
  const base = path.parse(inputPath).name;
  const ffmpeg = binPathFromStatic(ffmpegStatic, 'ffmpeg');
  const tracks = [];
  for (let i=0;i<streams.length;i++){
    const ts = Date.now();
    const outPath = path.join(outDir, `${base}_a${i}_${sampleRate}Hz_${channels}ch_${ts}.wav`);
    const args = [
      '-y',
      '-i', inputPath,
      '-map', `0:a:${i}`,
      '-vn', '-sn',
      '-ac', String(channels),
      '-ar', String(sampleRate),
      '-c:a', 'pcm_s16le',
      outPath
    ];
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpeg, args, { windowsHide: true });
      let err = '';
      proc.stderr.on('data', d => err += d.toString());
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(err || `ffmpeg exited ${code}`)));
    });
    tracks.push(outPath);
  }
  return { tracks };
});
